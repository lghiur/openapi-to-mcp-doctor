import { computeHealthScore } from '@/lib/engine/health'
import type { AnalysisReport, ReportFinding } from '@/types/api'
import type { ReportDelta } from './types'

/**
 * Stable identity for a finding across runs: rule + operation + spec path,
 * NUL-separated so fields can never collide. Deliberately excludes `message`
 * (LLM wording varies between runs) and `id`/`agentId` (run-scoped).
 * Exported: review-comment marker keys are derived from it (orchestrate.ts).
 */
export function findingKey(finding: ReportFinding): string {
  return [finding.rule, finding.operation ?? '', JSON.stringify(finding.path ?? [])].join('\u0000')
}

/**
 * Diff the base-branch report against the head-branch report. PR-visible
 * output is gated to `newFindings`; `resolvedFindings` feed the "fixed on
 * this branch" summary line. `base` is undefined when the base branch has
 * no report (first run) — every head finding is then new.
 */
export function diffReports(base: AnalysisReport | undefined, head: AnalysisReport): ReportDelta {
  const baseKeys = new Set((base?.findings ?? []).map(findingKey))
  const headKeys = new Set(head.findings.map(findingKey))

  return {
    newFindings: head.findings.filter((f) => !baseKeys.has(findingKey(f))),
    resolvedFindings: (base?.findings ?? []).filter((f) => !headKeys.has(findingKey(f))),
    healthBase: base ? computeHealthScore(base.summary) : undefined,
    healthHead: computeHealthScore(head.summary),
  }
}
