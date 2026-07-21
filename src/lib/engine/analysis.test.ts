import { describe, expect, it, vi } from 'vitest'
import { type AnalysisResult, runAnalysis } from '@/lib/engine/analysis'
import type { OperationRef } from '@/lib/engine/operations'
import type { WorkerContext } from '@/lib/engine/orchestrator'
import type { EngineEvent, Finding } from '@/types/domain'

const SPEC = `openapi: 3.0.3
info:
  title: T
  version: 1.0.0
paths:
  /users:
    get:
      operationId: list_users
      description: Returns users in the account, newest first, with pagination support here.
      responses:
        '200':
          description: ok
          content:
            application/json:
              schema:
                type: object
                description: users
  /items:
    get:
      operationId: list_items
      description: Returns items in the account, newest first, with pagination support here.
      responses:
        '200':
          description: ok
          content:
            application/json:
              schema:
                type: object
                description: items`

function workerFinding(agentId: string, op: string): Finding {
  return {
    id: `${agentId}-${op}`,
    agentId,
    operation: op,
    rule: 'MCP_NO_WHEN_TO_USE',
    severity: 'warning',
    confidence: 'MEDIUM',
    message: 'vague',
    autoFixable: false,
    autoFixed: false,
    resolution: 'pending',
  }
}

async function drain(
  gen: AsyncGenerator<EngineEvent, AnalysisResult>,
): Promise<{ events: EngineEvent[]; result: AnalysisResult }> {
  const events: EngineEvent[] = []
  let next = await gen.next()
  while (!next.done) {
    events.push(next.value)
    next = await gen.next()
  }
  return { events, result: next.value }
}

describe('runAnalysis — analysis_started', () => {
  it('emits analysis_started first, carrying every operation label and just the structural phase', async () => {
    const { events } = await drain(runAnalysis(SPEC))
    const first = events[0]
    expect(first?.type).toBe('analysis_started')
    if (first?.type !== 'analysis_started') throw new Error('expected analysis_started')
    expect(first.operations).toEqual(['GET /users', 'GET /items'])
    expect(first.phases).toEqual(['structural'])
  })

  it('plans worker + postprocess phases when an AI capability is supplied (≥2 ops)', async () => {
    const runWorker = vi.fn(async (batch: OperationRef[], ctx: WorkerContext) =>
      batch.map((o) => workerFinding(ctx.agentId, o.label)),
    )
    const runPostProcess = vi.fn(async () => [])
    const { events } = await drain(
      runAnalysis(SPEC, { ai: { runWorker, runPostProcess }, batchSize: 1 }),
    )
    const first = events[0]
    if (first?.type !== 'analysis_started') throw new Error('expected analysis_started')
    expect(first.phases).toEqual(['structural', 'workers', 'postprocess'])
  })

  it('plans the grounding phase when grounding is supplied', async () => {
    const grounding = vi.fn(async () => ({ findings: [], filesRead: [] }))
    const { events } = await drain(runAnalysis(SPEC, { grounding }))
    const first = events[0]
    if (first?.type !== 'analysis_started') throw new Error('expected analysis_started')
    expect(first.phases).toContain('grounding')
  })

  it('emits analysis_started even when the version is unsupported (no operations)', async () => {
    const { events } = await drain(runAnalysis('swagger: "2.0"\npaths: {}'))
    const first = events[0]
    if (first?.type !== 'analysis_started') throw new Error('expected analysis_started')
    expect(first.operations).toEqual([])
    expect(first.phases).toEqual(['structural'])
  })
})

describe('runAnalysis — structural gaps feed the workers', () => {
  it('forwards content-needing structural findings to workers as per-operation gaps', async () => {
    // /gaps has no description and its 200 response has no schema — both are
    // structural findings that need authored content.
    const gappySpec = `openapi: 3.0.3
info:
  title: T
  version: 1.0.0
paths:
  /gaps:
    get:
      operationId: gappy_operation
      responses:
        '200':
          description: ok`
    const contexts: Array<{ gaps?: Record<string, unknown[]> }> = []
    const runWorker = vi.fn(async (_batch: OperationRef[], ctx: WorkerContext) => {
      contexts.push(ctx)
      return []
    })
    await drain(runAnalysis(gappySpec, { ai: { runWorker, runPostProcess: async () => [] } }))

    const gaps = contexts[0]?.gaps?.['GET /gaps'] ?? []
    expect(gaps.length).toBeGreaterThan(0)
    const rules = gaps.map((g) => (g as { rule: string }).rule)
    expect(rules).toContain('mcp-response-schema-required')
  })
})

