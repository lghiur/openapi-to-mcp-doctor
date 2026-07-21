import type { HTMLAttributes } from 'react'
import { cn } from '@/lib/utils'

type Tone = 'error' | 'warning' | 'info' | 'neutral' | 'success' | 'primary'

export interface BadgeProps extends HTMLAttributes<HTMLSpanElement> {
  tone?: Tone
}

const TONES: Record<Tone, string> = {
  error: 'bg-error/12 text-error ring-1 ring-inset ring-error/25',
  warning: 'bg-warning/12 text-warning ring-1 ring-inset ring-warning/25',
  info: 'bg-info/12 text-info ring-1 ring-inset ring-info/25',
  success: 'bg-success/12 text-success ring-1 ring-inset ring-success/25',
  primary: 'bg-primary/12 text-primary ring-1 ring-inset ring-primary/25',
  neutral: 'bg-muted text-muted-foreground ring-1 ring-inset ring-border',
}

export function Badge({ className, tone = 'neutral', ...props }: BadgeProps) {
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-medium leading-none',
        TONES[tone],
        className,
      )}
      {...props}
    />
  )
}
