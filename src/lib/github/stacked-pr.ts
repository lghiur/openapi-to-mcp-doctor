/**
 * Stacked fix-PR lifecycle for the GitHub Action `fix-pr` behavior
 * (`docs/ideas/github-action-pr-mode.md`). Every run force-resets the fix
 * branch to the source PR's head and re-commits the patched spec on top, so
 * the branch is always "source head + one patch commit" — idempotent across
 * pushes, never a duplicate PR. A byte-identical re-run (fix branch already
 * carries exactly the new patched spec) skips the reset + commit entirely.
 * When the source PR closes, the fix PR is re-pointed at the source PR's
 * target branch or closed if nothing remains.
 */

/** Branch that carries the stacked fix PR for a source branch. */
export function fixBranchName(sourceBranch: string): string {
  return `${sourceBranch}-mcp-doctor-fixes`
}

/** Narrow structural slice of Octokit used by the stacked-PR lifecycle. */
export interface StackedPrApi {
  git: {
    getRef(params: {
      owner: string
      repo: string
      ref: string
    }): Promise<{ data: { object: { sha: string } } }>
    createRef(params: { owner: string; repo: string; ref: string; sha: string }): Promise<unknown>
    updateRef(params: {
      owner: string
      repo: string
      ref: string
      sha: string
      force: boolean
    }): Promise<unknown>
    /** Blob read for files the contents API truncates (> 1 MB). */
    getBlob(params: {
      owner: string
      repo: string
      file_sha: string
    }): Promise<{ data: { content: string; encoding: string } }>
  }
  repos: {
    getContent(params: {
      owner: string
      repo: string
      path: string
      ref: string
    }): Promise<{ data: unknown }>
    createOrUpdateFileContents(params: {
      owner: string
      repo: string
      path: string
      message: string
      content: string
      branch: string
      sha?: string
    }): Promise<unknown>
  }
  pulls: {
    list(params: {
      owner: string
      repo: string
      state: 'open'
      head: string
      base?: string
    }): Promise<{ data: Array<{ number: number; html_url: string; base: { ref: string } }> }>
    create(params: {
      owner: string
      repo: string
      base: string
      head: string
      title: string
      body: string
    }): Promise<{ data: { number: number; html_url: string } }>
    update(params: {
      owner: string
      repo: string
      pull_number: number
      title?: string
      body?: string
      base?: string
      state?: 'open' | 'closed'
    }): Promise<unknown>
  }
  issues: {
    createComment(params: {
      owner: string
      repo: string
      issue_number: number
      body: string
    }): Promise<unknown>
  }
}

export interface EnsureStackedFixPrParams {
  owner: string
  repo: string
  /** Head branch of the source PR the fixes stack on. */
  sourceBranch: string
  specPath: string
  /** Full patched spec content (utf8). */
  patchedContent: string
  title: string
  body: string
}

export interface RepointOrCloseParams {
  owner: string
  repo: string
  /** Head branch of the source PR that just closed/merged. */
  sourceBranch: string
  /** The source PR's target branch (master, release-1.x, …). */
  newBaseRef: string
  specPath: string
}

interface ContentFile {
  type: string
  sha: string
  content: string
  encoding?: string
}

function asContentFile(data: unknown): ContentFile | null {
  if (typeof data !== 'object' || data === null || Array.isArray(data)) return null
  const file = data as Partial<ContentFile>
  return file.type === 'file' && typeof file.content === 'string' && typeof file.sha === 'string'
    ? {
        type: file.type,
        sha: file.sha,
        content: file.content,
        ...(typeof file.encoding === 'string' ? { encoding: file.encoding } : {}),
      }
    : null
}

function isNotFound(error: unknown): boolean {
  return (
    typeof error === 'object' && error !== null && (error as { status?: unknown }).status === 404
  )
}

/**
 * Read a file at a ref. Null strictly means "no such file" (404 or the path is
 * a directory); every other API error is rethrown — collapsing errors to null
 * once let repointOrCloseFixPr "close" a PR because two reads both failed.
 * Files over the contents-API size limit come back with empty content and
 * `encoding: "none"`; those are fetched through the git blobs API instead.
 */
