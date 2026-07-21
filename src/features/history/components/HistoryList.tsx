'use client'

import { ArrowUpRight, ExternalLink, Search } from 'lucide-react'
import Link from 'next/link'
import { useMemo, useState } from 'react'
import { HealthRing } from '@/components/ui/health-ring'
import { Input } from '@/components/ui/input'
import { cn } from '@/lib/utils'

export interface HistoryRow {
  id: string
  repo: string | null
  specFile: string
  createdAt: string
  errors: number
  warnings: number
  total: number
  score: number
  prUrl: string | null
}

type Filter = 'all' | 'clean' | 'issues'

const FILTERS: { value: Filter; label: string }[] = [
  { value: 'all', label: 'All' },
  { value: 'issues', label: 'Has issues' },
  { value: 'clean', label: 'Clean' },
]

export function HistoryList({ runs }: { runs: HistoryRow[] }) {
  const [query, setQuery] = useState('')
  const [filter, setFilter] = useState<Filter>('all')

  const filtered = useMemo(
    () =>
      runs.filter((r) => {
        const haystack = `${r.repo ?? ''} ${r.specFile}`.toLowerCase()
        if (!haystack.includes(query.toLowerCase())) return false
        if (filter === 'clean') return r.errors === 0 && r.warnings === 0
        if (filter === 'issues') return r.errors > 0 || r.warnings > 0
        return true
      }),
    [runs, query, filter],
  )

  return (
    <div className="space-y-4">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
        <div className="relative flex-1">
          <Search className="absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search by repo or spec…"
            className="h-10 pl-9"
          />
        </div>
        <div className="inline-flex rounded-lg border border-border bg-card p-0.5">
          {FILTERS.map((f) => (
            <button
              key={f.value}
              type="button"
              onClick={() => setFilter(f.value)}
              className={cn(
                'rounded-md px-3 py-1.5 text-sm font-medium transition-colors',
                filter === f.value
                  ? 'bg-primary text-primary-foreground'
                  : 'text-muted-foreground hover:text-foreground',
              )}
            >
              {f.label}
            </button>
          ))}
        </div>
      </div>

      {filtered.length === 0 ? (
        <p className="rounded-xl border border-dashed border-border px-4 py-10 text-center text-sm text-muted-foreground">
          No runs match your filters.
        </p>
      ) : (
        <div className="space-y-2.5">
          {filtered.map((run) => (
            <Link
              key={run.id}
              href={`/history/${run.id}`}
              className="group flex items-center gap-4 rounded-xl border border-border bg-card p-4 transition-colors hover:border-primary/40"
            >
              <HealthRing score={run.score} size={56} stroke={5} />
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <p className="truncate text-sm font-semibold">{run.repo ?? 'Pasted spec'}</p>
                  {run.prUrl && (
                    <span className="inline-flex items-center gap-1 rounded-full bg-primary/12 px-2 py-0.5 text-[11px] font-medium text-primary">
                      <ExternalLink className="size-3" />
                      PR
                    </span>
                  )}
                </div>
                <p className="mt-0.5 truncate font-mono text-xs text-muted-foreground">
                  {run.specFile} · {run.createdAt}
                </p>
                <p className="tnum mt-1.5 flex gap-3 text-xs">
                  <span className={run.errors > 0 ? 'text-error' : 'text-muted-foreground'}>
                    {run.errors} errors
                  </span>
                  <span className={run.warnings > 0 ? 'text-warning' : 'text-muted-foreground'}>
                    {run.warnings} warnings
                  </span>
                  <span className="text-muted-foreground">{run.total} total</span>
                </p>
              </div>
              <ArrowUpRight className="size-4 shrink-0 text-muted-foreground transition-transform group-hover:-translate-y-0.5 group-hover:translate-x-0.5" />
            </Link>
          ))}
        </div>
      )}
    </div>
  )
}
