import { describe, expect, it } from 'vitest'
import { renderHuman, type HumanReportInput } from './human'
import type { Finding } from '@/types/domain'

const findings: Finding[] = [
  {
    id: 'a',
    agentId: 'structural-linter',
    operation: 'POST /users',
    rule: 'mcp-operationid-required',
    severity: 'error',
    confidence: 'HIGH',
    message: 'operationId is missing.',
    autoFixable: false,
    autoFixed: false,
    resolution: 'pending',
    path: ['paths', '/users', 'post'],
  },
  {
    id: 'b',
    agentId: 'structural-linter',
    operation: 'GET /users',
    rule: 'mcp-description-too-short',
    severity: 'warning',
    confidence: 'HIGH',
    message: 'Description is very short.',
    autoFixable: false,
    autoFixed: false,
    resolution: 'pending',
  },
]

const base: HumanReportInput = {
  specFile: 'api/openapi.yaml',
  version: '3.0',
  mcpVersion: '2025-11-25',
  healthScore: 77,
  summary: { total: 2, errors: 1, warnings: 1, info: 0 },
  findings,
  color: false,
}

const ANSI = /\x1b\[/

describe('renderHuman', () => {
  it('renders the header with spec file, version, and MCP version', () => {
    const out = renderHuman(base)
    expect(out).toContain('api/openapi.yaml')
    expect(out).toContain('3.0')
    expect(out).toContain('2025-11-25')
  })

  it('renders the health score and severity counts', () => {
    const out = renderHuman(base)
    expect(out).toContain('77')
    expect(out).toContain('1 error')
    expect(out).toContain('1 warning')
  })

  it('groups findings by severity and shows rule, operation, and message', () => {
    const out = renderHuman(base)
    expect(out).toContain('mcp-operationid-required')
    expect(out).toContain('POST /users')
    expect(out).toContain('operationId is missing.')
  })

  it('emits no ANSI escapes when color is disabled', () => {
    expect(ANSI.test(renderHuman({ ...base, color: false }))).toBe(false)
  })

  it('emits ANSI escapes when color is enabled', () => {
    expect(ANSI.test(renderHuman({ ...base, color: true }))).toBe(true)
  })

  it('shows MCP tool loadability when a simulation summary is provided', () => {
    const out = renderHuman({ ...base, mcp: { loadable: 1, total: 2 } })
    expect(out).toContain('MCP tools: 1/2 operations loadable')
  })

  it('omits the MCP line when no simulation summary is provided', () => {
    expect(renderHuman(base)).not.toContain('MCP tools:')
  })

  it('shows a clean message when there are no findings', () => {
    const out = renderHuman({
      ...base,
      summary: { total: 0, errors: 0, warnings: 0, info: 0 },
      findings: [],
      healthScore: 100,
    })
    expect(out.toLowerCase()).toContain('no findings')
  })
})
