import { extractOperations, type OperationRef } from '@/lib/engine/operations'
import { orchestrate, type RunWorker } from '@/lib/engine/orchestrator'
import { filterFindings, filterOperations } from '@/lib/engine/selection'
import { structuralGapsFor } from '@/lib/engine/workers/gaps'
import { runStructuralAnalysis } from '@/lib/engine/structural'
import { type StructuralSummary, summarizeFindings } from '@/lib/engine/summary'
import type {
  AgentRecord,
  AnalysisPhase,
  EngineEvent,
  Finding,
  OpenApiVersion,
  OperationSelection,
} from '@/types/domain'

export type GroundingRunner = (
  operations: OperationRef[],
  version: OpenApiVersion,
) => Promise<GroundingResult>

/** The AI half of analysis: a worker runner + a post-processing pass (+ v2 grounding). */
export interface AiCapability {
  runWorker: RunWorker
  runPostProcess: (operations: OperationRef[]) => Promise<Finding[]>
  /**
   * Fix-suggester (worker tier): authors a fix for every content-needing
   * structural finding, returning enriched copies (same ids) to replace them.
   */
  runSuggest?: (
    findings: Finding[],
    operations: OperationRef[],
    version: OpenApiVersion,
  ) => Promise<Finding[]>
  runGrounding?: (
    operations: OperationRef[],
    routeFiles: import('@/lib/engine/grounding').RouteFile[],
    version: OpenApiVersion,
    serverPrefixes?: string[],
  ) => Promise<GroundingResult>
}

export interface GroundingResult {
  findings: Finding[]
  filesRead: Array<import('@/lib/engine/grounding').FileReadRecord>
  /** Operations whose mismatch detection failed — zero findings ≠ "code matches". */
  failures?: Array<{ operation: string; error: string }>
}

export interface RunAnalysisOptions {
  ai?: AiCapability
  batchSize?: number
  /** v2 codebase grounding: reads handlers for the operations and returns mismatches. */
  grounding?: GroundingRunner
  /** Analyse/fix only these paths+methods; findings outside them are dropped. */
  selection?: OperationSelection
  now?: () => number
}

export interface AnalysisResult {
  version: OpenApiVersion | null
  halted: boolean
  findings: Finding[]
  summary: StructuralSummary
  agents: AgentRecord[]
}

const STRUCTURAL_AGENT_ID = 'structural-linter'

/**
 * The unified analysis event stream consumed by both the CLI and the web app.
 * Always runs the structural linter; if an `ai` capability is supplied it then
 * fans out workers and runs post-processing. Yields engine events as work
 * progresses and returns the fully assembled result.
 */
