import { describe, expect, it } from 'vitest'

import {
  REVIEW_MARKER,
  reviewMarkerFor,
  syncPrReview,
  type ReviewApi,
  type ReviewCommentInput,
} from './review'

interface ExistingComment {
  id: number
  path: string
  line?: number | null
  original_line?: number | null
  body: string
  user?: { login: string } | null
}

interface FakeCalls {
  reviews: Array<{
    commit_id: string
    event: string
    comments: Array<{ path: string; line: number; body: string }>
  }>
  individual: Array<{ path: string; line: number; body: string }>
  deletedIds: number[]
  listPages: number
}

function makeFake(options: {
  existing?: ExistingComment[]
  createReviewError?: Error
  individualErrors?: Map<string, Error>
}): { api: ReviewApi; calls: FakeCalls } {
  const calls: FakeCalls = { reviews: [], individual: [], deletedIds: [], listPages: 0 }
  const api: ReviewApi = {
    pulls: {
      listReviewComments: async (params) => {
        calls.listPages++
        const all = options.existing ?? []
        const page = params.page ?? 1
        const start = (page - 1) * params.per_page
        return { data: all.slice(start, start + params.per_page) }
      },
      createReview: async (params) => {
        if (options.createReviewError) throw options.createReviewError
        calls.reviews.push({
          commit_id: params.commit_id,
          event: params.event,
          comments: params.comments,
        })
      },
      createReviewComment: async (params) => {
        const err = options.individualErrors?.get(`${params.path}:${params.line}`)
        if (err) throw err
        calls.individual.push({ path: params.path, line: params.line, body: params.body })
      },
      deleteReviewComment: async (params) => {
        calls.deletedIds.push(params.comment_id)
      },
    },
  }
  return { api, calls }
}

const PARAMS_BASE = { owner: 'tyk', repo: 'gateway', prNumber: 42, commitSha: 'abc123' }

const BOT = { login: 'github-actions[bot]' }

const wanted: ReviewCommentInput[] = [
  { key: 'k-opid', path: 'swagger.yml', line: 10, body: 'operationId missing' },
  { key: 'k-desc', path: 'swagger.yml', line: 25, body: 'parameter has no description' },
]

/** Body as it appears on GitHub after syncPrReview marks it. */
function marked(key: string, body: string): string {
  return `${reviewMarkerFor(key)}\n${body}`
}

describe('reviewMarkerFor', () => {
  it('builds a keyed marker that starts with the bare marker prefix', () => {
    expect(reviewMarkerFor('abc123')).toBe('<!-- mcp-doctor:review:abc123 -->')
    expect(REVIEW_MARKER.startsWith('<!-- mcp-doctor:review')).toBe(true)
  })
})

