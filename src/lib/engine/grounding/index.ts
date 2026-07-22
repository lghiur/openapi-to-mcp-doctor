import { createHash } from 'node:crypto'
import { discoverUndocumentedEndpoints } from '@/lib/engine/grounding/discover'
import { type DetectMismatchesDeps, detectMismatches } from '@/lib/engine/grounding/read'
import {
  findSymbolDefinition,
  mapOperationsToHandlers,
  type HandlerCandidate,
  type RouteFile,
} from '@/lib/engine/grounding/map'
import type { OperationRef } from '@/lib/engine/operations'
import type { FileReadRole, Finding } from '@/types/domain'

export type { RouteFile } from '@/lib/engine/grounding/map'

/** Evidence trail: one file a grounding agent read, and why. */
export interface FileReadRecord {
  agentId: string
  path: string
  operation?: string
  /** Total lines of the file handed to the agent. */
  linesRead?: number
  /** Line where the route match / symbol definition was found. */
  line?: number
  role?: FileReadRole
  /** Handler symbol that led the agent to this file. */
  symbol?: string
}

const GROUNDING_AGENT_ID = 'worker'

/** Concurrent mismatch-detection calls — mirrors the orchestrator's fan-out ethos. */
const DEFAULT_GROUNDING_CONCURRENCY = 4

export interface GroundingInput {
  operations: OperationRef[]
  routeFiles: RouteFile[]
  version: import('@/types/domain').OpenApiVersion
  /** Spec `servers[].url` path components — tried as external base paths when mapping. */
  serverPrefixes?: string[]
}

export interface GroundingDeps {
  model: import('ai').LanguageModel
  /** Cancels in-flight LLM calls when the run is aborted. */
  signal?: AbortSignal
  concurrency?: number
  detect?: typeof detectMismatches
}

export interface GroundingResult {
  findings: Finding[]
  filesRead: FileReadRecord[]
  /** Operations whose mismatch detection failed — zero findings ≠ "code matches". */
  failures?: Array<{ operation: string; error: string }>
}

/** Combined hash of the route/handler files — the second cache dimension (v2). */
export function hashHandlerFiles(routeFiles: RouteFile[]): string {
  const hash = createHash('sha256')
  for (const file of [...routeFiles].sort((a, b) => a.path.localeCompare(b.path))) {
    hash.update(file.path).update('\0').update(file.content).update('\0')
  }
  return hash.digest('hex')
}

/**
 * Per-operation grounding reuse key (label → hash). Grounding compares the
 * operation's spec fragment against its handler code, so the key covers BOTH
 * sides: the hash of the exact files the grounding reads (registration site +
 * followed handler definition) mixed with the hash of the operation's spec
 * fragment — a cached spec⇄code mismatch finding must not be replayed after
 * either side changed. Unmapped operations hash the whole route-file set —
 * any change there could make them mappable.
 */
export function hashOperationHandlers(
  operations: OperationRef[],
  routeFiles: RouteFile[],
  options: { serverPrefixes?: string[] } = {},
): Record<string, string> {
  const candidates = mapOperationsToHandlers(operations, routeFiles, options)
  const allFilesHash = hashHandlerFiles(routeFiles)
  const specShapeByLabel = new Map(
    operations.map((operation) => [operation.label, hashOperationSpecShape(operation)]),
  )
  const hashes: Record<string, string> = {}
  for (const candidate of candidates) {
    let handlerHash = allFilesHash
    if (candidate.matched && candidate.file !== null) {
      const sources = resolveHandlerSources(candidate, routeFiles)
      if (sources.length > 0) handlerHash = hashHandlerFiles(sources.map((s) => s.file))
    }
    hashes[candidate.operation] = createHash('sha256')
      .update(specShapeByLabel.get(candidate.operation) ?? '')
      .update('\0')
      .update(handlerHash)
      .digest('hex')
  }
  return hashes
}

/** Hash of the operation's spec fragment — the spec side of the grounding key. */
function hashOperationSpecShape(operation: OperationRef): string {
  return createHash('sha256').update(JSON.stringify(operation.definition)).digest('hex')
}

/**
 * v2 codebase grounding: map each operation to its registration site, follow the
 * handler symbol to its definition (depth 2, deterministic — no LLM), and run
 * concurrent mismatch detection per operation. One operation's failed LLM call
 * never sinks the others; unmapped operations surface as an info finding.
 */
