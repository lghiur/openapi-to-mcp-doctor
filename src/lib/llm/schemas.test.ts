import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { LlmFindingSchema, MismatchOutputSchema } from '@/lib/llm/schemas'

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
      rule: 'r',
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
