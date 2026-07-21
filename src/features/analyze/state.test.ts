import { describe, expect, it } from 'vitest'
import { type AnalysisAction, analysisReducer, initialAnalysisState } from '@/features/analyze/state'
import type { SSEEvent } from '@/types/domain'

function reduce(events: SSEEvent[]) {
  return events.reduce(analysisReducer, initialAnalysisState)
}

describe('analysisReducer', () => {
  it('tracks agents from started/completed events', () => {
    const state = reduce([
      { type: 'agent_started', agentId: 'worker-1', operations: ['GET /a'] },
      { type: 'agent_completed', agentId: 'worker-1', findingsCount: 2, durationMs: 100 },
    ])
    expect(state.agents).toHaveLength(1)
    expect(state.agents[0]).toMatchObject({ agentId: 'worker-1', findingsCount: 2, done: true })
  })

  it('accumulates findings', () => {
    const state = reduce([
      {
        type: 'finding',
        id: 'f1',
        agentId: 'worker-1',
        operation: 'GET /a',
        rule: 'R',
        severity: 'warning',
        confidence: 'MEDIUM',
        message: 'm',
        autoFixable: false,
      },
    ])
    expect(state.findings).toHaveLength(1)
    expect(state.findings[0]?.rule).toBe('R')
  })

  it('upserts a finding re-emitted with the same id (fix-suggester enrichment)', () => {
    const base = {
      type: 'finding' as const,
      id: 'f1',
      agentId: 'structural-linter',
      operation: 'GET /a',
      rule: 'mcp-param-description-required',
      severity: 'warning' as const,
      confidence: 'HIGH' as const,
      message: 'missing description',
      autoFixable: false,
    }
    const state = reduce([
      base,
      {
        ...base,
        agentId: 'fix-suggester',
        confidence: 'MEDIUM' as const,
        suggested: 'Zero-based page number.',
      },
    ])
    // replaced in place, not duplicated
    expect(state.findings).toHaveLength(1)
    expect(state.findings[0]).toMatchObject({
      id: 'f1',
      suggested: 'Zero-based page number.',
      confidence: 'MEDIUM',
    })
  })

  it('marks completion and records totals', () => {
    const state = reduce([
      {
        type: 'analysis_complete',
        totalFindings: 3,
        errors: 1,
        warnings: 2,
        info: 0,
        durationMs: 9,
      },
    ])
    expect(state.complete).toBe(true)
    expect(state.totals).toEqual({ total: 3, errors: 1, warnings: 2, info: 0, durationMs: 9 })
  })

  it('does not mutate the input state', () => {
    const before = initialAnalysisState
    analysisReducer(before, { type: 'agent_started', agentId: 'w', operations: [] })
    expect(before.agents).toHaveLength(0)
  })

  it('seeds planned phases and the operation denominator from analysis_started', () => {
    const state = reduce([
      {
        type: 'analysis_started',
        operations: ['GET /a', 'POST /a'],
        phases: ['structural', 'workers', 'postprocess'],
      },
    ])
    expect(state.operations).toEqual(['GET /a', 'POST /a'])
    expect(state.plannedPhases).toEqual(['structural', 'workers', 'postprocess'])
    expect(state.phaseStatus).toEqual({
      structural: 'pending',
      workers: 'pending',
      postprocess: 'pending',
    })
  })

  it('moves the structural phase active → done as its agent runs', () => {
    const started = reduce([
      { type: 'analysis_started', operations: [], phases: ['structural'] },
      { type: 'agent_started', agentId: 'structural-linter', operations: [] },
    ])
    expect(started.phaseStatus.structural).toBe('active')
    const done = analysisReducer(started, {
      type: 'agent_completed',
      agentId: 'structural-linter',
      findingsCount: 0,
      durationMs: 1,
    })
    expect(done.phaseStatus.structural).toBe('done')
  })

  it('activates workers, then hands off to postprocess on postprocess_started', () => {
    const state = reduce([
      {
        type: 'analysis_started',
        operations: ['GET /a', 'GET /b'],
        phases: ['structural', 'workers', 'postprocess'],
      },
      { type: 'agent_started', agentId: 'worker-1', operations: ['GET /a'] },
    ])
    expect(state.phaseStatus.workers).toBe('active')
    const next = analysisReducer(state, {
      type: 'postprocess_started',
      check: 'near-duplicate-detection',
      operationCount: 2,
    })
    expect(next.phaseStatus.workers).toBe('done')
    expect(next.phaseStatus.postprocess).toBe('active')
  })

  it('marks every planned phase done on analysis_complete', () => {
    const state = reduce([
      {
        type: 'analysis_started',
        operations: ['GET /a'],
        phases: ['structural', 'workers'],
      },
      { type: 'analysis_complete', totalFindings: 0, errors: 0, warnings: 0, info: 0, durationMs: 5 },
    ])
    expect(state.phaseStatus).toEqual({ structural: 'done', workers: 'done' })
  })

  it('reset returns a fresh initial state (for retry)', () => {
    const dirty = reduce([
      { type: 'agent_started', agentId: 'worker-1', operations: ['GET /a'] },
    ])
    expect(dirty.agents).toHaveLength(1)
    const action: AnalysisAction = { type: 'reset' }
    const fresh = analysisReducer(dirty, action)
    expect(fresh).toEqual(initialAnalysisState)
  })
})