describe('runAnalysis — fix-suggester enrichment', () => {
  const gappySpec = `openapi: 3.0.3
info:
  title: T
  version: 1.0.0
paths:
  /gaps:
    get:
      operationId: gappy_operation
      responses:
        '200':
          description: ok`

  it('re-emits structural findings enriched with authored fixes and replaces them in the result', async () => {
    const runSuggest = vi.fn(async (findings: Finding[]) => {
      const target = findings.find((f) => f.rule === 'mcp-response-schema-required')
      if (!target) return []
      return [
        {
          ...target,
          after: '{"type":"object"}',
          path: ['paths', '/gaps', 'get', 'responses', '200', 'content', 'application/json', 'schema'],
          confidence: 'MEDIUM' as const,
        },
      ]
    })
    const { events, result } = await drain(
      runAnalysis(gappySpec, {
        ai: { runWorker: async () => [], runPostProcess: async () => [], runSuggest },
      }),
    )

    expect(runSuggest).toHaveBeenCalledOnce()
    // the enriched finding replaced the original — same id, no duplicate
    const matches = result.findings.filter((f) => f.rule === 'mcp-response-schema-required')
    expect(matches).toHaveLength(1)
    expect(matches[0]?.after).toBe('{"type":"object"}')
    expect(matches[0]?.confidence).toBe('MEDIUM')
    // it was re-emitted over the stream under the suggester agent
    const suggesterEvents = events.filter(
      (e) => e.type === 'finding' && e.agentId === 'fix-suggester',
    )
    expect(suggesterEvents).toHaveLength(1)
    // and the suggester shows up as an agent with a completion event
    expect(
      events.some((e) => e.type === 'agent_completed' && e.agentId === 'fix-suggester'),
    ).toBe(true)
    expect(result.agents.some((a) => a.id === 'fix-suggester')).toBe(true)
  })

  it('a failing suggester degrades to unenriched findings, never sinks the run', async () => {
    const runSuggest = vi.fn(async () => {
      throw new Error('gateway down')
    })
    const { events, result } = await drain(
      runAnalysis(gappySpec, {
        ai: { runWorker: async () => [], runPostProcess: async () => [], runSuggest },
      }),
    )
    expect(result.findings.length).toBeGreaterThan(0)
    const completed = events.find(
      (e) => e.type === 'agent_completed' && e.agentId === 'fix-suggester',
    )
    expect(completed && 'error' in completed ? completed.error : undefined).toContain(
      'gateway down',
    )
  })
})

describe('runAnalysis — operation selection', () => {
  it('narrows analysis_started and worker batches to the selected operations', async () => {
    const runWorker = vi.fn(async (batch: OperationRef[], ctx: WorkerContext) =>
      batch.map((o) => workerFinding(ctx.agentId, o.label)),
    )
    const runPostProcess = vi.fn(async () => [])
    const { events } = await drain(
      runAnalysis(SPEC, {
        ai: { runWorker, runPostProcess },
        selection: [{ path: '/users', methods: ['get'] }],
      }),
    )
    const first = events[0]
    if (first?.type !== 'analysis_started') throw new Error('expected analysis_started')
    expect(first.operations).toEqual(['GET /users'])
    // one op -> no postprocess phase, and workers only ever saw the selected op
    expect(first.phases).toEqual(['structural', 'workers'])
    const workerOps = runWorker.mock.calls.flatMap(([batch]) => batch.map((o) => o.label))
    expect(workerOps).toEqual(['GET /users'])
    expect(runPostProcess).not.toHaveBeenCalled()
  })

  it('drops structural findings anchored on unselected operations, keeps document-level ones', async () => {
    const all = await drain(runAnalysis(SPEC))
    const selected = await drain(
      runAnalysis(SPEC, { selection: [{ path: '/users', methods: ['get'] }] }),
    )
    const onItems = (findings: Finding[]) =>
      findings.filter((f) => f.path?.[0] === 'paths' && f.path?.[1] === '/items')
    // sanity: the unfiltered run does produce /items findings to drop
    expect(onItems(all.result.findings).length).toBeGreaterThan(0)
    expect(onItems(selected.result.findings)).toHaveLength(0)
    // document-level findings (no paths anchor) survive the filter
    const docLevel = (findings: Finding[]) =>
      findings.filter((f) => !f.path || f.path[0] !== 'paths')
    expect(docLevel(selected.result.findings).map((f) => f.rule)).toEqual(
      docLevel(all.result.findings).map((f) => f.rule),
    )
  })

  it('grounding only receives the selected operations', async () => {
    const grounding = vi.fn(async (_operations: OperationRef[]) => ({
      findings: [],
      filesRead: [],
    }))
    await drain(runAnalysis(SPEC, { grounding, selection: [{ path: '/items', methods: ['get'] }] }))
    expect(grounding).toHaveBeenCalledOnce()
    const operations = grounding.mock.calls[0]?.[0] ?? []
    expect(operations.map((o) => o.label)).toEqual(['GET /items'])
  })
})

