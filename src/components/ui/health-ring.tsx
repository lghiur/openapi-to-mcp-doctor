import { cn } from '@/lib/utils'

/** Map a 0–100 score to a semantic colour band. */
export function healthColor(score: number): string {
  if (score >= 80) return 'var(--success)'
  if (score >= 50) return 'var(--warning)'
  return 'var(--error)'
}

export function healthLabel(score: number): string {
  if (score >= 90) return 'Excellent'
  if (score >= 80) return 'Healthy'
  if (score >= 50) return 'Needs work'
  return 'Critical'
}

interface HealthRingProps {
  score: number
  size?: number
  stroke?: number
  className?: string
  showLabel?: boolean
}

/** Circular health-score gauge (0–100) with colour band and centred value. */
export function HealthRing({
  score,
  size = 72,
  stroke = 7,
  className,
  showLabel = false,
}: HealthRingProps) {
  const clamped = Math.max(0, Math.min(100, score))
  const r = (size - stroke) / 2
  const c = 2 * Math.PI * r
  const offset = c - (clamped / 100) * c
  const color = healthColor(clamped)

  return (
    <div className={cn('inline-flex flex-col items-center gap-1', className)}>
      <div className="relative" style={{ width: size, height: size }}>
        <svg width={size} height={size} className="-rotate-90">
          <circle
            cx={size / 2}
            cy={size / 2}
            r={r}
            fill="none"
            stroke="var(--border)"
            strokeWidth={stroke}
          />
          <circle
            cx={size / 2}
            cy={size / 2}
            r={r}
            fill="none"
            stroke={color}
            strokeWidth={stroke}
            strokeLinecap="round"
            strokeDasharray={c}
            strokeDashoffset={offset}
            style={{ transition: 'stroke-dashoffset 0.8s cubic-bezier(0.16,1,0.3,1)' }}
          />
        </svg>
        <div className="absolute inset-0 flex flex-col items-center justify-center">
          <span
            className="tnum text-lg font-semibold leading-none"
            style={{ color }}
          >
            {clamped}
          </span>
        </div>
      </div>
      {showLabel && (
        <span className="text-xs font-medium" style={{ color }}>
          {healthLabel(clamped)}
        </span>
      )}
    </div>
  )
}