describe('syncPrReview', () => {
  it('posts all comments as one review on first run, with the keyed marker prepended', async () => {
    const { api, calls } = makeFake({})

    const result = await syncPrReview(api, { ...PARAMS_BASE, comments: wanted })

    expect(result).toEqual({ posted: 2, deleted: 0, skipped: [] })
    const review = calls.reviews[0]
    expect(review).toBeDefined()
    expect(review?.event).toBe('COMMENT')
    expect(review?.commit_id).toBe('abc123')
    expect(review?.comments).toHaveLength(2)
    expect(review?.comments[0]?.body.startsWith(reviewMarkerFor('k-opid'))).toBe(true)
    expect(review?.comments[1]?.body.startsWith(reviewMarkerFor('k-desc'))).toBe(true)
    expect(calls.individual).toHaveLength(0)
    expect(calls.deletedIds).toHaveLength(0)
  })

  it('posts nothing and deletes nothing on a second identical run', async () => {
    const { api, calls } = makeFake({
      existing: [
        {
          id: 1,
          path: 'swagger.yml',
          line: 10,
          body: marked('k-opid', 'operationId missing'),
          user: BOT,
        },
        {
          id: 2,
          path: 'swagger.yml',
          line: 25,
          body: marked('k-desc', 'parameter has no description'),
          user: BOT,
        },
      ],
    })

    const result = await syncPrReview(api, { ...PARAMS_BASE, comments: wanted })

    expect(result).toEqual({ posted: 0, deleted: 0, skipped: [] })
    expect(calls.reviews).toHaveLength(0)
    expect(calls.individual).toHaveLength(0)
    expect(calls.deletedIds).toHaveLength(0)
  })

  it('keeps a comment whose LLM wording changed but whose key/path/line are stable', async () => {
    const { api, calls } = makeFake({
      existing: [
        {
          id: 1,
          path: 'swagger.yml',
          line: 10,
          body: marked('k-opid', 'a differently-worded message from the previous run'),
          user: BOT,
        },
      ],
    })

    const result = await syncPrReview(api, {
      ...PARAMS_BASE,
      comments: [{ key: 'k-opid', path: 'swagger.yml', line: 10, body: 'operationId missing' }],
    })

    expect(result).toEqual({ posted: 0, deleted: 0, skipped: [] })
    expect(calls.deletedIds).toHaveLength(0)
    expect(calls.reviews).toHaveLength(0)
  })

  it('deletes our comments whose finding disappeared', async () => {
    const { api, calls } = makeFake({
      existing: [
        {
          id: 7,
          path: 'swagger.yml',
          line: 10,
          body: marked('k-opid', 'operationId missing'),
          user: BOT,
        },
        {
          id: 8,
          path: 'swagger.yml',
          line: 99,
          body: marked('k-stale', 'stale finding'),
          user: BOT,
        },
      ],
    })

    const result = await syncPrReview(api, { ...PARAMS_BASE, comments: wanted })

    expect(result.deleted).toBe(1)
    expect(calls.deletedIds).toEqual([8])
    // The disappeared one is gone; the still-wanted one at line 10 is kept, only line 25 posted.
    expect(result.posted).toBe(1)
    expect(calls.reviews).toHaveLength(1)
    expect(calls.reviews[0]?.comments.map((c) => c.line)).toEqual([25])
  })

  it('treats legacy bare-marker comments as ours and cleans them up', async () => {
    const { api, calls } = makeFake({
      existing: [
        {
          id: 4,
          path: 'swagger.yml',
          line: 10,
          body: `${REVIEW_MARKER}\noperationId missing`,
          user: BOT,
        },
      ],
    })

    const result = await syncPrReview(api, {
      ...PARAMS_BASE,
      comments: [{ key: 'k-opid', path: 'swagger.yml', line: 10, body: 'operationId missing' }],
    })

    // Legacy comment has no key so it cannot match; it is replaced by a keyed one.
    expect(calls.deletedIds).toEqual([4])
    expect(result.posted).toBe(1)
  })

  it('never touches comments that do not carry the marker', async () => {
    const { api, calls } = makeFake({
      existing: [
        { id: 3, path: 'swagger.yml', line: 10, body: 'human comment, hands off', user: BOT },
      ],
    })

    const result = await syncPrReview(api, { ...PARAMS_BASE, comments: [] })

    expect(result).toEqual({ posted: 0, deleted: 0, skipped: [] })
    expect(calls.deletedIds).toHaveLength(0)
  })

  it('ignores marker-spoofing comments from non-bot users (never deletes, never dedupes on them)', async () => {
    const { api, calls } = makeFake({
      existing: [
        {
          id: 9,
          path: 'swagger.yml',
          line: 10,
          body: marked('k-opid', 'operationId missing'),
          user: { login: 'evil-user' },
        },
      ],
    })

    const result = await syncPrReview(api, {
      ...PARAMS_BASE,
      comments: [{ key: 'k-opid', path: 'swagger.yml', line: 10, body: 'operationId missing' }],
    })

    // Spoofed comment is not ours: it is not deleted, and it does not satisfy the wanted set.
    expect(calls.deletedIds).toHaveLength(0)
    expect(result.posted).toBe(1)
  })

  it('accepts a custom expectedAuthor that is not a [bot] login', async () => {
    const { api, calls } = makeFake({
      existing: [
        {
          id: 10,
          path: 'swagger.yml',
          line: 10,
          body: marked('k-opid', 'operationId missing'),
          user: { login: 'my-ci-user' },
        },
      ],
    })

    const result = await syncPrReview(api, {
      ...PARAMS_BASE,
      expectedAuthor: 'my-ci-user',
      comments: [{ key: 'k-opid', path: 'swagger.yml', line: 10, body: 'operationId missing' }],
    })

    expect(result).toEqual({ posted: 0, deleted: 0, skipped: [] })
    expect(calls.deletedIds).toHaveLength(0)
  })

  it('paginates past the first 100 review comments', async () => {
    const filler: ExistingComment[] = Array.from({ length: 100 }, (_, i) => ({
      id: i + 1,
      path: 'swagger.yml',
      line: 1,
      body: `human noise ${i}`,
      user: { login: 'human' },
    }))
    const { api, calls } = makeFake({
      existing: [
        ...filler,
        {
          id: 101,
          path: 'swagger.yml',
          line: 99,
          body: marked('k-stale', 'stale finding on page two'),
          user: BOT,
        },
      ],
    })

    const result = await syncPrReview(api, { ...PARAMS_BASE, comments: [] })

    expect(calls.listPages).toBeGreaterThanOrEqual(2)
    expect(result.deleted).toBe(1)
    expect(calls.deletedIds).toEqual([101])
  })

  it('falls back to individual comments when createReview fails, collecting failures into skipped', async () => {
    const { api, calls } = makeFake({
      createReviewError: new Error('Validation Failed: line must be part of the diff (422)'),
      individualErrors: new Map([['swagger.yml:25', new Error('422: line not in diff')]]),
    })

    const result = await syncPrReview(api, { ...PARAMS_BASE, comments: wanted })

    expect(result.posted).toBe(1)
    expect(result.skipped).toEqual([{ path: 'swagger.yml', line: 25 }])
    expect(calls.individual).toHaveLength(1)
    expect(calls.individual[0]?.path).toBe('swagger.yml')
    expect(calls.individual[0]?.line).toBe(10)
    expect(calls.individual[0]?.body.startsWith(reviewMarkerFor('k-opid'))).toBe(true)
  })

  it('matches existing comments via original_line when line is null (outdated position)', async () => {
    const { api, calls } = makeFake({
      existing: [
        {
          id: 5,
          path: 'swagger.yml',
          line: null,
          original_line: 10,
          body: marked('k-opid', 'operationId missing'),
          user: BOT,
        },
      ],
    })

    const result = await syncPrReview(api, {
      ...PARAMS_BASE,
      comments: [{ key: 'k-opid', path: 'swagger.yml', line: 10, body: 'operationId missing' }],
    })

    expect(result).toEqual({ posted: 0, deleted: 0, skipped: [] })
    expect(calls.reviews).toHaveLength(0)
  })
})
