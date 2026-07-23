'use client'

import { CheckCircle2, ChevronRight, FileCode2, TriangleAlert } from 'lucide-react'
import { useMemo } from 'react'
import { Spinner } from '@/components/ui/spinner'
import { cn } from '@/lib/utils'
import { Empty } from '@/features/analyze/components/Panel'
import type { AgentActivity as AgentRow, AnalysisState, FileReadActivity } from '@/features/analyze/state'

/**
 * One-line evidence of a grounding read: where in the file the agent looked,
 * why (route registration vs the handler it followed), and how much it read.
 */
export function fileEvidence(file: FileReadActivity): string {
  const location = file.line !== undefined ? `${file.path}:${file.line}` : file.path
  const parts: string[] = []
  if (file.role === 'handler') parts.push(`handler ${file.symbol ?? ''}`.trimEnd())
  else if (file.role === 'registration') parts.push('route registration')
  if (file.linesRead !== undefined) parts.push(`${file.linesRead} lines`)
  return parts.length > 0 ? `${location} · ${parts.join(' · ')}` : location
}

/** Right-hand summary of an agent row: failure reason, or findings + duration. */
function agentSummary(agent: AgentRow): string {
  if (!agent.done) return 'running…'
  if (agent.error !== undefined) return `failed — ${agent.error}`
  return `${agent.findingsCount ?? 0} findings · ${((agent.durationMs ?? 0) / 1000).toFixed(1)}s`
}

function AgentStatusIcon({ agent }: { agent: AgentRow }) {
  if (!agent.done) return <Spinner className="size-3.5 shrink-0 text-primary" />
  if (agent.error !== undefined)
    return <TriangleAlert className="size-3.5 shrink-0 text-destructive" />
  return <CheckCircle2 className="size-3.5 shrink-0 text-success" />
}

interface AgentActivityPanelProps {
  state: AnalysisState
  /** Live elapsed time (or the final duration once complete), pre-formatted. */
  elapsed: string
  /** Jump the findings list to the first finding for an operation. */
  onSelectOperation: (operation: string) => void
}

/**
 * The middle panel: what each agent is doing, which operations it examined, and
 * which handler files it read for code grounding. This is the tool's "show your
 * work" surface — every claim in the findings panel should be traceable here.
 */
export function AgentActivityPanel({ state, elapsed, onSelectOperation }: AgentActivityPanelProps) {
  // Per-operation lookups so each agent row can expand to show what it examined.
  const findingCountByOp = useMemo(() => {
    const map = new Map<string, number>()
    for (const finding of state.findings) {
      if (finding.operation) map.set(finding.operation, (map.get(finding.operation) ?? 0) + 1)
    }
    return map
  }, [state.findings])

  const filesByOp = useMemo(() => {
    const map = new Map<string, FileReadActivity[]>()
    for (const file of state.filesRead) {
      if (!file.operation) continue
      const files = map.get(file.operation) ?? []
      if (!files.some((f) => f.path === file.path && f.role === file.role)) files.push(file)
      map.set(file.operation, files)
    }
    return map
  }, [state.filesRead])

  return (
    <>
      {state.complete && state.totals && (
        <div className="mb-3 rounded-lg border border-success/30 bg-success/8 p-3">
          <p className="flex items-center gap-1.5 text-xs font-semibold text-success">
            <CheckCircle2 className="size-3.5" />
            Analysis complete — {elapsed}
          </p>
          <p className="mt-1 tnum text-xs text-muted-foreground">
            {state.totals.total} findings · {state.totals.errors} errors · {state.totals.warnings}{' '}
            warnings · {state.totals.info} info
          </p>
        </div>
      )}
      {state.agents.length === 0 && <Empty>Spinning up agents…</Empty>}
      <div className="space-y-2">
        {state.agents.map((agent) => {
          const expandable = agent.operations.length > 0
          return (
            <details
              key={agent.agentId}
              className="group rounded-lg border border-border/70 bg-surface-1/50 [&_summary::-webkit-details-marker]:hidden"
            >
              <summary
                className={cn(
                  'flex items-center justify-between gap-2 p-2.5',
                  expandable ? 'cursor-pointer' : 'cursor-default',
                )}
              >
                <span className="flex min-w-0 items-center gap-1.5 font-mono text-xs">
                  {expandable && (
                    <ChevronRight className="size-3 shrink-0 text-muted-foreground transition-transform group-open:rotate-90" />
                  )}
                  <AgentStatusIcon agent={agent} />
                  <span className="truncate">{agent.agentId}</span>
                </span>
                <span
                  className={cn(
                    'tnum shrink-0 truncate text-[11px]',
                    agent.error !== undefined ? 'text-destructive' : 'text-muted-foreground',
                  )}
                  title={agent.error}
                >
                  {agentSummary(agent)}
                </span>
              </summary>
              {expandable && (
                <div className="space-y-1.5 border-t border-border/60 px-2.5 py-2">
                  <p className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
                    Examined {agent.operations.length} operation
                    {agent.operations.length === 1 ? '' : 's'}
                  </p>
                  {agent.operations.map((op) => (
                    <ExaminedOperation
                      key={op}
                      operation={op}
                      findings={findingCountByOp.get(op) ?? 0}
                      files={filesByOp.get(op) ?? []}
                      onSelect={onSelectOperation}
                    />
                  ))}
                </div>
              )}
            </details>
          )
        })}
        {state.filesRead.length > 0 && (
          <div className="rounded-lg border border-border/70 bg-surface-1/50 p-2.5">
            <p className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
              Code checked
            </p>
            {state.filesRead.map((file, i) => (
              <div key={`${file.path}-${i}`} className="flex items-baseline gap-1.5">
                <p className="truncate font-mono text-[11px]">{fileEvidence(file)}</p>
                {file.operation !== undefined && (
                  <p className="shrink-0 truncate font-mono text-[10px] text-muted-foreground">
                    {file.operation}
                  </p>
                )}
              </div>
            ))}
          </div>
        )}
      </div>
    </>
  )
}

function ExaminedOperation({
  operation,
  findings,
  files,
  onSelect,
}: {
  operation: string
  findings: number
  files: FileReadActivity[]
  onSelect: (operation: string) => void
}) {
  return (
    <div>
      <button
        type="button"
        onClick={() => onSelect(operation)}
        className="flex w-full items-center justify-between gap-2 rounded px-1 py-0.5 text-left transition-colors hover:bg-accent/60"
      >
        <span className="truncate font-mono text-[11px]">{operation}</span>
        {findings > 0 && (
          <span className="tnum shrink-0 rounded-full bg-muted px-1.5 text-[10px] text-muted-foreground">
            {findings}
          </span>
        )}
      </button>
      {files.length > 0 && (
        <ul className="mt-0.5 space-y-0.5 pl-3">
          {files.map((file) => (
            <li
              key={`${file.path}-${file.role ?? ''}`}
              className="flex items-center gap-1 truncate font-mono text-[10px] text-muted-foreground"
            >
              <FileCode2 className="size-3 shrink-0 text-primary/70" />
              <span className="truncate">{fileEvidence(file)}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
