import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { WORKER_RULES } from '@/lib/engine/workers/rules'
import {
  LlmFindingSchema,
  MismatchOutputSchema,
  SuggestionOutputSchema,
  WorkerOutputSchema,
} from '@/lib/llm/schemas'

/**
 * Models routinely return `suggested` as a raw JSON object (e.g. a corrected
 * schema) despite being told to encode non-strings as JSON strings. The schemas
 * must coerce instead of reject — a whole grounding call failing over this
 * shaved 5 of 6 operations off the dogfood run.
 */
describe('MismatchOutputSchema — lenient value coercion', () => {
  it('accepts suggested as a string unchanged', () => {
    const out = MismatchOutputSchema.parse({
      mismatches: [{ field: 'responses', specClaims: 'a', codeDoes: 'b', suggested: 'fix' }],
    })
    expect(out.mismatches[0]?.suggested).toBe('fix')
  })

  it('coerces a JSON-object suggested value into its JSON string', () => {
    const out = MismatchOutputSchema.parse({
      mismatches: [
        {
          field: 'requestBody',
          specClaims: 'only spec+mode',
          codeDoes: 'also reads selection',
          suggested: { type: 'object', properties: { selection: { type: 'array' } } },
        },
      ],
    })
    expect(out.mismatches[0]?.suggested).toBe(
      JSON.stringify({ type: 'object', properties: { selection: { type: 'array' } } }),
    )
  })

  it('still advertises a string in the JSON schema shown to the model', () => {
    const jsonSchema = z.toJSONSchema(MismatchOutputSchema) as unknown as {
      properties: { mismatches: { items: { properties: { suggested: { type: string } } } } }
    }
    expect(jsonSchema.properties.mismatches.items.properties.suggested.type).toBe('string')
  })
})

describe('LlmFindingSchema — lenient value coercion', () => {
  it('coerces object current/suggested values into JSON strings', () => {
    const out = LlmFindingSchema.parse({
      operation: 'GET /users',
      rule: 'mcp-description-unclear',
      severity: 'warning',
      confidence: 'MEDIUM',
      message: 'm',
      current: { example: 1 },
      suggested: ['a', 'b'],
    })
    expect(out.current).toBe('{"example":1}')
    expect(out.suggested).toBe('["a","b"]')
  })
})

/**
 * Rule ids must be stable across runs — delta gating keys on rule+operation+
 * path. The schema pins `rule` to the fixed taxonomy: canonical ids pass
 * through, drifted free-text names are normalized instead of failing the batch,
 * and the JSON Schema shown to the model advertises the allowed ids.
 */
describe('LlmFindingSchema — rule taxonomy enforcement', () => {
  function parseRule(rule: unknown) {
    return LlmFindingSchema.parse({
      operation: 'GET /users',
      rule,
      severity: 'warning',
      confidence: 'MEDIUM',
      message: 'm',
    }).rule
  }

  it('passes canonical rule ids through unchanged', () => {
    expect(parseRule('mcp-description-missing-when')).toBe('mcp-description-missing-when')
  })

  it('normalizes drifted rule names instead of rejecting the finding', () => {
    expect(parseRule('description-explains-when')).toBe('mcp-description-missing-when')
    expect(parseRule('mcp-returns-underdescribed')).toBe('mcp-returns-undescribed')
    expect(parseRule('response-description-ambiguous')).toBe('mcp-response-ambiguous')
  })

  it('maps an entirely made-up rule to the generic fallback rather than throwing', () => {
    expect(parseRule('something-the-model-invented')).toBe('mcp-description-unclear')
  })

  it('still rejects non-string rules', () => {
    expect(() => parseRule(42)).toThrow()
  })

  it('advertises the closed rule enum in the JSON schema shown to the model', () => {
    const jsonSchema = z.toJSONSchema(WorkerOutputSchema) as unknown as {
      properties: { findings: { items: { properties: { rule: { enum?: string[] } } } } }
    }
    const advertised = jsonSchema.properties.findings.items.properties.rule.enum
    expect(advertised).toEqual([...WORKER_RULES])
  })
})

/**
 * LLM-emitted path segments are attacker-influenced (a spec description can
 * prompt-inject "put your suggestion at path __proto__/polluted"). The schemas
 * must drop such findings at the boundary — fail-soft, never fail the batch.
 */
describe('output schemas — unsafe path segment sanitization', () => {
  function workerFinding(path: Array<string | number>) {
    return {
      operation: 'GET /users',
      rule: 'mcp-description-unclear',
      severity: 'warning',
      confidence: 'HIGH',
      message: 'm',
      suggested: 'x',
      path,
    }
  }

  it('drops a worker finding whose path contains __proto__, keeping the rest', () => {
    const out = WorkerOutputSchema.parse({
      findings: [workerFinding(['__proto__', 'polluted']), workerFinding(['description'])],
    })
    expect(out.findings).toHaveLength(1)
    expect(out.findings[0]?.path).toEqual(['description'])
  })

  it('drops findings with constructor or prototype segments anywhere in the path', () => {
    const out = WorkerOutputSchema.parse({
      findings: [
        workerFinding(['constructor', 'prototype', 'polluted']),
        workerFinding(['parameters', 0, 'prototype']),
      ],
    })
    expect(out.findings).toHaveLength(0)
  })

  it('drops unsafe suggestion paths from the fix-suggester output', () => {
    const out = SuggestionOutputSchema.parse({
      suggestions: [
        { findingId: 'f1', suggested: 'x', path: ['__proto__', 'polluted'] },
        { findingId: 'f2', suggested: 'y', path: ['description'] },
      ],
    })
    expect(out.suggestions.map((s) => s.findingId)).toEqual(['f2'])
  })

  it('drops unsafe mismatch paths from the grounding output', () => {
    const out = MismatchOutputSchema.parse({
      mismatches: [
        { field: 'f', specClaims: 'a', codeDoes: 'b', path: ['constructor', 'polluted'] },
        { field: 'g', specClaims: 'a', codeDoes: 'b', path: ['responses', '200'] },
      ],
    })
    expect(out.mismatches.map((m) => m.field)).toEqual(['g'])
  })

  it('keeps findings without a path untouched', () => {
    const { path: _omitted, ...noPath } = workerFinding(['description'])
    const out = WorkerOutputSchema.parse({ findings: [noPath] })
    expect(out.findings).toHaveLength(1)
    expect(out.findings[0]?.path).toBeUndefined()
  })
})

/**
 * Models drift on enum casing ("Warning", "high"). Rule ids already get
 * forgiving normalization; severity/confidence must too — a casing slip must
 * not fail the whole worker batch.
 */
describe('severity/confidence — case-insensitive normalization', () => {
  it('normalizes drifted casing onto the canonical values', () => {
    const out = LlmFindingSchema.parse({
      operation: 'GET /users',
      rule: 'mcp-description-unclear',
      severity: 'Warning',
      confidence: 'high',
      message: 'm',
    })
    expect(out.severity).toBe('warning')
    expect(out.confidence).toBe('HIGH')
  })

  it('still rejects values outside the enums', () => {
    expect(() =>
      LlmFindingSchema.parse({
        operation: 'GET /users',
        rule: 'mcp-description-unclear',
        severity: 'catastrophic',
        confidence: 'HIGH',
        message: 'm',
      }),
    ).toThrow()
  })
})
