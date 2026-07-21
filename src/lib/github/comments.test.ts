import { describe, expect, it } from 'vitest'

import {
  isTrustedCommentAuthor,
  REVIEW_COMMENT_MARKER,
  STICKY_COMMENT_MARKER,
  upsertStickyComment,
  type IssueCommentApi,
} from './comments'

interface FakeComment {
  id: number
  body?: string
  user?: { login: string } | null
}

/** In-memory fake honouring the pagination contract (per_page slices). */
function makeFakeApi(initial: FakeComment[]) {
  const comments = [...initial]
  let nextId = comments.reduce((max, c) => Math.max(max, c.id), 0) + 1
  const calls = { list: 0, create: 0, update: 0 }

  const api: IssueCommentApi = {
    issues: {
      listComments: async (params) => {
        calls.list += 1
        const perPage = params.per_page ?? 30
        const page = params.page ?? 1
        const start = (page - 1) * perPage
        return { data: comments.slice(start, start + perPage) }
      },
      createComment: async (params) => {
        calls.create += 1
        const comment = { id: nextId++, body: params.body }
        comments.push(comment)
        return { data: { id: comment.id } }
      },
      updateComment: async (params) => {
        calls.update += 1
        const existing = comments.find((c) => c.id === params.comment_id)
        if (!existing) throw new Error(`no comment ${params.comment_id}`)
        existing.body = params.body
        return { data: { id: existing.id } }
      },
    },
  }

  return { api, comments, calls }
}

const params = { owner: 'tyk', repo: 'demo', issueNumber: 7 }

describe('marker constants', () => {
  it('match the shared literal values', () => {
    expect(STICKY_COMMENT_MARKER).toBe('<!-- mcp-doctor:sticky -->')
    expect(REVIEW_COMMENT_MARKER).toBe('<!-- mcp-doctor:review -->')
  })
})

describe('isTrustedCommentAuthor', () => {
  it('accepts any [bot] login, the expected author, and a missing user', () => {
    expect(isTrustedCommentAuthor({ login: 'github-actions[bot]' }, 'github-actions[bot]')).toBe(
      true,
    )
    expect(isTrustedCommentAuthor({ login: 'my-app[bot]' }, 'github-actions[bot]')).toBe(true)
    expect(isTrustedCommentAuthor({ login: 'my-ci-user' }, 'my-ci-user')).toBe(true)
    expect(isTrustedCommentAuthor(undefined, 'github-actions[bot]')).toBe(true)
    expect(isTrustedCommentAuthor(null, 'github-actions[bot]')).toBe(true)
  })

  it('rejects ordinary user logins', () => {
    expect(isTrustedCommentAuthor({ login: 'evil-user' }, 'github-actions[bot]')).toBe(false)
  })
})

describe('upsertStickyComment', () => {
  it('creates a comment when no marked comment exists', async () => {
    const { api, comments, calls } = makeFakeApi([{ id: 1, body: 'hello from a human' }])
    const body = `${STICKY_COMMENT_MARKER}\nfirst report`

    const result = await upsertStickyComment(api, { ...params, body })

    expect(result.created).toBe(true)
    expect(calls.create).toBe(1)
    expect(calls.update).toBe(0)
    expect(comments).toHaveLength(2)
    expect(comments.find((c) => c.id === result.id)?.body).toBe(body)
  })

  it('updates the marked comment in place when present', async () => {
    const { api, comments, calls } = makeFakeApi([
      { id: 1, body: 'unrelated' },
      { id: 2, body: `${STICKY_COMMENT_MARKER}\nold report` },
    ])
    const body = `${STICKY_COMMENT_MARKER}\nnew report`

    const result = await upsertStickyComment(api, { ...params, body })

    expect(result).toEqual({ id: 2, created: false })
    expect(calls.create).toBe(0)
    expect(calls.update).toBe(1)
    expect(comments).toHaveLength(2)
    expect(comments[1]?.body).toBe(body)
  })

  it('finds the marked comment beyond the first page', async () => {
    const filler: FakeComment[] = Array.from({ length: 100 }, (_, i) => ({
      id: i + 1,
      body: `noise ${i}`,
    }))
    const { api, calls } = makeFakeApi([
      ...filler,
      { id: 101, body: `${STICKY_COMMENT_MARKER}\npage-two report` },
    ])
    const body = `${STICKY_COMMENT_MARKER}\nupdated`

    const result = await upsertStickyComment(api, { ...params, body })

    expect(result).toEqual({ id: 101, created: false })
    expect(calls.list).toBeGreaterThanOrEqual(2)
    expect(calls.create).toBe(0)
    expect(calls.update).toBe(1)
  })

  it('ignores comments that merely mention the marker mid-body', async () => {
    const { api, calls } = makeFakeApi([
      { id: 1, body: `quoting ${STICKY_COMMENT_MARKER} in a discussion` },
      { id: 2 }, // body absent entirely
    ])
    const body = `${STICKY_COMMENT_MARKER}\nfresh`

    const result = await upsertStickyComment(api, { ...params, body })

    expect(result.created).toBe(true)
    expect(calls.update).toBe(0)
    expect(calls.create).toBe(1)
  })

  it('does not update a marker-spoofing comment from a non-bot user', async () => {
    const { api, comments, calls } = makeFakeApi([
      { id: 1, body: `${STICKY_COMMENT_MARKER}\nspoofed`, user: { login: 'evil-user' } },
    ])
    const body = `${STICKY_COMMENT_MARKER}\nreal report`

    const result = await upsertStickyComment(api, { ...params, body })

    expect(result.created).toBe(true)
    expect(calls.update).toBe(0)
    expect(comments.find((c) => c.id === 1)?.body).toContain('spoofed')
  })

  it('updates a comment owned by a custom expectedAuthor', async () => {
    const { api, calls } = makeFakeApi([
      { id: 2, body: `${STICKY_COMMENT_MARKER}\nold`, user: { login: 'my-ci-user' } },
    ])
    const body = `${STICKY_COMMENT_MARKER}\nnew`

    const result = await upsertStickyComment(api, {
      ...params,
      body,
      expectedAuthor: 'my-ci-user',
    })

    expect(result).toEqual({ id: 2, created: false })
    expect(calls.update).toBe(1)
  })

  it('rejects a body that does not start with the marker', async () => {
    const { api, calls } = makeFakeApi([])

    await expect(upsertStickyComment(api, { ...params, body: 'no marker here' })).rejects.toThrow(
      /marker/i,
    )
    expect(calls.create).toBe(0)
    expect(calls.update).toBe(0)
  })
})
