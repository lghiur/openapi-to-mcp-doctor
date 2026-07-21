import { describe, expect, it } from 'vitest'
import type { AnalysisReport } from '@/types/api'
import { failOnGate, renderJobSummary } from './summary'

const report: AnalysisReport = {
  runId: 'run-1',
  timestamp: '2026-06-24T14:23:00Z',
  spec: { file: 'api/openapi.yaml', version: '3.0.3', operationCount: 24 },
  mcpSpecVersion: '2025-11-25',
  mode: 'lint',
  mismatchMode: 'flag',
  durationMs: 12400,
  summary: { total: 14, errors: 3, warnings: 8, info: 3, autoFixed: 2 },
  agents: [
    {
      id: 'structural-linter',
      type: 'structural-linter',
      operations: [],
      filesRead: [],
      findingsCount: 3,
      durationMs: 100,
    },
    {
      id: 'worker-1',
      type: 'worker',
      operations: ['GET /users'],
      filesRead: [],
      findingsCount: 2,
      durationMs: 4200,
    },
  ],
  findings: [
    {
      id: 'f1',
      agentId: 'structural-linter',
      operation: 'GET /users/{id}',
      rule: 'MCP_OPERATIONID_FORMAT',
      severity: 'error',
      confidence: 'HIGH',
      message: 'snake_case',
      autoFixed: false,
      resolution: 'pending',
    },
  ],
}

describe('renderJobSummary', () => {
  it('renders the documented header and metadata', () => {
    const md = renderJobSummary(report)
    expect(md).toContain('## ⚕ MCP Doctor — Run Summary')
    expect(md).toContain('api/openapi.yaml')
    expect(md).toContain('OpenAPI 3.0.3')
    expect(md).toContain('2025-11-25')
  })

  it('renders the results table with counts', () => {
    const md = renderJobSummary(report)
    expect(md).toContain('### Results')
    expect(md).toMatch(/Errors.*3/)
    expect(md).toMatch(/Warnings.*8/)
    expect(md).toMatch(/Auto-fixed.*2/)
  })

  it('renders agent activity and top findings', () => {
    const md = renderJobSummary(report)
    expect(md).toContain('### Agent Activity')
    expect(md).toContain('structural-linter')
    expect(md).toContain('worker-1')
    expect(md).toContain('### Top Findings')
    expect(md).toContain('MCP_OPERATIONID_FORMAT')
  })
})

describe('failOnGate', () => {
  const summary = { errors: 2, warnings: 5, info: 1 }
  it('fails on errors when fail-on=error', () => {
    expect(failOnGate('error', summary)).toBe(true)
    expect(failOnGate('error', { errors: 0, warnings: 5, info: 0 })).toBe(false)
  })
  it('fails on warnings too when fail-on=warning', () => {
    expect(failOnGate('warning', { errors: 0, warnings: 1, info: 0 })).toBe(true)
  })
  it('never fails when fail-on=never', () => {
    expect(failOnGate('never', summary)).toBe(false)
  })
})
