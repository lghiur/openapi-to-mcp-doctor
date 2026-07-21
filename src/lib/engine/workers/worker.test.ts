import { describe, expect, it, vi } from 'vitest'
import type { OperationRef } from '@/lib/engine/operations'
import { createWorker } from '@/lib/engine/workers/worker'
import { buildWorkerSystemPrompt } from '@/lib/engine/workers/prompt'
import type { WorkerOutput } from '@/lib/llm/schemas'

const batch: OperationRef[] = [
  { id: 'get_user', method: 'GET', path: '/users/{id}', label: 'GET /users/{id}', definition: {} },
]

const fakeModel = {} as never

function generatorReturning(output: WorkerOutput) {
  return vi.fn(async (_args: { prompt: string; system?: string }) => output)
}

describe('buildWorkerSystemPrompt', () => {
  it('names the detected version and forbids the other version syntax', () => {
    const p30 = buildWorkerSystemPrompt('3.0')
    expect(p30).toContain('OpenAPI 3.0')
    expect(p30).toContain('never use OpenAPI 3.1 syntax')

    const p31 = buildWorkerSystemPrompt('3.1')
    expect(p31).toContain('never use OpenAPI 3.0 syntax')
  })
})

describe('createWorker — structural gaps in the prompt', () => {
  it('lists the batch operations’ linter gaps so the model can author the missing content', async () => {
    const generate = generatorReturning({ findings: [] })
    const worker = createWorker({ model: fakeModel, generate })

    await worker(batch, {
      version: '3.0',
      agentId: 'worker-1',
      gaps: {
        'GET /users/{id}': [
          {
            rule: 'mcp-param-description-required',
            message: 'Parameter "id" has no description.',
            path: ['parameters', 0, 'description'],
          },
        ],
      },
    })

    const prompt = generate.mock.calls[0]?.[0]?.prompt as string
    expect(prompt).toContain('Known gaps')
    expect(prompt).toContain('mcp-param-description-required')
    expect(prompt).toContain('Parameter "id" has no description.')
    expect(prompt).toContain('["parameters",0,"description"]')
  })

  it('renders no gap section when the context has none', async () => {
    const generate = generatorReturning({ findings: [] })
    const worker = createWorker({ model: fakeModel, generate })
    await worker(batch, { version: '3.0', agentId: 'worker-1' })
    const prompt = generate.mock.calls[0]?.[0]?.prompt as string
    expect(prompt).not.toContain('Known gaps')
  })
})

describe('createWorker', () => {
  it('makes exactly one generate call per batch and maps output to findings', async () => {
    const generate = generatorReturning({
      findings: [
        {
          operation: 'GET /users/{id}',
          rule: 'MCP_NO_WHEN_TO_USE',
          severity: 'warning',
          confidence: 'MEDIUM',
          message: 'Explain when to use this.',
          current: 'Returns a user.',
          suggested: 'Returns the full user profile. Use when you have the exact user ID.',
        },
      ],
    })
    const worker = createWorker({ model: fakeModel, generate })

    const findings = await worker(batch, { version: '3.0', agentId: 'worker-1' })

    expect(generate).toHaveBeenCalledTimes(1)
    expect(findings).toHaveLength(1)
    expect(findings[0]).toMatchObject({
      agentId: 'worker-1',
      operation: 'GET /users/{id}',
      rule: 'MCP_NO_WHEN_TO_USE',
      severity: 'warning',
      confidence: 'MEDIUM',
      before: 'Returns a user.',
      after: 'Returns the full user profile. Use when you have the exact user ID.',
    })
  })

  it('marks findings auto-fixable only with HIGH confidence AND a suggestion AND a path', async () => {
    const generate = generatorReturning({
      findings: [
        {
          operation: 'GET /users/{id}',
          rule: 'A',
          severity: 'error',
          confidence: 'HIGH',
          message: 'm',
          suggested: 'better',
          path: ['description'],
        },
        // HIGH but nothing to apply / nowhere to apply it — not auto-fixable.
        {
          operation: 'GET /users/{id}',
          rule: 'B',
          severity: 'error',
          confidence: 'HIGH',
          message: 'm',
        },
        {
          operation: 'GET /users/{id}',
          rule: 'C',
          severity: 'warning',
          confidence: 'MEDIUM',
          message: 'm',
          suggested: 'better',
          path: ['description'],
        },
      ],
    })
    const worker = createWorker({ model: fakeModel, generate })
    const findings = await worker(batch, { version: '3.0', agentId: 'worker-1' })
    expect(findings.find((f) => f.rule === 'A')?.autoFixable).toBe(true)
    expect(findings.find((f) => f.rule === 'B')?.autoFixable).toBe(false)
    expect(findings.find((f) => f.rule === 'C')?.autoFixable).toBe(false)
  })

  it('anchors agent-relative paths to the document root via the operation', async () => {
    const generate = generatorReturning({
      findings: [
        {
          operation: 'GET /users/{id}',
          rule: 'A',
          severity: 'warning',
          confidence: 'MEDIUM',
          message: 'm',
          suggested: 'better',
          path: ['parameters', 0, 'description'],
        },
      ],
    })
    const worker = createWorker({ model: fakeModel, generate })
    const findings = await worker(batch, { version: '3.0', agentId: 'worker-1' })
    expect(findings[0]?.path).toEqual([
      'paths',
      '/users/{id}',
      'get',
      'parameters',
      0,
      'description',
    ])
  })

  it('drops the path (and auto-fixability) when the agent names an unknown operation', async () => {
    const generate = generatorReturning({
      findings: [
        {
          operation: 'DELETE /nonexistent',
          rule: 'A',
          severity: 'error',
          confidence: 'HIGH',
          message: 'm',
          suggested: 'better',
          path: ['description'],
        },
      ],
    })
    const worker = createWorker({ model: fakeModel, generate })
    const findings = await worker(batch, { version: '3.0', agentId: 'worker-1' })
    expect(findings[0]?.path).toBeUndefined()
    expect(findings[0]?.autoFixable).toBe(false)
  })

  it('passes its abort signal through to the generate call', async () => {
    const controller = new AbortController()
    const generate = vi.fn(async (args: { abortSignal?: AbortSignal }) => {
      expect(args.abortSignal).toBe(controller.signal)
      return { findings: [] }
    })
    const worker = createWorker({ model: fakeModel, signal: controller.signal, generate })
    await worker(batch, { version: '3.0', agentId: 'worker-1' })
    expect(generate).toHaveBeenCalledTimes(1)
  })

  it('assigns unique ids and pending resolution', async () => {
    const generate = generatorReturning({
      findings: [
        {
          operation: 'GET /users/{id}',
          rule: 'A',
          severity: 'info',
          confidence: 'MEDIUM',
          message: 'm',
        },
        {
          operation: 'GET /users/{id}',
          rule: 'A',
          severity: 'info',
          confidence: 'MEDIUM',
          message: 'm',
        },
      ],
    })
    const worker = createWorker({ model: fakeModel, generate })
    const findings = await worker(batch, { version: '3.0', agentId: 'worker-2' })
    expect(new Set(findings.map((f) => f.id)).size).toBe(2)
    expect(findings.every((f) => f.resolution === 'pending')).toBe(true)
  })
})
