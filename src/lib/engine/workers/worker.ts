import type { LanguageModel } from 'ai'
import type { ZodType } from 'zod'
import type { RunWorker, WorkerContext } from '@/lib/engine/orchestrator'
import { type OperationRef, operationBasePath } from '@/lib/engine/operations'
import { buildWorkerSystemPrompt, buildWorkerUserPrompt } from '@/lib/engine/workers/prompt'
import { generateStructured } from '@/lib/llm/client'
import { type LlmFinding, type WorkerOutput, WorkerOutputSchema } from '@/lib/llm/schemas'
import type { Finding, SpecPath } from '@/types/domain'

/**
 * Structured-generation function specialized to the worker's output. The generic
 * `generateStructured` satisfies this, and a plain mock is assignable in tests.
 */
export type GenerateWorkerOutput = (args: {
  schema: ZodType<WorkerOutput>
  prompt: string
  system?: string
  model: LanguageModel
  abortSignal?: AbortSignal
}) => Promise<WorkerOutput>

export interface CreateWorkerOptions {
  model: LanguageModel
  /** Cancels in-flight LLM calls when the run is aborted. */
  signal?: AbortSignal
  /** Injectable for tests; defaults to the real generateStructured. */
  generate?: GenerateWorkerOutput
}

/**
 * Build a worker agent. Each invocation makes exactly one structured LLM call for
 * its whole batch, evaluating description quality and MCP semantics. In v1 it
 * reads no code — only the operation definitions the orchestrator hands it.
 */
export function createWorker(options: CreateWorkerOptions): RunWorker {
  const generate = options.generate ?? generateStructured

  return async (batch: OperationRef[], context: WorkerContext): Promise<Finding[]> => {
    const output = await generate({
      schema: WorkerOutputSchema,
      system: buildWorkerSystemPrompt(context.version),
      prompt: buildWorkerUserPrompt(batch, context.gaps),
      model: options.model,
      ...(options.signal ? { abortSignal: options.signal } : {}),
    })
    return output.findings.map((finding, index) =>
      toFinding(finding, context.agentId, index, batch),
    )
  }
}

/**
 * Anchor an agent's operation-relative path to the document root. Returns
 * undefined when the agent named an operation outside its batch — an anchored
 * path we can't trust is worse than no path.
 */
function absolutePath(llm: LlmFinding, batch: OperationRef[]): SpecPath | undefined {
  if (llm.path === undefined) return undefined
  const operation = batch.find((o) => o.label === llm.operation || o.id === llm.operation)
  if (!operation) return undefined
  return [...operationBasePath(operation), ...llm.path]
}

function toFinding(
  llm: LlmFinding,
  agentId: string,
  index: number,
  batch: OperationRef[],
): Finding {
  const path = absolutePath(llm, batch)
  return {
    id: `${agentId}-${index}-${llm.rule}`,
    agentId,
    operation: llm.operation,
    rule: llm.rule,
    severity: llm.severity,
    confidence: llm.confidence,
    message: llm.message,
    ...(llm.current !== undefined ? { before: llm.current } : {}),
    ...(llm.suggested !== undefined ? { after: llm.suggested } : {}),
    ...(path !== undefined ? { path } : {}),
    // Appliable means: something to write, and a verified place to write it.
    autoFixable: llm.confidence === 'HIGH' && llm.suggested !== undefined && path !== undefined,
    autoFixed: false,
    resolution: 'pending',
  }
}
