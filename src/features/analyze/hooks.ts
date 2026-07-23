'use client'

import { useCallback, useEffect, useReducer, useRef, useState } from 'react'
import { type AnalysisState, analysisReducer, initialAnalysisState } from '@/features/analyze/state'
import type { SSEEvent } from '@/types/domain'

const EVENT_TYPES = [
  'analysis_started',
  'agent_started',
  'agent_completed',
  'finding',
  'file_read',
  'postprocess_started',
  'analysis_complete',
  'notice',
] as const

/** If no event arrives for this long while streaming, flag the run as stalled. */
const STALL_MS = 20_000

export type StreamPhase = 'connecting' | 'streaming' | 'complete' | 'cancelled' | 'error'

export interface AnalysisStream {
  state: AnalysisState
  phase: StreamPhase
  /** True when no events have arrived for a while and the run hasn't finished. */
  stalled: boolean
  /** Stop the run: aborts the server work and marks the job cancelled. */
  cancel: () => void
  /** Discard partial results and re-run the analysis from scratch. */
  retry: () => void
}

/**
 * Open the SSE stream for a job and fold its events into analysis state, while
 * tracking connection lifecycle. Unlike a naive EventSource hook, this never
 * silently sticks on "analysing": a close-before-complete becomes `error`, a
 * long silence becomes `stalled`, and the run can be cancelled or retried.
 */
export function useAnalysisStream(jobId: string): AnalysisStream {
  const [state, dispatch] = useReducer(analysisReducer, initialAnalysisState)
  const [phase, setPhase] = useState<StreamPhase>('connecting')
  const [stalled, setStalled] = useState(false)
  const [attempt, setAttempt] = useState(0)

  const sourceRef = useRef<EventSource | null>(null)
  const terminalRef = useRef(false)
  const stallTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  const clearStall = useCallback(() => {
    if (stallTimer.current) clearTimeout(stallTimer.current)
    stallTimer.current = null
  }, [])

  const armStall = useCallback(() => {
    clearStall()
    stallTimer.current = setTimeout(() => {
      if (!terminalRef.current) setStalled(true)
    }, STALL_MS)
  }, [clearStall])

  useEffect(() => {
    // Phase/stalled are reset by retry() (the only re-entry) and by the initial
    // mount defaults, so we avoid synchronous setState here.
    terminalRef.current = false
    armStall()

    const source = new EventSource(`/api/jobs/${jobId}/stream`)
    sourceRef.current = source

    const onActivity = () => {
      setStalled(false)
      armStall()
      if (!terminalRef.current) setPhase('streaming')
    }

    const handle = (event: MessageEvent<string>) => {
      onActivity()
      try {
        dispatch(JSON.parse(event.data) as SSEEvent)
      } catch {
        // ignore malformed frames
      }
    }

    source.onopen = onActivity
    for (const type of EVENT_TYPES) source.addEventListener(type, handle as EventListener)

    source.addEventListener('analysis_complete', () => {
      terminalRef.current = true
      clearStall()
      setPhase('complete')
      source.close()
    })

    source.onerror = () => {
      // A clean close after completion/cancel also fires onerror — ignore those.
      if (terminalRef.current) return
      terminalRef.current = true
      clearStall()
      setPhase('error')
      source.close()
    }

    return () => {
      clearStall()
      source.close()
    }
  }, [jobId, attempt, armStall, clearStall])

  const cancel = useCallback(() => {
    if (terminalRef.current) return
    terminalRef.current = true
    clearStall()
    sourceRef.current?.close()
    setPhase('cancelled')
    void fetch(`/api/jobs/${jobId}/cancel`, { method: 'POST' }).catch(() => {})
  }, [jobId, clearStall])

  const retry = useCallback(() => {
    dispatch({ type: 'reset' })
    setPhase('connecting')
    setStalled(false)
    setAttempt((n) => n + 1)
  }, [])

  return { state, phase, stalled, cancel, retry }
}
