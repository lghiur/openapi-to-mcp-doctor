import { describe, expect, it } from 'vitest'
import type { AnalysisReport, ReportFinding } from '@/types/api'
import { diffReports } from './delta'

function finding(overrides: Partial<ReportFinding> = {}): ReportFinding {
  return {
    id: 'f1',
    agentId: 'structural-linter',
    operation: 'GET /users/{id}',
    rule: 'MCP_OPERATIONID_FORMAT',
    severity: 'error',
    confidence: 'HIGH',
    message: 'operationId must be snake_case',
    autoFixed: false,
    resolution: 'pending',
    path: ['paths', '/users/{id}', 'get'],
    ...overrides,
  }
}

function report(
  findings: ReportFinding[],
  summary?: Partial<AnalysisReport['summary']>,
): AnalysisReport {
  return {
    runId: 'run-1',
    timestamp: '2026-07-21T10:00:00Z',
    spec: { file: 'api/openapi.yaml', version: '3.0.3', operationCount: 12 },
    mcpSpecVersion: '2025-11-25',
    mode: 'lint',
    mismatchMode: 'flag',
    durationMs: 1000,
    summary: {
      total: findings.length,
      errors: findings.filter((f) => f.severity === 'error').length,
      warnings: findings.filter((f) => f.severity === 'warning').length,
      info: findings.filter((f) => f.severity === 'info').length,
      autoFixed: 0,
      ...summary,
    },
    agents: [],
    findings,
  }
}

describe('diffReports', () => {
  it('returns an empty delta for identical reports', () => {
    const base = report([finding()])
    const head = report([finding()])
    const delta = diffReports(base, head)
    expect(delta.newFindings).toEqual([])
    expect(delta.resolvedFindings).toEqual([])
  })

  it('reports findings only in head as new and findings only in base as resolved', () => {
    const shared = finding()
    const added = finding({ id: 'f2', rule: 'MCP_PARAM_DESCRIPTION_REQUIRED' })
    const removed = finding({ id: 'f3', rule: 'MCP_RESPONSE_SCHEMA_REQUIRED' })
    const delta = diffReports(report([shared, removed]), report([shared, added]))
    expect(delta.newFindings).toEqual([added])
    expect(delta.resolvedFindings).toEqual([removed])
  })

  it('treats the same rule+operation at a different path as a different finding', () => {
    const atGet = finding({ path: ['paths', '/users/{id}', 'get'] })
    const atPut = finding({ path: ['paths', '/users/{id}', 'put'] })
    const delta = diffReports(report([atGet]), report([atPut]))
    expect(delta.newFindings).toEqual([atPut])
    expect(delta.resolvedFindings).toEqual([atGet])
  })

  it('ignores message wording changes between runs', () => {
    const base = report([finding({ message: 'operationId should use snake_case' })])
    const head = report([finding({ id: 'other-id', message: 'use snake_case for operationId' })])
    const delta = diffReports(base, head)
    expect(delta.newFindings).toEqual([])
    expect(delta.resolvedFindings).toEqual([])
  })

  it('ignores run-scoped id/agentId differences', () => {
    const base = report([finding({ id: 'a', agentId: 'worker-1' })])
    const head = report([finding({ id: 'b', agentId: 'worker-7' })])
    const delta = diffReports(base, head)
    expect(delta.newFindings).toEqual([])
    expect(delta.resolvedFindings).toEqual([])
  })

  it('treats every head finding as new when base is undefined', () => {
    const f1 = finding()
    const f2 = finding({ id: 'f2', rule: 'MCP_ENUM_DESCRIPTION_REQUIRED' })
    const delta = diffReports(undefined, report([f1, f2]))
    expect(delta.newFindings).toEqual([f1, f2])
    expect(delta.resolvedFindings).toEqual([])
    expect(delta.healthBase).toBeUndefined()
  })

  it('keys on missing operation/path without collapsing distinct findings', () => {
    const noOp = finding({ operation: undefined, path: undefined })
    const withOp = finding()
    const delta = diffReports(report([noOp]), report([noOp, withOp]))
    expect(delta.newFindings).toEqual([withOp])
    expect(delta.resolvedFindings).toEqual([])
  })

  it('computes health scores from each report summary', () => {
    // base: 2 errors, 1 warning, 1 info → 100 - 20 - 3 - 1 = 76
    const base = report([], { total: 4, errors: 2, warnings: 1, info: 1 })
    // head: 1 error, 0 warnings, 2 info → 100 - 10 - 2 = 88
    const head = report([], { total: 3, errors: 1, warnings: 0, info: 2 })
    const delta = diffReports(base, head)
    expect(delta.healthBase).toBe(76)
    expect(delta.healthHead).toBe(88)
  })
})
