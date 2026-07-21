import { ArrowLeft, ExternalLink } from 'lucide-react'
import Link from 'next/link'
import { Header } from '@/components/app-shell/header'
import { HealthRing, healthLabel } from '@/components/ui/health-ring'
import { computeHealthScore } from '@/lib/engine'
import { getRunStore } from '@/lib/db'
import { RunFindings, type FindingRowData } from '@/features/history/components/RunFindings'

export default async function RunDetailPage({ params }: { params: Promise<{ runId: string }> }) {
  const { runId } = await params
  const run = getRunStore().getRun(runId)

  if (!run) {
    return (
      <div className="flex min-h-screen flex-col">
        <Header />
        <main className="mx-auto w-full max-w-4xl flex-1 px-6 py-16 text-center">
          <p className="text-sm text-muted-foreground">Run not found.</p>
          <Link href="/history" className="mt-3 inline-block text-sm text-primary hover:underline">
            ← Back to history
          </Link>
        </main>
      </div>
    )
  }

  const score = computeHealthScore(run.summary)
  const maxDuration = Math.max(1, ...run.agents.map((a) => a.durationMs))
  const findings: FindingRowData[] = run.findings.map((f) => ({
    id: f.id,
    operation: f.operation,
    rule: f.rule,
    ...(f.owasp !== undefined ? { owasp: f.owasp } : {}),
    severity: f.severity,
    confidence: f.confidence,
    before: f.before,
    after: f.resolvedContent ?? f.after,
    resolution: f.resolution,
    autoFixed: f.autoFixed,
  }))

  return (
    <div className="flex min-h-screen flex-col">
      <Header />
      <main className="mx-auto w-full max-w-4xl flex-1 space-y-8 px-4 py-10 sm:px-6">
        <div>
          <Link
            href="/history"
            className="mb-4 inline-flex items-center gap-1.5 text-sm text-muted-foreground transition-colors hover:text-foreground"
          >
            <ArrowLeft className="size-4" />
            History
          </Link>
          <div className="flex flex-col gap-5 rounded-2xl border border-border bg-card p-6 sm:flex-row sm:items-center">
            <HealthRing score={score} size={84} stroke={8} showLabel />
            <div className="min-w-0 flex-1">
              <h1 className="text-xl font-semibold tracking-tight">
                {run.repo ?? 'Pasted spec'}
              </h1>
              <p className="mt-1 font-mono text-sm text-muted-foreground">
                {run.specFile}
                {run.branch ? ` · ${run.branch}` : ''}
              </p>
              <p className="tnum mt-3 flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
                <span>{run.createdAt.toISOString().slice(0, 16).replace('T', ' ')}</span>
                <span>{(run.durationMs / 1000).toFixed(1)}s</span>
                <span>mode: {run.mode}</span>
                <span>mismatch: {run.mismatchMode}</span>
                <span className="font-medium text-foreground">{healthLabel(score)}</span>
              </p>
            </div>
            {run.prUrl && (
              <a
                href={run.prUrl}
                target="_blank"
                rel="noreferrer"
                className="inline-flex items-center gap-1.5 rounded-lg border border-border px-3 py-2 text-sm font-medium transition-colors hover:bg-accent"
              >
                View PR
                <ExternalLink className="size-3.5" />
              </a>
            )}
          </div>
        </div>

        {/* Summary stats */}
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          <Stat label="Total" value={run.summary.totalFindings} />
          <Stat label="Errors" value={run.summary.errors} tone="text-error" />
          <Stat label="Warnings" value={run.summary.warnings} tone="text-warning" />
          <Stat label="Auto-fixed" value={run.summary.autoFixed} tone="text-success" />
        </div>

        {/* Agent durations */}
        <section>
          <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-muted-foreground">
            Agent activity
          </h2>
          <div className="space-y-2.5 rounded-xl border border-border bg-card p-4">
            {run.agents.map((agent) => (
              <div key={agent.id} className="flex items-center gap-3">
                <span className="w-36 shrink-0 truncate font-mono text-xs">{agent.id}</span>
                <div className="h-2 flex-1 overflow-hidden rounded-full bg-muted">
                  <div
                    className="h-full rounded-full bg-gradient-to-r from-primary to-[oklch(0.7_0.2_330)]"
                    style={{ width: `${Math.max(4, (agent.durationMs / maxDuration) * 100)}%` }}
                  />
                </div>
                <span className="tnum w-28 shrink-0 text-right text-xs text-muted-foreground">
                  {(agent.durationMs / 1000).toFixed(1)}s · {agent.findingsCount}
                </span>
              </div>
            ))}
          </div>
        </section>

        {/* Findings */}
        <section>
          <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-muted-foreground">
            Findings
          </h2>
          <RunFindings findings={findings} />
        </section>
      </main>
    </div>
  )
}

function Stat({ label, value, tone }: { label: string; value: number; tone?: string }) {
  return (
    <div className="rounded-xl border border-border bg-card p-4">
      <p className={`tnum text-2xl font-semibold ${tone ?? ''}`}>{value}</p>
      <p className="mt-0.5 text-xs text-muted-foreground">{label}</p>
    </div>
  )
}
