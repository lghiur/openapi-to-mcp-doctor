import { describe, expect, it } from 'vitest'
import type { ReportFinding } from '@/types/api'
import type { LocatedFinding } from '../gh/types'
import { renderAnnotations } from './annotations'

function finding(overrides: Partial<ReportFinding> = {}): ReportFinding {
  return {
    id: 'f1',
    agentId: 'structural-linter',
    rule: 'mcp-operationid-required',
    severity: 'error',
    confidence: 'HIGH',
    message: 'operationId is missing',
    autoFixed: false,
    resolution: 'pending',
    ...overrides,
  }
}

function located(overrides: Partial<LocatedFinding> = {}): LocatedFinding {
  return { finding: finding(), file: 'api/openapi.yaml', line: 12, target: 'spec', ...overrides }
}

describe('renderAnnotations', () => {
  it('renders one workflow command per finding', () => {
    const lines = renderAnnotations([located(), located({ line: 30 })])
    expect(lines).toHaveLength(2)
    expect(lines[0]).toBe(
      '::error file=api/openapi.yaml,line=12,title=mcp-operationid-required::operationId is missing',
    )
  })

  it('returns an empty array for no findings', () => {
    expect(renderAnnotations([])).toEqual([])
  })

  it('maps severity to the workflow command level', () => {
    const lines = renderAnnotations([
      located({ finding: finding({ severity: 'error' }) }),
      located({ finding: finding({ severity: 'warning' }) }),
      located({ finding: finding({ severity: 'info' }) }),
    ])
    expect(lines[0]).toMatch(/^::error /)
    expect(lines[1]).toMatch(/^::warning /)
    expect(lines[2]).toMatch(/^::notice /)
  })

  it('omits line= when the line is unresolved', () => {
    const [line] = renderAnnotations([located({ line: undefined })])
    expect(line).toBe(
      '::error file=api/openapi.yaml,title=mcp-operationid-required::operationId is missing',
    )
  })

  it('escapes %, \\r and \\n in the message', () => {
    const [line] = renderAnnotations([
      located({ finding: finding({ message: '50% of\r\nops fail' }) }),
    ])
    expect(line?.endsWith('::50%25 of%0D%0Aops fail')).toBe(true)
  })

  it('additionally escapes : and , in file and title property values', () => {
    const [line] = renderAnnotations([
      located({ file: 'a:b,c.yaml', finding: finding({ rule: 'rule: x, y' }) }),
    ])
    expect(line).toContain('file=a%3Ab%2Cc.yaml')
    expect(line).toContain('title=rule%3A x%2C y')
  })

  it('escapes % before : and , in property values (no double escaping)', () => {
    const [line] = renderAnnotations([located({ file: '100%:done.yaml' })])
    expect(line).toContain('file=100%25%3Adone.yaml')
  })
})
