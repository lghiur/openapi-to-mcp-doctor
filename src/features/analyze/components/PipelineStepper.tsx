import { CheckCircle2, CircleDashed } from 'lucide-react'
import { Spinner } from '@/components/ui/spinner'
import { cn } from '@/lib/utils'
import type { PhaseStatus } from '@/features/analyze/state'
import type { AnalysisPhase } from '@/types/domain'

const PHASE_LABEL: Record<AnalysisPhase, string> = {
  structural: 'Structural',
  workers: 'AI workers',
  postprocess: 'Near-duplicate check',
  grounding: 'Code grounding',
}

const STATUS_WORD: Record<PhaseStatus, string> = {
  pending: 'pending',
  active: 'in progress',
  done: 'done',
}

/**
 * Horizontal pipeline stepper: one step per planned phase, showing which stage is
 * running, what's finished, and what's still queued — the "what's left" view. The
 * phase that processes operations (AI workers, or the structural pass when it's the
 * only phase) also shows an "X / N" operation count so progress is legible at a
 * glance. Status is conveyed by icon, colour, AND an sr-only word for a11y.
 */
export function PipelineStepper({
  phases,
  status,
  opsDone,
  opsTotal,
}: {
  phases: AnalysisPhase[]
  status: Partial<Record<AnalysisPhase, PhaseStatus>>
  opsDone: number
  opsTotal: number
}) {
  if (phases.length === 0) return null

  return (
    <ol
      aria-label="Analysis pipeline"
      className="flex flex-wrap items-center gap-x-1 gap-y-2 rounded-xl border border-border bg-card px-4 py-2.5"
    >
      {phases.map((phase, i) => {
        const s = status[phase] ?? 'pending'
        // The op count belongs to whichever phase actually walks the operations.
        const tracksOps = phase === 'workers' || (phase === 'structural' && phases.length === 1)
        const showCount = tracksOps && opsTotal > 0 && s !== 'pending'
        return (
          <li
            key={phase}
            aria-current={s === 'active' ? 'step' : undefined}
            className="flex items-center gap-1"
          >
            <span
              className={cn(
                'flex items-center gap-1.5 rounded-lg px-2 py-1 text-xs font-medium transition-colors',
                s === 'done' && 'text-success',
                s === 'active' && 'bg-primary/10 text-primary',
                s === 'pending' && 'text-muted-foreground/60',
              )}
            >
              <StepIcon status={s} />
              {PHASE_LABEL[phase]}
              {showCount && (
                <span className="tnum tabular-nums text-[11px] opacity-80">
                  {opsDone}/{opsTotal}
                </span>
              )}
              <span className="sr-only">— {STATUS_WORD[s]}</span>
            </span>
            {i < phases.length - 1 && (
              <span
                aria-hidden="true"
                className={cn(
                  'h-px w-4 sm:w-6',
                  s === 'done' ? 'bg-success/40' : 'bg-border',
                )}
              />
            )}
          </li>
        )
      })}
    </ol>
  )
}

function StepIcon({ status }: { status: PhaseStatus }) {
  if (status === 'done') return <CheckCircle2 className="size-3.5" aria-hidden="true" />
  if (status === 'active') return <Spinner className="size-3.5" aria-hidden="true" />
  return <CircleDashed className="size-3.5" aria-hidden="true" />
}
