import { Octokit } from '@octokit/rest'
import { isRefAlreadyExistsError } from './errors'
import {
  HANDLER_HINT,
  MAX_SOURCE_CANDIDATES,
  SOURCE_EXCLUDE,
  SOURCE_PATTERN,
} from './source-patterns'

export interface RepoSummary {
  fullName: string
  defaultBranch: string
  private: boolean
}

/**
 * A repository-tree listing. `truncated` is GitHub's own signal that the tree
 * response was cut short (very large monorepo): the paths are then a partial
 * view, and a spec or handler file being absent proves nothing. Callers must
 * surface it rather than present the partial listing as the whole repo.
 */
export interface TreeListing {
  paths: string[]
  truncated: boolean
}

/** Result of a bulk file read: the files that came back, plus how many did not. */
export interface ReadFilesResult {
  files: Array<{ path: string; content: string }>
  /** Reads that failed (unreadable, binary, too large, denied) — never silent. */
  failed: number
}

export interface CreatePrParams {
  owner: string
  repo: string
  baseBranch: string
  headBranch: string
  path: string
  content: string
  commitMessage: string
  title: string
  body: string
}

export interface GitHubClient {
  listRepos(): Promise<RepoSummary[]>
  listSpecCandidates(owner: string, repo: string, branch: string): Promise<TreeListing>
  /** v2 grounding: candidate handler/source files, handler-ish first, capped. */
  listSourceCandidates(owner: string, repo: string, branch: string): Promise<TreeListing>
  readFile(owner: string, repo: string, path: string, ref: string): Promise<string>
  /** v2: fetch multiple handler/route files for codebase grounding. */
  readFiles(owner: string, repo: string, paths: string[], ref: string): Promise<ReadFilesResult>
  createFixPr(params: CreatePrParams): Promise<{ url: string; number: number }>
}

// Deliberately broader than SPEC_FILE_PATTERN: the web UI lists every
// yaml/json file and lets the user pick, rather than guessing by filename.
const SPEC_PATTERN = /\.(ya?ml|json)$/i

const REPO_PAGE_SIZE = 100

/**
 * Hard cap on repository pages walked by `listRepos` — 10 × 100 = 1000 repos.
 * Users in large orgs need more than one page to find their repo, but an
 * account with tens of thousands of repos must not hold the dashboard render
 * hostage; past the cap the list is simply the 1000 most recently updated.
 */
export const MAX_REPO_PAGES = 10

/**
 * Simultaneous `getContent` calls in `readFiles`. GitHub's secondary rate
 * limits explicitly target concurrent bursts against the same endpoint, so the
 * reads run through a small worker pool rather than all at once.
 */
export const READ_CONCURRENCY = 5

/**
 * Run `fn` over `items` with at most `limit` in flight, preserving order and
 * never rejecting — the per-item outcome is reported like `allSettled`.
 * (Local on purpose: `lib/engine` has its own semaphore, and `lib/github` must
 * not depend on the engine.)
 */
