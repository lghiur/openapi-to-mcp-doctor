import type { SSEFinding } from '@/types/domain'

/** A user's decision on a single suggestion. */
export type Decision = 'accepted' | 'rejected' | 'pending'

export interface ReviewItem {
  decision: Decision
  /** Present when the user edited the suggested text before accepting. */
  editedContent?: string
}

export interface ReviewState {
  /** Keyed by finding id. Absent ids are implicitly pending. */
  items: Record<string, ReviewItem>
}

export const initialReviewState: ReviewState = { items: {} }

export type ReviewAction =
  | { type: 'accept'; id: string }
  | { type: 'reject'; id: string }
  | { type: 'edit'; id: string; content: string }
  | { type: 'reset'; id: string }
  | { type: 'accept_all'; ids: string[] }
  | { type: 'reject_all'; ids: string[] }

function set(state: ReviewState, id: string, item: ReviewItem): ReviewState {
  return { items: { ...state.items, [id]: item } }
}

/** Fold a review action into immutable review state. */
export function reviewReducer(state: ReviewState, action: ReviewAction): ReviewState {
  switch (action.type) {
    case 'accept':
      return set(state, action.id, {
        decision: 'accepted',
        ...(state.items[action.id]?.editedContent !== undefined
          ? { editedContent: state.items[action.id]?.editedContent }
          : {}),
      })
    case 'reject':
      return set(state, action.id, { decision: 'rejected' })
    case 'edit':
      return set(state, action.id, { decision: 'accepted', editedContent: action.content })
    case 'reset':
      return set(state, action.id, { decision: 'pending' })
    case 'accept_all':
      return {
        items: {
          ...state.items,
          ...Object.fromEntries(
            action.ids.map((id) => [
              id,
              {
                decision: 'accepted' as const,
                ...(state.items[id]?.editedContent !== undefined
                  ? { editedContent: state.items[id]?.editedContent }
                  : {}),
              },
            ]),
          ),
        },
      }
    case 'reject_all':
      return {
        items: {
          ...state.items,
          ...Object.fromEntries(action.ids.map((id) => [id, { decision: 'rejected' as const }])),
        },
      }
    default:
      return state
  }
}

export function decisionOf(state: ReviewState, id: string): Decision {
  return state.items[id]?.decision ?? 'pending'
}

export interface ReviewCounts {
  accepted: number
  rejected: number
  pending: number
}

/** Tally decisions across a known set of suggestion ids. */
export function reviewCounts(state: ReviewState, ids: string[]): ReviewCounts {
  const counts: ReviewCounts = { accepted: 0, rejected: 0, pending: 0 }
  for (const id of ids) counts[decisionOf(state, id)] += 1
  return counts
}

/** Ids the user has accepted (used to build the patched spec). */
export function acceptedIds(state: ReviewState): string[] {
  return Object.entries(state.items)
    .filter(([, item]) => item.decision === 'accepted')
    .map(([id]) => id)
}

/** The content that would be applied: the user's edit if present, else the AI suggestion. */
export function finalContent(state: ReviewState, finding: SSEFinding): string | undefined {
  return state.items[finding.id]?.editedContent ?? finding.suggested
}
