import { describe, expect, it } from 'vitest'
import { buildAnalysisRun } from '@/lib/engine/history/record'
import type { AgentRecord, Finding } from '@/types/domain'

const findings: Finding[] = [
  {
    id: 'f1',
    agentId: 'structural-linter',
    operation: 'GET /users',
    rule: 'mcp-operationid-format',
    severity: 'error',
    confidence: 'HIGH',
    message: 'snake_case',
    before: 'GetUsers',
    after: 'get_users',
    autoFixable: true,
    autoFixed: true,
    resolution: 'auto-fixed',
  },
  {
    id: 'f2',
    agentId: 'worker-1',
    operation: 'GET /users',
    rule: 'MCP_NO_WHEN_TO_USE',
    severity: 'warning',
    confidence: 'MEDIUM',
    message: 'vague',
    autoFixable: false,
    autoFixed: false,
    resolution: 'pending',
  },
]

const agents: AgentRecord[] = [
  {
    id: 'structural-linter',
    type: 'structural-linter',
    operations: [],
    filesRead: [],
    findingsCount: 1,
    durationMs: 5,
  },
]

const params = {
  id: 'run-1',
  createdAt: new Date('2026-06-24T00:00:00Z'),
  specSource: 'paste' as const,
  specFile: 'paste',
  mode: 'fix' as const,
  mismatchMode: 'flag' as const,
  durationMs: 100,
  status: 'complete' as const,
  findings,
  summary: { total: 2, errors: 1, warnings: 1, info: 0 },
  agents,
}

describe('buildAnalysisRun', () => {
  it('assembles a run with a summary that counts auto-fixes', () => {
    const run = buildAnalysisRun(params)
    expect(run.id).toBe('run-1')
    expect(run.summary).toMatchObject({
      totalFindings: 2,
      errors: 1,
      warnings: 1,
      info: 0,
      autoFixed: 1,
      accepted: 0,
      rejected: 0,
    })
  })

  it('maps findings into FindingRecords', () => {
    const run = buildAnalysisRun(params)
    expect(run.findings[0]).toMatchObject({
      id: 'f1',
      operation: 'GET /users',
      rule: 'mcp-operationid-format',
      before: 'GetUsers',
      after: 'get_users',
      resolution: 'auto-fixed',
      autoFixed: true,
    })
  })

  it('carries agents and run metadata', () => {
    const run = buildAnalysisRun(params)
    expect(run.agents).toHaveLength(1)
    expect(run.specSource).toBe('paste')
    expect(run.mode).toBe('fix')
    expect(run.status).toBe('complete')
  })
})
