'use client'

import {
  Check,
  CheckCheck,
  CheckCircle2,
  ChevronRight,
  CircleSlash,
  Download,
  FileCode2,
  FileJson,
  FileText,
  Info,
  Layers,
  ListChecks,
  RotateCw,
  Sparkles,
  TriangleAlert,
  Undo2,
  X,
} from 'lucide-react'
import Link from 'next/link'
import { useEffect, useMemo, useReducer, useRef, useState } from 'react'
import { Button } from '@/components/ui/button'
import { LiveDot, Spinner } from '@/components/ui/spinner'
import { cn } from '@/lib/utils'
import { useAnalysisStream } from '@/features/analyze/hooks'
import {
  acceptedIds,
  initialReviewState,
  reviewCounts,
  reviewReducer,
} from '@/features/analyze/review'
import { CreatePr } from '@/features/github/components/CreatePr'
import { SuggestionCard } from '@/features/analyze/components/SuggestionCard'
import { DiagnosticCard } from '@/features/analyze/components/DiagnosticCard'
import { buildOperationRows, OpStatusIcon } from '@/features/analyze/components/op-status'
import { PipelineStepper } from '@/features/analyze/components/PipelineStepper'
import { errorFindingIds, partitionResolved } from '@/features/analyze/resolved'
import type { FileReadActivity } from '@/features/analyze/state'
import type { Resolution, Severity } from '@/types/domain'

/**
 * One-line evidence of a grounding read: where in the file the agent looked,
 * why (route registration vs the handler it followed), and how much it read.
 */
function fileEvidence(file: FileReadActivity): string {
  const location = file.line !== undefined ? `${file.path}:${file.line}` : file.path
  const parts: string[] = []
  if (file.role === 'handler') parts.push(`handler ${file.symbol ?? ''}`.trimEnd())
  else if (file.role === 'registration') parts.push('route registration')
  if (file.linesRead !== undefined) parts.push(`${file.linesRead} lines`)
  return parts.length > 0 ? `${location} · ${parts.join(' · ')}` : location
}

const SEVERITY_RANK: Record<Severity, number> = { error: 3, warning: 2, info: 1 }

/** Tick a live elapsed timer (seconds) until `stop` is true. */
function useElapsed(stop: boolean, finalMs?: number): string {
  const [seconds, setSeconds] = useState(0)
  const start = useRef<number | null>(null)
  useEffect(() => {
    if (stop) return
    if (start.current === null) start.current = performance.now()
    const id = setInterval(() => {
      if (start.current !== null) setSeconds((performance.now() - start.current) / 1000)
    }, 100)
    return () => clearInterval(id)
  }, [stop])
  const value = stop && finalMs !== undefined ? finalMs / 1000 : seconds
  return `${value.toFixed(1)}s`
}

/** Origin of a repo-sourced job — enables the Create PR flow and spec labelling. */
export interface AnalysisRepoRef {
  fullName: string
  branch: string
  path: string
}

