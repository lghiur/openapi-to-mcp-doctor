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

describe('renderJobSummary — untrusted cell escaping', () => {
  const hostile: AnalysisReport = {
    ...report,
    findings: [
      {
        id: 'h1',
        agentId: 'structural-linter',
        operation: 'GET /a|b\nc @octocat',
        rule: 'EVIL|RULE\n@team',
        severity: 'error',
        confidence: 'HIGH',
        message: 'x',
        autoFixed: false,
        resolution: 'pending',
      },
    ],
  }

  it('escapes pipes so hostile values cannot break the table', () => {
    const md = renderJobSummary(hostile)
    expect(md).toContain('a\\|b')
    expect(md).toContain('EVIL\\|RULE')
  })

  it('flattens newlines inside cells', () => {
    const md = renderJobSummary(hostile)
    const findingRow = md.split('\n').find((line) => line.includes('EVIL'))
    expect(findingRow).toBeDefined()
    expect(findingRow).toContain('c @')
  })

  it('neutralizes @mentions in cells', () => {
    const md = renderJobSummary(hostile)
    expect(md).not.toContain('@octocat')
    expect(md).not.toContain('@team')
    expect(md).toContain('@\u200bocto')
  })
})

describe('renderJobSummary — top findings ordering', () => {
  it('sorts findings error > warning > info before slicing the top 10', () => {
    const finding = (id: string, severity: 'error' | 'warning' | 'info') => ({
      id,
      agentId: 'structural-linter',
      operation: `GET /${id}`,
      rule: `RULE_${id.toUpperCase()}`,
      severity,
      confidence: 'HIGH' as const,
      message: 'm',
      autoFixed: false,
      resolution: 'pending' as const,
    })
    // ten info findings first in emission order, then one error — without the
    // sort, the error falls off the top-10 slice.
    const many: AnalysisReport = {
      ...report,
      findings: [
        ...Array.from({ length: 10 }, (_, i) => finding(`i${i}`, 'info')),
        finding('w1', 'warning'),
        finding('e1', 'error'),
      ],
    }
    const md = renderJobSummary(many)
    expect(md).toContain('RULE_E1')
    expect(md).toContain('RULE_W1')
    const errorAt = md.indexOf('RULE_E1')
    const warningAt = md.indexOf('RULE_W1')
    expect(errorAt).toBeLessThan(warningAt)
  })

  it('keeps emission order within the same severity (stable sort)', () => {
    const finding = (id: string) => ({
      id,
      agentId: 'structural-linter',
      operation: `GET /${id}`,
      rule: `RULE_${id.toUpperCase()}`,
      severity: 'warning' as const,
      confidence: 'HIGH' as const,
      message: 'm',
      autoFixed: false,
      resolution: 'pending' as const,
    })
    const md = renderJobSummary({ ...report, findings: [finding('first'), finding('second')] })
    expect(md.indexOf('RULE_FIRST')).toBeLessThan(md.indexOf('RULE_SECOND'))
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
