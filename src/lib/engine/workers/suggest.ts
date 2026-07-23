import type { LanguageModel } from 'ai'
import type { ZodType } from 'zod'
import { type OperationRef, operationBasePath } from '@/lib/engine/operations'
import { type ContentGap, contentGaps } from '@/lib/engine/workers/gaps'
import { generateStructured } from '@/lib/llm/client'
import { type SuggestionOutput, SuggestionOutputSchema } from '@/lib/llm/schemas'
import type { Finding, OpenApiVersion } from '@/types/domain'

/**
 * The fix-suggester (worker tier): authors a concrete fix for every structural
 * finding the linter could only detect — missing descriptions, schemas,
 * examples… It enriches the ORIGINAL findings (same id) with `after` + `path`,
 * so the review UI's diagnostics become acceptable suggestions and "Accept all"
 * covers them. AI-authored content is always demoted to MEDIUM confidence:
 * detection was deterministic, the fix is not.
 */

export type GenerateSuggestions = (args: {
  schema: ZodType<SuggestionOutput>
  prompt: string
  system?: string
  model: LanguageModel
  abortSignal?: AbortSignal
}) => Promise<SuggestionOutput>

export interface CreateSuggesterOptions {
  model: LanguageModel
  signal?: AbortSignal
  /** Injectable for tests; defaults to the real generateStructured. */
  generate?: GenerateSuggestions
  /** Findings per LLM call. */
  chunkSize?: number
  /** Concurrent LLM calls. */
  concurrency?: number
}

export type RunSuggest = (
  findings: Finding[],
  operations: OperationRef[],
  version: OpenApiVersion,
) => Promise<Finding[]>

const DEFAULT_CHUNK_SIZE = 12
const DEFAULT_CONCURRENCY = 4

/**
 * The findings this suggester authors content for: `contentGaps` — the same
 * definition the worker-prompt path uses, so the two can never drift apart.
 */
type Candidate = ContentGap

export function createSuggester(options: CreateSuggesterOptions): RunSuggest {
  const generate = options.generate ?? generateStructured
  const chunkSize = options.chunkSize ?? DEFAULT_CHUNK_SIZE
  const concurrency = options.concurrency ?? DEFAULT_CONCURRENCY

  return async (findings, operations, version) => {
    const candidates = contentGaps(operations, findings)
    if (candidates.length === 0) return []

    const chunks: Candidate[][] = []
    for (let i = 0; i < candidates.length; i += chunkSize) {
      chunks.push(candidates.slice(i, i + chunkSize))
    }

    // Chunk isolation: one bad chunk must not discard the others' suggestions.
    // But if EVERY chunk failed there is nothing to isolate — the gateway is
    // down, and swallowing that would report "no fixes needed" on a run where
    // nothing was even asked. Rethrow so the caller marks the agent errored.
    const failures: unknown[] = []
    const outputs = await mapConcurrent(chunks, concurrency, (chunk) =>
      generate({
        schema: SuggestionOutputSchema,
        system: buildSystemPrompt(version),
        prompt: buildChunkPrompt(chunk),
        model: options.model,
        ...(options.signal ? { abortSignal: options.signal } : {}),
      }).catch((cause: unknown): SuggestionOutput => {
        failures.push(cause)
        return { suggestions: [] }
      }),
    )
    if (failures.length === chunks.length) {
      throw failures[0] instanceof Error
        ? failures[0]
        : new Error('Fix suggestion failed for every batch.')
    }

    const byId = new Map(candidates.map((c) => [c.finding.id, c]))
    const enriched: Finding[] = []
    for (const output of outputs) {
      for (const suggestion of output.suggestions) {
        const candidate = byId.get(suggestion.findingId)
        // A suggestion is appliable only with a verified target: known finding +
        // a model-provided path anchored to that finding's operation.
        if (!candidate || suggestion.path === undefined) continue
        enriched.push({
          ...candidate.finding,
          after: suggestion.suggested,
          path: [...operationBasePath(candidate.operation), ...suggestion.path],
          confidence: 'MEDIUM',
          autoFixable: false,
        })
        byId.delete(suggestion.findingId) // first suggestion wins
      }
    }
    return enriched
  }
}

function buildSystemPrompt(version: OpenApiVersion): string {
  const wrongVersion = version === '3.1' ? '3.0' : '3.1'
  return [
    `You author fixes for OpenAPI ${version} lint findings so the spec works well as MCP`,
    `tools for LLM agents. For each finding you are given, write the exact content to`,
    `insert: descriptions that explain when to use the operation and how to construct`,
    `arguments; response schemas that reflect what the operation plausibly returns;`,
    `examples that satisfy their schema. Encode non-string values (schemas, booleans,`,
    `arrays) as JSON strings. Never use OpenAPI ${wrongVersion} syntax.`,
    ``,
    `Return one suggestion per finding you can fix, with:`,
    `- "findingId": copied exactly from the finding`,
    `- "suggested": the exact value to insert`,
    `- "path": where to write it, relative to the finding's operation object, as an`,
    `  array of keys and array indexes, e.g. ["parameters", 0, "description"] or`,
    `  ["responses", "200", "content", "application/json", "schema"]. Only the final`,
    `  key may be a field that does not exist yet.`,
    `Omit findings you cannot author a concrete, correct value for.`,
  ].join('\n')
}

function buildChunkPrompt(chunk: Candidate[]): string {
  // One definition block per distinct operation, then the findings against them.
  const operations = new Map(chunk.map((c) => [c.operation.label, c.operation]))
  const sections = [...operations.values()].map(
    (op) => `### ${op.label}\n\`\`\`json\n${JSON.stringify(op.definition, null, 2)}\n\`\`\``,
  )
  const findingLines = chunk.map(
    ({ finding, operation, relativePath }) =>
      `- findingId ${finding.id} | operation ${operation.label} | rule ${finding.rule} | at ${JSON.stringify(relativePath)} | ${finding.message}`,
  )
  return [
    `Operations under review:`,
    ...sections,
    ``,
    `Author a fix for each of these findings:`,
    ...findingLines,
  ].join('\n\n')
}

/** Run `fn` over items with at most `limit` in flight; results keep item order. */
async function mapConcurrent<T, R>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array<R>(items.length)
  let nextIndex = 0
  const lanes = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    while (nextIndex < items.length) {
      const index = nextIndex
      nextIndex += 1
      const item = items[index]
      if (item === undefined) continue
      results[index] = await fn(item)
    }
  })
  await Promise.all(lanes)
  return results
}
