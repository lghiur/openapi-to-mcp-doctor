'use client'

import { ChevronRight } from 'lucide-react'
import { useState } from 'react'
import { cn } from '@/lib/utils'
import type { SpecPathListing } from '@/features/github/actions'

/** Selected methods (lowercase) per spec path. A missing key = nothing selected. */
export type PickerValue = Record<string, string[]>

/** All-selected value for a listing — the picker's default state. */
export function selectAll(paths: SpecPathListing[]): PickerValue {
  return Object.fromEntries(paths.map((p) => [p.path, [...p.methods]]))
}

export function countSelected(value: PickerValue): number {
  return Object.values(value).reduce((sum, methods) => sum + methods.length, 0)
}

/**
 * Checkbox tree over a spec's paths and methods. Every operation starts
 * selected; ticking a path toggles all of its methods, and expanding a path
 * lets the user pick individual methods (path shows indeterminate when partial).
 */
export function OperationPicker({
  paths,
  value,
  onChange,
}: {
  paths: SpecPathListing[]
  value: PickerValue
  onChange: (value: PickerValue) => void
}) {
  const [expanded, setExpanded] = useState<Record<string, boolean>>({})
  const total = paths.reduce((sum, p) => sum + p.methods.length, 0)
  const selected = countSelected(value)

  const setPath = (path: string, methods: string[]) => {
    const next = { ...value }
    if (methods.length === 0) delete next[path]
    else next[path] = methods
    onChange(next)
  }

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between text-xs">
        <span className="tnum text-muted-foreground">
          {selected} of {total} operations selected
        </span>
        <span className="flex gap-3">
          <button
            type="button"
            onClick={() => onChange(selectAll(paths))}
            className="font-medium text-primary hover:underline"
          >
            Select all
          </button>
          <button
            type="button"
            onClick={() => onChange({})}
            className="font-medium text-muted-foreground hover:underline"
          >
            Clear
          </button>
        </span>
      </div>

      <div className="max-h-72 divide-y divide-border overflow-y-auto rounded-lg border border-border bg-card">
        {paths.map(({ path, methods }) => {
          const picked = value[path] ?? []
          const allPicked = picked.length === methods.length
          const partial = picked.length > 0 && !allPicked
          const isOpen = expanded[path] ?? false
          return (
            <div key={path}>
              <div className="flex items-center gap-2 px-3 py-2">
                <input
                  type="checkbox"
                  aria-label={`Select all methods of ${path}`}
                  checked={allPicked}
                  ref={(el) => {
                    if (el) el.indeterminate = partial
                  }}
                  onChange={() => setPath(path, allPicked ? [] : [...methods])}
                  className="size-4 shrink-0 accent-[var(--primary)]"
                />
                <button
                  type="button"
                  onClick={() => setExpanded((e) => ({ ...e, [path]: !isOpen }))}
                  className="flex min-w-0 flex-1 items-center gap-1.5 text-left"
                >
                  <span className="min-w-0 flex-1 truncate font-mono text-xs">{path}</span>
                  <span className="tnum shrink-0 text-[11px] text-muted-foreground">
                    {picked.length}/{methods.length}
                  </span>
                  <ChevronRight
                    className={cn(
                      'size-3.5 shrink-0 text-muted-foreground transition-transform',
                      isOpen && 'rotate-90',
                    )}
                  />
                </button>
              </div>
              {isOpen && (
                <div className="flex flex-wrap gap-2 px-9 pb-2.5">
                  {methods.map((method) => {
                    const methodPicked = picked.includes(method)
                    return (
                      <label
                        key={method}
                        className={cn(
                          'flex cursor-pointer items-center gap-1.5 rounded-md border px-2 py-1 font-mono text-[11px] uppercase transition-colors',
                          methodPicked
                            ? 'border-primary/50 bg-primary/5'
                            : 'border-border text-muted-foreground hover:bg-accent/40',
                        )}
                      >
                        <input
                          type="checkbox"
                          checked={methodPicked}
                          onChange={() =>
                            setPath(
                              path,
                              methodPicked
                                ? picked.filter((m) => m !== method)
                                : // keep the spec's method order stable
                                  methods.filter((m) => picked.includes(m) || m === method),
                            )
                          }
                          className="size-3.5 accent-[var(--primary)]"
                        />
                        {method}
                      </label>
                    )
                  })}
                </div>
              )}
            </div>
          )
        })}
      </div>
    </div>
  )
}
