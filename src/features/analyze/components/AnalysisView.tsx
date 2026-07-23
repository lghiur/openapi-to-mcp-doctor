'use client'

import {
  Check,
  CheckCheck,
  CheckCircle2,
  CircleSlash,
  Download,
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
import { AgentActivityPanel } from '@/features/analyze/components/AgentActivity'
import { Empty, Panel } from '@/features/analyze/components/Panel'
import { PipelineStepper } from '@/features/analyze/components/PipelineStepper'
import { errorFindingIds, partitionResolved } from '@/features/analyze/resolved'
import type { Resolution, Severity } from '@/types/domain'

const SEVERITY_RANK: Record<Severity, number> = { error: 3, warning: 2, info: 1 }

/** Dot colour for a finding in the collapsed "Resolved" list. */
const SEVERITY_DOT: Record<Severity, string> = {
  error: 'bg-error',
  warning: 'bg-warning',
  info: 'bg-muted-foreground',
}

/** Tick a live elapsed timer (seconds) until `stop` is true. */
function useElapsed(stop: boolean, finalMs?: number): string {
  const [seconds, setSeconds] = useState(0)
  const [prevStop, setPrevStop] = useState(stop)
  const start = useRef<number | null>(null)
  // Restart the clock whenever a run (re)starts — a retry must not resume the
  // previous run's elapsed time. Done during render (not in the effect) per the
  // "adjusting state when a prop changes" pattern.
  if (prevStop !== stop) {
    setPrevStop(stop)
    if (!stop) setSeconds(0)
  }
  useEffect(() => {
    if (stop) return
    start.current = performance.now()
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
  // Always one request for the whole batch: "accept all" on a large run must not
  // fan out into hundreds of concurrent rewrites of the same row.
  function syncResolution(ids: string[], resolution: Resolution): void {
    if (ids.length === 0) return
    void fetch(`/api/runs/${jobId}/resolution`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ updates: ids.map((findingId) => ({ findingId, resolution })) }),
    }).catch(() => {})
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

      {/* Run caveats from the server (e.g. only part of the codebase was read) */}
      {state.notices.map((message) => (
        <Notice
          key={message}
          tone="warning"
          icon={TriangleAlert}
          title="Partial input"
          body={message}
        />
      ))}

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
          <AgentActivityPanel
            state={state}
            elapsed={elapsed}
            onSelectOperation={scrollToOperation}
          />
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
                              SEVERITY_DOT[finding.severity],
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
