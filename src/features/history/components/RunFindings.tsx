'use client'

import { useMemo, useState } from 'react'
import { ConfidenceBadge, OwaspBadge, SeverityBadge } from '@/components/ui/severity'
import { cn } from '@/lib/utils'
import type { Confidence, Resolution, Severity } from '@/types/domain'

export interface FindingRowData {
  id: string
  operation: string
  rule: string
  owasp?: string
  severity: Severity
  confidence: Confidence
  before: string
  after: string
  resolution: Resolution
}

type Tab = 'all' | 'accepted' | 'rejected' | 'pending'

const RESOLUTION_LABEL: Record<Resolution, string> = {
  accepted: 'accepted',
  rejected: 'rejected',
  edited: 'accepted · edited',
  'auto-fixed': 'auto-fixed',
  pending: 'pending',
}

function matchesTab(resolution: Resolution, tab: Tab): boolean {
  if (tab === 'all') return true
  if (tab === 'accepted') return resolution === 'accepted' || resolution === 'edited' || resolution === 'auto-fixed'
  if (tab === 'rejected') return resolution === 'rejected'
  return resolution === 'pending'
}

export function RunFindings({ findings }: { findings: FindingRowData[] }) {
  const [tab, setTab] = useState<Tab>('all')
  const [openId, setOpenId] = useState<string | null>(null)

  const tabs = useMemo(() => {
    const count = (t: Tab) => findings.filter((f) => matchesTab(f.resolution, t)).length
    return [
      { value: 'all' as const, label: 'All', n: findings.length },
      { value: 'accepted' as const, label: 'Accepted', n: count('accepted') },
      { value: 'rejected' as const, label: 'Rejected', n: count('rejected') },
      { value: 'pending' as const, label: 'Pending', n: count('pending') },
    ]
  }, [findings])

  const visible = findings.filter((f) => matchesTab(f.resolution, tab))

  return (
    <div className="overflow-hidden rounded-xl border border-border bg-card">
      <div className="flex gap-1 border-b border-border p-1.5">
        {tabs.map((t) => (
          <button
            key={t.value}
            type="button"
            onClick={() => setTab(t.value)}
            className={cn(
              'rounded-lg px-3 py-1.5 text-sm font-medium transition-colors',
              tab === t.value
                ? 'bg-accent text-accent-foreground'
                : 'text-muted-foreground hover:text-foreground',
            )}
          >
            {t.label}
            <span className="tnum ml-1.5 text-xs text-muted-foreground">{t.n}</span>
          </button>
        ))}
      </div>

      <div className="divide-y divide-border">
        {visible.length === 0 && (
          <p className="px-4 py-8 text-center text-sm text-muted-foreground">
            No findings in this tab.
          </p>
        )}
        {visible.map((f) => {
          const open = openId === f.id
          return (
            <div key={f.id}>
              <button
                type="button"
                onClick={() => setOpenId(open ? null : f.id)}
                className="flex w-full items-center gap-3 px-4 py-3 text-left transition-colors hover:bg-accent/40"
              >
                <SeverityBadge severity={f.severity} />
                <div className="min-w-0 flex-1">
                  <p className="truncate font-mono text-xs font-medium">{f.operation}</p>
                  <p className="truncate font-mono text-[11px] text-muted-foreground">{f.rule}</p>
                </div>
                {f.owasp && <OwaspBadge owasp={f.owasp} />}
                <ConfidenceBadge confidence={f.confidence} />
                <span className="hidden text-xs text-muted-foreground sm:inline">
                  {RESOLUTION_LABEL[f.resolution]}
                </span>
              </button>
              {open && (f.before || f.after) && (
                <div className="space-y-2 bg-surface-1/40 px-4 py-3">
                  {f.before && (
                    <pre className="overflow-x-auto whitespace-pre-wrap rounded-lg border border-error/20 bg-error/5 px-3 py-2 font-mono text-xs">
                      − {f.before}
                    </pre>
                  )}
                  {f.after && (
                    <pre className="overflow-x-auto whitespace-pre-wrap rounded-lg border border-success/20 bg-success/5 px-3 py-2 font-mono text-xs">
                      + {f.after}
                    </pre>
                  )}
                </div>
              )}
            </div>
          )
        })}
      </div>
    </div>
  )
}
