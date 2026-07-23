/**
 * Layout primitives shared by the three columns of the analysis console.
 * Server-safe (no hooks or handlers of their own) so either side of the
 * client boundary can use them.
 */

/** A titled, independently scrolling column with an optional count and action. */
export function Panel({
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

/** Centred placeholder for a panel with nothing to show yet. */
export function Empty({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex h-full min-h-[80px] items-center justify-center px-4 text-center text-sm text-muted-foreground">
      {children}
    </div>
  )
}
