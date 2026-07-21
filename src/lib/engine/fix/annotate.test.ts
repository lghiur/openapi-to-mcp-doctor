import { describe, expect, it } from 'vitest'
import { annotateDeterministicFixes } from '@/lib/engine/fix/annotate'
import { runStructuralAnalysis } from '@/lib/engine/structural'
import type { Finding, SpecPath } from '@/types/domain'

const SPEC = `openapi: 3.0.3
info:
  title: T
  version: 1.0.0
paths:
  /users:
    get:
      operationId: GetAllUsers
      responses:
        '200':
          description: ok`

function finding(rule: string, path: SpecPath): Finding {
  return {
    id: `${rule}:${path.join('/')}`,
    agentId: 'structural-linter',
    rule,
    severity: 'error',
    confidence: 'HIGH',
    message: 'violated',
    path,
    autoFixable: false,
    autoFixed: false,
    resolution: 'pending',
  }
}

describe('annotateDeterministicFixes', () => {
  it('attaches the snake_case rename preview to mcp-operationid-format findings', () => {
    const [annotated] = annotateDeterministicFixes(
      [finding('mcp-operationid-format', ['paths', '/users', 'get', 'operationId'])],
      SPEC,
      '3.0',
    )
    expect(annotated).toMatchObject({
      before: 'GetAllUsers',
      after: 'get_all_users',
      autoFixable: true,
    })
  })

  it('attaches the 3.1 type-array preview to mcp-nullable-deprecated findings', () => {
    const spec31 = `openapi: 3.1.0
info:
  title: T
  version: 1.0.0
paths:
  /users:
    get:
      operationId: list_users
      responses:
        '200':
          description: ok
          content:
            application/json:
              schema:
                type: string
                nullable: true`
    const path: SpecPath = [
      'paths',
      '/users',
      'get',
      'responses',
      '200',
      'content',
      'application/json',
      'schema',
      'nullable',
    ]
    const [annotated] = annotateDeterministicFixes(
      [finding('mcp-nullable-deprecated', path)],
      spec31,
      '3.1',
    )
    expect(annotated?.autoFixable).toBe(true)
    expect(annotated?.after).toContain('"null"')
  })

  it('leaves other findings untouched', () => {
    const original = finding('operation-description', ['paths', '/users', 'get'])
    const [annotated] = annotateDeterministicFixes([original], SPEC, '3.0')
    expect(annotated).toEqual(original)
  })

  it('skips annotation when the target value is missing from the document', () => {
    const [annotated] = annotateDeterministicFixes(
      [finding('mcp-operationid-format', ['paths', '/ghost', 'get', 'operationId'])],
      SPEC,
      '3.0',
    )
    expect(annotated?.autoFixable).toBe(false)
    expect(annotated?.after).toBeUndefined()
  })
})

describe('runStructuralAnalysis — deterministic fix annotation', () => {
  it('emits operationId-format findings already carrying their rename', async () => {
    const result = await runStructuralAnalysis(SPEC)
    const idFinding = result.findings.find((f) => f.rule === 'mcp-operationid-format')
    expect(idFinding).toBeDefined()
    expect(idFinding).toMatchObject({
      before: 'GetAllUsers',
      after: 'get_all_users',
      autoFixable: true,
    })
  })
})
