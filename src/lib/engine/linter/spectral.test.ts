import { describe, expect, it } from 'vitest'
import {
  normalizeSpectralResults,
  runStructuralLint,
  sanitizeNulls,
} from '@/lib/engine/linter/spectral'
import { mcpRuleset } from '@/lib/engine/linter/rulesets/mcp'

const SPEC_30_MISSING_INFO = `openapi: 3.0.3
paths: {}
`

const SPEC_30_OK = `openapi: 3.0.3
info:
  title: Test API
  version: 1.0.0
paths:
  /users:
    get:
      responses:
        '200':
          description: A list of users.
`

const SPEC_31_OK = `openapi: 3.1.0
info:
  title: Test API
  version: 1.0.0
paths: {}
`

const SPEC_SWAGGER_20 = `swagger: "2.0"
info:
  title: Old API
  version: 1.0.0
paths: {}
`

describe('normalizeSpectralResults', () => {
  it('maps Spectral severities to our severity union', () => {
    const findings = normalizeSpectralResults([
      { code: 'r-error', message: 'e', path: ['info'], severity: 0 },
      { code: 'r-warn', message: 'w', path: ['paths'], severity: 1 },
      { code: 'r-info', message: 'i', path: [], severity: 2 },
      { code: 'r-hint', message: 'h', path: [], severity: 3 },
    ])
    expect(findings.map((f) => f.severity)).toEqual(['error', 'warning', 'info', 'info'])
  })

  it('marks every structural finding HIGH confidence and attributes it to the linter', () => {
    const findings = normalizeSpectralResults([
      { code: 'r1', message: 'm', path: ['info'], severity: 1 },
    ])
    expect(findings[0]).toMatchObject({
      rule: 'r1',
      confidence: 'HIGH',
      agentId: 'structural-linter',
      autoFixable: false,
      autoFixed: false,
      resolution: 'pending',
    })
  })

  it('derives an operation label from a paths.<route>.<method> path', () => {
    const findings = normalizeSpectralResults([
      {
        code: 'operation-operationId',
        message: 'm',
        path: ['paths', '/users', 'get'],
        severity: 1,
      },
    ])
    expect(findings[0]?.operation).toBe('GET /users')
  })

  it('assigns unique ids even when rule and path repeat', () => {
    const findings = normalizeSpectralResults([
      { code: 'dup', message: 'a', path: ['info'], severity: 1 },
      { code: 'dup', message: 'b', path: ['info'], severity: 1 },
    ])
    const ids = findings.map((f) => f.id)
    expect(new Set(ids).size).toBe(2)
  })
})

describe('runStructuralLint', () => {
  it('returns normalized findings for a 3.0 spec, including a schema error', async () => {
    const result = await runStructuralLint(SPEC_30_MISSING_INFO)
    expect(result.halted).toBe(false)
    expect(result.version).toBe('3.0')
    expect(result.findings.length).toBeGreaterThan(0)
    expect(result.findings.some((f) => f.severity === 'error')).toBe(true)
    // structural findings are always HIGH confidence with a path and rule
    for (const f of result.findings) {
      expect(f.confidence).toBe('HIGH')
      expect(typeof f.rule).toBe('string')
      expect(Array.isArray(f.path)).toBe(true)
    }
  })

  it('runs against a 3.1 spec and reports version 3.1', async () => {
    const result = await runStructuralLint(SPEC_31_OK)
    expect(result.halted).toBe(false)
    expect(result.version).toBe('3.1')
    expect(Array.isArray(result.findings)).toBe(true)
  })

  it('produces findings for a well-formed 3.0 spec (oas recommendations)', async () => {
    const result = await runStructuralLint(SPEC_30_OK)
    expect(result.version).toBe('3.0')
    expect(Array.isArray(result.findings)).toBe(true)
  })

  it('halts on Swagger 2.0 with a single version error, without running Spectral', async () => {
    const result = await runStructuralLint(SPEC_SWAGGER_20)
    expect(result.halted).toBe(true)
    expect(result.version).toBeNull()
    expect(result.findings).toHaveLength(1)
    expect(result.findings[0]).toMatchObject({
      rule: 'SWAGGER_20_NOT_SUPPORTED',
      severity: 'error',
      confidence: 'HIGH',
    })
  })

  it('halts on an undetectable version', async () => {
    const result = await runStructuralLint('just a bare string')
    expect(result.halted).toBe(true)
    expect(result.findings[0]?.rule).toBe('OAS_VERSION_UNDETECTABLE')
  })

  // Regression: real-world specs (e.g. Tyk's) carry literal `null` values. The
  // built-in `oas` ruleset's `$..[?(@.enum)]`-style JSONPaths made nimma throw
  // `Cannot read properties of null` and abort the whole run. We sanitise nulls
  // before linting so a null anywhere can no longer crash any rule.
  it('does not crash when the spec contains literal null values (built-in oas rules)', async () => {
    const spec = `openapi: 3.0.3
info:
  title: T
  version: 1.0.0
paths:
  /things:
    get:
      operationId: list_things
      responses:
        '200':
          description: ok
components:
  schemas:
    Address:
      type: object
      properties:
        locality: null
        province: null
        status:
          type: string
          enum: [a, b, null]
`
    const result = await runStructuralLint(spec) // default oas ruleset — the crasher
    expect(result.halted).toBe(false)
    expect(result.version).toBe('3.0')
    expect(Array.isArray(result.findings)).toBe(true)
  })

  // Regression: Spectral's default resolver fetches remote $refs over HTTP, which
  // hangs the run (and is an SSRF risk) on specs that reference external schemas.
  // We resolve internal refs but never fetch remote ones. The unroutable host
  // below means that if a fetch were attempted, this test would time out.
  it('resolves internal $refs but never fetches remote ones (no hang, no SSRF)', async () => {
    const spec = `openapi: 3.0.3
info:
  title: T
  version: 1.0.0
paths:
  /x:
    get:
      operationId: get_x
      description: A description long enough to keep the short-description rule quiet here.
      responses:
        '200':
          description: ok
          content:
            application/json:
              schema:
                $ref: '#/components/schemas/Local'
components:
  schemas:
    Local:
      type: object
      description: A local schema that is resolved inline.
      properties:
        ext:
          $ref: 'https://10.255.255.1/never-fetched.json'
`
    const result = await runStructuralLint(spec, mcpRuleset('3.0'))
    expect(result.halted).toBe(false)
    // The remote ref is seen as an unresolved external ref, never fetched.
    expect(result.findings.map((f) => f.rule)).toContain('mcp-external-ref')
  }, 10000)
})