export async function* runAnalysis(
  spec: string,
  options: RunAnalysisOptions = {},
): AsyncGenerator<EngineEvent, AnalysisResult> {
  const now = options.now ?? (() => Date.now())
  const startedAt = now()

  // Announce the run up front so the client knows the full operation set (the
  // denominator for "X of N analysed") and which pipeline phases will run, before
  // any work — and any findings — arrive. Safe on unparseable specs ([] operations).
  // An operation selection narrows the set to what the user picked.
  const operations = filterOperations(extractOperations(spec), options.selection)
  const phases: AnalysisPhase[] = ['structural']
  if (options.ai) {
    phases.push('workers')
    if (operations.length >= 2) phases.push('postprocess')
  }
  if (options.grounding) phases.push('grounding')
  yield { type: 'analysis_started', operations: operations.map((o) => o.label), phases }

  const structural = await runStructuralAnalysis(spec)
  // The linter always runs on the whole document; the selection filter then
  // drops findings anchored on unselected paths/methods (document-level ones stay).
  const structuralFindings = filterFindings(structural.findings, options.selection)
  const findings: Finding[] = [...structuralFindings]
  const agents: AgentRecord[] = []

  yield { type: 'agent_started', agentId: STRUCTURAL_AGENT_ID, operations: [] }
  for (const finding of structuralFindings) {
    yield { type: 'finding', agentId: STRUCTURAL_AGENT_ID, finding }
  }
  yield {
    type: 'agent_completed',
    agentId: STRUCTURAL_AGENT_ID,
    findingsCount: structuralFindings.length,
    durationMs: 0,
  }
  agents.push({
    id: STRUCTURAL_AGENT_ID,
    type: 'structural-linter',
    operations: [],
    filesRead: [],
    findingsCount: structuralFindings.length,
    durationMs: 0,
  })

  if (structural.halted || structural.version === null) {
    yield completeEvent(findings, now() - startedAt)
    return { version: null, halted: true, findings, summary: summarizeFindings(findings), agents }
  }

  if (options.ai) {
    // Fix-suggester runs concurrently with the workers: it authors fixes for the
    // structural findings already streamed out, then re-emits them enriched
    // (same ids) so clients upgrade their diagnostics to acceptable suggestions.
    const runSuggest = options.ai.runSuggest
    const suggestStartedAt = now()
    let suggestError: string | undefined
    const suggestPromise: Promise<Finding[]> =
      runSuggest && structuralFindings.length > 0
        ? runSuggest(structuralFindings, operations, structural.version).catch(
            (cause: unknown) => {
              suggestError = cause instanceof Error ? cause.message : 'Fix suggestion failed.'
              return []
            },
          )
        : Promise.resolve([])
    if (runSuggest && structuralFindings.length > 0) {
      yield { type: 'agent_started', agentId: 'fix-suggester', operations: [] }
    }

    const workerStats = new Map<
      string,
      { operations: string[]; findingsCount: number; durationMs: number }
    >()

    for await (const event of orchestrate({
      operations,
      version: structural.version,
      batchSize: options.batchSize,
      runWorker: options.ai.runWorker,
      // Linter-detected gaps that need authored content (missing descriptions,
      // response schemas…) — the workers propose the content, closing the loop.
      gaps: structuralGapsFor(operations, structuralFindings),
      now,
    })) {
      if (event.type === 'finding') findings.push(event.finding)
      if (event.type === 'agent_started') {
        workerStats.set(event.agentId, {
          operations: event.operations,
          findingsCount: 0,
          durationMs: 0,
        })
      }
      if (event.type === 'agent_completed') {
        const stats = workerStats.get(event.agentId)
        if (stats) {
          stats.findingsCount = event.findingsCount
          stats.durationMs = event.durationMs
        }
      }
      yield event
    }

    for (const [id, stats] of workerStats) {
      agents.push({
        id,
        type: 'worker',
        operations: stats.operations,
        filesRead: [],
        findingsCount: stats.findingsCount,
        durationMs: stats.durationMs,
      })
    }

    if (runSuggest && structuralFindings.length > 0) {
      const enriched = await suggestPromise
      for (const finding of enriched) {
        const index = findings.findIndex((f) => f.id === finding.id)
        if (index === -1) continue
        findings[index] = finding
        yield { type: 'finding', agentId: 'fix-suggester', finding }
      }
      yield {
        type: 'agent_completed',
        agentId: 'fix-suggester',
        findingsCount: enriched.length,
        durationMs: now() - suggestStartedAt,
        ...(suggestError !== undefined ? { error: suggestError } : {}),
      }
      agents.push({
        id: 'fix-suggester',
        type: 'worker',
        operations: [],
        filesRead: [],
        findingsCount: enriched.length,
        durationMs: now() - suggestStartedAt,
      })
    }

    if (operations.length >= 2) {
      yield {
        type: 'postprocess_started',
        check: 'near-duplicate-detection',
        operationCount: operations.length,
      }
      const postStartedAt = now()
      let duplicates: Finding[] = []
      let postError: string | undefined
      try {
        duplicates = await options.ai.runPostProcess(operations)
      } catch (cause) {
        // A post-process failure degrades to "no cross-operation findings" — it
        // must never crash a run whose worker findings already streamed out.
        postError = cause instanceof Error ? cause.message : 'Post-processing failed.'
      }
      for (const finding of duplicates) {
        findings.push(finding)
        yield { type: 'finding', agentId: 'orchestrator', finding }
      }
      yield {
        type: 'agent_completed',
        agentId: 'orchestrator',
        findingsCount: duplicates.length,
        durationMs: now() - postStartedAt,
        ...(postError !== undefined ? { error: postError } : {}),
      }
      agents.push({
        id: 'orchestrator',
        type: 'orchestrator',
        operations: [],
        filesRead: [],
        findingsCount: duplicates.length,
        durationMs: now() - postStartedAt,
      })
    }
  }

  if (options.grounding) {
    const groundingStartedAt = now()
    let grounding: GroundingResult = { findings: [], filesRead: [] }
    let groundingError: string | undefined
    try {
      grounding = await options.grounding(operations, structural.version)
      if (grounding.failures && grounding.failures.length > 0) {
        const ops = grounding.failures.map((f) => f.operation).join(', ')
        groundingError = `mismatch detection failed for ${grounding.failures.length} operation(s): ${ops}`
      }
    } catch (cause) {
      // Same isolation as workers/post-process: grounding is additive, its
      // failure degrades the run to spec-only findings rather than sinking it.
      groundingError = cause instanceof Error ? cause.message : 'Grounding failed.'
    }
    for (const file of grounding.filesRead) {
      yield {
        type: 'file_read',
        agentId: file.agentId,
        path: file.path,
        ...(file.operation !== undefined ? { operation: file.operation } : {}),
        ...(file.linesRead !== undefined ? { linesRead: file.linesRead } : {}),
        ...(file.line !== undefined ? { line: file.line } : {}),
        ...(file.role !== undefined ? { role: file.role } : {}),
        ...(file.symbol !== undefined ? { symbol: file.symbol } : {}),
      }
    }
    for (const finding of grounding.findings) {
      findings.push(finding)
      yield { type: 'finding', agentId: finding.agentId, finding }
    }
    yield {
      type: 'agent_completed',
      agentId: 'grounding',
      findingsCount: grounding.findings.length,
      durationMs: now() - groundingStartedAt,
      ...(groundingError !== undefined ? { error: groundingError } : {}),
    }
    agents.push({
      id: 'grounding',
      type: 'worker',
      operations: [],
      filesRead: grounding.filesRead.map((f) => f.path),
      findingsCount: grounding.findings.length,
      durationMs: now() - groundingStartedAt,
    })
  }

  yield completeEvent(findings, now() - startedAt)
  return {
    version: structural.version,
    halted: false,
    findings,
    summary: summarizeFindings(findings),
    agents,
  }
}

function completeEvent(findings: readonly Finding[], durationMs: number): EngineEvent {
  const summary = summarizeFindings(findings)
  return {
    type: 'analysis_complete',
    totalFindings: summary.total,
    errors: summary.errors,
    warnings: summary.warnings,
    info: summary.info,
    durationMs,
  }
}
