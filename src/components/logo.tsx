import Link from 'next/link'
import { cn } from '@/lib/utils'

/** Brand mark: a caduceus-style health glyph in a gradient tile + wordmark. */
export function Logo({ className, href = '/' }: { className?: string; href?: string }) {
  return (
    <Link href={href} className={cn('group inline-flex items-center gap-2.5', className)}>
      <span className="relative grid size-8 place-items-center rounded-lg bg-gradient-to-br from-primary to-[oklch(0.62_0.22_320)] text-primary-foreground shadow-sm transition-transform group-hover:scale-105">
        <svg viewBox="0 0 24 24" className="size-5" fill="none" aria-hidden="true">
          <path
            d="M12 3v18M8 6.5c0 2 1.8 3.2 4 3.2s4-1.2 4-3.2M8 12c0 2 1.8 3.2 4 3.2s4-1.2 4-3.2"
            stroke="currentColor"
            strokeWidth="1.6"
            strokeLinecap="round"
          />
          <circle cx="12" cy="3.2" r="1.4" fill="currentColor" />
        </svg>
      </span>
      <span className="text-[15px] font-semibold tracking-tight">
        MCP<span className="text-muted-foreground"> Doctor</span>
      </span>
    </Link>
  )
}
