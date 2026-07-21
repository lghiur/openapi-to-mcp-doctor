/**
 * PR review sync: keeps MCP Doctor's inline review comments on a PR in step
 * with the current set of findings — post new, keep unchanged, delete stale.
 *
 * Comment identity is the caller-supplied stable `key` (finding rule +
 * operation + path hash) plus file path and line — NOT the body, whose LLM
 * wording varies between runs. Every body starts with a keyed marker
 * `<!-- mcp-doctor:review:<key> -->`; ownership is recognized by the bare
 * marker prefix (backward compatible with pre-key comments) AND the comment
 * author, so marker-spoofing comments from arbitrary users are never touched.
 *
 * The bare marker literal is owned by `./comments`; `REVIEW_MARKER` is kept as
 * an alias so existing imports stay valid.
 */
import { DEFAULT_BOT_LOGIN, isTrustedCommentAuthor, REVIEW_COMMENT_MARKER } from './comments'

export const REVIEW_MARKER = REVIEW_COMMENT_MARKER

/** Prefix shared by the bare and keyed review markers — the "ours" check. */
const REVIEW_MARKER_PREFIX = '<!-- mcp-doctor:review'

/** Keyed marker identifying one finding's review comment across pushes. */
export function reviewMarkerFor(key: string): string {
  return `<!-- mcp-doctor:review:${key} -->`
}

const KEYED_MARKER_RE = /^<!-- mcp-doctor:review:([\w.-]+) -->/

/** Extract the stable key from a keyed marker body; undefined for legacy bare markers. */
function markerKeyOf(body: string): string | undefined {
  return KEYED_MARKER_RE.exec(body)?.[1]
}

/** A single inline comment the caller wants on the PR (body without marker). */
export interface ReviewCommentInput {
  /** Stable identity across pushes (e.g. hash of rule + operation + spec path). */
  key: string
  path: string
  line: number
  body: string
}

/** GitHub review comment as returned by pulls.listReviewComments. */
interface ExistingReviewComment {
  id: number
  path: string
  /** Null when the comment is outdated (line no longer in the diff). */
  line?: number | null
  original_line?: number | null
  body: string
  user?: { login: string } | null
}

/**
 * Narrow structural slice of Octokit's `pulls` namespace — only the four
 * calls the sync needs, so tests can pass plain fakes.
 */
export interface ReviewApi {
  pulls: {
    listReviewComments(params: {
      owner: string
      repo: string
      pull_number: number
      per_page: number
      page?: number
    }): Promise<{ data: ExistingReviewComment[] }>
    createReview(params: {
      owner: string
      repo: string
      pull_number: number
      commit_id: string
      event: 'COMMENT'
      comments: Array<{ path: string; line: number; body: string }>
    }): Promise<unknown>
    createReviewComment(params: {
      owner: string
      repo: string
      pull_number: number
      commit_id: string
      path: string
      line: number
      body: string
    }): Promise<unknown>
    deleteReviewComment(params: {
      owner: string
      repo: string
      comment_id: number
    }): Promise<unknown>
  }
}

export interface SyncPrReviewParams {
  owner: string
  repo: string
  prNumber: number
  /** Head SHA the review comments anchor to. */
  commitSha: string
  comments: ReviewCommentInput[]
  /** Login owning our comments (besides any `[bot]`). Default github-actions[bot]. */
  expectedAuthor?: string
}

export interface SyncPrReviewResult {
  posted: number
  deleted: number
  /** Comments that could not be placed (e.g. line not in the diff). */
  skipped: Array<{ path: string; line: number }>
}

const PER_PAGE = 100

/** Identity of a comment across pushes: stable key + position (never the body). */
function commentIdentity(key: string, path: string, line: number): string {
  return [key, path, String(line)].join('\u0000')
}

/** Walk all pages of review comments until a short page. */
async function listAllReviewComments(
  api: ReviewApi,
  owner: string,
  repo: string,
  prNumber: number,
): Promise<ExistingReviewComment[]> {
  const all: ExistingReviewComment[] = []
  for (let page = 1; ; page++) {
    const { data } = await api.pulls.listReviewComments({
      owner,
      repo,
      pull_number: prNumber,
      per_page: PER_PAGE,
      page,
    })
    all.push(...data)
    if (data.length < PER_PAGE) break
  }
  return all
}

/**
 * Reconcile MCP Doctor's inline review comments with the wanted set.
 *
 * - Existing marker-owned comments (marker prefix + trusted author) whose
 *   key/path/line match a wanted comment are kept — LLM re-wording alone never
 *   churns comments; stale ones are deleted; foreign comments are untouched.
 * - New comments go out as a single COMMENT review. If that batch call fails
 *   (typically 422: a line is outside the diff), each comment is retried
 *   individually and per-comment failures land in `skipped` — never thrown.
 */
export async function syncPrReview(
  api: ReviewApi,
  params: SyncPrReviewParams,
): Promise<SyncPrReviewResult> {
  const { owner, repo, prNumber, commitSha } = params
  const expectedAuthor = params.expectedAuthor ?? DEFAULT_BOT_LOGIN

  const existing = await listAllReviewComments(api, owner, repo, prNumber)
  const ours = existing.filter(
    (c) =>
      c.body.startsWith(REVIEW_MARKER_PREFIX) && isTrustedCommentAuthor(c.user, expectedAuthor),
  )

  const wanted = params.comments.map((c) => ({
    path: c.path,
    line: c.line,
    body: `${reviewMarkerFor(c.key)}\n${c.body}`,
    identity: commentIdentity(c.key, c.path, c.line),
  }))
  const wantedIdentities = new Set(wanted.map((c) => c.identity))

  // Delete our comments whose finding disappeared; remember the kept identities.
  const keptIdentities = new Set<string>()
  let deleted = 0
  for (const comment of ours) {
    const line = comment.line ?? comment.original_line
    const key = markerKeyOf(comment.body)
    const identity =
      line == null || key === undefined ? undefined : commentIdentity(key, comment.path, line)
    if (identity !== undefined && wantedIdentities.has(identity)) {
      keptIdentities.add(identity)
    } else {
      await api.pulls.deleteReviewComment({ owner, repo, comment_id: comment.id })
      deleted++
    }
  }

  const toPost = wanted.filter((c) => !keptIdentities.has(c.identity))
  const skipped: Array<{ path: string; line: number }> = []
  let posted = 0

  if (toPost.length > 0) {
    try {
      await api.pulls.createReview({
        owner,
        repo,
        pull_number: prNumber,
        commit_id: commitSha,
        event: 'COMMENT',
        comments: toPost.map(({ path, line, body }) => ({ path, line, body })),
      })
      posted = toPost.length
    } catch {
      // Batch review rejected (e.g. one line outside the diff): retry each
      // comment on its own so one bad anchor doesn't sink the rest.
      for (const comment of toPost) {
        try {
          await api.pulls.createReviewComment({
            owner,
            repo,
            pull_number: prNumber,
            commit_id: commitSha,
            path: comment.path,
            line: comment.line,
            body: comment.body,
          })
          posted++
        } catch {
          skipped.push({ path: comment.path, line: comment.line })
        }
      }
    }
  }

  return { posted, deleted, skipped }
}
