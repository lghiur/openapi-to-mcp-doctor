'use client'

import { Check, Pencil, RotateCcw, TriangleAlert, X } from 'lucide-react'
import { useState } from 'react'
import { Button } from '@/components/ui/button'
import { Textarea } from '@/components/ui/textarea'
import { ConfidenceBadge, OwaspBadge, SeverityBadge } from '@/components/ui/severity'
import { cn } from '@/lib/utils'
import type { Decision } from '@/features/analyze/review'
import type { SSEFinding } from '@/types/domain'

interface SuggestionCardProps {
  finding: SSEFinding
  decision: Decision
  editedContent: string | undefined
  onAccept: () => void
  onReject: () => void
  onEdit: (content: string) => void
  onReset: () => void
}

/** A diff block labelled before/after with monospace content. */
function DiffBlock({
  label,
  tone,
  children,
}: {
  label: string
  tone: 'before' | 'after' | 'code'
  children: React.ReactNode
}) {
  return (
    <div>
      <p
        className={cn(
          'mb-1 text-[11px] font-semibold uppercase tracking-wide',
          tone === 'before' && 'text-error/80',
          tone === 'after' && 'text-success/90',
          tone === 'code' && 'text-info/90',
        )}
      >
        {label}
      </p>
      <pre
        className={cn(
          'overflow-x-auto whitespace-pre-wrap rounded-lg border px-3 py-2 font-mono text-xs leading-relaxed',
          tone === 'before' && 'border-error/20 bg-error/5',
          tone === 'after' && 'border-success/20 bg-success/5',
          tone === 'code' && 'border-info/20 bg-info/5',
        )}
      >
        {children}
      </pre>
    </div>
  )
}

export function SuggestionCard({
  finding,
  decision,
  editedContent,
  onAccept,
  onReject,
  onEdit,
  onReset,
}: SuggestionCardProps) {
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(editedContent ?? finding.suggested ?? '')
  const isMismatch = finding.actual !== undefined
  const after = editedContent ?? finding.suggested

  return (
    <div
      id={`finding-${finding.id}`}
      className={cn(
        'animate-rise rounded-xl border bg-card p-4 shadow-sm transition-colors',
        decision === 'accepted' && 'border-success/40 ring-1 ring-success/20',
        decision === 'rejected' && 'border-border opacity-60',
        decision === 'pending' && 'border-border',
      )}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          {finding.operation && (
            <p className="truncate font-mono text-xs font-medium text-foreground">
              {finding.operation}
            </p>
          )}
          <p className="mt-0.5 font-mono text-[11px] text-muted-foreground">{finding.rule}</p>
        </div>
        <div className="flex shrink-0 flex-wrap items-center justify-end gap-1.5">
          {finding.owasp && <OwaspBadge owasp={finding.owasp} />}
          <SeverityBadge severity={finding.severity} />
          <ConfidenceBadge confidence={finding.confidence} />
        </div>
      </div>

      <p className="mt-2.5 text-sm text-foreground/90">{finding.message}</p>

      {finding.warning && (
        <div className="mt-3 flex items-start gap-2 rounded-lg border border-error/30 bg-error/8 px-3 py-2 text-xs text-error">
          <TriangleAlert className="mt-0.5 size-3.5 shrink-0" />
          <span>{finding.warning}</span>
        </div>
      )}

      {editing ? (
        <div className="mt-3 space-y-2">
          <Textarea
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            className="min-h-[120px] text-xs"
            aria-label="Edit suggestion"
          />
          <div className="flex justify-end gap-2">
            <Button size="sm" variant="ghost" onClick={() => setEditing(false)}>
              Cancel
            </Button>
            <Button
              size="sm"
              onClick={() => {
                onEdit(draft)
                setEditing(false)
              }}
            >
              <Check className="size-3.5" />
              Confirm edit
            </Button>
          </div>
        </div>
      ) : (
        <div className="mt-3 space-y-3">
          {finding.current !== undefined && (
            <DiffBlock label={isMismatch ? 'Spec claims' : 'Before'} tone="before">
              {finding.current}
            </DiffBlock>
          )}
          {isMismatch && finding.actual !== undefined && (
            <DiffBlock label="Code does" tone="code">
              {finding.actual}
            </DiffBlock>
          )}
          {after !== undefined && (
            <DiffBlock label={isMismatch ? 'Suggested fix' : 'After (suggested)'} tone="after">
              {after}
            </DiffBlock>
          )}
        </div>
      )}

      {!editing && (
        <div className="mt-3.5 flex flex-wrap items-center gap-2">
          {decision === 'pending' ? (
            <>
              <Button size="sm" variant="success" onClick={onAccept}>
                <Check className="size-3.5" />
                Accept
              </Button>
              {finding.suggested !== undefined && (
                <Button size="sm" variant="outline" onClick={() => setEditing(true)}>
                  <Pencil className="size-3.5" />
                  Edit
                </Button>
              )}
              <Button size="sm" variant="ghost" onClick={onReject}>
                <X className="size-3.5" />
                Reject
              </Button>
            </>
          ) : (
            <>
              <span
                className={cn(
                  'inline-flex items-center gap-1.5 text-xs font-medium',
                  decision === 'accepted' ? 'text-success' : 'text-muted-foreground',
                )}
              >
                {decision === 'accepted' ? (
                  <Check className="size-3.5" />
                ) : (
                  <X className="size-3.5" />
                )}
                {decision === 'accepted'
                  ? editedContent !== undefined
                    ? 'Accepted · edited'
                    : 'Accepted'
                  : 'Rejected'}
              </span>
              <Button size="sm" variant="ghost" onClick={onReset} className="ml-auto">
                <RotateCcw className="size-3.5" />
                Undo
              </Button>
            </>
          )}
        </div>
      )}
    </div>
  )
}
