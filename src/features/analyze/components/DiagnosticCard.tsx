import { FindingHeader } from '@/features/analyze/components/FindingHeader'
import type { SSEFinding } from '@/types/domain'

/**
 * A read-only finding with no auto-generated fix (e.g. structural-linter
 * diagnostics in anonymous/structural-only mode). Shows what's wrong and where,
 * but offers no Accept/Edit/Reject — there is nothing to apply.
 */
export function DiagnosticCard({ finding }: { finding: SSEFinding }) {
  return (
    <div
      id={`finding-${finding.id}`}
      className="animate-rise rounded-xl border border-border bg-card p-4 shadow-sm"
    >
      <FindingHeader finding={finding} />

      <p className="mt-2.5 text-sm text-foreground/90">{finding.message}</p>

      {finding.current !== undefined && (
        <pre className="mt-2.5 overflow-x-auto whitespace-pre-wrap rounded-lg border border-border bg-surface-1/60 px-3 py-2 font-mono text-xs">
          {finding.current}
        </pre>
      )}
    </div>
  )
}
