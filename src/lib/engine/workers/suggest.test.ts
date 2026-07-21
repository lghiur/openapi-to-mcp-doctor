import { describe, expect, it, vi } from 'vitest'
import { extractOperations } from '@/lib/engine/operations'
import { createSuggester } from '@/lib/engine/workers/suggest'
import type { SuggestionOutput } from '@/lib/llm/schemas'
import type { Finding, SpecPath } from '@/types/domain'

const SPEC = `openapi: 3.0.3
info:
  title: T
  version: 1.0.0
paths:
  /users:
    get:
      operationId: list_users
      parameters:
        - name: page
          in: query
          schema:
            type: integer
  /items:
    get:
      operationId: list_items`

const operations = extractOperations(SPEC)
const fakeModel = {} as never

function structural(id: string, rule: string, path: SpecPath): Finding {
  return {
    id,
    agentId: 'structural-linter',
    rule,
    severity: 'warning',
    confidence: 'HIGH',
    message: `${rule} violated`,
    path,
    autoFixable: false,
    autoFixed: false,
    resolution: 'pending',
  }
}

const PARAM_FINDING = structural('f-param', 'mcp-param-description-required', [
  'paths',
  '/users',
  'get',
  'parameters',
  0,
])
const DESC_FINDING = structural('f-desc', 'operation-description', ['paths', '/items', 'get'])

function generatorReturning(outputs: SuggestionOutput[]) {
  let call = 0
  return vi.fn(async (_args: { prompt: string; system?: string }) => {
    const output = outputs[call] ?? { suggestions: [] }
    call += 1
    return output
  })
}

describe('createSuggester', () => {
  it('authors suggestions for structural findings, enriching them in place (id preserved, MEDIUM)', async () => {
    const generate = generatorReturning([
      {
        suggestions: [
          {
            findingId: 'f-param',
            suggested: 'Zero-based page number. Use with the default page size of 20.',
            path: ['parameters', 0, 'description'],
          },
        ],
      },
    ])
    const suggest = createSuggester({ model: fakeModel, generate })
    const enriched = await suggest([PARAM_FINDING], operations, '3.0')

    expect(enriched).toHaveLength(1)
    expect(enriched[0]).toMatchObject({
      id: 'f-param', // same finding, now actionable
      rule: 'mcp-param-description-required',
      after: 'Zero-based page number. Use with the default page size of 20.',
      confidence: 'MEDIUM', // AI-authored content is never HIGH
      autoFixable: false,
      // path anchored to the document root from the operation-relative path
      path: ['paths', '/users', 'get', 'parameters', 0, 'description'],
    })
    // the prompt gives the model the operation definition and the finding ids
    const prompt = generate.mock.calls[0]?.[0]?.prompt as string
    expect(prompt).toContain('f-param')
    expect(prompt).toContain('list_users')
  })

  it('chunks large finding sets into multiple calls', async () => {
    const findings = Array.from({ length: 5 }, (_, i) =>
      structural(`f-${i}`, 'operation-description', ['paths', '/users', 'get']),
    )
    const generate = generatorReturning([{ suggestions: [] }, { suggestions: [] }, { suggestions: [] }])
    const suggest = createSuggester({ model: fakeModel, generate, chunkSize: 2 })
    await suggest(findings, operations, '3.0')
    expect(generate).toHaveBeenCalledTimes(3) // ceil(5/2)
  })

  it('skips suggestions without a path and unknown finding ids', async () => {
    const generate = generatorReturning([
      {
        suggestions: [
          { findingId: 'f-desc', suggested: 'no path given' },
          { findingId: 'ghost', suggested: 'x', path: ['description'] },
        ],
      },
    ])
    const suggest = createSuggester({ model: fakeModel, generate })
    const enriched = await suggest([DESC_FINDING], operations, '3.0')
    expect(enriched).toHaveLength(0)
  })

  it('isolates a failing chunk — other chunks still produce enrichments', async () => {
    let call = 0
    const generate = vi.fn(async (_args: { prompt: string }) => {
      call += 1
      if (call === 1) throw new Error('gateway hiccup')
      return {
        suggestions: [{ findingId: 'f-desc', suggested: 'Lists items.', path: ['description'] }],
      }
    })
    const findings = [PARAM_FINDING, DESC_FINDING]
    const suggest = createSuggester({ model: fakeModel, generate, chunkSize: 1 })
    const enriched = await suggest(findings, operations, '3.0')
    expect(enriched).toHaveLength(1)
    expect(enriched[0]?.id).toBe('f-desc')
  })

  it('ignores findings that already carry a fix or are not operation-scoped', async () => {
    const generate = generatorReturning([{ suggestions: [] }])
    const suggest = createSuggester({ model: fakeModel, generate })
    const already: Finding = { ...PARAM_FINDING, after: 'has one' }
    const docLevel = structural('f-doc', 'info-description', ['info'])
    await suggest([already, docLevel], operations, '3.0')
    expect(generate).not.toHaveBeenCalled()
  })
})
