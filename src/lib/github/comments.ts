/**
 * Sticky PR comment upsert: one marker-identified comment per PR, updated in
 * place on every run so the conversation never fills with stale reports.
 *
 * Canonical home of the comment markers — `cli/gh/types.ts` re-exports from
 * here (src/lib must never import from cli/).
 */

/** Hidden HTML marker identifying MCP Doctor's sticky comment / review comments. */
export const STICKY_COMMENT_MARKER = '<!-- mcp-doctor:sticky -->'
export const REVIEW_COMMENT_MARKER = '<!-- mcp-doctor:review -->'

/** Author our comments are posted as when the workflow token is used. */
export const DEFAULT_BOT_LOGIN = 'github-actions[bot]'

/**
 * Ownership guard: a marker alone can be spoofed by any commenter, so a
 * comment is only "ours" when its author is a bot or the expected login.
 * A missing user (structural fakes / redacted API responses) is accepted.
 */
export function isTrustedCommentAuthor(
  user: { login: string } | null | undefined,
  expectedAuthor: string,
): boolean {
  if (user == null) return true
  return user.login === expectedAuthor || user.login.endsWith('[bot]')
}

const PER_PAGE = 100

/** Narrow structural slice of Octokit — only the issue-comment methods we call. */
export interface IssueCommentApi {
  issues: {
    listComments(params: {
      owner: string
      repo: string
      issue_number: number
      per_page?: number
      page?: number
    }): Promise<{
      data: Array<{ id: number; body?: string; user?: { login: string } | null }>
    }>
    createComment(params: {
      owner: string
      repo: string
      issue_number: number
      body: string
    }): Promise<{ data: { id: number } }>
    updateComment(params: {
      owner: string
      repo: string
      comment_id: number
      body: string
    }): Promise<{ data: { id: number } }>
  }
}

export interface UpsertStickyCommentParams {
  owner: string
  repo: string
  issueNumber: number
  /** Full comment body; must start with STICKY_COMMENT_MARKER. */
  body: string
  /** Login owning our comments (besides any `[bot]`). Default github-actions[bot]. */
  expectedAuthor?: string
}

/**
 * Create or update the single marker-identified comment on a PR.
 * Never creates a second marked comment.
 */
export async function upsertStickyComment(
  api: IssueCommentApi,
  params: UpsertStickyCommentParams,
): Promise<{ id: number; created: boolean }> {
  const { owner, repo, issueNumber, body } = params
  const expectedAuthor = params.expectedAuthor ?? DEFAULT_BOT_LOGIN

  if (!body.startsWith(STICKY_COMMENT_MARKER)) {
    throw new Error(`sticky comment body must start with the marker ${STICKY_COMMENT_MARKER}`)
  }

  // Walk all pages until a short page — the marked comment may be anywhere.
  for (let page = 1; ; page++) {
    const { data } = await api.issues.listComments({
      owner,
      repo,
      issue_number: issueNumber,
      per_page: PER_PAGE,
      page,
    })

    const existing = data.find(
      (c) =>
        c.body?.startsWith(STICKY_COMMENT_MARKER) && isTrustedCommentAuthor(c.user, expectedAuthor),
    )
    if (existing) {
      await api.issues.updateComment({ owner, repo, comment_id: existing.id, body })
      return { id: existing.id, created: false }
    }

    if (data.length < PER_PAGE) break
  }

  const { data } = await api.issues.createComment({ owner, repo, issue_number: issueNumber, body })
  return { id: data.id, created: true }
}
