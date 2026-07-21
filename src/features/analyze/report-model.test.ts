import { describe, expect, it } from 'vitest'
import { buildReportModel } from '@/features/analyze/report-model'
import type { Finding } from '@/types/domain'

const f = (over: Partial<Finding> & Pick<Finding, 'severity'>): Finding => ({
  id: Math.random().toString(36).slice(2),
  agentId: 'a',
  rule: 'r',
  confidence: 'HIGH',
  message: 'm',
  autoFixable: false,
  autoFixed: false,
  resolution: 'pending',
  ...over,
})

describe('buildReportModel', () => {
  const findings: Finding[] = [
    f({ severity: 'warning', operation: 'GET /users' }),
    f({ severity: 'error', operation: 'GET /users' }),
    f({ severity: 'error', operation: 'POST /users' }),
    f({ severity: 'info' }), // no operation — counted in summary, not in the per-op table
  ]
  const summary = { total: 4, errors: 2, warnings: 1, info: 1 }
  const model = buildReportModel({ summary, findings })

  it('computes a 0–100 readiness score from the summary', () => {
    expect(model.score).toBeGreaterThanOrEqual(0)
    expect(model.score).toBeLessThanOrEqual(100)
  })

  it('passes the summary through', () => {
    expect(model.summary).toEqual(summary)
  })

  it('groups findings by operation, worst first (equal errors → more findings first)', () => {
    // Both have 1 error; GET /users has more total findings, so it ranks first.
    expect(model.operations.map((o) => o.operation)).toEqual(['GET /users', 'POST /users'])
    const getUsers = model.operations.find((o) => o.operation === 'GET /users')
    expect(getUsers).toMatchObject({ errors: 1, warnings: 1, info: 0, total: 2 })
  })

  it('omits findings with no operation from the per-operation table', () => {
    expect(model.operations.some((o) => o.operation === undefined)).toBe(false)
    expect(model.operations).toHaveLength(2)
  })

  it('orders the full findings list error-first', () => {
    expect(model.findings[0]?.severity).toBe('error')
    expect(model.findings.at(-1)?.severity).toBe('info')
  })
})
