import { parse as parseYaml } from 'yaml'
import { describe, expect, it } from 'vitest'
import { applyFixes } from '@/lib/engine/fix/apply'
import type { Finding } from '@/types/domain'

function finding(partial: Partial<Finding> & Pick<Finding, 'rule' | 'confidence'>): Finding {
  return {
    id: partial.id ?? partial.rule,
    agentId: 'worker-1',
    severity: 'warning',
    message: 'm',
    autoFixable: true,
    autoFixed: false,
    resolution: 'pending',
    ...partial,
  }
}

const YAML_SPEC = `openapi: 3.0.3
info:
  title: API
  version: 1.0.0
paths:
  /users:
    get:
      operationId: GetUsers
      description: short
`

describe('applyFixes — confidence thresholds', () => {
  const high = finding({
    rule: 'h',
    confidence: 'HIGH',
    path: ['info', 'title'],
    after: 'High Applied',
  })
  const medium = finding({
    rule: 'm',
    confidence: 'MEDIUM',
    path: ['info', 'version'],
    after: '2.0.0',
  })
  const low = finding({
    rule: 'l',
    confidence: 'LOW',
    path: ['info', 'description'],
    after: 'Low desc',
  })
  const findings = [high, medium, low]

  it('high threshold applies only HIGH-confidence fixes', () => {
    const result = applyFixes({ spec: YAML_SPEC, findings, threshold: 'high', version: '3.0' })
    expect(result.applied.map((f) => f.rule)).toEqual(['h'])
    expect(parseYaml(result.patched).info.title).toBe('High Applied')
    expect(parseYaml(result.patched).info.version).toBe('1.0.0')
  })

  it('medium threshold also applies MEDIUM fixes', () => {
    const result = applyFixes({ spec: YAML_SPEC, findings, threshold: 'medium', version: '3.0' })
    expect(result.applied.map((f) => f.rule).sort()).toEqual(['h', 'm'])
  })

  it('low threshold applies all and warns about LOW fixes', () => {
    const result = applyFixes({ spec: YAML_SPEC, findings, threshold: 'low', version: '3.0' })
    expect(result.applied.map((f) => f.rule).sort()).toEqual(['h', 'l', 'm'])
    expect(result.warnings.join(' ')).toMatch(/LOW/)
  })
})

describe('applyFixes — version-aware structural fixes', () => {
  it('snake_cases an operationId', () => {
    const f = finding({
      rule: 'mcp-operationid-format',
      confidence: 'HIGH',
      path: ['paths', '/users', 'get', 'operationId'],
    })
    const result = applyFixes({ spec: YAML_SPEC, findings: [f], threshold: 'high', version: '3.0' })
    expect(parseYaml(result.patched).paths['/users'].get.operationId).toBe('get_users')
  })

  it('converts nullable to a 3.1 type-array and removes nullable', () => {
    const spec = `openapi: 3.1.0
info:
  title: API
  version: 1.0.0
components:
  schemas:
    User:
      type: object
      properties:
        name:
          type: string
          nullable: true
`
    const f = finding({
      rule: 'mcp-nullable-deprecated',
      confidence: 'MEDIUM',
      path: ['components', 'schemas', 'User', 'properties', 'name', 'nullable'],
    })
    const result = applyFixes({ spec, findings: [f], threshold: 'medium', version: '3.1' })
    const name = parseYaml(result.patched).components.schemas.User.properties.name
    expect(name.type).toEqual(['string', 'null'])
    expect(name.nullable).toBeUndefined()
  })
})

describe('applyFixes — spec/code mismatch gating', () => {
  const mismatch = finding({
    rule: 'SPEC_CODE_MISMATCH',
    confidence: 'LOW',
    path: ['paths', '/users', 'get', 'description'],
    after: 'Returns 204 No Content on success.',
  })

  it('skips mismatch fixes in flag mode (the default), even at the low threshold', () => {
    const result = applyFixes({
      spec: YAML_SPEC,
      findings: [mismatch],
      threshold: 'low',
      version: '3.0',
    })
    expect(result.applied).toHaveLength(0)
    expect(result.skipped.map((f) => f.rule)).toEqual(['SPEC_CODE_MISMATCH'])
    expect(parseYaml(result.patched).paths['/users'].get.description).toBe('short')
  })

  it('applies mismatch fixes with mismatchMode fix + low threshold, and warns loudly', () => {
    const result = applyFixes({
      spec: YAML_SPEC,
      findings: [mismatch],
      threshold: 'low',
      version: '3.0',
      mismatchMode: 'fix',
    })
    expect(result.applied.map((f) => f.rule)).toEqual(['SPEC_CODE_MISMATCH'])
    expect(parseYaml(result.patched).paths['/users'].get.description).toBe(
      'Returns 204 No Content on success.',
    )
    expect(result.warnings.join(' ')).toMatch(/spec\/code mismatch/)
  })

  it('still gates mismatch fixes by confidence even in fix mode', () => {
    const result = applyFixes({
      spec: YAML_SPEC,
      findings: [mismatch],
      threshold: 'high',
      version: '3.0',
      mismatchMode: 'fix',
    })
    expect(result.applied).toHaveLength(0)
  })
})

