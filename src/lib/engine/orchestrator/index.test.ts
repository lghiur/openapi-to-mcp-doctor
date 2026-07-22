import { describe, expect, it, vi } from 'vitest'
import { orchestrate } from '@/lib/engine/orchestrator'
import type { OperationRef } from '@/lib/engine/operations'
import type { EngineEvent, Finding } from '@/types/domain'

function makeOps(n: number): OperationRef[] {
  return Array.from({ length: n }, (_, i) => ({
    id: `op_${i}`,
    method: 'GET',
    path: `/r${i}`,
    label: `GET /r${i}`,
    definition: { operationId: `op_${i}` },
  }))
}

function finding(agentId: string, operation: string): Finding {
  return {
    id: `${agentId}-${operation}`,
    agentId,
    operation,
    rule: 'MCP_NO_WHEN_TO_USE',
    severity: 'warning',
    confidence: 'MEDIUM',
    message: 'vague',
    autoFixable: false,
    autoFixed: false,
    resolution: 'pending',
  }
}

async function collect(gen: AsyncGenerator<EngineEvent>): Promise<EngineEvent[]> {
  const events: EngineEvent[] = []
  for await (const event of gen) events.push(event)
  return events
}

describe('orchestrate — structural gaps', () => {
  it('hands each worker only its own batch’s gaps', async () => {
    const operations = makeOps(3)
    const seen: unknown[] = []
    const runWorker = vi.fn(
      async (_batch: OperationRef[], ctx: { agentId: string; gaps?: unknown }) => {
        seen.push(ctx.gaps)
        return [] as Finding[]
      },
    )
    const gap = { rule: 'operation-description', message: 'missing', path: [] }
    await collect(
      orchestrate({
        operations,
        version: '3.0',
        batchSize: 1,
        runWorker,
        gaps: { 'GET /r0': [gap] },
      }),
    )
    // the batch containing GET /r0 sees its gap; gap-free batches get none
    expect(seen[0]).toEqual({ 'GET /r0': [gap] })
    expect(seen.slice(1).every((g) => g === undefined)).toBe(true)
  })
})

