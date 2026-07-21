'use client'

import { AlertTriangle, ArrowLeft, ChevronRight, FileCode2, ListChecks, Lock, Search, Stethoscope, X } from 'lucide-react'
import { useMemo, useState, useTransition } from 'react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Spinner } from '@/components/ui/spinner'
import { cn } from '@/lib/utils'
import { analyzeRepoSpec, listSpecOperations, type SpecPathListing } from '@/features/github/actions'
import {
  countSelected,
  OperationPicker,
  selectAll,
  type PickerValue,
} from '@/features/github/components/OperationPicker'
import type { RepoSummary } from '@/lib/github/client'

type Plan = 'lint' | 'fix-high' | 'fix-medium' | 'fix-low'

const PLANS: { value: Plan; title: string; body: string; warn?: boolean }[] = [
  { value: 'lint', title: 'Lint', body: 'Report only — no auto-fixes.' },
  { value: 'fix-high', title: 'Fix — Conservative', body: 'Apply HIGH confidence only (safe).' },
  { value: 'fix-medium', title: 'Fix — Standard', body: 'HIGH + MEDIUM. Adds AI description rewrites.' },
  {
    value: 'fix-low',
    title: 'Fix — Aggressive',
    body: 'Apply all, including LOW. Review before committing.',
    warn: true,
  },
]

const MODE: Record<Plan, { mode: 'lint' | 'fix'; threshold: 'high' | 'medium' | 'low' }> = {
  lint: { mode: 'lint', threshold: 'high' },
  'fix-high': { mode: 'fix', threshold: 'high' },
  'fix-medium': { mode: 'fix', threshold: 'medium' },
  'fix-low': { mode: 'fix', threshold: 'low' },
}

export function RepoBrowser({
  repos,
  llmConfigured,
}: {
  repos: RepoSummary[]
  llmConfigured: boolean
}) {
  const [query, setQuery] = useState('')
  const [open, setOpen] = useState<string | null>(null)

  const filtered = useMemo(
    () => repos.filter((r) => r.fullName.toLowerCase().includes(query.toLowerCase())),
    [repos, query],
  )

  return (
    <div className="space-y-4">
      <div className="relative">
        <Search className="absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
        <Input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search repositories…"
          className="h-10 pl-9"
        />
      </div>

      {filtered.length === 0 && (
        <p className="rounded-xl border border-dashed border-border px-4 py-8 text-center text-sm text-muted-foreground">
          No repositories match “{query}”.
        </p>
      )}

      <div className="divide-y divide-border overflow-hidden rounded-xl border border-border bg-card">
        {filtered.map((repo) => {
          const expanded = open === repo.fullName
          return (
            <div key={repo.fullName}>
              <button
                type="button"
                onClick={() => setOpen(expanded ? null : repo.fullName)}
                className="flex w-full items-center gap-3 px-4 py-3 text-left transition-colors hover:bg-accent/50"
              >
                <FileCode2 className="size-4 shrink-0 text-muted-foreground" />
                <span className="min-w-0 flex-1 truncate text-sm font-medium">{repo.fullName}</span>
                {repo.private && (
                  <span className="inline-flex items-center gap-1 rounded-full bg-muted px-2 py-0.5 text-[11px] text-muted-foreground">
                    <Lock className="size-3" />
                    Private
                  </span>
                )}
                <ChevronRight
                  className={cn(
                    'size-4 shrink-0 text-muted-foreground transition-transform',
                    expanded && 'rotate-90',
                  )}
                />
              </button>
              {expanded && (
                <ConfigPanel
                  repo={repo}
                  llmConfigured={llmConfigured}
                  onClose={() => setOpen(null)}
                />
              )}
            </div>
          )
        })}
      </div>
    </div>
  )
}

