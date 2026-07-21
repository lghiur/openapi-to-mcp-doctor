import { computeHealthScore } from '@/lib/engine/health'
import type { StructuralSummary } from '@/lib/engine/summary'
import type { Finding, Severity } from '@/types/domain'

export interface OperationReportRow {
  operation: string
  errors: number
  warnings: number
  info: number
  total: number
}

export interface ReportModel {
  /** MCP readiness score, 0–100. */
  score: number
  summary: StructuralSummary
  /** Per-operation breakdown (operations with at least one finding), worst first. */
  operations: OperationReportRow[]
  /** All findings, error-first. */
  findings: Finding[]
}

const RANK: Record<Severity, number> = { error: 3, warning: 2, info: 1 }

/** Derive the report view-model from an analysis result (summary + findings). */
export function buildReportModel(input: {
  summary: StructuralSummary
  findings: Finding[]
}): ReportModel {
  const score = computeHealthScore({
    errors: input.summary.errors,
    warnings: input.summary.warnings,
    info: input.summary.info,
  })

  const byOperation = new Map<string, OperationReportRow>()
  for (const finding of input.findings) {
    if (!finding.operation) continue
    const row = byOperation.get(finding.operation) ?? {
      operation: finding.operation,
      errors: 0,
      warnings: 0,
      info: 0,
      total: 0,
    }
    if (finding.severity === 'error') row.errors += 1
    else if (finding.severity === 'warning') row.warnings += 1
    else row.info += 1
    row.total += 1
    byOperation.set(finding.operation, row)
  }

  const operations = [...byOperation.values()].sort(
    (a, b) => b.errors - a.errors || b.total - a.total || a.operation.localeCompare(b.operation),
  )
  const findings = [...input.findings].sort((a, b) => RANK[b.severity] - RANK[a.severity])

  return { score, summary: input.summary, operations, findings }
}
