import { Octokit } from '@octokit/rest'
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
  listSpecCandidates(owner: string, repo: string, branch: string): Promise<string[]>
  /** v2 grounding: candidate handler/source files, handler-ish first, capped. */
  listSourceCandidates(owner: string, repo: string, branch: string): Promise<string[]>
  readFile(owner: string, repo: string, path: string, ref: string): Promise<string>
  /** v2: fetch multiple handler/route files for codebase grounding. */
  readFiles(
    owner: string,
    repo: string,
    paths: string[],
    ref: string,
  ): Promise<Array<{ path: string; content: string }>>
  createFixPr(params: CreatePrParams): Promise<{ url: string; number: number }>
}

// Deliberately broader than SPEC_FILE_PATTERN: the web UI lists every
// yaml/json file and lets the user pick, rather than guessing by filename.
const SPEC_PATTERN = /\.(ya?ml|json)$/i

/** Wrap an Octokit instance in the narrow surface the app needs. */
export function githubClient(octokit: Octokit): GitHubClient {
  return {
    async listRepos() {
      const { data } = await octokit.repos.listForAuthenticatedUser({
        per_page: 100,
        sort: 'updated',
      })
      return data.map((repo) => ({
        fullName: repo.full_name,
        defaultBranch: repo.default_branch ?? 'main',
        private: repo.private,
      }))
    },

    async listSpecCandidates(owner, repo, branch) {
      const { data } = await octokit.git.getTree({
        owner,
        repo,
        tree_sha: branch,
        recursive: 'true',
      })
      return data.tree
        .filter((node) => node.type === 'blob' && typeof node.path === 'string')
        .map((node) => node.path as string)
        .filter((path) => SPEC_PATTERN.test(path))
    },

    async listSourceCandidates(owner, repo, branch) {
      const { data } = await octokit.git.getTree({
        owner,
        repo,
        tree_sha: branch,
        recursive: 'true',
      })
      const paths = data.tree
        .filter((node) => node.type === 'blob' && typeof node.path === 'string')
        .map((node) => node.path as string)
        .filter((path) => SOURCE_PATTERN.test(path) && !SOURCE_EXCLUDE.test(path))

      // Handler-ish files first, then shallower paths, then alphabetical — so the
      // capped slice keeps the files most likely to register routes.
      paths.sort((a, b) => {
        const hintA = HANDLER_HINT.test(a) ? 0 : 1
        const hintB = HANDLER_HINT.test(b) ? 0 : 1
        if (hintA !== hintB) return hintA - hintB
        const depthA = a.split('/').length
        const depthB = b.split('/').length
        if (depthA !== depthB) return depthA - depthB
        return a.localeCompare(b)
      })
      return paths.slice(0, MAX_SOURCE_CANDIDATES)
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
      // contents-API size limit, so one bad file can't abort grounding.
      const settled = await Promise.allSettled(
        paths.map(async (path) => ({ path, content: await this.readFile(owner, repo, path, ref) })),
      )
      return settled
        .filter(
          (r): r is PromiseFulfilledResult<{ path: string; content: string }> =>
            r.status === 'fulfilled',
        )
        .map((r) => r.value)
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
      try {
        await octokit.git.createRef({
          owner: params.owner,
          repo: params.repo,
          ref: `refs/heads/${params.headBranch}`,
          sha: baseSha,
        })
      } catch {
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
