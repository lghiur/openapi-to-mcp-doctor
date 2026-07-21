import { afterEach, describe, expect, it, vi } from 'vitest'
import { runStructuralAnalysis } from '@/lib/engine'

const SPEC_30_BAD = `openapi: 3.0.3
paths:
  /users:
    get:
      responses:
        '200':
          description: ok
`

const SPEC_30_CLEAN = `openapi: 3.0.3
info:
  title: Users API
  version: 1.0.0
paths:
  /users:
    get:
      operationId: list_users
      description: Returns the list of users in the account, newest first, with pagination.
      responses:
        '200':
          description: A page of users.
          content:
            application/json:
              schema:
                type: object
                description: A page of users.
`

afterEach(() => {
  vi.restoreAllMocks()
})

describe('runStructuralAnalysis', () => {
  it('returns version, findings, and a severity summary for a 3.0 spec', async () => {
    const result = await runStructuralAnalysis(SPEC_30_BAD)
    expect(result.version).toBe('3.0')
    expect(result.halted).toBe(false)
    expect(result.findings.length).toBeGreaterThan(0)
    expect(result.summary.total).toBe(result.findings.length)
    expect(result.summary.errors + result.summary.warnings + result.summary.info).toBe(
      result.summary.total,
    )
  })

  it('runs BOTH the base oas ruleset and the MCP ruleset', async () => {
    const rules = (await runStructuralAnalysis(SPEC_30_BAD)).findings.map((f) => f.rule)
    // MCP rule (missing operationId) and a base oas rule (missing `info`) both fire.
    expect(rules).toContain('mcp-operationid-required')
    expect(rules).toContain('oas3-schema')
  })

  it('does not make any network/LLM calls', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch')
    await runStructuralAnalysis(SPEC_30_CLEAN)
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('every finding is HIGH confidence (deterministic structural pass)', async () => {
    const result = await runStructuralAnalysis(SPEC_30_CLEAN)
    expect(result.findings.every((f) => f.confidence === 'HIGH')).toBe(true)
  })

  it('halts cleanly on Swagger 2.0', async () => {
    const result = await runStructuralAnalysis('swagger: "2.0"\ninfo: { title: x, version: 1 }\n')
    expect(result.halted).toBe(true)
    expect(result.version).toBeNull()
    expect(result.findings).toHaveLength(1)
    expect(result.findings[0]?.rule).toBe('SWAGGER_20_NOT_SUPPORTED')
    expect(result.summary).toMatchObject({ total: 1, errors: 1, warnings: 0, info: 0 })
  })

  it('halts cleanly on an undetectable version', async () => {
    const result = await runStructuralAnalysis('not a spec')
    expect(result.halted).toBe(true)
    expect(result.version).toBeNull()
    expect(result.findings[0]?.rule).toBe('OAS_VERSION_UNDETECTABLE')
  })
})