describe('orchestrate', () => {
  it('partitions N operations into ceil(N/batchSize) workers', async () => {
    const runWorker = vi.fn(async (batch: OperationRef[], ctx: { agentId: string }) =>
      batch.map((o) => finding(ctx.agentId, o.label)),
    )
    const events = await collect(
      orchestrate({ operations: makeOps(10), version: '3.0', batchSize: 4, runWorker }),
    )
    const started = events.filter((e) => e.type === 'agent_started')
    expect(started).toHaveLength(3) // ceil(10/4)
    expect(runWorker).toHaveBeenCalledTimes(3)
  })

  it('passes each worker only its own batch (not the whole set)', async () => {
    const seen: number[] = []
    const runWorker = vi.fn(async (batch: OperationRef[]) => {
      seen.push(batch.length)
      return []
    })
    await collect(orchestrate({ operations: makeOps(5), version: '3.0', batchSize: 2, runWorker }))
    expect(seen).toEqual([2, 2, 1])
  })

  it('emits finding events followed by an agent_completed per worker', async () => {
    const runWorker = async (batch: OperationRef[], ctx: { agentId: string }) =>
      batch.map((o) => finding(ctx.agentId, o.label))
    const events = await collect(
      orchestrate({ operations: makeOps(2), version: '3.0', batchSize: 1, runWorker }),
    )
    const findings = events.filter((e) => e.type === 'finding')
    const completed = events.filter((e) => e.type === 'agent_completed')
    expect(findings).toHaveLength(2)
    expect(completed).toHaveLength(2)
    // finding events carry the full Finding object
    const first = findings[0]
    expect(first?.type === 'finding' ? first.finding.rule : undefined).toBe('MCP_NO_WHEN_TO_USE')
  })

  it('streams results in completion order, not input order', async () => {
    // worker-1 (batch 0) is slow; worker-2 (batch 1) is fast and should complete first.
    const runWorker = async (batch: OperationRef[], ctx: { agentId: string }) => {
      const delay = ctx.agentId === 'worker-1' ? 30 : 0
      await new Promise((r) => setTimeout(r, delay))
      return batch.map((o) => finding(ctx.agentId, o.label))
    }
    const events = await collect(
      orchestrate({ operations: makeOps(2), version: '3.0', batchSize: 1, runWorker }),
    )
    const completedOrder = events
      .filter((e) => e.type === 'agent_completed')
      .map((e) => (e.type === 'agent_completed' ? e.agentId : ''))
    expect(completedOrder[0]).toBe('worker-2')
  })

  it('survives a worker that throws (completes it with zero findings)', async () => {
    const runWorker = async (batch: OperationRef[], ctx: { agentId: string }) => {
      if (ctx.agentId === 'worker-1') throw new Error('llm exploded')
      return batch.map((o) => finding(ctx.agentId, o.label))
    }
    const events = await collect(
      orchestrate({ operations: makeOps(2), version: '3.0', batchSize: 1, runWorker }),
    )
    const completed = events.filter((e) => e.type === 'agent_completed')
    expect(completed).toHaveLength(2)
    // The healthy worker still produced its finding.
    expect(events.filter((e) => e.type === 'finding')).toHaveLength(1)
  })

  it('carries the error on agent_completed so zero findings never reads as clean', async () => {
    const runWorker = async (batch: OperationRef[], ctx: { agentId: string }) => {
      if (ctx.agentId === 'worker-1') throw new Error('llm exploded')
      return batch.map((o) => finding(ctx.agentId, o.label))
    }
    const events = await collect(
      orchestrate({ operations: makeOps(2), version: '3.0', batchSize: 1, runWorker }),
    )
    const completed = events.filter((e) => e.type === 'agent_completed')
    const failed = completed.find((e) => e.type === 'agent_completed' && e.agentId === 'worker-1')
    const healthy = completed.find((e) => e.type === 'agent_completed' && e.agentId === 'worker-2')
    expect(failed && 'error' in failed ? failed.error : undefined).toBe('llm exploded')
    expect(healthy && 'error' in healthy ? healthy.error : undefined).toBeUndefined()
  })

  it('caps in-flight workers at 4 by default', async () => {
    let inFlight = 0
    let maxInFlight = 0
    const runWorker = async (batch: OperationRef[], ctx: { agentId: string }) => {
      inFlight++
      maxInFlight = Math.max(maxInFlight, inFlight)
      await new Promise((r) => setTimeout(r, 5))
      inFlight--
      return batch.map((o) => finding(ctx.agentId, o.label))
    }
    const events = await collect(
      orchestrate({ operations: makeOps(12), version: '3.0', batchSize: 1, runWorker }),
    )
    expect(maxInFlight).toBe(4)
    // Every worker still runs to completion and streams its findings.
    expect(events.filter((e) => e.type === 'agent_completed')).toHaveLength(12)
    expect(events.filter((e) => e.type === 'finding')).toHaveLength(12)
  })

  it('honors a concurrency override', async () => {
    let inFlight = 0
    let maxInFlight = 0
    const runWorker = async () => {
      inFlight++
      maxInFlight = Math.max(maxInFlight, inFlight)
      await new Promise((r) => setTimeout(r, 2))
      inFlight--
      return []
    }
    await collect(
      orchestrate({
        operations: makeOps(6),
        version: '3.0',
        batchSize: 1,
        concurrency: 2,
        runWorker,
      }),
    )
    expect(maxInFlight).toBe(2)
  })

  it('releases a failed worker’s slot so queued workers still run', async () => {
    const started: string[] = []
    const runWorker = async (_batch: OperationRef[], ctx: { agentId: string }) => {
      started.push(ctx.agentId)
      throw new Error('llm exploded')
    }
    const events = await collect(
      orchestrate({
        operations: makeOps(5),
        version: '3.0',
        batchSize: 1,
        concurrency: 1,
        runWorker,
      }),
    )
    expect(started).toHaveLength(5)
    expect(events.filter((e) => e.type === 'agent_completed')).toHaveLength(5)
  })

  it('yields nothing but a clean stream when there are no operations', async () => {
    const runWorker = vi.fn(async () => [])
    const events = await collect(orchestrate({ operations: [], version: '3.0', runWorker }))
    expect(events).toHaveLength(0)
    expect(runWorker).not.toHaveBeenCalled()
  })
})