async function readFileAt(
  api: StackedPrApi,
  owner: string,
  repo: string,
  path: string,
  ref: string,
): Promise<{ content: string; sha: string } | null> {
  let res: { data: unknown }
  try {
    res = await api.repos.getContent({ owner, repo, path, ref })
  } catch (error) {
    if (isNotFound(error)) return null
    throw error
  }
  const file = asContentFile(res.data)
  if (!file) return null
  if (file.content === '' && file.encoding === 'none') {
    const blob = await api.git.getBlob({ owner, repo, file_sha: file.sha })
    const content =
      blob.data.encoding === 'base64'
        ? Buffer.from(blob.data.content, 'base64').toString('utf8')
        : blob.data.content
    return { content, sha: file.sha }
  }
  return { content: Buffer.from(file.content, 'base64').toString('utf8'), sha: file.sha }
}

/** Branch head sha, or null when the branch does not exist. */
async function branchSha(
  api: StackedPrApi,
  owner: string,
  repo: string,
  branch: string,
): Promise<string | null> {
  try {
    const ref = await api.git.getRef({ owner, repo, ref: `heads/${branch}` })
    return ref.data.object.sha
  } catch (error) {
    if (isNotFound(error)) return null
    throw error
  }
}

/**
 * Create or refresh the stacked fix branch + PR for a source PR's head branch.
 * Safe to call on every push: same branch, same PR, no empty commits.
 */
export async function ensureStackedFixPr(
  api: StackedPrApi,
  params: EnsureStackedFixPrParams,
): Promise<{ number: number; url: string; created: boolean }> {
  const { owner, repo, sourceBranch, specPath, patchedContent, title, body } = params
  const branch = fixBranchName(sourceBranch)

  const sourceHead = await api.git.getRef({ owner, repo, ref: `heads/${sourceBranch}` })
  const sourceSha = sourceHead.data.object.sha

  // Byte-identical re-run: the fix branch already carries exactly this patched
  // spec — skip the force-reset + commit, only reconcile the PR below.
  const existingBranchSha = await branchSha(api, owner, repo, branch)
  const alreadyPatched =
    existingBranchSha !== null &&
    (await readFileAt(api, owner, repo, specPath, branch))?.content === patchedContent

  if (!alreadyPatched) {
    // Force-reset the fix branch to the source head so stale patch commits from
    // previous runs never accumulate or conflict.
    try {
      await api.git.createRef({ owner, repo, ref: `refs/heads/${branch}`, sha: sourceSha })
    } catch {
      await api.git.updateRef({ owner, repo, ref: `heads/${branch}`, sha: sourceSha, force: true })
    }

    // Commit only when the patched spec actually differs — no empty commits.
    const existing = await readFileAt(api, owner, repo, specPath, branch)
    if (existing?.content !== patchedContent) {
      await api.repos.createOrUpdateFileContents({
        owner,
        repo,
        path: specPath,
        message: title,
        content: Buffer.from(patchedContent, 'utf8').toString('base64'),
        branch,
        ...(existing ? { sha: existing.sha } : {}),
      })
    }
  }

  // Find the fix PR by head only: a previously re-pointed PR (base moved off
  // the source branch by the closed-lifecycle) must be found and re-pointed
  // back, never duplicated.
  const open = await api.pulls.list({ owner, repo, state: 'open', head: `${owner}:${branch}` })
  const found = open.data[0]
  if (found) {
    await api.pulls.update({
      owner,
      repo,
      pull_number: found.number,
      title,
      body,
      ...(found.base.ref !== sourceBranch ? { base: sourceBranch } : {}),
    })
    return { number: found.number, url: found.html_url, created: false }
  }

  const pr = await api.pulls.create({ owner, repo, base: sourceBranch, head: branch, title, body })
  return { number: pr.data.number, url: pr.data.html_url, created: true }
}

