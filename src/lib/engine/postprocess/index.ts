import type { LanguageModel } from 'ai'
import type { ZodType } from 'zod'
import type { OperationRef } from '@/lib/engine/operations'
import { generateStructured } from '@/lib/llm/client'
import { type PostProcessOutput, PostProcessOutputSchema } from '@/lib/llm/schemas'
import type { Finding } from '@/types/domain'

export type GeneratePostProcess = (args: {
  schema: ZodType<PostProcessOutput>
  prompt: string
  system?: string
  model: LanguageModel
  abortSignal?: AbortSignal
}) => Promise<PostProcessOutput>

export interface PostProcessOptions {
  operations: OperationRef[]
  model: LanguageModel
  /** Cancels the in-flight LLM call when the run is aborted. */
  signal?: AbortSignal
  /** Injectable for tests; defaults to the real generateStructured. */
  generate?: GeneratePostProcess
}

const SYSTEM_PROMPT = [
  'You are reviewing a set of OpenAPI operations that will be exposed as MCP tools.',
  'Identify near-duplicate operations: pairs (or groups) an LLM agent would struggle to',
  'choose between — same intent, overlapping descriptions, or paths differing only by a',
  'query parameter. For each, propose a one-line disambiguation telling the agent when to',
  'use each. Do not invent duplicates; report only genuine ambiguity.',
].join('\n')

/**
 * Cross-operation post-processing: a single LLM call (after all workers finish)
 * that flags near-duplicate operations. Skipped entirely when there are fewer
 * than two operations to compare.
 */
export async function runPostProcess(options: PostProcessOptions): Promise<Finding[]> {
  if (options.operations.length < 2) return []
  const generate = options.generate ?? generateStructured

  const output = await generate({
    schema: PostProcessOutputSchema,
    system: SYSTEM_PROMPT,
    prompt: buildPrompt(options.operations),
    model: options.model,
    ...(options.signal ? { abortSignal: options.signal } : {}),
  })

  return output.nearDuplicates.map((pair, index) => ({
    id: `orchestrator-near-duplicate-${index}`,
    agentId: 'orchestrator',
    operations: pair.operations,
    rule: 'MCP_NEAR_DUPLICATE',
    severity: 'warning',
    confidence: 'MEDIUM',
    message: `These operations are near-duplicates an agent may confuse: ${pair.operations.join(', ')}.`,
    after: pair.suggested,
    autoFixable: false,
    autoFixed: false,
    resolution: 'pending',
  }))
}

function buildPrompt(operations: OperationRef[]): string {
  const lines = operations.map((operation) => {
    const description =
      typeof operation.definition.description === 'string'
        ? operation.definition.description
        : '(no description)'
    return `- ${operation.label}: ${description}`
  })
  return `Operations:\n${lines.join('\n')}`
}