async function mapWithLimit<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<Array<{ ok: true; value: R } | { ok: false }>> {
  const results: Array<{ ok: true; value: R } | { ok: false }> = new Array(items.length)
  let cursor = 0
  const worker = async (): Promise<void> => {
    for (let index = cursor++; index < items.length; index = cursor++) {
      const item = items[index] as T
      try {
        results[index] = { ok: true, value: await fn(item) }
      } catch {
        results[index] = { ok: false }
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker))
  return results
}

/** Every blob path in a repo tree, plus GitHub's truncation flag. */
async function listTreeBlobs(
  octokit: Octokit,
  owner: string,
  repo: string,
  branch: string,
): Promise<TreeListing> {
  const { data } = await octokit.git.getTree({ owner, repo, tree_sha: branch, recursive: 'true' })
  const paths = data.tree
    .filter((node) => node.type === 'blob' && typeof node.path === 'string')
    .map((node) => node.path as string)
  return { paths, truncated: data.truncated === true }
}

/**
 * Order source candidates so the capped slice keeps the files most likely to
 * register routes: handler-ish names first, then shallower paths, then
 * alphabetical.
 */
function bySourceRelevance(a: string, b: string): number {
  const hintA = HANDLER_HINT.test(a) ? 0 : 1
  const hintB = HANDLER_HINT.test(b) ? 0 : 1
  if (hintA !== hintB) return hintA - hintB
  const depthA = a.split('/').length
  const depthB = b.split('/').length
  if (depthA !== depthB) return depthA - depthB
  return a.localeCompare(b)
}

/** Wrap an Octokit instance in the narrow surface the app needs. */
export function githubClient(octokit: Octokit): GitHubClient {
  return {
    async listRepos() {
      // Walk pages until a short one (or the cap): a user in a large org would
      // otherwise never see their repo in the picker.
      const repos: RepoSummary[] = []
      for (let page = 1; page <= MAX_REPO_PAGES; page++) {
        const { data } = await octokit.repos.listForAuthenticatedUser({
          per_page: REPO_PAGE_SIZE,
          page,
          sort: 'updated',
        })
        for (const repo of data) {
          repos.push({
            fullName: repo.full_name,
            defaultBranch: repo.default_branch ?? 'main',
            private: repo.private,
          })
        }
        if (data.length < REPO_PAGE_SIZE) break
      }
      return repos
    },

    async listSpecCandidates(owner, repo, branch) {
      const { paths, truncated } = await listTreeBlobs(octokit, owner, repo, branch)
      return { paths: paths.filter((path) => SPEC_PATTERN.test(path)), truncated }
    },

    async listSourceCandidates(owner, repo, branch) {
      const { paths, truncated } = await listTreeBlobs(octokit, owner, repo, branch)
      const sources = paths
        .filter((path) => SOURCE_PATTERN.test(path) && !SOURCE_EXCLUDE.test(path))
        .sort(bySourceRelevance)
      return { paths: sources.slice(0, MAX_SOURCE_CANDIDATES), truncated }
    },

    async readFile(owner, repo, path, ref) {
      const { data } = await octokit.repos.getContent({ owner, repo, path, ref })
      if (Array.isArray(data) || data.type !== 'file' || typeof data.content !== 'string') {
        throw new Error(`Not a readable file: ${path}`)
      }
      return Buffer.from(data.content, 'base64').toString('utf8')
    },

    async readFiles(owner, repo, paths, ref) {
      // Resilient: skip files that are unreadable, binary, or over GitHub's
      // contents-API size limit, so one bad file can't abort grounding — but
      // report how many were skipped instead of silently returning less.
      const settled = await mapWithLimit(paths, READ_CONCURRENCY, async (path) => ({
        path,
        content: await this.readFile(owner, repo, path, ref),
      }))
      const files = settled.flatMap((result) => (result.ok ? [result.value] : []))
      return { files, failed: settled.length - files.length }
    },

    async createFixPr(params) {
      const baseRef = await octokit.git.getRef({
        owner: params.owner,
        repo: params.repo,
        ref: `heads/${params.baseBranch}`,
      })
      const baseSha = baseRef.data.object.sha

      // 422 when the branch already exists (e.g. a previous run's leftover):
      // force-reset it to the base instead of failing, same as stacked-pr.ts.
      // Any other failure (401/403/429/5xx) propagates — retrying it as an
      // updateRef would surface as a baffling "Reference does not exist".
      try {
        await octokit.git.createRef({
          owner: params.owner,
          repo: params.repo,
          ref: `refs/heads/${params.headBranch}`,
          sha: baseSha,
        })
      } catch (error) {
        if (!isRefAlreadyExistsError(error)) throw error
        await octokit.git.updateRef({
          owner: params.owner,
          repo: params.repo,
          ref: `heads/${params.headBranch}`,
          sha: baseSha,
          force: true,
        })
      }

      const existing = await octokit.repos
        .getContent({
          owner: params.owner,
          repo: params.repo,
          path: params.path,
          ref: params.headBranch,
        })
        .catch(() => null)
      const sha =
        existing && !Array.isArray(existing.data) && existing.data.type === 'file'
          ? existing.data.sha
          : undefined

      await octokit.repos.createOrUpdateFileContents({
        owner: params.owner,
        repo: params.repo,
        path: params.path,
        message: params.commitMessage,
        content: Buffer.from(params.content, 'utf8').toString('base64'),
        branch: params.headBranch,
        ...(sha ? { sha } : {}),
      })

      const pr = await octokit.pulls.create({
        owner: params.owner,
        repo: params.repo,
        base: params.baseBranch,
        head: params.headBranch,
        title: params.title,
        body: params.body,
      })

      return { url: pr.data.html_url, number: pr.data.number }
    },
  }
}

export function createGitHubClient(token: string): GitHubClient {
  return githubClient(new Octokit({ auth: token }))
}
