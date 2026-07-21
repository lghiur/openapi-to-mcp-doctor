'use client'

import { CheckCircle2, GitPullRequest, TriangleAlert } from 'lucide-react'
import { useState } from 'react'
import { Button } from '@/components/ui/button'
import { Spinner } from '@/components/ui/spinner'

type PrState =
  | { phase: 'idle' }
  | { phase: 'creating' }
  | { phase: 'done'; url: string; number: number }
  | { phase: 'error'; message: string }

/**
 * "Create PR" action for repo-sourced analyses: commits the patched spec on a
 * new branch via POST /api/github/pr and links to the opened pull request.
 * Enabled only once the user has accepted at least one suggestion.
 */
export function CreatePr({ jobId, acceptedIds }: { jobId: string; acceptedIds: string[] }) {
  const [state, setState] = useState<PrState>({ phase: 'idle' })

  if (state.phase === 'done') {
    return (
      <a
        href={state.url}
        target="_blank"
        rel="noreferrer"
        className="inline-flex h-9 items-center gap-1.5 rounded-lg border border-success/40 bg-success/10 px-3 text-sm font-medium text-success transition-colors hover:bg-success/20"
      >
        <CheckCircle2 className="size-4" />
        PR #{state.number} opened
      </a>
    )
  }

  async function create(): Promise<void> {
    setState({ phase: 'creating' })
    try {
      const res = await fetch('/api/github/pr', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jobId, acceptedIds }),
      })
      const data = (await res.json().catch(() => ({}))) as {
        url?: string
        number?: number
        error?: string
      }
      if (res.ok && typeof data.url === 'string' && typeof data.number === 'number') {
        setState({ phase: 'done', url: data.url, number: data.number })
      } else {
        setState({ phase: 'error', message: data.error ?? 'Could not create the PR.' })
      }
    } catch {
      setState({ phase: 'error', message: 'Could not reach the server.' })
    }
  }

  return (
    <span className="flex items-center gap-2">
      {state.phase === 'error' && (
        <span role="alert" className="flex items-center gap-1 text-xs text-error">
          <TriangleAlert className="size-3.5 shrink-0" />
          {state.message}
        </span>
      )}
      <Button
        type="button"
        onClick={create}
        disabled={acceptedIds.length === 0 || state.phase === 'creating'}
      >
        {state.phase === 'creating' ? <Spinner /> : <GitPullRequest className="size-4" />}
        {state.phase === 'creating' ? 'Opening PR…' : 'Create PR'}
      </Button>
    </span>
  )
}
