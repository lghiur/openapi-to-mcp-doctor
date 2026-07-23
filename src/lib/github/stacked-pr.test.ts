import { describe, expect, it } from 'vitest'
import {
  closeFixPrForAbandonedSource,
  closeFixPrIfObsolete,
  ensureStackedFixPr,
  fixBranchName,
  repointOrCloseFixPr,
  type StackedPrApi,
} from '@/lib/github/stacked-pr'

interface FakePr {
  number: number
  html_url: string
  state: string
  head: { ref: string }
  base: { ref: string }
  title: string
  body: string
}

function apiError(status: number, message: string): Error {
  return Object.assign(new Error(message), { status })
}

/**
 * Minimal in-memory GitHub: branches point at commit shas, commits are file
 * snapshots — enough git semantics for force-reset + commit + PR lifecycle.
 */
function fakeRepo(seed: {
  branches: Record<string, Record<string, string>>
  /** Paths whose getContent responses come back truncated (size > 1MB). */
  largeFiles?: string[]
  /** Force getContent for a ref to fail with this error (non-404 scenarios). */
  contentErrors?: Record<string, Error>
}) {
  let commitN = 0
  let prN = 0
  const commits = new Map<string, Record<string, string>>()
  const branches = new Map<string, string>()
  for (const [name, files] of Object.entries(seed.branches)) {
    const sha = `seed-${name}`
    commits.set(sha, { ...files })
    branches.set(name, sha)
  }
  const prs: FakePr[] = []
  const comments: string[] = []
  const calls = { createRef: 0, updateRef: 0, commit: 0, prCreate: 0, prUpdate: 0, getBlob: 0 }
  const blobs = new Map<string, string>()

  const stripHeads = (ref: string) => ref.replace(/^refs\/heads\//, '').replace(/^heads\//, '')
  const fileAt = (branch: string, path: string): string | undefined => {
    const sha = branches.get(branch)
    return sha ? commits.get(sha)?.[path] : undefined
  }

  const api: StackedPrApi = {
    git: {
      async getRef({ ref }) {
        const sha = branches.get(stripHeads(ref))
        if (!sha) throw apiError(404, `404: ref ${ref}`)
        return { data: { object: { sha } } }
      },
      async createRef({ ref, sha }) {
        const branch = stripHeads(ref)
        if (branches.has(branch)) throw apiError(422, '422: Reference already exists')
        calls.createRef++
        branches.set(branch, sha)
        return {}
      },
      async updateRef({ ref, sha, force }) {
        if (!force) throw apiError(422, '422: non-fast-forward')
        calls.updateRef++
        branches.set(stripHeads(ref), sha)
        return {}
      },
      async getBlob({ file_sha }) {
        calls.getBlob++
        const content = blobs.get(file_sha)
        if (content === undefined) throw apiError(404, `404: blob ${file_sha}`)
        return {
          data: { content: Buffer.from(content, 'utf8').toString('base64'), encoding: 'base64' },
        }
      },
    },
    repos: {
      async getContent({ path, ref }) {
        const forced = seed.contentErrors?.[ref]
        if (forced) throw forced
        const content = fileAt(ref, path)
        if (content === undefined) throw apiError(404, `404: ${path}@${ref}`)
        const sha = `file-${path}-${branches.get(ref)}`
        if (seed.largeFiles?.includes(path)) {
          blobs.set(sha, content)
          return { data: { type: 'file', sha, content: '', encoding: 'none', size: 2_000_000 } }
        }
        return {
          data: {
            type: 'file',
            sha,
            content: Buffer.from(content, 'utf8').toString('base64'),
            encoding: 'base64',
          },
        }
      },
      async createOrUpdateFileContents({ path, content, branch }) {
        calls.commit++
        const parentSha = branches.get(branch)
        const files = { ...(parentSha ? commits.get(parentSha) : {}) }
        files[path] = Buffer.from(content, 'base64').toString('utf8')
        const sha = `commit-${++commitN}`
        commits.set(sha, files)
        branches.set(branch, sha)
        return {}
      },
    },
    pulls: {
      async list({ owner, state, head, base }) {
        return {
          data: prs.filter(
            (pr) =>
              pr.state === state &&
              `${owner}:${pr.head.ref}` === head &&
              (base === undefined || pr.base.ref === base),
          ),
        }
      },
      async create({ head, base, title, body }) {
        calls.prCreate++
        const pr: FakePr = {
          number: ++prN,
          html_url: `https://pr/${prN}`,
          state: 'open',
          head: { ref: head },
          base: { ref: base },
          title,
          body,
        }
        prs.push(pr)
        return { data: { number: pr.number, html_url: pr.html_url } }
      },
      async update({ pull_number, title, body, base, state }) {
        calls.prUpdate++
        const pr = prs.find((p) => p.number === pull_number)
        if (!pr) throw apiError(404, '404: pr')
        if (title !== undefined) pr.title = title
        if (body !== undefined) pr.body = body
        if (base !== undefined) pr.base.ref = base
        if (state !== undefined) pr.state = state
        return {}
      },
    },
    issues: {
      async createComment({ body }) {
        comments.push(body)
        return {}
      },
    },
  }

  return { api, prs, comments, calls, fileAt }
}

describe('fixBranchName', () => {
  it('derives the stacked fix branch from the source branch', () => {
    expect(fixBranchName('feature-x')).toBe('feature-x-mcp-doctor-fixes')
  })
})

describe('ensureStackedFixPr', () => {
  const params = {
    owner: 'o',
    repo: 'r',
    sourceBranch: 'feature-x',
    specPath: 'api/openapi.yaml',
    patchedContent: 'openapi: 3.0.0\npatched: true\n',
    title: 'Fix spec',
    body: 'Body v1',
  }

  it('creates the branch, commits the patch, and opens the PR on first run', async () => {
    const repo = fakeRepo({
      branches: { 'feature-x': { 'api/openapi.yaml': 'openapi: 3.0.0\n' } },
    })

    const result = await ensureStackedFixPr(repo.api, params)

    expect(result.created).toBe(true)
    expect(result.number).toBe(1)
    expect(repo.calls.createRef).toBe(1)
    expect(repo.calls.updateRef).toBe(0)
    expect(repo.calls.commit).toBe(1)
    expect(repo.fileAt('feature-x-mcp-doctor-fixes', 'api/openapi.yaml')).toBe(
      params.patchedContent,
    )
    expect(repo.prs).toHaveLength(1)
    expect(repo.prs[0]?.base.ref).toBe('feature-x')
  })

  it('is a no-op on a byte-identical re-run: no force-reset, no commit, PR reused', async () => {
    const repo = fakeRepo({
      branches: { 'feature-x': { 'api/openapi.yaml': 'openapi: 3.0.0\n' } },
    })

    const first = await ensureStackedFixPr(repo.api, params)
    const second = await ensureStackedFixPr(repo.api, {
      ...params,
      title: 'Fix spec v2',
      body: 'Body v2',
    })

    expect(second.created).toBe(false)
    expect(second.number).toBe(first.number)
    expect(repo.prs).toHaveLength(1)
    expect(repo.calls.createRef).toBe(1)
    // The fix branch already carries exactly this patched content — skip the
    // force-reset + commit entirely.
    expect(repo.calls.updateRef).toBe(0)
    expect(repo.calls.commit).toBe(1)
    expect(repo.calls.prCreate).toBe(1)
    expect(repo.prs[0]?.title).toBe('Fix spec v2')
    expect(repo.prs[0]?.body).toBe('Body v2')
  })

  it('force-resets and re-commits when the patched content changed', async () => {
    const repo = fakeRepo({
      branches: { 'feature-x': { 'api/openapi.yaml': 'openapi: 3.0.0\n' } },
    })

    const first = await ensureStackedFixPr(repo.api, params)
    const second = await ensureStackedFixPr(repo.api, {
      ...params,
      patchedContent: 'openapi: 3.0.0\npatched: v2\n',
    })

    expect(second.number).toBe(first.number)
    expect(repo.calls.updateRef).toBe(1)
    expect(repo.calls.commit).toBe(2)
    expect(repo.fileAt('feature-x-mcp-doctor-fixes', 'api/openapi.yaml')).toBe(
      'openapi: 3.0.0\npatched: v2\n',
    )
  })

  it('rethrows a non-422 createRef failure instead of masking it as updateRef', async () => {
    const repo = fakeRepo({
      branches: { 'feature-x': { 'api/openapi.yaml': 'openapi: 3.0.0\n' } },
    })
    const forbidden = apiError(403, 'Resource not accessible by integration')
    const api: StackedPrApi = {
      ...repo.api,
      git: {
        ...repo.api.git,
        createRef: async () => {
          throw forbidden
        },
      },
    }

    await expect(ensureStackedFixPr(api, params)).rejects.toThrow(
      /not accessible by integration/,
    )
    expect(repo.calls.updateRef).toBe(0)
  })

  it('skips the commit when the branch content already matches', async () => {
    const repo = fakeRepo({
      branches: { 'feature-x': { 'api/openapi.yaml': params.patchedContent } },
    })

    await ensureStackedFixPr(repo.api, params)

    expect(repo.calls.commit).toBe(0)
  })

  it('finds a previously re-pointed fix PR (base != source) and re-points it back', async () => {
    const repo = fakeRepo({
      branches: { 'feature-x': { 'api/openapi.yaml': 'openapi: 3.0.0\n' } },
    })
    // A fix PR left over from a close/reopen cycle, re-pointed at main.
    repo.prs.push({
      number: 9,
      html_url: 'https://pr/9',
      state: 'open',
      head: { ref: 'feature-x-mcp-doctor-fixes' },
      base: { ref: 'main' },
      title: 'old',
      body: 'old',
    })

    const result = await ensureStackedFixPr(repo.api, params)

    expect(result.created).toBe(false)
    expect(result.number).toBe(9)
    expect(repo.calls.prCreate).toBe(0)
    expect(repo.prs).toHaveLength(1)
    expect(repo.prs[0]?.base.ref).toBe('feature-x')
  })

  it('reads a truncated (>1MB) spec via the blobs API instead of treating it as empty', async () => {
    const repo = fakeRepo({
      branches: { 'feature-x': { 'api/openapi.yaml': 'openapi: 3.0.0\n' } },
      largeFiles: ['api/openapi.yaml'],
    })

    await ensureStackedFixPr(repo.api, params)
    const before = repo.calls.commit
    // Re-run with identical content: the blob read must see the real bytes and no-op.
    await ensureStackedFixPr(repo.api, params)

    expect(repo.calls.getBlob).toBeGreaterThan(0)
    expect(repo.calls.commit).toBe(before)
  })
})

describe('repointOrCloseFixPr', () => {
  const params = {
    owner: 'o',
    repo: 'r',
    sourceBranch: 'feature-x',
    newBaseRef: 'main',
    specPath: 'api/openapi.yaml',
  }

  function seedFixPr(repo: ReturnType<typeof fakeRepo>): FakePr {
    const pr: FakePr = {
      number: 7,
      html_url: 'https://pr/7',
      state: 'open',
      head: { ref: 'feature-x-mcp-doctor-fixes' },
      base: { ref: 'feature-x' },
      title: 'Fix spec',
      body: 'Body',
    }
    repo.prs.push(pr)
    return pr
  }

  it('re-points the fix PR at the new base when a diff remains', async () => {
    const repo = fakeRepo({
      branches: {
        main: { 'api/openapi.yaml': 'openapi: 3.0.0\n' },
        'feature-x-mcp-doctor-fixes': { 'api/openapi.yaml': 'openapi: 3.0.0\npatched: true\n' },
      },
    })
    const pr = seedFixPr(repo)

    const outcome = await repointOrCloseFixPr(repo.api, params)

    expect(outcome).toBe('repointed')
    expect(pr.base.ref).toBe('main')
    expect(pr.state).toBe('open')
    expect(repo.comments).toHaveLength(1)
    expect(repo.comments[0]).toContain('main')
  })

  it('closes the fix PR with a note when nothing differs from the new base', async () => {
    const repo = fakeRepo({
      branches: {
        main: { 'api/openapi.yaml': 'openapi: 3.0.0\npatched: true\n' },
        'feature-x-mcp-doctor-fixes': { 'api/openapi.yaml': 'openapi: 3.0.0\npatched: true\n' },
      },
    })
    const pr = seedFixPr(repo)

    const outcome = await repointOrCloseFixPr(repo.api, params)

    expect(outcome).toBe('closed')
    expect(pr.state).toBe('closed')
    expect(pr.base.ref).toBe('feature-x')
    expect(repo.comments).toHaveLength(1)
  })

  it('still closes when the spec is genuinely missing (404) on both sides', async () => {
    const repo = fakeRepo({
      branches: {
        main: { 'other.txt': 'x' },
        'feature-x-mcp-doctor-fixes': { 'other.txt': 'x' },
      },
    })
    const pr = seedFixPr(repo)

    const outcome = await repointOrCloseFixPr(repo.api, params)

    expect(outcome).toBe('closed')
    expect(pr.state).toBe('closed')
  })

  it('rethrows non-404 read errors instead of wrongly closing the PR', async () => {
    const repo = fakeRepo({
      branches: {
        main: { 'api/openapi.yaml': 'openapi: 3.0.0\n' },
        'feature-x-mcp-doctor-fixes': { 'api/openapi.yaml': 'openapi: 3.0.0\npatched: true\n' },
      },
      contentErrors: { main: apiError(500, '500: server error') },
    })
    const pr = seedFixPr(repo)

    await expect(repointOrCloseFixPr(repo.api, params)).rejects.toThrow('500')
    expect(pr.state).toBe('open')
    expect(repo.comments).toHaveLength(0)
  })

  it('returns none when no open fix PR exists', async () => {
    const repo = fakeRepo({
      branches: { main: { 'api/openapi.yaml': 'openapi: 3.0.0\n' } },
    })

    const outcome = await repointOrCloseFixPr(repo.api, params)

    expect(outcome).toBe('none')
    expect(repo.calls.prUpdate).toBe(0)
    expect(repo.comments).toHaveLength(0)
  })
})

describe('closeFixPrIfObsolete', () => {
  const params = { owner: 'o', repo: 'r', sourceBranch: 'feature-x' }

  it('closes an open fix PR with an explanatory comment', async () => {
    const repo = fakeRepo({
      branches: { 'feature-x': { 'api/openapi.yaml': 'openapi: 3.0.0\n' } },
    })
    const pr: FakePr = {
      number: 3,
      html_url: 'https://pr/3',
      state: 'open',
      head: { ref: 'feature-x-mcp-doctor-fixes' },
      base: { ref: 'feature-x' },
      title: 'Fix spec',
      body: 'Body',
    }
    repo.prs.push(pr)

    const outcome = await closeFixPrIfObsolete(repo.api, params)

    expect(outcome).toBe('closed')
    expect(pr.state).toBe('closed')
    expect(repo.comments).toHaveLength(1)
    expect(repo.comments[0]).toContain('no longer')
  })

  it('returns none when there is nothing to close', async () => {
    const repo = fakeRepo({
      branches: { 'feature-x': { 'api/openapi.yaml': 'openapi: 3.0.0\n' } },
    })

    const outcome = await closeFixPrIfObsolete(repo.api, params)

    expect(outcome).toBe('none')
    expect(repo.comments).toHaveLength(0)
  })
})

describe('closeFixPrForAbandonedSource', () => {
  const params = { owner: 'o', repo: 'r', sourceBranch: 'feature-x' }

  it('closes the fix PR with an abandoned-source note, without re-pointing it', async () => {
    const repo = fakeRepo({
      branches: { 'feature-x': { 'api/openapi.yaml': 'openapi: 3.0.0\n' } },
    })
    const pr: FakePr = {
      number: 5,
      html_url: 'https://pr/5',
      state: 'open',
      head: { ref: 'feature-x-mcp-doctor-fixes' },
      base: { ref: 'feature-x' },
      title: 'Fix spec',
      body: 'Body',
    }
    repo.prs.push(pr)

    const outcome = await closeFixPrForAbandonedSource(repo.api, params)

    expect(outcome).toBe('closed')
    expect(pr.state).toBe('closed')
    // Never re-pointed at another base — the abandoned branch's content must
    // not be proposed into the base branch.
    expect(pr.base.ref).toBe('feature-x')
    expect(repo.comments).toHaveLength(1)
    expect(repo.comments[0]).toContain('closed without merging')
  })

  it('returns none when no open fix PR exists', async () => {
    const repo = fakeRepo({
      branches: { 'feature-x': { 'api/openapi.yaml': 'openapi: 3.0.0\n' } },
    })

    const outcome = await closeFixPrForAbandonedSource(repo.api, params)

    expect(outcome).toBe('none')
    expect(repo.comments).toHaveLength(0)
  })
})
