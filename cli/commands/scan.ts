import { randomUUID } from 'node:crypto'
import { readFile, writeFile } from 'node:fs/promises'
import {
  MCP_VERSION,
  summarizeFindings,
  type AiCapability,
  type AnalysisResult,
  type GroundingRunner,
  type RouteFile,
  runAnalysis,
} from '@/lib/engine'
import { EXIT_CODES } from '@/lib/engine/constants'
import {
  hashSpec,
  readSidecar,
  SCHEMA_VERSION,
  sidecarPathFor,
  withAnalysisCache,
  writeSidecar,
} from '@/lib/engine/cache/sidecar'
import { applyFixes } from '@/lib/engine/fix/apply'
import { verifyFixes } from '@/lib/engine/fix/verify'
import { hashOperationHandlers } from '@/lib/engine/grounding'
import { simulateMcpTools } from '@/lib/engine/mcp/simulate'
import { computeHealthScore } from '@/lib/engine/health'
import { detectVersion } from '@/lib/engine/linter/version'
import {
  countOperations,
  extractOperations,
  extractServerPathPrefixes,
} from '@/lib/engine/operations'
import { buildAnalysisRun } from '@/lib/engine/history/record'
import { buildStructuralReport } from '@/lib/engine/report'
import { aiCapabilityFromEnv } from '@/lib/llm/capability'
import type {
  AnalysisMode,
  ConfidenceThreshold,
  EngineEvent,
  Finding,
  MismatchMode,
} from '@/types/domain'
import { saveRun } from '../history/store'
import { renderHuman } from '../render/human'

// Re-exported so existing CLI entry points (`./commands/scan`) keep importing it
// from here; the implementation now lives in the shared LLM module.
export { aiCapabilityFromEnv }

export interface ScanOptions {
  specPath: string
  json?: boolean
  reportPath?: string
  color?: boolean
  mcpVersion?: string
  verbose?: boolean
  /** lint (default) reports findings; fix applies eligible fixes. */
  mode?: AnalysisMode
  /** Confidence gate for fix mode (default high). */
  confidenceThreshold?: ConfidenceThreshold
  /** flag (default) reports spec/code mismatches; fix makes them appliable. */
  mismatchMode?: MismatchMode
  /** Where to write the patched spec in fix mode. */
  outputPath?: string
  /** AI capability (worker + post-process). When absent, runs structural-only. */
  ai?: AiCapability
  /** v2: handler/route file paths to read for codebase grounding. */
  routePaths?: string[]
  /** v2 grounding runner override (tests); otherwise derived from ai + routePaths. */
  grounding?: GroundingRunner
  /** When set, persist the run as history under this base dir's .mcp-doctor/runs. */
  historyBaseDir?: string
  /** Reuse/refresh the `.mcp-doctor.yaml` sidecar next to the spec (default in the CLI; `--no-cache` disables). */
  cache?: boolean
  /** Injected clock for deterministic tests; defaults to the real time. */
  now?: () => number
}

export interface ScanResult {
  exitCode: number
  stdout: string
  /** Progress / hints — written to the real stderr by the CLI entry. */
  stderr: string
}

/**
 * Resolve the grounding runner: explicit override, or derived from ai + route
 * files. The read route files are returned too — they feed the per-operation
 * handler hashes of the sidecar cache (the override has none, so grounded runs
 * through it bypass the cache rather than risk reusing stale grounding).
 */
async function resolveGrounding(
  options: ScanOptions,
  spec: string,
): Promise<{ grounding?: GroundingRunner; routeFiles?: RouteFile[] }> {
  if (options.grounding) return { grounding: options.grounding }
  const runGround = options.ai?.runGrounding
  if (!runGround || !options.routePaths || options.routePaths.length === 0) return {}
  const routeFiles = await Promise.all(
    options.routePaths.map(async (path) => ({ path, content: await readFile(path, 'utf8') })),
  )
  // Server base paths let the mapper find code that registers the full external
  // path (`/v1/users`) for spec paths written relative to `servers[].url`.
  const serverPrefixes = extractServerPathPrefixes(spec)
  return {
    grounding: (operations, version) =>
      runGround(operations, routeFiles, version, serverPrefixes),
    routeFiles,
  }
}

const AI_DISABLED_HINT =
  'AI analysis not enabled — set LLM_BASE_URL and LLM_API_TOKEN to enable description and ' +
  'MCP-semantic checks. Running deterministic structural checks only.'