describe('runAnalysis — structural only (no LLM)', () => {
  it('yields structural findings then analysis_complete, with no worker events', async () => {
    const { events, result } = await drain(runAnalysis(SPEC))
    const types = events.map((e) => e.type)
    expect(types).toContain('agent_started')
    expect(types).toContain('analysis_complete')
    // no worker-* agents started beyond the structural linter
    const startedAgents = events
      .filter((e) => e.type === 'agent_started')
      .map((e) => (e.type === 'agent_started' ? e.agentId : ''))
    expect(startedAgents).toEqual(['structural-linter'])
    expect(result.version).toBe('3.0')
    expect(result.findings.length).toBeGreaterThan(0)
  })

  it('halts cleanly on Swagger 2.0', async () => {
    const { events, result } = await drain(runAnalysis('swagger: "2.0"\npaths: {}'))
    expect(result.halted).toBe(true)
    expect(events[events.length - 1]?.type).toBe('analysis_complete')
  })
})

describe('runAnalysis — with AI capability', () => {
  it('runs workers and post-processing and merges all findings', async () => {
    const runWorker = vi.fn(async (batch: OperationRef[], ctx: WorkerContext) =>
      batch.map((o) => workerFinding(ctx.agentId, o.label)),
    )
    const runPostProcess = vi.fn(async () => [
      {
        id: 'orchestrator-near-duplicate-0',
        agentId: 'orchestrator',
        operations: ['GET /users', 'GET /items'],
        rule: 'MCP_NEAR_DUPLICATE',
        severity: 'warning' as const,
        confidence: 'MEDIUM' as const,
        message: 'dup',
        autoFixable: false,
        autoFixed: false,
        resolution: 'pending' as const,
      },
    ])

    const { events, result } = await drain(
      runAnalysis(SPEC, { ai: { runWorker, runPostProcess }, batchSize: 1 }),
    )

    const types = events.map((e) => e.type)
    expect(types).toContain('postprocess_started')
    expect(runWorker).toHaveBeenCalled()
    expect(runPostProcess).toHaveBeenCalledTimes(1)

    const rules = result.findings.map((f) => f.rule)
    expect(rules).toContain('MCP_NO_WHEN_TO_USE') // worker
    expect(rules).toContain('MCP_NEAR_DUPLICATE') // post-process

    // agents recorded: structural-linter + workers + orchestrator
    const agentTypes = result.agents.map((a) => a.type)
    expect(agentTypes).toContain('structural-linter')
    expect(agentTypes).toContain('worker')
    expect(agentTypes).toContain('orchestrator')
  })
})

describe('runAnalysis — v2 grounding', () => {
  it('emits file_read events and merges mismatch findings', async () => {
    const grounding = vi.fn(async (_ops, _version) => ({
      findings: [
        {
          id: 'm1',
          agentId: 'worker',
          operation: 'GET /users',
          rule: 'SPEC_CODE_MISMATCH',
          severity: 'error' as const,
          confidence: 'LOW' as const,
          message: 'mismatch',
          actual: '204',
          warning: 'confirm',
          autoFixable: false,
          autoFixed: false,
          resolution: 'pending' as const,
        },
      ],
      filesRead: [{ agentId: 'worker', path: 'handlers/users.go' }],
    }))

    const { events, result } = await drain(runAnalysis(SPEC, { grounding }))
    expect(events.some((e) => e.type === 'file_read')).toBe(true)
    expect(result.findings.map((f) => f.rule)).toContain('SPEC_CODE_MISMATCH')
    expect(result.agents.some((a) => a.id === 'grounding')).toBe(true)
  })

  it('a grounding failure degrades to spec-only findings instead of crashing the run', async () => {
    const grounding = vi.fn(async () => {
      throw new Error('gateway down')
    })
    const { events, result } = await drain(runAnalysis(SPEC, { grounding }))
    expect(result.halted).toBe(false)
    expect(events.some((e) => e.type === 'analysis_complete')).toBe(true)
    const completed = events.find(
      (e) => e.type === 'agent_completed' && e.agentId === 'grounding',
    )
    expect(completed && 'error' in completed ? completed.error : undefined).toBe('gateway down')
  })
})

describe('runAnalysis — failure isolation', () => {
  it('a post-process failure keeps worker findings and completes the run', async () => {
    const runWorker = vi.fn(async (batch: OperationRef[], ctx: WorkerContext) =>
      batch.map((o) => workerFinding(ctx.agentId, o.label)),
    )
    const runPostProcess = vi.fn(async (): Promise<Finding[]> => {
      throw new Error('post-process exploded')
    })

    const { events, result } = await drain(
      runAnalysis(SPEC, { ai: { runWorker, runPostProcess }, batchSize: 1 }),
    )

    expect(result.halted).toBe(false)
    expect(result.findings.map((f) => f.rule)).toContain('MCP_NO_WHEN_TO_USE')
    expect(events.some((e) => e.type === 'analysis_complete')).toBe(true)
    const completed = events.find(
      (e) => e.type === 'agent_completed' && e.agentId === 'orchestrator',
    )
    expect(completed && 'error' in completed ? completed.error : undefined).toBe(
      'post-process exploded',
    )
  })
})
