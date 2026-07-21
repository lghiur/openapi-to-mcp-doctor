import { describe, expect, it } from 'vitest'
import { analysisReducer, initialAnalysisState } from '@/features/analyze/state'
import { buildOperationRows } from '@/features/analyze/components/op-status'
import type { SSEEvent } from '@/types/domain'

function reduce(events: SSEEvent[]) {
  return events.reduce(analysisReducer, initialAnalysisState)
}

const finding = (operation: string, severity: 'error' | 'warning' | 'info'): SSEEvent => ({
  type: 'finding',
  id: `${operation}-${severity}`,
  agentId: 'structural-linter',
  operation,
  rule: 'R',
  severity,
  confidence: 'HIGH',
  message: 'm',
  autoFixable: false,
})

describe('buildOperationRows — denominator', () => {
  it('lists every operation as pending up front, before any work', () => {
    const state = reduce([
      { type: 'analysis_started', operations: ['GET /a', 'POST /a', 'GET /b'], phases: ['structural'] },
    ])
    const rows = buildOperationRows(state)
    expect(rows.map((r) => r.operation).sort()).toEqual(['GET /a', 'GET /b', 'POST /a'])
    expect(rows.every((r) => r.status === 'pending')).toBe(true)
  })

  it('structural-only: shows analysing while the linter runs', () => {
    const state = reduce([
      { type: 'analysis_started', operations: ['GET /a'], phases: ['structural'] },
      { type: 'agent_started', agentId: 'structural-linter', operations: [] },
    ])
    expect(buildOperationRows(state)[0]?.status).toBe('analysing')
  })

  it('structural-only: after the linter completes, clean ops are clean and flagged ops carry severity', () => {
    const state = reduce([
      { type: 'analysis_started', operations: ['GET /a', 'GET /b'], phases: ['structural'] },
      { type: 'agent_started', agentId: 'structural-linter', operations: [] },
      finding('GET /a', 'error'),
      { type: 'agent_completed', agentId: 'structural-linter', findingsCount: 1, durationMs: 1 },
    ])
    const byOp = Object.fromEntries(buildOperationRows(state).map((r) => [r.operation, r]))
    expect(byOp['GET /a']?.status).toBe('error')
    expect(byOp['GET /a']?.findings).toBe(1)
    expect(byOp['GET /b']?.status).toBe('clean')
  })

  it('AI mode: an op stays pending until its worker runs, even after structural is done', () => {
    const state = reduce([
      {
        type: 'analysis_started',
        operations: ['GET /a', 'GET /b'],
        phases: ['structural', 'workers'],
      },
      { type: 'agent_started', agentId: 'structural-linter', operations: [] },
      { type: 'agent_completed', agentId: 'structural-linter', findingsCount: 0, durationMs: 1 },
      { type: 'agent_started', agentId: 'worker-1', operations: ['GET /a'] },
    ])
    const byOp = Object.fromEntries(buildOperationRows(state).map((r) => [r.operation, r]))
    expect(byOp['GET /a']?.status).toBe('analysing') // worker running
    expect(byOp['GET /b']?.status).toBe('pending') // worker not started — NOT cleaned by structural
  })

  it('falls back to deriving rows from findings when no operations were seeded', () => {
    const state = reduce([finding('GET /legacy', 'warning')])
    const row = buildOperationRows(state)[0]
    expect(row?.operation).toBe('GET /legacy')
    expect(row?.status).toBe('warning')
  })
})
