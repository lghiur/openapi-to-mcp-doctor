import { ConfidenceBadge, OwaspBadge, SeverityBadge } from '@/components/ui/severity'
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
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          {finding.operation && (
            <p className="truncate font-mono text-xs font-medium text-foreground">
              {finding.operation}
            </p>
          )}
          <p className="mt-0.5 font-mono text-[11px] text-muted-foreground">{finding.rule}</p>
        </div>
        <div className="flex shrink-0 flex-wrap items-center justify-end gap-1.5">
          {finding.owasp && <OwaspBadge owasp={finding.owasp} />}
          <SeverityBadge severity={finding.severity} />
          <ConfidenceBadge confidence={finding.confidence} />
        </div>
      </div>

      <p className="mt-2.5 text-sm text-foreground/90">{finding.message}</p>

      {finding.current !== undefined && (
        <pre className="mt-2.5 overflow-x-auto whitespace-pre-wrap rounded-lg border border-border bg-surface-1/60 px-3 py-2 font-mono text-xs">
          {finding.current}
        </pre>
      )}
    </div>
  )
}