function ConfigPanel({
  repo,
  llmConfigured,
  onClose,
}: {
  repo: RepoSummary
  llmConfigured: boolean
  onClose: () => void
}) {
  const [plan, setPlan] = useState<Plan>('lint')
  const [routeFiles, setRouteFiles] = useState('')
  const [mismatchFix, setMismatchFix] = useState(false)
  const [branch, setBranch] = useState(repo.defaultBranch)
  const [specPath, setSpecPath] = useState('')

  // Step 2 — operation selection, loaded from the spec once the user has pointed
  // at it. Everything starts selected; deselecting narrows what gets analysed/fixed.
  const [step, setStep] = useState<'config' | 'operations'>('config')
  const [paths, setPaths] = useState<SpecPathListing[]>([])
  const [picked, setPicked] = useState<PickerValue>({})
  const [loadError, setLoadError] = useState<string | null>(null)
  const [loading, startLoading] = useTransition()

  const hasRoutes = routeFiles.trim().length > 0
  const { mode, threshold } = MODE[plan]

  const totalOps = paths.reduce((sum, p) => sum + p.methods.length, 0)
  const pickedOps = countSelected(picked)
  const allPicked = pickedOps === totalOps
  // Whole-spec runs omit the field entirely so the engine skips filtering.
  const selectionJson = allPicked
    ? ''
    : JSON.stringify(
        paths
          .filter((p) => (picked[p.path] ?? []).length > 0)
          .map((p) => ({ path: p.path, methods: picked[p.path] as string[] })),
      )

  const loadOperations = () => {
    if (!specPath.trim()) {
      setLoadError('Enter the OpenAPI spec path first.')
      return
    }
    setLoadError(null)
    startLoading(async () => {
      const result = await listSpecOperations({
        repo: repo.fullName,
        branch,
        path: specPath.trim(),
      })
      if (!result.ok) {
        setLoadError(result.error)
        return
      }
      setPaths(result.paths)
      setPicked(selectAll(result.paths))
      setStep('operations')
    })
  }

  return (
    <form
      action={analyzeRepoSpec}
      className="animate-rise space-y-4 border-t border-border bg-surface-1/40 p-5"
    >
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-semibold">{repo.fullName}</h3>
        <button type="button" onClick={onClose} aria-label="Close" className="text-muted-foreground hover:text-foreground">
          <X className="size-4" />
        </button>
      </div>

      <input type="hidden" name="repo" value={repo.fullName} />
      <input type="hidden" name="mode" value={mode} />
      <input type="hidden" name="confidenceThreshold" value={threshold} />
      <input type="hidden" name="mismatchMode" value={hasRoutes && mismatchFix ? 'fix' : 'flag'} />
      {selectionJson && <input type="hidden" name="selection" value={selectionJson} />}

      {/* Step 1 stays mounted (hidden) so its fields still submit with the form. */}
      <div className={cn('space-y-4', step !== 'config' && 'hidden')}>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Branch">
            <Input
              name="branch"
              value={branch}
              onChange={(e) => setBranch(e.target.value)}
              className="font-mono"
            />
          </Field>
          <Field label="OpenAPI spec path">
            <Input
              name="path"
              value={specPath}
              onChange={(e) => setSpecPath(e.target.value)}
              placeholder="api/openapi.yaml"
              className="font-mono"
              required
            />
          </Field>
        </div>

        <Field label="Route files (optional — v2 codebase grounding)">
          <Input
            value={routeFiles}
            onChange={(e) => setRouteFiles(e.target.value)}
            placeholder="internal/api/routes/,handlers/"
            className="font-mono"
          />
          <p className="mt-1 text-xs text-muted-foreground">
            Leave blank for spec-only analysis. Go &amp; Express handler files supported.
          </p>
        </Field>

        <fieldset className="space-y-2">
          <legend className="mb-1 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
            Analysis mode
          </legend>
          {PLANS.map((p) => (
            <label
              key={p.value}
              className={cn(
                'flex cursor-pointer items-start gap-3 rounded-lg border p-3 transition-colors',
                plan === p.value ? 'border-primary bg-primary/5' : 'border-border hover:bg-accent/40',
              )}
            >
              <input
                type="radio"
                name="plan"
                checked={plan === p.value}
                onChange={() => setPlan(p.value)}
                className="mt-0.5 accent-[var(--primary)]"
              />
              <span className="min-w-0">
                <span className="flex items-center gap-2 text-sm font-medium">
                  {p.title}
                  {p.warn && (
                    <span className="rounded bg-error/15 px-1.5 text-[10px] font-semibold text-error">
                      ⚠ risky
                    </span>
                  )}
                </span>
                <span className="mt-0.5 block text-xs text-muted-foreground">{p.body}</span>
              </span>
            </label>
          ))}
        </fieldset>

        <label
          className={cn(
            'flex items-center justify-between gap-3 rounded-lg border border-border p-3 text-sm',
            !hasRoutes && 'opacity-50',
          )}
        >
          <span>
            <span className="font-medium">Auto-fix spec/code mismatches</span>
            <span className="mt-0.5 block text-xs text-muted-foreground">
              {hasRoutes ? 'Correct the spec when it disagrees with code.' : 'Requires route files.'}
            </span>
          </span>
          <input
            type="checkbox"
            disabled={!hasRoutes}
            checked={mismatchFix}
            onChange={(e) => setMismatchFix(e.target.checked)}
            className="size-4 accent-[var(--primary)]"
          />
        </label>
      </div>

      {step === 'operations' && (
        <div className="animate-rise space-y-3">
          <div>
            <h4 className="flex items-center gap-2 text-sm font-medium">
              <ListChecks className="size-4 text-muted-foreground" />
              Choose operations to analyse
            </h4>
            <p className="mt-1 text-xs text-muted-foreground">
              <span className="font-mono">{specPath}</span> @ {branch} — untick paths or expand
              them to pick individual methods. Only selected operations are analysed
              {mode === 'fix' ? ' and fixed' : ''}.
            </p>
          </div>
          <OperationPicker paths={paths} value={picked} onChange={setPicked} />
        </div>
      )}

      {loadError && (
        <p className="flex items-center gap-2 rounded-lg border border-error/30 bg-error/8 px-3 py-2 text-xs text-error">
          <AlertTriangle className="size-3.5 shrink-0" />
          {loadError}
        </p>
      )}

      <div className="flex items-center justify-between gap-3 border-t border-border pt-4">
        <span className="flex items-center gap-1.5 text-xs">
          <span
            className={cn('size-1.5 rounded-full', llmConfigured ? 'bg-success' : 'bg-warning')}
          />
          {llmConfigured ? 'AI-powered analysis enabled' : 'LLM not configured — structural only'}
        </span>
        {step === 'config' ? (
          <Button type="button" onClick={loadOperations} disabled={loading}>
            {loading ? <Spinner className="size-4" /> : <ListChecks className="size-4" />}
            {loading ? 'Reading spec…' : 'Choose operations'}
          </Button>
        ) : (
          <span className="flex items-center gap-2">
            <Button type="button" variant="ghost" onClick={() => setStep('config')}>
              <ArrowLeft className="size-4" />
              Back
            </Button>
            <Button type="submit" disabled={pickedOps === 0}>
              <Stethoscope className="size-4" />
              Analyse {pickedOps === totalOps ? 'all' : pickedOps} operation
              {pickedOps === 1 ? '' : 's'}
            </Button>
          </span>
        )}
      </div>
    </form>
  )
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block">
      <span className="mb-1.5 block text-xs font-medium text-muted-foreground">{label}</span>
      {children}
    </label>
  )
}