export async function runScan(options: ScanOptions): Promise<ScanResult> {
  const now = options.now ?? (() => Date.now())
  const mcpVersion = options.mcpVersion ?? MCP_VERSION

  let spec: string
  try {
    spec = await readFile(options.specPath, 'utf8')
  } catch {
    return {
      exitCode: EXIT_CODES.ANALYSIS_FAILED,
      stdout: `Could not read spec file: ${options.specPath}`,
      stderr: '',
    }
  }

  const startedAt = now()
  const progress: string[] = []
  let grounding: GroundingRunner | undefined
  let routeFiles: RouteFile[] | undefined
  try {
    ;({ grounding, routeFiles } = await resolveGrounding(options, spec))
  } catch (cause) {
    const detail = cause instanceof Error ? cause.message : String(cause)
    return {
      exitCode: EXIT_CODES.ANALYSIS_FAILED,
      stdout: `Could not read route files for grounding: ${detail}`,
      stderr: '',
    }
  }
  // Sidecar cache. Ungrounded runs use the spec-hash dimension alone: an
  // unchanged spec reuses the previous findings with zero LLM/Spectral work.
  // Grounded runs add the per-operation handler-hash dimension: spec-only
  // changes reuse grounding, handler-only changes re-run just those handlers.
  const specHash = hashSpec(spec)
  const sidecarPath = sidecarPathFor(options.specPath)
  let result: AnalysisResult | null = null

  if (options.cache === true && grounding !== undefined && routeFiles !== undefined) {
    const detected = detectVersion(spec)
    if (detected.ok) {
      const version = detected.version
      const operations = extractOperations(spec)
      const runGround = grounding
      const cached = await withAnalysisCache({
        sidecarPath,
        specHash,
        generatedAt: new Date(now()).toISOString(),
        computeSpec: async () => {
          const generator = runAnalysis(spec, { ai: options.ai, now })
          let next = await generator.next()
          while (!next.done) {
            appendProgress(progress, next.value)
            next = await generator.next()
          }
          return {
            findings: next.value.findings,
            summary: next.value.summary,
            operations: operations.map((o) => o.label),
          }
        },
        handlerHashes: hashOperationHandlers(operations, routeFiles, {
          serverPrefixes: extractServerPathPrefixes(spec),
        }),
        computeGrounding: async (stale) => {
          const staleOps = operations.filter((o) => stale.includes(o.label))
          const grounded = await runGround(staleOps, version)
          const grouped: Record<string, Finding[]> = Object.fromEntries(
            stale.map((label) => [label, []]),
          )
          for (const finding of grounded.findings) {
            if (finding.operation !== undefined) grouped[finding.operation]?.push(finding)
          }
          // failed detections stay uncached so they retry on the next run
          for (const failure of grounded.failures ?? []) delete grouped[failure.operation]
          return grouped
        },
      })
      if (cached.specFromCache) {
        progress.push('✓ cache: spec quality reused (spec unchanged, no LLM calls)')
      }
      if (cached.groundingReused.length > 0) {
        progress.push(
          `✓ cache: grounding reused for ${cached.groundingReused.length} operation(s) (handlers unchanged)`,
        )
      }
      if (cached.groundingRecomputed.length > 0) {
        progress.push(
          `→ grounding recomputed for ${cached.groundingRecomputed.length} operation(s)`,
        )
      }
      const merged = [...cached.findings, ...Object.values(cached.groundingFindings).flat()]
      result = {
        version,
        halted: false,
        findings: merged,
        summary: summarizeFindings(merged),
        agents: [],
      }
    }
  } else if (options.cache === true) {
    const cached = await readSidecar(sidecarPath)
    if (cached && cached.specHash === specHash) {
      const detected = detectVersion(spec)
      if (detected.ok) {
        result = {
          version: detected.version,
          halted: false,
          findings: cached.findings,
          summary: cached.summary,
          agents: [],
        }
        progress.push('✓ cache hit — spec unchanged, reused previous findings (no LLM calls)')
      }
    }
  }

  if (result === null) {
    const generator = runAnalysis(spec, { ai: options.ai, grounding, now })
    let next = await generator.next()
    while (!next.done) {
      appendProgress(progress, next.value)
      next = await generator.next()
    }
    result = next.value
    if (options.cache === true && grounding === undefined && !result.halted && result.version !== null) {
      await writeSidecar(sidecarPath, {
        schemaVersion: SCHEMA_VERSION,
        specHash,
        generatedAt: new Date(now()).toISOString(),
        findings: result.findings,
        summary: result.summary,
        operations: extractOperations(spec).map((o) => ({ label: o.label })),
      })
    }
  }
  const durationMs = now() - startedAt

  if (result.halted || result.version === null) {
    const reason = result.findings[0]?.message ?? 'Analysis could not proceed.'
    return { exitCode: EXIT_CODES.ANALYSIS_FAILED, stdout: reason, stderr: '' }
  }

  if (options.mode === 'fix') {
    const threshold = options.confidenceThreshold ?? 'high'
    const mismatchMode = options.mismatchMode ?? 'flag'
    const fix = applyFixes({
      spec,
      findings: result.findings,
      threshold,
      version: result.version,
      mismatchMode,
    })
    // The doctor re-examines the patient: re-lint the patched spec BEFORE writing
    // anything, so a fix pass that breaks the document never overwrites a file.
    const verification =
      fix.applied.length > 0
        ? await verifyFixes({
            patched: fix.patched,
            applied: fix.applied,
            originalFindings: result.findings,
          })
        : null
    if (verification !== null && !verification.valid) {
      return {
        exitCode: EXIT_CODES.ANALYSIS_FAILED,
        stdout:
          '✗ Verification failed — the patched spec is no longer a valid OpenAPI document. ' +
          'No output written; fixes rejected.',
        stderr: progress.join('\n'),
      }
    }
    if (options.outputPath !== undefined) {
      await writeFile(options.outputPath, fix.patched)
    }
    const lines: string[] = []
    if (threshold === 'low') {
      lines.push(
        mismatchMode === 'fix'
          ? '⚠ AGGRESSIVE MODE — applied LOW-confidence fixes, including spec/code mismatches (code treated as source of truth). Review every change before committing.'
          : '⚠ AGGRESSIVE MODE — applied LOW-confidence fixes. Review every change before committing.',
      )
    }
    lines.push(`Applied ${fix.applied.length} fix(es), skipped ${fix.skipped.length}.`)
    if (verification !== null) {
      lines.push(
        `Verified: ${verification.resolved.length} resolved, ` +
          `${verification.unresolved.length} unresolved, ` +
          `${verification.regressions.length} new finding(s) introduced.`,
      )
      if (verification.regressions.length > 0) {
        lines.push(
          `⚠ Fixes introduced ${verification.regressions.length} new finding(s) — review the patched spec before committing.`,
        )
      }
      const before = simulateMcpTools(spec)
      const after = simulateMcpTools(fix.patched)
      lines.push(
        `MCP tools: ${before.loadable}/${before.total} → ${after.loadable}/${after.total} loadable as MCP tools.`,
      )
      lines.push(...after.clientWarnings.map((warning) => `⚠ ${warning}`))
    }
    const flaggedMismatches = fix.skipped.filter((f) => f.rule === 'SPEC_CODE_MISMATCH').length
    if (flaggedMismatches > 0 && mismatchMode !== 'fix') {
      lines.push(
        `${flaggedMismatches} spec/code mismatch(es) flagged but not applied — rerun with --mismatch-mode=fix --confidence-threshold=low to apply them.`,
      )
    }
    lines.push(...fix.warnings)
    return {
      exitCode: EXIT_CODES.OK,
      stdout: lines.join('\n'),
      stderr: progress.join('\n'),
    }
  }

  const report = buildStructuralReport({
    runId: randomUUID(),
    timestamp: new Date(now()).toISOString(),
    specFile: options.specPath,
    version: result.version,
    operationCount: countOperations(spec),
    mcpVersion,
    mode: 'lint',
    mismatchMode: options.mismatchMode ?? 'flag',
    durationMs,
    findings: result.findings,
    summary: result.summary,
    agents: result.agents,
  })

  if (options.reportPath !== undefined) {
    await writeFile(options.reportPath, `${JSON.stringify(report, null, 2)}\n`)
  }

  if (options.historyBaseDir !== undefined) {
    const run = buildAnalysisRun({
      id: report.runId,
      createdAt: new Date(now()),
      specSource: 'paste',
      specFile: options.specPath,
      mode: 'lint',
      mismatchMode: options.mismatchMode ?? 'flag',
      durationMs,
      status: 'complete',
      findings: result.findings,
      summary: result.summary,
      agents: result.agents,
    })
    await saveRun(run, options.historyBaseDir)
  }

  const simulation = simulateMcpTools(spec)
  const stdout = options.json
    ? JSON.stringify(report, null, 2)
    : renderHuman({
        specFile: options.specPath,
        version: result.version,
        mcpVersion,
        healthScore: computeHealthScore(result.summary),
        summary: result.summary,
        findings: result.findings,
        color: options.color ?? true,
        mcp: { loadable: simulation.loadable, total: simulation.total },
      })

  const stderr =
    options.ai || grounding ? progress.join('\n') : [...progress, AI_DISABLED_HINT].join('\n')
  const exitCode = result.summary.errors > 0 ? EXIT_CODES.FINDINGS_ERROR : EXIT_CODES.OK
  return { exitCode, stdout, stderr }
}

function appendProgress(progress: string[], event: EngineEvent): void {
  if (event.type === 'agent_started' && event.agentId.startsWith('worker')) {
    progress.push(`→ ${event.agentId} analyzing ${event.operations.length} operation(s)`)
  }
  if (event.type === 'file_read') {
    const location = event.line !== undefined ? `${event.path}:${event.line}` : event.path
    const why =
      event.role === 'handler'
        ? `handler ${event.symbol ?? ''}`.trimEnd()
        : event.role === 'registration'
          ? 'route registration'
          : 'source'
    const size = event.linesRead !== undefined ? `, ${event.linesRead} lines` : ''
    const forOp = event.operation !== undefined ? ` for ${event.operation}` : ''
    progress.push(`→ grounding read ${location} (${why}${size})${forOp}`)
  }
  if (event.type === 'agent_completed' && event.error !== undefined) {
    progress.push(`✗ ${event.agentId} failed: ${event.error}`)
  } else if (event.type === 'agent_completed' && event.agentId.startsWith('worker')) {
    progress.push(`✓ ${event.agentId}: ${event.findingsCount} finding(s) in ${event.durationMs}ms`)
  }
  if (event.type === 'postprocess_started') {
    progress.push(`→ post-processing: ${event.check}`)
  }
}
