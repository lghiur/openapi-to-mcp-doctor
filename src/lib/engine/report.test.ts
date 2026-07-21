import { describe, expect, it } from 'vitest'
import { buildStructuralReport } from '@/lib/engine/report'
import { AnalysisReportSchema } from '@/types/api'
import type { Finding } from '@/types/domain'

const finding: Finding = {
  id: 'mcp-operationid-required:paths//users/post',
  agentId: 'structural-linter',
  operation: 'POST /users',
  rule: 'mcp-operationid-required',
  severity: 'error',
  confidence: 'HIGH',
  message: 'operationId is missing.',
  before: '',
  after: 'create_user',
  path: ['paths', '/users', 'post', 'operationId'],
  autoFixable: false,
  autoFixed: false,
  resolution: 'pending',
}

const params = {
  runId: 'run-1',
  timestamp: '2026-06-24T00:00:00Z',
  specFile: 'api/openapi.yaml',
  version: '3.0' as const,
  operationCount: 2,
  mcpVersion: '2025-11-25',
  mode: 'lint' as const,
  mismatchMode: 'flag' as const,
  durationMs: 12,
  findings: [finding],
  summary: { total: 1, errors: 1, warnings: 0, info: 0 },
}

describe('buildStructuralReport', () => {
  it('produces a report that validates against the JSON report schema', () => {
    const report = buildStructuralReport(params)
    expect(() => AnalysisReportSchema.parse(report)).not.toThrow()
  })

  it('records a single structural-linter agent and zero auto-fixes', () => {
    const report = buildStructuralReport(params)
    expect(report.summary.autoFixed).toBe(0)
    expect(report.agents).toHaveLength(1)
    expect(report.agents[0]).toMatchObject({ id: 'structural-linter', type: 'structural-linter' })
  })

  it('maps engine findings into report findings', () => {
    const report = buildStructuralReport(params)
    expect(report.findings[0]).toMatchObject({
      rule: 'mcp-operationid-required',
      operation: 'POST /users',
      severity: 'error',
      confidence: 'HIGH',
      after: 'create_user',
    })
  })

  it('carries spec metadata through', () => {
    const report = buildStructuralReport(params)
    expect(report.spec).toEqual({ file: 'api/openapi.yaml', version: '3.0', operationCount: 2 })
    expect(report.mcpSpecVersion).toBe('2025-11-25')
  })
})
