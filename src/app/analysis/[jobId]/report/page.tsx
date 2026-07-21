import { ArrowLeft, CircleAlert, FileWarning, Info, TriangleAlert } from 'lucide-react'
import Link from 'next/link'
import { Header } from '@/components/app-shell/header'
import { OwaspBadge } from '@/components/ui/severity'
import { buildReportModel } from '@/features/analyze/report-model'
import { extractOperations } from '@/lib/engine/operations'
import { getJob } from '@/lib/jobs/store'
import { cn } from '@/lib/utils'
import type { Finding, Severity } from '@/types/domain'
import { PrintButton } from './PrintButton'

function scoreTone(score: number): { ring: string; text: string; label: string } {
  if (score >= 80) return { ring: 'text-success', text: 'text-success', label: 'Agent-ready' }
  if (score >= 50)
    return { ring: 'text-warning', text: 'text-warning', label: 'Needs work before exposing' }
  return { ring: 'text-error', text: 'text-error', label: 'Not ready for agents' }
}

const SEVERITY_META: Record<Severity, { Icon: typeof CircleAlert; cls: string; label: string }> = {
  error: { Icon: CircleAlert, cls: 'text-error', label: 'Error' },
  warning: { Icon: TriangleAlert, cls: 'text-warning', label: 'Warning' },
  info: { Icon: Info, cls: 'text-info', label: 'Info' },
}

export default async function ReportPage({ params }: { params: Promise<{ jobId: string }> }) {
  const { jobId } = await params
  const job = getJob(jobId)

  if (!job?.result) {
    return (
      <div className="flex min-h-screen flex-col">
        <Header />
        <main className="mx-auto flex w-full max-w-3xl flex-1 flex-col items-center justify-center gap-4 px-6 py-20 text-center">
          <FileWarning className="size-10 text-muted-foreground" />
          <h1 className="text-xl font-semibold">No report yet</h1>
          <p className="max-w-md text-sm text-muted-foreground">
            This report is generated once an analysis finishes. Run the analysis, then come back —
            or the session may have expired (results live in memory).
          </p>
          <Link
            href={`/analysis/${jobId}`}
            className="inline-flex h-9 items-center gap-1.5 rounded-lg border border-border px-3 text-sm font-medium hover:bg-accent/60"
          >
            <ArrowLeft className="size-4" />
            Back to analysis
          </Link>
        </main>
      </div>
    )
  }

  const model = buildReportModel(job.result)
  const tone = scoreTone(model.score)
  const totalOps = extractOperations(job.spec).length
  const flaggedOps = model.operations.length
  const cleanOps = Math.max(0, totalOps - flaggedOps)
  const circumference = 2 * Math.PI * 52

  return (
    <div className="flex min-h-screen flex-col">
      <Header />
      <main className="mx-auto w-full max-w-5xl flex-1 px-6 py-10 print:py-4">
        {/* Top bar */}
        <div className="mb-8 flex items-center justify-between gap-4 print:hidden">
          <Link
            href={`/analysis/${jobId}`}
            className="inline-flex items-center gap-1.5 text-sm font-medium text-muted-foreground transition-colors hover:text-foreground"
          >
            <ArrowLeft className="size-4" />
            Back to analysis
          </Link>
          <PrintButton />
        </div>

        {/* Hero */}
        <section className="grid grid-cols-1 gap-6 rounded-2xl border border-border bg-card p-6 sm:grid-cols-[auto_1fr] sm:items-center">
          <div className="relative mx-auto size-32">
            <svg viewBox="0 0 120 120" className="size-32 -rotate-90">
              <circle cx="60" cy="60" r="52" fill="none" stroke="currentColor" strokeWidth="10" className="text-muted/40" />
              <circle
                cx="60"
                cy="60"
                r="52"
                fill="none"
                stroke="currentColor"
                strokeWidth="10"
                strokeLinecap="round"
                strokeDasharray={circumference}
                strokeDashoffset={circumference * (1 - model.score / 100)}
                className={tone.ring}
              />
            </svg>
            <div className="absolute inset-0 flex flex-col items-center justify-center">
              <span className={cn('tnum text-4xl font-bold', tone.text)}>{model.score}</span>
              <span className="text-[10px] uppercase tracking-wide text-muted-foreground">/ 100</span>
            </div>
          </div>
          <div>
            <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
              MCP readiness
            </p>
            <h1 className={cn('mt-1 text-2xl font-semibold tracking-tight', tone.text)}>
              {tone.label}
            </h1>
            <p className="mt-2 text-sm text-muted-foreground">
              OpenAPI {model.summary.total === 0 ? '' : `${job.result.version ?? '—'} · `}
              {model.summary.total} finding{model.summary.total === 1 ? '' : 's'} across {totalOps}{' '}
              operation{totalOps === 1 ? '' : 's'} — {cleanOps} clean, {flaggedOps} flagged.
            </p>
            <div className="mt-4 flex flex-wrap gap-2">
              <Stat tone="error" label="errors" value={model.summary.errors} />
              <Stat tone="warning" label="warnings" value={model.summary.warnings} />
              <Stat tone="info" label="info" value={model.summary.info} />
            </div>
          </div>
        </section>

        {/* By operation */}
        {model.operations.length > 0 && (
          <section className="mt-10">
            <h2 className="mb-3 text-lg font-semibold tracking-tight">By operation</h2>
            <div className="overflow-hidden rounded-xl border border-border">
              <table className="w-full text-sm">
                <thead className="bg-surface-1/60 text-left text-xs uppercase tracking-wide text-muted-foreground">
                  <tr>
                    <th className="px-4 py-2.5 font-medium">Operation</th>
                    <th className="px-3 py-2.5 text-right font-medium">Errors</th>
                    <th className="px-3 py-2.5 text-right font-medium">Warnings</th>
                    <th className="px-3 py-2.5 text-right font-medium">Info</th>
                    <th className="px-4 py-2.5 text-right font-medium">Total</th>
                  </tr>
                </thead>
                <tbody>
                  {model.operations.map((op) => (
                    <tr key={op.operation} className="border-t border-border/70">
                      <td className="px-4 py-2.5 font-mono text-xs">{op.operation}</td>
                      <td className="tnum px-3 py-2.5 text-right text-error">{op.errors || ''}</td>
                      <td className="tnum px-3 py-2.5 text-right text-warning">{op.warnings || ''}</td>
                      <td className="tnum px-3 py-2.5 text-right text-muted-foreground">
                        {op.info || ''}
                      </td>
                      <td className="tnum px-4 py-2.5 text-right font-semibold">{op.total}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>
        )}

        {/* All findings */}
        <section className="mt-10">
          <h2 className="mb-3 text-lg font-semibold tracking-tight">
            All findings ({model.findings.length})
          </h2>
          {model.findings.length === 0 ? (
            <p className="rounded-xl border border-success/30 bg-success/8 px-4 py-3 text-sm text-success">
              No findings — your spec looks clean. 🎉
            </p>
          ) : (
            <ul className="space-y-2.5">
              {model.findings.map((finding) => (
                <FindingItem key={finding.id} finding={finding} />
              ))}
            </ul>
          )}
        </section>

        <footer className="mt-12 border-t border-border pt-6 text-xs text-muted-foreground">
          Generated by MCP Doctor · open-source OpenAPI diagnostics for the agent era.
        </footer>
      </main>
    </div>
  )
}

function Stat({ tone, label, value }: { tone: Severity; label: string; value: number }) {
  const meta = SEVERITY_META[tone]
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1.5 rounded-lg border px-2.5 py-1 text-sm',
        tone === 'error' && 'border-error/30 bg-error/8',
        tone === 'warning' && 'border-warning/30 bg-warning/8',
        tone === 'info' && 'border-info/30 bg-info/8',
      )}
    >
      <meta.Icon className={cn('size-3.5', meta.cls)} />
      <span className={cn('tnum font-semibold', meta.cls)}>{value}</span>
      <span className="text-muted-foreground">{label}</span>
    </span>
  )
}

