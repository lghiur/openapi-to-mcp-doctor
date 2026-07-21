import { CheckCircle2, CircleAlert, CircleDashed, TriangleAlert } from 'lucide-react'
import type { Severity } from '@/types/domain'
import type { AnalysisState } from '@/features/analyze/state'

export type OpStatus = 'error' | 'warning' | 'clean' | 'analysing' | 'pending'

export interface OperationRow {
  operation: string
  status: OpStatus
  findings: number
}

const RANK: Record<Severity, number> = { error: 3, warning: 2, info: 1 }

/**
 * Derive the operations rail from stream state. Every operation known up front
 * (from analysis_started) is seeded as `pending`, so the panel shows the full
 * "X of N" denominator from the start; worker assignments and findings then
 * upgrade each row's status as work progresses.
 *
 * Resolution depends on the pipeline: when AI workers are planned, an op is only
 * "done" once its worker completes (structural finishing early must not clean it);
 * in structural-only mode the linter covers every op at once, so the structural
 * phase finishing resolves them all. Sorted by findings count, then alphabetically.
 */
export function buildOperationRows(state: AnalysisState): OperationRow[] {
  const map = new Map<string, { worst: number; count: number; done: boolean; started: boolean }>()

  const ensure = (op: string) => {
    const existing = map.get(op)
    if (existing) return existing
    const fresh = { worst: 0, count: 0, done: false, started: false }
    map.set(op, fresh)
    return fresh
  }

  // Seed the full operation set so the denominator is known before any findings.
  for (const op of state.operations) ensure(op)

  for (const agent of state.agents) {
    for (const op of agent.operations) {
      const row = ensure(op)
      row.started = true
      if (agent.done) row.done = true
    }
  }
  for (const finding of state.findings) {
    if (!finding.operation) continue
    const row = ensure(finding.operation)
    row.count += 1
    row.worst = Math.max(row.worst, RANK[finding.severity])
  }

  const hasWorkers = state.plannedPhases.includes('workers')
  const structuralActive = state.phaseStatus.structural === 'active'
  const structuralDone = state.phaseStatus.structural === 'done'

  const rows: OperationRow[] = [...map.entries()].map(([operation, r]) => {
    // An op is resolved by its worker (AI mode) or by the structural pass
    // (structural-only mode); a completed run resolves everything left over.
    const resolved = (hasWorkers ? r.done : structuralDone) || state.complete
    const active = hasWorkers ? r.started && !r.done : structuralActive
    const status: OpStatus =
      r.worst === 3
        ? 'error'
        : r.worst === 2
          ? 'warning'
          : resolved
            ? 'clean'
            : active
              ? 'analysing'
              : 'pending'
    return { operation, findings: r.count, status }
  })

  return rows.sort((a, b) => b.findings - a.findings || a.operation.localeCompare(b.operation))
}

const ICON = {
  error: { Icon: CircleAlert, cls: 'text-error' },
  warning: { Icon: TriangleAlert, cls: 'text-warning' },
  clean: { Icon: CheckCircle2, cls: 'text-success' },
  analysing: { Icon: CircleDashed, cls: 'text-primary animate-spin' },
  pending: { Icon: CircleDashed, cls: 'text-muted-foreground/50' },
} as const

export function OpStatusIcon({ status }: { status: OpStatus }) {
  const { Icon, cls } = ICON[status]
  return <Icon className={`size-3.5 ${cls}`} aria-hidden="true" />
}