describe('applyFixes — agent path validation and value coercion', () => {
  it('skips a suggestion whose path parent does not exist (hallucinated location)', () => {
    const f = finding({
      rule: 'h',
      confidence: 'HIGH',
      path: ['paths', '/ghosts', 'get', 'description'],
      after: 'nope',
    })
    const result = applyFixes({ spec: YAML_SPEC, findings: [f], threshold: 'high', version: '3.0' })
    expect(result.applied).toHaveLength(0)
    expect(result.skipped.map((f2) => f2.rule)).toEqual(['h'])
    expect(parseYaml(result.patched).paths['/ghosts']).toBeUndefined()
  })

  it('allows the final key to be a new field on an existing parent (adding a description)', () => {
    const f = finding({
      rule: 'h',
      confidence: 'HIGH',
      path: ['paths', '/users', 'get', 'summary'],
      after: 'List users',
    })
    const result = applyFixes({ spec: YAML_SPEC, findings: [f], threshold: 'high', version: '3.0' })
    expect(result.applied).toHaveLength(1)
    expect(parseYaml(result.patched).paths['/users'].get.summary).toBe('List users')
  })

  it('parses a JSON-encoded suggestion when the target is not a string', () => {
    const spec = `openapi: 3.0.3
info:
  title: API
  version: 1.0.0
paths:
  /users:
    get:
      operationId: get_users
      deprecated: false
`
    const f = finding({
      rule: 'h',
      confidence: 'HIGH',
      path: ['paths', '/users', 'get', 'deprecated'],
      after: 'true',
    })
    const result = applyFixes({ spec, findings: [f], threshold: 'high', version: '3.0' })
    expect(parseYaml(result.patched).paths['/users'].get.deprecated).toBe(true)
  })

  it('keeps a suggestion as a string when the target is currently a string', () => {
    const f = finding({
      rule: 'h',
      confidence: 'HIGH',
      path: ['paths', '/users', 'get', 'description'],
      after: 'true',
    })
    const result = applyFixes({ spec: YAML_SPEC, findings: [f], threshold: 'high', version: '3.0' })
    expect(parseYaml(result.patched).paths['/users'].get.description).toBe('true')
  })
})

describe('applyFixes — format preservation', () => {
  it('keeps YAML output for YAML input', () => {
    const f = finding({ rule: 'h', confidence: 'HIGH', path: ['info', 'title'], after: 'X' })
    const result = applyFixes({ spec: YAML_SPEC, findings: [f], threshold: 'high', version: '3.0' })
    expect(result.patched.trimStart().startsWith('{')).toBe(false)
    expect(parseYaml(result.patched).info.title).toBe('X')
  })

  it('keeps JSON output for JSON input', () => {
    const json = JSON.stringify({ openapi: '3.0.3', info: { title: 'A', version: '1' }, paths: {} })
    const f = finding({ rule: 'h', confidence: 'HIGH', path: ['info', 'title'], after: 'B' })
    const result = applyFixes({ spec: json, findings: [f], threshold: 'high', version: '3.0' })
    expect(result.patched.trimStart().startsWith('{')).toBe(true)
    expect(JSON.parse(result.patched).info.title).toBe('B')
  })

  it('skips findings with no applicable fix', () => {
    const f = finding({ rule: 'mcp-operationid-required', confidence: 'HIGH', path: [] })
    const result = applyFixes({ spec: YAML_SPEC, findings: [f], threshold: 'high', version: '3.0' })
    expect(result.applied).toHaveLength(0)
    expect(result.skipped).toHaveLength(1)
  })
})