function FindingItem({ finding }: { finding: Finding }) {
  const meta = SEVERITY_META[finding.severity]
  return (
    <li className="break-inside-avoid rounded-xl border border-border bg-card p-4">
      <div className="flex items-start gap-2.5">
        <meta.Icon className={cn('mt-0.5 size-4 shrink-0', meta.cls)} />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <span className="font-mono text-xs font-semibold">{finding.rule}</span>
            {finding.owasp && <OwaspBadge owasp={finding.owasp} />}
            {finding.operation && (
              <span className="rounded-full bg-muted px-2 py-0.5 font-mono text-[11px] text-muted-foreground">
                {finding.operation}
              </span>
            )}
            <span className="text-[11px] uppercase tracking-wide text-muted-foreground">
              {finding.confidence}
            </span>
          </div>
          <p className="mt-1 text-sm text-foreground/90">{finding.message}</p>

          {finding.actual !== undefined && (
            <p className="mt-2 rounded-lg border border-warning/30 bg-warning/8 px-3 py-2 text-xs text-warning">
              Code actually does: <span className="font-mono">{finding.actual}</span>
            </p>
          )}

          {finding.before !== undefined && finding.after !== undefined && (
            <div className="mt-2 grid grid-cols-1 gap-2 sm:grid-cols-2">
              <pre className="overflow-x-auto rounded-lg border border-error/20 bg-error/5 p-2.5 text-[11px] leading-relaxed">
                <code>{finding.before}</code>
              </pre>
              <pre className="overflow-x-auto rounded-lg border border-success/20 bg-success/5 p-2.5 text-[11px] leading-relaxed">
                <code>{finding.after}</code>
              </pre>
            </div>
          )}
        </div>
      </div>
    </li>
  )
}
