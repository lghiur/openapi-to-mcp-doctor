import type { AnalysisReport, ReportFinding } from '@/types/api'
import { mdCell } from '../gh/orchestrate'
import {
  STICKY_COMMENT_MARKER,
  type Behavior,
  type DirectionResult,
  type ReportDelta,
} from '../gh/types'

const MAX_TABLE_ROWS = 20

const SEVERITY_EMOJI: Record<ReportFinding['severity'], string> = {
  error: '🔴',
  warning: '🟡',
  info: '🔵',
}

const DIRECTION_NARRATIVE: Record<DirectionResult['strategy'], string> = {
  'lint-only': 'No spec or route changes — structural lint only.',
  'code-drift': 'Route files changed — checked the spec for missing endpoints.',
  'spec-verify': 'Spec changed — verified it against the handler code.',
  full: 'Spec and route files both changed — ran the full spec/code check.',
}

export interface StickyCommentParams {
  delta: ReportDelta
  direction: DirectionResult
  report: AnalysisReport
  behavior: Behavior
  fixPr?: { url: string; number: number }
  /**
   * Fixes actually applied by the fix-mode scan (what the fix PR carries).
   * The lint report's `summary.autoFixed` is always 0 in lint mode, so the
   * caller must thread this from the fix pass.
   */
  appliedFixCount?: number
  /** Review comments that could not be placed on a diff line. */
  skippedInline?: number
  jobSummaryUrl?: string
  /**
   * What the fix PR covers: 'pr' = only operations with findings introduced by
   * this PR (the default), 'full' = the whole spec's debt. Omitted = no clause.
   */
  fixScope?: 'pr' | 'full'
}

/** `72 → 68 ▼`, or empty when either side of the delta is missing. */
function healthDelta(delta: ReportDelta): string {
  const { healthBase: base, healthHead: head } = delta
  if (base === undefined || head === undefined) return ''
  const arrow = head < base ? '▼' : head > base ? '▲' : '='
  return `${base} → ${head} ${arrow}`
}

// Markdown table cells go through mdCell (one line, pipe-safe, @-mention-safe)
// — untrusted spec/LLM text must never break the table or ping users.
const cell = mdCell

function findingsTable(newFindings: ReportFinding[]): string {
  if (newFindings.length === 0) return 'No new findings introduced by this PR. ✨'
  const rows = newFindings
    .slice(0, MAX_TABLE_ROWS)
    .map(
      (f) =>
        `| ${SEVERITY_EMOJI[f.severity]} | \`${cell(f.rule)}\` | ${f.operation ? `\`${cell(f.operation)}\`` : '—'} | ${cell(f.message)} |`,
    )
  const overflow = newFindings.length - MAX_TABLE_ROWS
  const table = `|   | Rule | Operation | Message |
| - | ---- | --------- | ------- |
${rows.join('\n')}`
  return overflow > 0 ? `${table}\n\n_+${overflow} more — see the Job Summary._` : table
}

/** Render the marker-identified sticky PR comment (updated in place on each push). */
export function renderStickyComment(params: StickyCommentParams): string {
  const { delta, direction, report, fixPr, appliedFixCount, skippedInline, jobSummaryUrl, fixScope } =
    params

  const health = healthDelta(delta)
  const header = health ? `## MCP Doctor — ${health}` : '## MCP Doctor'

  const sections: string[] = [
    header,
    DIRECTION_NARRATIVE[direction.strategy],
    '### New in this PR',
    findingsTable(delta.newFindings),
  ]

  if (delta.resolvedFindings.length > 0) {
    const n = delta.resolvedFindings.length
    sections.push(`✅ ${n} ${n === 1 ? 'finding' : 'findings'} resolved by this PR.`)
  }

  if (fixPr) {
    const n = appliedFixCount ?? report.summary.autoFixed
    const scope =
      fixScope === 'pr' ? " (scoped to this PR's changes)" : fixScope === 'full' ? ' (whole spec)' : ''
    sections.push(
      `> 🔧 **${n} ${n === 1 ? 'fix' : 'fixes'} ready**${scope} — merge [#${fixPr.number}](${fixPr.url}) into your branch to apply them.`,
    )
  }

  if (skippedInline !== undefined && skippedInline > 0) {
    sections.push(
      `_${skippedInline} ${skippedInline === 1 ? 'finding' : 'findings'} could not be placed inline; see the Job Summary._`,
    )
  }

  const summaryLink = jobSummaryUrl ? `[Job Summary](${jobSummaryUrl})` : 'Job Summary'
  const { total, errors, warnings, info } = report.summary
  sections.push(
    `<details>
<summary>Pre-existing on this branch: ${total} total</summary>

${errors} errors · ${warnings} warnings · ${info} info — full report in the ${summaryLink}.

</details>`,
  )

  return `${STICKY_COMMENT_MARKER}\n${sections.join('\n\n')}\n`
}
