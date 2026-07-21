import { DEFAULT_WORKER_BATCH_SIZE } from '@/lib/engine/constants'
import type { OperationRef } from '@/lib/engine/operations'
import type { StructuralGapsByOperation } from '@/lib/engine/workers/gaps'
import type { EngineEvent, Finding, OpenApiVersion } from '@/types/domain'

/** Context an orchestrator passes to each worker: only its batch + version, never the whole spec. */
export interface WorkerContext {
  version: OpenApiVersion
  agentId: string
  /** Structural-linter gaps for this batch's operations — content the AI should author. */
  gaps?: StructuralGapsByOperation
}

export type RunWorker = (batch: OperationRef[], context: WorkerContext) => Promise<Finding[]>

export interface OrchestrateOptions {
  operations: OperationRef[]
  version: OpenApiVersion
  batchSize?: number
  runWorker: RunWorker
  /** Structural gaps per operation label; each worker receives only its batch's slice. */
  gaps?: StructuralGapsByOperation
  /** Injectable clock for deterministic tests. */
  now?: () => number
}

/**
 * Fan out worker agents over operation batches and stream their events. Workers
 * run concurrently; events are yielded in completion order so a slow worker never
 * blocks a fast one's findings from reaching the client.
 */
export async function* orchestrate(options: OrchestrateOptions): AsyncGenerator<EngineEvent, void> {
  const now = options.now ?? (() => Date.now())
  const batchSize = options.batchSize ?? DEFAULT_WORKER_BATCH_SIZE
  const batches = partition(options.operations, batchSize)
  if (batches.length === 0) return

  // Announce every worker up front so the client can render the agent list.
  const jobs = batches.map((batch, index) => {
    const agentId = `worker-${index + 1}`
    return { agentId, batch }
  })
  for (const job of jobs) {
    yield { type: 'agent_started', agentId: job.agentId, operations: job.batch.map((o) => o.label) }
  }

  const running = jobs.map((job) => {
    const startedAt = now()
    const batchGaps = Object.fromEntries(
      job.batch
        .map((op) => [op.label, options.gaps?.[op.label]] as const)
        .filter((entry): entry is readonly [string, NonNullable<(typeof entry)[1]>] =>
          Boolean(entry[1]?.length),
        ),
    )
    return (
      options
        .runWorker(job.batch, {
          version: options.version,
          agentId: job.agentId,
          ...(Object.keys(batchGaps).length > 0 ? { gaps: batchGaps } : {}),
        })
        .then((findings) => ({
          agentId: job.agentId,
          findings,
          durationMs: now() - startedAt,
          error: undefined as string | undefined,
        }))
        // A failing worker must not abort the whole stream — it completes with no
        // findings, but carries the error so zero findings never masquerades as
        // "clean". Engine errors (LlmGenerationError) are credential-free.
        .catch((cause: unknown) => ({
          agentId: job.agentId,
          findings: [] as Finding[],
          durationMs: now() - startedAt,
          error: cause instanceof Error ? cause.message : 'Worker failed.',
        }))
    )
  })

  for await (const result of settleAsCompleted(running)) {
    for (const finding of result.findings) {
      yield { type: 'finding', agentId: result.agentId, finding }
    }
    yield {
      type: 'agent_completed',
      agentId: result.agentId,
      findingsCount: result.findings.length,
      durationMs: result.durationMs,
      ...(result.error !== undefined ? { error: result.error } : {}),
    }
  }
}

function partition<T>(items: T[], size: number): T[][] {
  const batches: T[][] = []
  for (let i = 0; i < items.length; i += size) {
    batches.push(items.slice(i, i + size))
  }
  return batches
}

/** Yield each promise's value as it resolves, in completion order. */
async function* settleAsCompleted<T>(promises: Promise<T>[]): AsyncGenerator<T> {
  const pending = new Map(promises.map((promise, index) => [index, wrap(promise, index)]))
  while (pending.size > 0) {
    const { index, value } = await Promise.race(pending.values())
    pending.delete(index)
    yield value
  }
}

function wrap<T>(promise: Promise<T>, index: number): Promise<{ index: number; value: T }> {
  return promise.then((value) => ({ index, value }))
}
