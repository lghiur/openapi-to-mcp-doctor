import type { ReportFinding } from '@/types/api'

/**
 * Shared contracts for GitHub Action PR mode (`docs/ideas/github-action-pr-mode.md`).
 * The behavior ladder is cumulative: each level does everything below it.
 */
export type Behavior = 'summary' | 'comment' | 'review' | 'fix-pr'

export const BEHAVIORS: readonly Behavior[] = ['summary', 'comment', 'review', 'fix-pr']

/** PR facts parsed from the Actions event payload + env. */
export interface PrContext {
  eventName: string
  /** Event action, e.g. 'opened' | 'synchronize' | 'closed'. */
  eventAction?: string
  owner: string
  repo: string
  prNumber: number
  /** Head branch name (source branch of the PR). */
  headRef: string
  headSha: string
  /** Base branch the PR targets (master, release-1.x, …). */
  baseRef: string
  /** True when the head repo differs from the base repo. */
  isFork: boolean
  /** True when the source PR was merged (only meaningful on 'closed'). */
  merged?: boolean
}

/** What the PR touched → which scan strategy to run. */
export interface DirectionResult {
  specChanged: boolean
  routesChanged: boolean
  /**
   * lint-only  → neither spec nor route files changed: structural lint, no LLM
   * code-drift → route files changed: run undocumented-endpoint discovery
   * spec-verify→ spec changed: verify spec against handlers (mismatch checks)
   * full       → both changed
   */
  strategy: 'lint-only' | 'code-drift' | 'spec-verify' | 'full'
  changedFiles: string[]
}

/** Base-vs-head report diff. PR-visible output is gated to `newFindings`. */
export interface ReportDelta {
  newFindings: ReportFinding[]
  resolvedFindings: ReportFinding[]
  /** computeHealthScore of the base / head runs (0–100). */
  healthBase?: number
  healthHead?: number
}

/** A finding resolved to a concrete file + line for annotations / review comments. */
export interface LocatedFinding {
  finding: ReportFinding
  file: string
  /** 1-based line; absent when the path could not be resolved. */
  line?: number
  /** Which side of the drift the location points at. */
  target: 'spec' | 'handler'
}

// Canonical definitions live in src/lib/github (src/lib must never import from
// cli/, so the constants are defined there and re-exported here).
export { REVIEW_COMMENT_MARKER, STICKY_COMMENT_MARKER } from '@/lib/github/comments'
export { fixBranchName } from '@/lib/github/stacked-pr'
