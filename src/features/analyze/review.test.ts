import { describe, expect, it } from 'vitest'
import {
  acceptedIds,
  finalContent,
  initialReviewState,
  reviewCounts,
  reviewReducer,
} from './review'
import type { SSEFinding } from '@/types/domain'

function finding(id: string, suggested?: string): SSEFinding {
  return {
    id,
    agentId: 'worker-1',
    rule: 'MCP_NO_WHEN_TO_USE',
    severity: 'warning',
    confidence: 'MEDIUM',
    message: 'x',
    autoFixable: true,
    ...(suggested !== undefined ? { suggested } : {}),
  }
}

describe('reviewReducer', () => {
  it('starts with every suggestion pending', () => {
    const counts = reviewCounts(initialReviewState, ['a', 'b', 'c'])
    expect(counts).toEqual({ accepted: 0, rejected: 0, pending: 3 })
  })

  it('accepts a single suggestion', () => {
    const state = reviewReducer(initialReviewState, { type: 'accept', id: 'a' })
    expect(reviewCounts(state, ['a', 'b'])).toEqual({ accepted: 1, rejected: 0, pending: 1 })
    expect(acceptedIds(state)).toEqual(['a'])
  })

  it('rejecting an accepted suggestion flips it', () => {
    let state = reviewReducer(initialReviewState, { type: 'accept', id: 'a' })
    state = reviewReducer(state, { type: 'reject', id: 'a' })
    expect(reviewCounts(state, ['a'])).toEqual({ accepted: 0, rejected: 1, pending: 0 })
    expect(acceptedIds(state)).toEqual([])
  })

  it('editing implies acceptance and stores the edited content', () => {
    const state = reviewReducer(initialReviewState, {
      type: 'edit',
      id: 'a',
      content: 'my better description',
    })
    expect(acceptedIds(state)).toEqual(['a'])
    expect(finalContent(state, finding('a', 'ai text'))).toBe('my better description')
  })

  it('falls back to the suggested text when not edited', () => {
    const state = reviewReducer(initialReviewState, { type: 'accept', id: 'a' })
    expect(finalContent(state, finding('a', 'ai text'))).toBe('ai text')
  })

  it('accept_all marks every provided id accepted', () => {
    const state = reviewReducer(initialReviewState, { type: 'accept_all', ids: ['a', 'b', 'c'] })
    expect(reviewCounts(state, ['a', 'b', 'c'])).toEqual({ accepted: 3, rejected: 0, pending: 0 })
  })

  it('reject_all marks every provided id rejected', () => {
    const state = reviewReducer(initialReviewState, { type: 'reject_all', ids: ['a', 'b'] })
    expect(reviewCounts(state, ['a', 'b'])).toEqual({ accepted: 0, rejected: 2, pending: 0 })
  })
})