export async function runGrounding(
  input: GroundingInput,
  deps: GroundingDeps,
): Promise<GroundingResult> {
  const detect = deps.detect ?? detectMismatches
  const candidates = mapOperationsToHandlers(input.operations, input.routeFiles, {
    ...(input.serverPrefixes !== undefined ? { serverPrefixes: input.serverPrefixes } : {}),
  })
  const findings: Finding[] = []
  const filesRead: FileReadRecord[] = []

  // The inverse check needs no LLM: routes registered in code that the spec
  // does not document, each carrying an insertable documentation stub.
  findings.push(
    ...discoverUndocumentedEndpoints(input.operations, input.routeFiles, {
      ...(input.serverPrefixes !== undefined ? { serverPrefixes: input.serverPrefixes } : {}),
    }),
  )

  const jobs: Array<{ operation: OperationRef; handlerCode: string }> = []
  for (const candidate of candidates) {
    const operation = input.operations.find((o) => o.label === candidate.operation)
    if (!operation) continue

    if (!candidate.matched || candidate.file === null) {
      findings.push(handlerNotFound(operation))
      continue
    }

    const sources = resolveHandlerSources(candidate, input.routeFiles)
    if (sources.length === 0) continue

    for (const source of sources) {
      filesRead.push({
        agentId: GROUNDING_AGENT_ID,
        path: source.file.path,
        operation: operation.label,
        linesRead: countLines(source.file.content),
        ...(source.line !== null ? { line: source.line } : {}),
        role: source.role,
        ...(source.symbol !== undefined ? { symbol: source.symbol } : {}),
      })
    }
    jobs.push({ operation, handlerCode: renderSources(sources) })
  }

  // Fan out with a cap; per-operation failure isolation (a hung or failing call
  // yields no findings for that operation, the rest proceed) — but failures are
  // recorded, never swallowed: "no mismatches" and "detection failed" differ.
  const failures: Array<{ operation: string; error: string }> = []
  const results = await mapConcurrent(
    jobs,
    deps.concurrency ?? DEFAULT_GROUNDING_CONCURRENCY,
    (job) =>
      detect(
        { operation: job.operation, handlerCode: job.handlerCode, version: input.version },
        {
          model: deps.model,
          agentId: GROUNDING_AGENT_ID,
          ...(deps.signal ? { signal: deps.signal } : {}),
        } satisfies DetectMismatchesDeps,
      ).catch((cause: unknown): Finding[] => {
        failures.push({
          operation: job.operation.label,
          error: cause instanceof Error ? cause.message : 'Mismatch detection failed.',
        })
        return []
      }),
  )
  for (const result of results) findings.push(...result)

  return { findings, filesRead, ...(failures.length > 0 ? { failures } : {}) }
}

/** One source file resolved for an operation, with the evidence of why it was read. */
interface HandlerSource {
  file: RouteFile
  /** Where the route match / symbol definition sits in the file. */
  line: number | null
  role: FileReadRole
  symbol?: string
}

/**
 * The code an operation's detector should read: the registration file, plus —
 * when the registered symbol's definition lives in a different provided file —
 * that file too. This is the depth-2 read: registration site → handler body.
 */
function resolveHandlerSources(
  candidate: HandlerCandidate,
  routeFiles: RouteFile[],
): HandlerSource[] {
  const registration = routeFiles.find((f) => f.path === candidate.file)
  if (!registration) return []

  const registrationSource: HandlerSource = {
    file: registration,
    line: candidate.line,
    role: 'registration',
    ...(candidate.symbol !== null ? { symbol: candidate.symbol } : {}),
  }

  if (candidate.symbol) {
    const definition = findSymbolDefinition(candidate.symbol, routeFiles)
    if (definition && definition.file !== registration.path) {
      const definitionFile = routeFiles.find((f) => f.path === definition.file)
      if (definitionFile) {
        return [
          registrationSource,
          {
            file: definitionFile,
            line: definition.line,
            role: 'handler',
            symbol: candidate.symbol,
          },
        ]
      }
    }
  }
  return [registrationSource]
}

function renderSources(sources: HandlerSource[]): string {
  return sources
    .map((source) => `// --- ${source.file.path} ---\n${source.file.content}`)
    .join('\n\n')
}

function countLines(content: string): number {
  return content.split('\n').length
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

function handlerNotFound(operation: OperationRef): Finding {
  return {
    id: `grounding-unmapped-${operation.id}`,
    agentId: GROUNDING_AGENT_ID,
    operation: operation.label,
    rule: 'SPEC_CODE_HANDLER_NOT_FOUND',
    severity: 'info',
    confidence: 'LOW',
    message:
      `No handler found for ${operation.label} in the provided route files. ` +
      'The path may be built dynamically (config-driven names, string concatenation) ' +
      'or registered in a file that was not provided.',
    autoFixable: false,
    autoFixed: false,
    resolution: 'pending',
  }
}