describe('sanitizeNulls', () => {
  it('replaces null object values with empty strings, preserving keys', () => {
    expect(sanitizeNulls({ a: null, b: 'x', c: 1 })).toEqual({ a: '', b: 'x', c: 1 })
  })

  it('replaces null array elements in place, preserving indices', () => {
    expect(sanitizeNulls(['a', null, 'b'])).toEqual(['a', '', 'b'])
  })

  it('recurses through nested objects and arrays', () => {
    expect(sanitizeNulls({ s: { p: [null, { q: null }] } })).toEqual({
      s: { p: ['', { q: '' }] },
    })
  })

  it('leaves non-null primitives untouched', () => {
    expect(sanitizeNulls(0)).toBe(0)
    expect(sanitizeNulls(false)).toBe(false)
    expect(sanitizeNulls('keep')).toBe('keep')
  })

  it('cuts self-referential cycles instead of recursing forever', () => {
    const node: Record<string, unknown> = { type: 'object' }
    node.child = node
    expect(sanitizeNulls(node)).toEqual({ type: 'object', child: '' })
  })

  it('cuts cycles that run through an array', () => {
    const node: Record<string, unknown> = { type: 'object' }
    node.anyOf = [node]
    expect(sanitizeNulls(node)).toEqual({ type: 'object', anyOf: [''] })
  })

  it('duplicates shared (non-cyclic) nodes rather than treating them as cycles', () => {
    const shared = { description: 'shared' }
    expect(sanitizeNulls({ a: shared, b: shared })).toEqual({
      a: { description: 'shared' },
      b: { description: 'shared' },
    })
  })

  it('keeps a literal `__proto__` key as an own property instead of losing it', () => {
    const sanitized = sanitizeNulls(JSON.parse('{"__proto__":{"enum":["a"]},"type":"object"}'))
    expect(Object.getPrototypeOf(sanitized)).toBe(Object.prototype)
    expect(Object.keys(sanitized as object)).toEqual(['__proto__', 'type'])
    expect('enum' in (sanitized as object)).toBe(false)
  })
})

describe('runStructuralLint — hostile document shapes', () => {
  it('completes on a spec whose YAML anchors form a cycle (never throws)', async () => {
    const cyclic = `openapi: 3.0.3
info:
  title: T
  version: 1.0.0
paths: {}
components:
  schemas:
    Node: &node
      type: object
      properties:
        child: *node
`
    const result = await runStructuralLint(cyclic, mcpRuleset('3.0'))
    expect(result.halted).toBe(false)
    expect(Array.isArray(result.findings)).toBe(true)
  }, 10000)
})
