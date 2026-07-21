'use client'

import { Printer } from 'lucide-react'

/** Print / save-as-PDF trigger for the report page. */
export function PrintButton() {
  return (
    <button
      type="button"
      onClick={() => window.print()}
      className="inline-flex h-9 items-center gap-1.5 rounded-lg border border-border bg-card px-3 text-sm font-medium transition-colors hover:bg-accent/60 print:hidden"
    >
      <Printer className="size-4" />
      Print / PDF
    </button>
  )
}