/**
 * Source-PR-closed lifecycle: re-point the open fix PR at the source PR's
 * target branch so surviving fixes can land on their own, or close it with a
 * note when the patched spec no longer differs from the new base. A spec
 * missing on BOTH sides with genuine 404s counts as identical (close); read
 * errors propagate so a flaky API call can never close the PR.
 */
export async function repointOrCloseFixPr(
  api: StackedPrApi,
  params: RepointOrCloseParams,
): Promise<'repointed' | 'closed' | 'none'> {
  const { owner, repo, sourceBranch, newBaseRef, specPath } = params
  const branch = fixBranchName(sourceBranch)

  const open = await api.pulls.list({ owner, repo, state: 'open', head: `${owner}:${branch}` })
  const pr = open.data[0]
  if (!pr) return 'none'

  const [onFixBranch, onNewBase] = await Promise.all([
    readFileAt(api, owner, repo, specPath, branch),
    readFileAt(api, owner, repo, specPath, newBaseRef),
  ])

  if (onFixBranch?.content === onNewBase?.content) {
    await api.pulls.update({ owner, repo, pull_number: pr.number, state: 'closed' })
    await api.issues.createComment({
      owner,
      repo,
      issue_number: pr.number,
      body: `Closing: the spec on \`${newBaseRef}\` already matches these fixes, so this PR has nothing left to offer.\n\n🤖 Closed by [MCP Doctor](https://github.com/TykTechnologies/openapi-to-mcp-doctor)`,
    })
    return 'closed'
  }

  await api.pulls.update({ owner, repo, pull_number: pr.number, base: newBaseRef })
  await api.issues.createComment({
    owner,
    repo,
    issue_number: pr.number,
    body: `The source PR for \`${sourceBranch}\` was closed, so this fix PR now targets \`${newBaseRef}\` — the remaining spec fixes can land on their own.\n\n🤖 Re-pointed by [MCP Doctor](https://github.com/TykTechnologies/openapi-to-mcp-doctor)`,
  })
  return 'repointed'
}

/** Close the open fix PR for a source branch with an explanatory comment. */
async function closeOpenFixPr(
  api: StackedPrApi,
  owner: string,
  repo: string,
  sourceBranch: string,
  note: string,
): Promise<'closed' | 'none'> {
  const branch = fixBranchName(sourceBranch)

  const open = await api.pulls.list({ owner, repo, state: 'open', head: `${owner}:${branch}` })
  const pr = open.data[0]
  if (!pr) return 'none'

  await api.pulls.update({ owner, repo, pull_number: pr.number, state: 'closed' })
  await api.issues.createComment({
    owner,
    repo,
    issue_number: pr.number,
    body: `${note}\n\n🤖 Closed by [MCP Doctor](https://github.com/TykTechnologies/openapi-to-mcp-doctor)`,
  })
  return 'closed'
}

/**
 * A later push made the fix PR obsolete (spec now clean, or fixes no longer
 * apply): close the open fix PR with an explanatory comment. No-op when no
 * open fix PR exists.
 */
export async function closeFixPrIfObsolete(
  api: StackedPrApi,
  params: { owner: string; repo: string; sourceBranch: string },
): Promise<'closed' | 'none'> {
  const { owner, repo, sourceBranch } = params
  return closeOpenFixPr(
    api,
    owner,
    repo,
    sourceBranch,
    `Closing: the latest push to \`${sourceBranch}\` no longer needs these fixes — the spec is clean or the findings were resolved.`,
  )
}

/**
 * The source PR was closed WITHOUT merging: its branch's spec content was
 * abandoned, so the stacked fix PR must be closed — never re-pointed at the
 * base branch, which would propose the abandoned branch's content there.
 * No-op when no open fix PR exists.
 */
export async function closeFixPrForAbandonedSource(
  api: StackedPrApi,
  params: { owner: string; repo: string; sourceBranch: string },
): Promise<'closed' | 'none'> {
  const { owner, repo, sourceBranch } = params
  return closeOpenFixPr(
    api,
    owner,
    repo,
    sourceBranch,
    `Closing: the source PR for \`${sourceBranch}\` was closed without merging, so these spec fixes no longer apply anywhere.`,
  )
}