export function AnalysisView({ jobId, repo }: { jobId: string; repo?: AnalysisRepoRef }) {
  const { state, phase, stalled, cancel, retry } = useAnalysisStream(jobId)
  const [review, dispatch] = useReducer(reviewReducer, initialReviewState)
  const [downloading, setDownloading] = useState(false)
  const running = phase === 'connecting' || phase === 'streaming'
  const elapsed = useElapsed(!running, state.totals?.durationMs)

  const operations = useMemo(() => buildOperationRows(state), [state])
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
  // Resolved = analysed (clean) or flagged; pending/analysing are still outstanding.
  const opsDone = useMemo(
    () => operations.filter((o) => o.status !== 'pending' && o.status !== 'analysing').length,
    [operations],
  )
  // All findings, errors first — both AI suggestions (actionable) and structural
  // diagnostics (read-only) are shown so the panel never hides issues.
  const findings = useMemo(
    () => [...state.findings].sort((a, b) => SEVERITY_RANK[b.severity] - SEVERITY_RANK[a.severity]),
    [state.findings],
  )
  const actionable = useMemo(
    () => findings.filter((f) => f.suggested !== undefined || f.actual !== undefined),
    [findings],
  )
  const actionableIds = useMemo(() => actionable.map((s) => s.id), [actionable])
  const counts = reviewCounts(review, actionableIds)
  const structuralOnly = findings.length > 0 && actionable.length === 0

  // Session-only "mark solved": resolved findings move to a collapsed group.
  const [resolved, setResolved] = useState<ReadonlySet<string>>(new Set())
  const { active: activeFindings, resolved: resolvedFindings } = useMemo(
    () => partitionResolved(findings, resolved),
    [findings, resolved],
  )
  const unresolvedErrorIds = useMemo(() => errorFindingIds(activeFindings), [activeFindings])
  const resolveFinding = (id: string) => setResolved((prev) => new Set(prev).add(id))
  const unresolveFinding = (id: string) =>
    setResolved((prev) => {
      const next = new Set(prev)
      next.delete(id)
      return next
    })
  const resolveAllErrors = () =>
    setResolved((prev) => new Set([...prev, ...unresolvedErrorIds]))

  // Mirror review decisions onto the persisted run record (authed runs only —
  // for anonymous jobs there is no record and the request is a harmless 401/404).
  function syncResolution(ids: string[], resolution: Resolution): void {
    for (const findingId of ids) {
      void fetch(`/api/runs/${jobId}/resolution`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ findingId, resolution }),
      }).catch(() => {})
    }
  }

  function scrollToOperation(op: string): void {
    const first = findings.find((s) => s.operation === op)
    if (!first) return
    document
      .getElementById(`finding-${first.id}`)
      ?.scrollIntoView({ behavior: 'smooth', block: 'center' })
  }

  function downloadReport(): void {
    const report = {
      findings: state.findings,
      summary: state.totals ?? null,
    }
    const blob = new Blob([JSON.stringify(report, null, 2)], { type: 'application/json' })
    const url = URL.createObjectURL(blob)
    const link = document.createElement('a')
    link.href = url
    link.download = 'mcp-doctor-report.json'
    link.click()
    URL.revokeObjectURL(url)
  }

  async function download(): Promise<void> {
    setDownloading(true)
    try {
      const res = await fetch(`/api/jobs/${jobId}/patch`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ acceptedIds: acceptedIds(review) }),
      })
      if (!res.ok) return
      const blob = await res.blob()
      const url = URL.createObjectURL(blob)
      const link = document.createElement('a')
      link.href = url
      link.download = 'openapi.patched.yaml'
      link.click()
      URL.revokeObjectURL(url)
    } finally {
      setDownloading(false)
    }
  }

  return (
    <div className="flex h-full flex-col gap-3">
      {/* Status bar */}
      <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-border bg-card px-4 py-2.5">
        <div className="flex items-center gap-2 font-mono text-xs text-muted-foreground">
          <FileText className="size-3.5" />
          {repo ? `${repo.fullName} · ${repo.path} @ ${repo.branch}` : 'pasted spec'}
        </div>
        <div className="flex items-center gap-3">
          <StatusPill phase={phase} stalled={stalled} elapsed={elapsed} />
          {running && (
            <Button size="sm" variant="outline" onClick={cancel}>
              <X className="size-3.5" />
              Cancel
            </Button>
          )}
          {(phase === 'cancelled' || phase === 'error') && (
            <Button size="sm" onClick={retry}>
              <RotateCw className="size-3.5" />
              Try again
            </Button>
          )}
        </div>
      </div>

      {/* Pipeline progress — which phase is running, what's done, what's left */}
      {state.plannedPhases.length > 0 && (
        <PipelineStepper
          phases={state.plannedPhases}
          status={state.phaseStatus}
          opsDone={opsDone}
          opsTotal={operations.length}
        />
      )}

      {/* Contextual banner for non-running / stalled states */}
      {phase === 'error' && (
        <Notice
          tone="error"
          icon={TriangleAlert}
          title="This analysis didn’t finish"
          body="The session may have expired or the connection dropped. Try again, or start over from a fresh paste."
        >
          <Button size="sm" onClick={retry}>
            <RotateCw className="size-3.5" />
            Try again
          </Button>
          <Link
            href="/"
            className="inline-flex h-8 items-center rounded-lg px-3 text-xs font-medium text-muted-foreground transition-colors hover:text-foreground"
          >
            Start over
          </Link>
        </Notice>
      )}
      {phase === 'cancelled' && (
        <Notice
          tone="neutral"
          icon={CircleSlash}
          title="Analysis cancelled"
          body="You stopped this run. Any suggestions already accepted can still be downloaded below."
        >
          <Button size="sm" onClick={retry}>
            <RotateCw className="size-3.5" />
            Run again
          </Button>
        </Notice>
      )}
      {running && stalled && (
        <Notice
          tone="warning"
          icon={TriangleAlert}
          title="This is taking longer than expected"
          body="The analysis is still running but hasn’t reported progress recently. You can keep waiting or cancel."
        >
          <Button size="sm" variant="outline" onClick={cancel}>
            <X className="size-3.5" />
            Cancel
          </Button>
        </Notice>
      )}

      {/* Three panels */}
      <div className="grid min-h-0 flex-1 grid-cols-1 gap-3 lg:grid-cols-[minmax(180px,0.85fr)_minmax(220px,1fr)_minmax(340px,1.5fr)]">
        {/* Operations */}
        <Panel icon={Layers} title="Operations" count={operations.length}>
          {operations.length === 0 && <Empty>Waiting for operations…</Empty>}
          <div className="space-y-0.5">
            {operations.map((row) => (
              <button
                key={row.operation}
                type="button"
                onClick={() => scrollToOperation(row.operation)}
                className="flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left transition-colors hover:bg-accent/60"
              >
                <OpStatusIcon status={row.status} />
                <span className="min-w-0 flex-1 truncate font-mono text-xs">{row.operation}</span>
                {row.findings > 0 && (
                  <span className="tnum shrink-0 rounded-full bg-muted px-1.5 text-[10px] font-medium text-muted-foreground">
                    {row.findings}
                  </span>
                )}
              </button>
            ))}
          </div>
        </Panel>

        {/* Agent activity */}
        <Panel icon={Sparkles} title="Agent activity">
          {state.complete && state.totals && (
            <div className="mb-3 rounded-lg border border-success/30 bg-success/8 p-3">
              <p className="flex items-center gap-1.5 text-xs font-semibold text-success">
                <CheckCircle2 className="size-3.5" />
                Analysis complete — {elapsed}
              </p>
              <p className="mt-1 tnum text-xs text-muted-foreground">
                {state.totals.total} findings · {state.totals.errors} errors ·{' '}
                {state.totals.warnings} warnings · {state.totals.info} info
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
                      {agent.done ? (
                        agent.error !== undefined ? (
                          <TriangleAlert className="size-3.5 shrink-0 text-destructive" />
                        ) : (
                          <CheckCircle2 className="size-3.5 shrink-0 text-success" />
                        )
                      ) : (
                        <Spinner className="size-3.5 shrink-0 text-primary" />
                      )}
                      <span className="truncate">{agent.agentId}</span>
                    </span>
                    <span
                      className={cn(
                        'tnum shrink-0 truncate text-[11px]',
                        agent.error !== undefined ? 'text-destructive' : 'text-muted-foreground',
                      )}
                      title={agent.error}
                    >
                      {agent.done
                        ? agent.error !== undefined
                          ? `failed — ${agent.error}`
                          : `${agent.findingsCount ?? 0} findings · ${((agent.durationMs ?? 0) / 1000).toFixed(1)}s`
                        : 'running…'}
                    </span>
                  </summary>
                  {expandable && (
                    <div className="space-y-1.5 border-t border-border/60 px-2.5 py-2">
                      <p className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
                        Examined {agent.operations.length} operation
                        {agent.operations.length === 1 ? '' : 's'}
                      </p>
                      {agent.operations.map((op) => {
                        const files = filesByOp.get(op) ?? []
                        const count = findingCountByOp.get(op) ?? 0
                        return (
                          <div key={op}>
                            <button
                              type="button"
                              onClick={() => scrollToOperation(op)}
                              className="flex w-full items-center justify-between gap-2 rounded px-1 py-0.5 text-left transition-colors hover:bg-accent/60"
                            >
                              <span className="truncate font-mono text-[11px]">{op}</span>
                              {count > 0 && (
                                <span className="tnum shrink-0 rounded-full bg-muted px-1.5 text-[10px] text-muted-foreground">
                                  {count}
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
                      })}
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
        </Panel>

        {/* Findings */}
        <Panel
          icon={ListChecks}
          title="Findings"
          count={findings.length}
          action={
            actionable.length > 0 || unresolvedErrorIds.length > 0 ? (
              <div className="flex gap-1.5">
                {actionable.length > 0 && (
                  <>
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() => {
                        dispatch({ type: 'accept_all', ids: actionableIds })
                        syncResolution(actionableIds, 'accepted')
                      }}
                    >
                      Accept all
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() => {
                        dispatch({ type: 'reject_all', ids: actionableIds })
                        syncResolution(actionableIds, 'rejected')
                      }}
                    >
                      Reject all
                    </Button>
                  </>
                )}
                {unresolvedErrorIds.length > 0 && (
                  <Button size="sm" variant="ghost" onClick={resolveAllErrors}>
                    <CheckCheck className="size-3.5" />
                    Solve {unresolvedErrorIds.length} error{unresolvedErrorIds.length === 1 ? '' : 's'}
                  </Button>
                )}
              </div>
            ) : null
          }
        >
          {findings.length === 0 ? (
            <Empty>
              {state.complete
                ? 'No findings — your spec looks clean. 🎉'
                : 'Findings will appear here…'}
            </Empty>
          ) : (
            <div className="space-y-3">
              {structuralOnly && (
                <div className="flex items-start gap-2 rounded-lg border border-info/30 bg-info/8 px-3 py-2.5 text-xs text-info">
                  <Info className="mt-0.5 size-3.5 shrink-0" />
                  <span>
                    Structural checks only. Connect GitHub or configure an LLM to get AI fixes —
                    description rewrites, disambiguation, and one-click apply.
                  </span>
                </div>
              )}
              {activeFindings.map((finding) => (
                <div key={finding.id} className="group relative">
                  {finding.suggested !== undefined || finding.actual !== undefined ? (
                    <SuggestionCard
                      finding={finding}
                      decision={review.items[finding.id]?.decision ?? 'pending'}
                      editedContent={review.items[finding.id]?.editedContent}
                      onAccept={() => {
                        dispatch({ type: 'accept', id: finding.id })
                        syncResolution([finding.id], 'accepted')
                      }}
                      onReject={() => {
                        dispatch({ type: 'reject', id: finding.id })
                        syncResolution([finding.id], 'rejected')
                      }}
                      onEdit={(content) => {
                        dispatch({ type: 'edit', id: finding.id, content })
                        syncResolution([finding.id], 'edited')
                      }}
                      onReset={() => {
                        dispatch({ type: 'reset', id: finding.id })
                        syncResolution([finding.id], 'pending')
                      }}
                    />
                  ) : (
                    <DiagnosticCard finding={finding} />
                  )}
                  <button
                    type="button"
                    onClick={() => resolveFinding(finding.id)}
                    aria-label="Mark this finding solved"
                    className="absolute right-2 top-2 inline-flex items-center gap-1 rounded-md border border-border bg-card/95 px-2 py-1 text-[11px] font-medium text-muted-foreground opacity-0 shadow-sm transition-opacity hover:text-success focus-visible:opacity-100 group-hover:opacity-100"
                  >
                    <Check className="size-3" />
                    Mark solved
                  </button>
                </div>
              ))}

              {activeFindings.length === 0 && (
                <div className="flex items-center gap-2 rounded-lg border border-success/30 bg-success/8 px-3 py-2.5 text-xs text-success">
                  <CheckCircle2 className="size-3.5 shrink-0" />
                  Everything triaged — all findings marked solved. 🎉
                </div>
              )}

              {resolvedFindings.length > 0 && (
                <details className="rounded-xl border border-border/60 bg-surface-1/40">
                  <summary className="cursor-pointer select-none px-3 py-2 text-xs font-semibold text-muted-foreground">
                    Resolved ({resolvedFindings.length})
                  </summary>
                  <div className="space-y-0.5 px-2 pb-2">
                    {resolvedFindings.map((finding) => (
                      <div
                        key={finding.id}
                        className="flex items-center justify-between gap-2 rounded-lg px-2 py-1.5"
                      >
                        <span className="flex min-w-0 items-center gap-2 text-xs text-muted-foreground line-through">
                          <span
                            aria-hidden="true"
                            className={cn(
                              'size-1.5 shrink-0 rounded-full',
                              finding.severity === 'error'
                                ? 'bg-error'
                                : finding.severity === 'warning'
                                  ? 'bg-warning'
                                  : 'bg-muted-foreground',
                            )}
                          />
                          <span className="truncate font-mono text-[11px]">
                            {finding.operation ? `${finding.operation} · ` : ''}
                            {finding.rule}
                          </span>
                        </span>
                        <button
                          type="button"
                          onClick={() => unresolveFinding(finding.id)}
                          aria-label="Reopen this finding"
                          className="inline-flex shrink-0 items-center gap-1 text-[11px] text-muted-foreground transition-colors hover:text-foreground"
                        >
                          <Undo2 className="size-3" />
                          Reopen
                        </button>
                      </div>
                    ))}
                  </div>
                </details>
              )}
            </div>
          )}
        </Panel>
      </div>

      {/* Bottom action bar */}
      <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-border bg-card px-4 py-2.5">
        <div className="tnum flex items-center gap-3 text-sm">
          {actionable.length > 0 ? (
            <>
              <span className="text-success">{counts.accepted} accepted</span>
              <span className="text-muted-foreground">·</span>
              <span className="text-muted-foreground">{counts.rejected} rejected</span>
              <span className="text-muted-foreground">·</span>
              <span className="text-muted-foreground">{counts.pending} pending</span>
            </>
          ) : (
            <span className="text-muted-foreground">
              {findings.length} finding{findings.length === 1 ? '' : 's'}
              {state.totals ? ` · ${state.totals.errors} errors · ${state.totals.warnings} warnings` : ''}
            </span>
          )}
        </div>
        <div className="flex items-center gap-2">
          {state.complete && (
            <Link
              href={`/analysis/${jobId}/report`}
              className="inline-flex h-9 items-center gap-1.5 rounded-lg border border-border bg-card px-3 text-sm font-medium transition-colors hover:bg-accent/60"
            >
              <ListChecks className="size-4" />
              View report
            </Link>
          )}
          <Button variant="outline" onClick={downloadReport} disabled={findings.length === 0}>
            <FileJson className="size-4" />
            Download report
          </Button>
          {actionable.length > 0 && (
            <Button onClick={download} disabled={counts.accepted === 0 || downloading}>
              {downloading ? <Spinner /> : <Download className="size-4" />}
              Download patched spec
            </Button>
          )}
          {repo && actionable.length > 0 && (
            <CreatePr jobId={jobId} acceptedIds={acceptedIds(review)} />
          )}
        </div>
      </div>
    </div>
  )
}

function Panel({
  icon: Icon,
  title,
  count,
  action,
  children,
}: {
  icon: React.ComponentType<{ className?: string }>
  title: string
  count?: number
  action?: React.ReactNode
  children: React.ReactNode
}) {
  return (
    <section className="flex min-h-0 flex-col overflow-hidden rounded-xl border border-border bg-card">
      <header className="flex items-center justify-between gap-2 border-b border-border px-4 py-2.5">
        <h2 className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
          <Icon className="size-3.5" />
          {title}
          {count !== undefined && (
            <span className="tnum rounded-full bg-muted px-1.5 text-[10px] text-muted-foreground">
              {count}
            </span>
          )}
        </h2>
        {action}
      </header>
      <div className="min-h-0 flex-1 overflow-y-auto p-3">{children}</div>
    </section>
  )
}

function Empty({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex h-full min-h-[80px] items-center justify-center px-4 text-center text-sm text-muted-foreground">
      {children}
    </div>
  )
}

function StatusPill({
  phase,
  stalled,
  elapsed,
}: {
  phase: 'connecting' | 'streaming' | 'complete' | 'cancelled' | 'error'
  stalled: boolean
  elapsed: string
}) {
  if (phase === 'complete') {
    return (
      <span className="flex items-center gap-2 text-xs font-medium text-success">
        <CheckCircle2 className="size-3.5" />
        Complete
        <span className="tnum text-muted-foreground">{elapsed}</span>
      </span>
    )
  }
  if (phase === 'cancelled') {
    return (
      <span className="flex items-center gap-2 text-xs font-medium text-muted-foreground">
        <CircleSlash className="size-3.5" />
        Cancelled
        <span className="tnum">{elapsed}</span>
      </span>
    )
  }
  if (phase === 'error') {
    return (
      <span className="flex items-center gap-2 text-xs font-medium text-error">
        <TriangleAlert className="size-3.5" />
        Couldn’t complete
        <span className="tnum text-muted-foreground">{elapsed}</span>
      </span>
    )
  }
  // connecting / streaming
  return (
    <span
      className={cn(
        'flex items-center gap-2 text-xs font-medium',
        stalled ? 'text-warning' : 'text-primary',
      )}
    >
      <LiveDot />
      {stalled ? 'Still working…' : 'Analysing'}
      <span className="tnum text-muted-foreground">{elapsed}</span>
    </span>
  )
}

function Notice({
  tone,
  icon: Icon,
  title,
  body,
  children,
}: {
  tone: 'error' | 'warning' | 'neutral'
  icon: React.ComponentType<{ className?: string }>
  title: string
  body: string
  children?: React.ReactNode
}) {
  const tones = {
    error: 'border-error/30 bg-error/8 text-error',
    warning: 'border-warning/30 bg-warning/8 text-warning',
    neutral: 'border-border bg-surface-1/60 text-foreground',
  } as const
  return (
    <div
      className={cn(
        'flex flex-col gap-3 rounded-xl border px-4 py-3 sm:flex-row sm:items-center sm:justify-between',
        tones[tone],
      )}
    >
      <div className="flex items-start gap-2.5">
        <Icon className="mt-0.5 size-4 shrink-0" />
        <div>
          <p className="text-sm font-medium">{title}</p>
          <p className="mt-0.5 text-xs opacity-90">{body}</p>
        </div>
      </div>
      {children && <div className="flex shrink-0 items-center gap-2">{children}</div>}
    </div>
  )
}
