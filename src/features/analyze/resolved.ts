import type { SSEFinding } from '@/types/domain'

/** Ids of error-severity findings — the target set for "mark all errors solved". */
export function errorFindingIds(findings: SSEFinding[]): string[] {
  return findings.filter((finding) => finding.severity === 'error').map((finding) => finding.id)
}

/** Split findings into still-active and user-resolved, preserving input order. */
export function partitionResolved(
  findings: SSEFinding[],
  resolved: ReadonlySet<string>,
): { active: SSEFinding[]; resolved: SSEFinding[] } {
  const active: SSEFinding[] = []
  const done: SSEFinding[] = []
  for (const finding of findings) {
    if (resolved.has(finding.id)) done.push(finding)
    else active.push(finding)
  }
  return { active, resolved: done }
}
