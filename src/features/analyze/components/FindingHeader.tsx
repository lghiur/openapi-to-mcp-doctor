import { ConfidenceBadge, OwaspBadge, SeverityBadge } from '@/components/ui/severity'
import type { SSEFinding } from '@/types/domain'

/**
 * Shared top row of a finding card: which operation and rule it came from, and
 * the severity/confidence/OWASP badges. Identical for actionable suggestions and
 * read-only diagnostics, so the two card types stay visually in step.
 */
export function FindingHeader({ finding }: { finding: SSEFinding }) {
  return (
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
  )
}
