import type { LanguageModel } from 'ai'
import type { ZodType } from 'zod'
import { type OperationRef, operationBasePath } from '@/lib/engine/operations'
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

interface Candidate {
  finding: Finding
  operation: OperationRef
}

export function createSuggester(options: CreateSuggesterOptions): RunSuggest {
  const generate = options.generate ?? generateStructured
  const chunkSize = options.chunkSize ?? DEFAULT_CHUNK_SIZE
  const concurrency = options.concurrency ?? DEFAULT_CONCURRENCY

  return async (findings, operations, version) => {
    const candidates = candidatesFor(findings, operations)
    if (candidates.length === 0) return []

    const chunks: Candidate[][] = []
    for (let i = 0; i < candidates.length; i += chunkSize) {
      chunks.push(candidates.slice(i, i + chunkSize))
    }

    const outputs = await mapConcurrent(chunks, concurrency, (chunk) =>
      generate({
        schema: SuggestionOutputSchema,
        system: buildSystemPrompt(version),
        prompt: buildChunkPrompt(chunk),
        model: options.model,
        ...(options.signal ? { abortSignal: options.signal } : {}),
      }).catch((): SuggestionOutput => ({ suggestions: [] })), // chunk isolation
    )

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

/** Structural findings that still need a fix, paired with their operation. */
function candidatesFor(findings: Finding[], operations: OperationRef[]): Candidate[] {
  const byLocation = new Map(
    operations.map((op) => [`${op.path} ${op.method.toLowerCase()}`, op]),
  )
  const candidates: Candidate[] = []
  for (const finding of findings) {
    if (finding.after !== undefined) continue
    const path = finding.path
    if (!path || path[0] !== 'paths' || typeof path[1] !== 'string' || typeof path[2] !== 'string')
      continue
    const operation = byLocation.get(`${path[1]} ${path[2].toLowerCase()}`)
    if (!operation) continue
    candidates.push({ finding, operation })
  }
  return candidates
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
  const findingLines = chunk.map(({ finding, operation }) => {
    const relative = finding.path ? finding.path.slice(3) : []
    return `- findingId ${finding.id} | operation ${operation.label} | rule ${finding.rule} | at ${JSON.stringify(relative)} | ${finding.message}`
  })
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
