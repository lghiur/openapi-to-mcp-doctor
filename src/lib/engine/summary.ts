import type { Finding, Severity } from '@/types/domain'

export interface StructuralSummary {
  total: number
  errors: number
  warnings: number
  info: number
}

export function summarizeFindings(findings: readonly Finding[]): StructuralSummary {
  const summary: StructuralSummary = { total: findings.length, errors: 0, warnings: 0, info: 0 }
  for (const finding of findings) {
    summary[severityBucket(finding.severity)] += 1
  }
  return summary
}

function severityBucket(severity: Severity): 'errors' | 'warnings' | 'info' {
  if (severity === 'error') return 'errors'
  if (severity === 'warning') return 'warnings'
  return 'info'
}
