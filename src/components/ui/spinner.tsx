import { Loader2 } from 'lucide-react'
import { cn } from '@/lib/utils'

/** Indeterminate spinner. Inherits text colour. */
export function Spinner({ className }: { className?: string }) {
  return <Loader2 className={cn('size-4 animate-spin', className)} aria-hidden="true" />
}

/** A small pulsing dot used for live/streaming status. */
export function LiveDot({ className }: { className?: string }) {
  return (
    <span className={cn('relative flex size-2', className)}>
      <span className="absolute inline-flex size-full animate-ping rounded-full bg-current opacity-60" />
      <span className="relative inline-flex size-2 rounded-full bg-current" />
    </span>
  )
}
