import { describe, expect, it, vi } from 'vitest'
import { detectMismatches } from '@/lib/engine/grounding/read'
import type { OperationRef } from '@/lib/engine/operations'
import type { MismatchOutput } from '@/lib/llm/schemas'

const operation: OperationRef = {
  id: 'get_user',
  method: 'GET',
  path: '/users/{id}',
  label: 'GET /users/{id}',
  definition: {},
}

const fakeModel = {} as never

function generatorReturning(output: MismatchOutput) {
  return vi.fn(async () => output)
}

describe('detectMismatches', () => {
  it('produces LOW-confidence findings with the code-bug warning', async () => {
    const generate = generatorReturning({
      mismatches: [
        {
          field: 'status code',
          specClaims: 'Returns 200 with a user object',
          codeDoes: 'Returns 204 No Content when the user is missing',
          suggested: 'Document the 204 response',
        },
      ],
    })
    const findings = await detectMismatches(
      { operation, handlerCode: 'func GetUser() {}', version: '3.0' },
      { model: fakeModel, generate, agentId: 'worker-1' },
    )
    expect(findings).toHaveLength(1)
    expect(findings[0]).toMatchObject({
      rule: 'SPEC_CODE_MISMATCH',
      severity: 'error',
      confidence: 'LOW',
      operation: 'GET /users/{id}',
      actual: 'Returns 204 No Content when the user is missing',
      after: 'Document the 204 response',
    })
    expect(findings[0]?.warning).toMatch(/confirm this is a code bug/i)
    expect(findings[0]?.autoFixable).toBe(false)
  })

  it('returns no findings when the code matches the spec', async () => {
    const generate = generatorReturning({ mismatches: [] })
    const findings = await detectMismatches(
      { operation, handlerCode: 'ok', version: '3.1' },
      { model: fakeModel, generate },
    )
    expect(findings).toEqual([])
  })

  it('anchors an operation-relative mismatch path to the document root', async () => {
    const generate = generatorReturning({
      mismatches: [
        {
          field: 'responses.200.description',
          specClaims: 'Returns 200',
          codeDoes: 'Returns 204',
          suggested: 'No Content',
          path: ['responses', '200', 'description'],
        },
      ],
    })
    const findings = await detectMismatches(
      { operation, handlerCode: 'func GetUser() {}', version: '3.0' },
      { model: fakeModel, generate },
    )
    expect(findings[0]?.path).toEqual([
      'paths',
      '/users/{id}',
      'get',
      'responses',
      '200',
      'description',
    ])
  })

  it('omits the path when the agent gave none', async () => {
    const generate = generatorReturning({
      mismatches: [{ field: 'auth', specClaims: 'none', codeDoes: 'bearer required' }],
    })
    const findings = await detectMismatches(
      { operation, handlerCode: 'code', version: '3.0' },
      { model: fakeModel, generate },
    )
    expect(findings[0]?.path).toBeUndefined()
  })
})
