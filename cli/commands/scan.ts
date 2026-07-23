import { randomUUID } from 'node:crypto'
import { readFile, rm, writeFile } from 'node:fs/promises'
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
  type SidecarCache,
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
import { filterFindings, filterOperations } from '@/lib/engine/selection'
import { aiCapabilityFromEnv } from '@/lib/llm/capability'
import type {
  AnalysisMode,
  ConfidenceThreshold,
  EngineEvent,
  Finding,
  MismatchMode,
  OpenApiVersion,
  OperationSelection,
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
  /**
   * Analyse/fix only these paths+methods (lint findings AND fix application are
   * both scoped); findings outside the selection are dropped. Undefined = whole spec.
   */
  selection?: OperationSelection
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

/**
 * Analysis-failure result (exit 2). The message stays on stdout — that is a
 * stable machine contract (`cli/action.ts` reads `result.stdout` for the halt
 * reason on exit 2) — and is mirrored to stderr under `--json` so a human
 * piping stdout into a JSON parser still sees why nothing was emitted.
 * Without `--json` the message appears once, on stdout, as before.
 */
function analysisFailure(message: string, json: boolean | undefined): ScanResult {
  return {
    exitCode: EXIT_CODES.ANALYSIS_FAILED,
    stdout: message,
    stderr: json === true ? message : '',
  }
}

/**
 * Write a user-designated output file (`--report` / `--output`). An unwritable
 * path is a configuration error, not an analysis failure or a findings verdict,
 * so it maps to EXIT_CODES.INVALID_ARGS (3), consistent with the exit-code
 * contract in `lib/engine/constants.ts`. Returns null on success, or the full
 * failure ScanResult (progress so far + the error on stderr) for the caller to
 * return as-is.
 */
async function writeUserFile(
  flag: '--output' | '--report',
  path: string,
  content: string,
  progress: string[],
): Promise<ScanResult | null> {
  try {
    await writeFile(path, content)
    return null
  } catch (cause) {
    const detail = cause instanceof Error ? cause.message : String(cause)
    return {
      exitCode: EXIT_CODES.INVALID_ARGS,
      stdout: '',
      stderr: [...progress, `Could not write ${flag} file ${path}: ${detail}`].join('\n'),
    }
  }
}

/** Drain the analysis generator to completion, translating events into progress lines. */
async function drainAnalysis(
  generator: AsyncGenerator<EngineEvent, AnalysisResult>,
  progress: string[],
): Promise<AnalysisResult> {
  let next = await generator.next()
  while (!next.done) {
    appendProgress(progress, next.value)
    next = await generator.next()
  }
  return next.value
}

/**
 * A cached sidecar only satisfies a run with the SAME analysis capability:
 * a structural-only cache must not be served to an AI-enabled run (stale,
 * silently missing AI findings), and an AI cache must not leak AI findings
 * into a structural-only run. Absent meta (pre-upgrade sidecars) counts as
 * `false`, so old caches keep hitting for structural-only runs.
 */
function capabilityMatches(cached: SidecarCache, aiOn: boolean, groundingOn: boolean): boolean {
  return (cached.aiEnabled ?? false) === aiOn && (cached.groundingEnabled ?? false) === groundingOn
}

/** Values shared by every cache strategy below, derived once in runScan. */
interface CacheContext {
  spec: string
  specHash: string
  sidecarPath: string
  /** Capability of THIS run — cached results from a differently-capable run never satisfy it. */
  aiOn: boolean
  /** Progress lines (stderr) — cache hits/misses are reported here. */
  progress: string[]
}

/** Wrap cached/merged findings in the AnalysisResult shape the report path expects. */
function cachedResult(
  version: AnalysisResult['version'],
  findings: Finding[],
  summary: AnalysisResult['summary'],
): AnalysisResult {
  return { version, halted: false, findings, summary, agents: [] }
}

/**
 * Selection-scoped runs treat the sidecar as READ-ONLY. The cache is keyed by
 * spec hash alone (the selection is NOT part of the key), so a fresh full-spec
 * cache may be consumed — narrowed to the selection here — but a scoped run
 * must never write its partial findings back: a later full-spec run would
 * silently reuse them as if they covered the whole document.
 */
async function readScopedCache(
  ctx: CacheContext,
  selection: OperationSelection,
  groundingOn: boolean,
): Promise<AnalysisResult | null> {
  const cached = await readSidecar(ctx.sidecarPath)
  if (!cached || cached.specHash !== ctx.specHash) return null
  if (!capabilityMatches(cached, ctx.aiOn, groundingOn)) return null
  const detected = detectVersion(ctx.spec)
  if (!detected.ok) return null

  const selectedLabels = new Set(
    filterOperations(extractOperations(ctx.spec), selection).map((o) => o.label),
  )
  // Two filters, mirroring what a live scoped run produces: spec-path
  // anchored findings go through the engine's selection filter; findings
  // carrying an operation label (AI workers, grounding) must be on a
  // selected operation — a live scoped run never analyses the others.
  const scoped = filterFindings(cached.findings, selection).filter(
    (f) => f.operation === undefined || selectedLabels.has(f.operation),
  )
  const groundingFindings = cached.operations
    .filter((op) => selectedLabels.has(op.label))
    .flatMap((op) => op.groundingFindings ?? [])
  const merged = [...scoped, ...groundingFindings]
  ctx.progress.push(
    '✓ cache hit — reused previous findings, narrowed to the selected operations (no LLM calls)',
  )
  return cachedResult(detected.version, merged, summarizeFindings(merged))
}

/**
 * Grounded run through the two-dimension sidecar cache: the spec-hash dimension
 * reuses spec-quality findings when the spec is unchanged; the per-operation
 * handler-hash dimension re-runs grounding only for operations whose handlers
 * changed. Returns null only when the version is undetectable — the fresh-run
 * path then reproduces the halt with its usual reporting.
 */
async function runGroundedCachedAnalysis(
  ctx: CacheContext,
  grounding: GroundingRunner,
  routeFiles: RouteFile[],
  ai: AiCapability | undefined,
  now: () => number,
): Promise<AnalysisResult | null> {
  const detected = detectVersion(ctx.spec)
  if (!detected.ok) return null
  // withAnalysisCache trusts a matching spec hash for the spec-quality
  // findings — but only a record produced with the same AI capability may
  // be trusted. Evict a mismatched sidecar (e.g. structural-only) instead
  // of silently serving it to this AI-grounded run. Grounding freshness
  // itself is governed by the per-operation handler hashes, so
  // `groundingEnabled` needs no check here.
  const preexisting = await readSidecar(ctx.sidecarPath)
  if (
    preexisting &&
    preexisting.specHash === ctx.specHash &&
    (preexisting.aiEnabled ?? false) !== ctx.aiOn
  ) {
    await rm(ctx.sidecarPath, { force: true })
  }
  const version = detected.version
  const operations = extractOperations(ctx.spec)
  const cached = await withAnalysisCache({
    sidecarPath: ctx.sidecarPath,
    specHash: ctx.specHash,
    generatedAt: new Date(now()).toISOString(),
    computeSpec: async () => {
      const fresh = await drainAnalysis(runAnalysis(ctx.spec, { ai, now }), ctx.progress)
      return {
        findings: fresh.findings,
        summary: fresh.summary,
        operations: operations.map((o) => o.label),
      }
    },
    handlerHashes: hashOperationHandlers(operations, routeFiles, {
      serverPrefixes: extractServerPathPrefixes(ctx.spec),
    }),
    computeGrounding: async (stale) => {
      const staleOps = operations.filter((o) => stale.includes(o.label))
      const grounded = await grounding(staleOps, version)
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
    ctx.progress.push('✓ cache: spec quality reused (spec unchanged, no LLM calls)')
  }
  if (cached.groundingReused.length > 0) {
    ctx.progress.push(
      `✓ cache: grounding reused for ${cached.groundingReused.length} operation(s) (handlers unchanged)`,
    )
  }
  if (cached.groundingRecomputed.length > 0) {
    ctx.progress.push(
      `→ grounding recomputed for ${cached.groundingRecomputed.length} operation(s)`,
    )
  }
  // withAnalysisCache wrote the sidecar without capability meta — stamp it
  // so later runs can tell what capability produced this record.
  const written = await readSidecar(ctx.sidecarPath)
  if (written) {
    await writeSidecar(ctx.sidecarPath, {
      ...written,
      aiEnabled: ctx.aiOn,
      groundingEnabled: true,
    })
  }
  const merged = [...cached.findings, ...Object.values(cached.groundingFindings).flat()]
  return cachedResult(version, merged, summarizeFindings(merged))
}

/** Ungrounded full-spec run: reuse the whole cached record when the spec is unchanged. */
async function readFullCache(ctx: CacheContext): Promise<AnalysisResult | null> {
  const cached = await readSidecar(ctx.sidecarPath)
  if (!cached || cached.specHash !== ctx.specHash) return null
  if (!capabilityMatches(cached, ctx.aiOn, false)) return null
  const detected = detectVersion(ctx.spec)
  if (!detected.ok) return null
  ctx.progress.push('✓ cache hit — spec unchanged, reused previous findings (no LLM calls)')
  return cachedResult(detected.version, cached.findings, cached.summary)
}

/**
 * Fix mode: apply eligible fixes, verify the patched spec, write `--output` /
 * `--report`, and render the fix summary. The non-JSON stdout is byte-stable —
 * `cli/action.ts` parses `Applied ${n} fix(es)` from it.
 */
async function runFixMode(params: {
  options: ScanOptions
  spec: string
  version: OpenApiVersion
  findings: Finding[]
  agents: AnalysisResult['agents']
  progress: string[]
  durationMs: number
  mcpVersion: string
  now: () => number
}): Promise<ScanResult> {
  const { options, spec, version, findings, agents, progress, durationMs, mcpVersion, now } = params
  const threshold = options.confidenceThreshold ?? 'high'
  const mismatchMode = options.mismatchMode ?? 'flag'
  const fix = applyFixes({ spec, findings, threshold, version, mismatchMode })
  // The doctor re-examines the patient: re-lint the patched spec BEFORE writing
  // anything, so a fix pass that breaks the document never overwrites a file.
  const verification =
    fix.applied.length > 0
      ? await verifyFixes({
          patched: fix.patched,
          applied: fix.applied,
          originalFindings: findings,
          // Scoped runs produce selection-filtered baselines; the re-lint
          // must be filtered identically or out-of-selection findings would
          // be misreported as regressions.
          ...(options.selection !== undefined ? { selection: options.selection } : {}),
        })
      : null
  if (verification !== null && !verification.valid) {
    const message =
      '✗ Verification failed — the patched spec is no longer a valid OpenAPI document. ' +
      'No output written; fixes rejected.'
    return {
      exitCode: EXIT_CODES.ANALYSIS_FAILED,
      // stdout carries the failure (stable contract; see analysisFailure) and
      // --json runs get it mirrored onto stderr with the progress log.
      stdout: message,
      stderr: (options.json === true ? [...progress, message] : progress).join('\n'),
    }
  }
  if (options.outputPath !== undefined) {
    const failure = await writeUserFile('--output', options.outputPath, fix.patched, progress)
    if (failure) return failure
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

  // --json / --report in fix mode: emit the post-fix AnalysisReport. Applied
  // fixes surface as `autoFixed: true` / `resolution: 'auto-fixed'` findings;
  // skipped findings remain as-is. severity counts cover ALL findings
  // (applied + skipped); `summary.autoFixed` is the applied count.
  if (options.json === true || options.reportPath !== undefined) {
    const postFindings: Finding[] = [
      ...fix.applied.map((f) => ({ ...f, autoFixed: true, resolution: 'auto-fixed' as const })),
      ...fix.skipped,
    ]
    const base = buildStructuralReport({
      runId: randomUUID(),
      timestamp: new Date(now()).toISOString(),
      specFile: options.specPath,
      version,
      operationCount: countOperations(spec),
      mcpVersion,
      mode: 'fix',
      mismatchMode,
      durationMs,
      findings: postFindings,
      summary: summarizeFindings(postFindings),
      agents,
    })
    const report = { ...base, summary: { ...base.summary, autoFixed: fix.applied.length } }
    const reportJson = JSON.stringify(report, null, 2)
    if (options.reportPath !== undefined) {
      const failure = await writeUserFile('--report', options.reportPath, `${reportJson}\n`, progress)
      if (failure) return failure
    }
    if (options.json === true) {
      return {
        exitCode: EXIT_CODES.OK,
        stdout: reportJson,
        // the human summary (incl. AGGRESSIVE MODE warnings) moves to stderr
        // so warnings are never lost while stdout stays pure JSON
        stderr: [...progress, ...lines].join('\n'),
      }
    }
  }

  // Non-JSON path: byte-compatible with the historical output —
  // `cli/action.ts` parses `Applied ${n} fix(es)` from this stdout.
  return {
    exitCode: EXIT_CODES.OK,
    stdout: lines.join('\n'),
    stderr: progress.join('\n'),
  }
}

export async function runScan(options: ScanOptions): Promise<ScanResult> {
  const now = options.now ?? (() => Date.now())
  const mcpVersion = options.mcpVersion ?? MCP_VERSION

  let spec: string
  try {
    spec = await readFile(options.specPath, 'utf8')
  } catch {
    return analysisFailure(`Could not read spec file: ${options.specPath}`, options.json)
  }

  const startedAt = now()
  const progress: string[] = []
  let grounding: GroundingRunner | undefined
  let routeFiles: RouteFile[] | undefined
  try {
    ;({ grounding, routeFiles } = await resolveGrounding(options, spec))
  } catch (cause) {
    const detail = cause instanceof Error ? cause.message : String(cause)
    return analysisFailure(`Could not read route files for grounding: ${detail}`, options.json)
  }
  // Sidecar cache. Ungrounded runs use the spec-hash dimension alone: an
  // unchanged spec reuses the previous findings with zero LLM/Spectral work.
  // Grounded runs add the per-operation handler-hash dimension: spec-only
  // changes reuse grounding, handler-only changes re-run just those handlers.
  const ctx: CacheContext = {
    spec,
    specHash: hashSpec(spec),
    sidecarPath: sidecarPathFor(options.specPath),
    aiOn: options.ai !== undefined,
    progress,
  }
  let result: AnalysisResult | null = null

  if (options.cache === true) {
    if (options.selection !== undefined) {
      result = await readScopedCache(ctx, options.selection, grounding !== undefined)
    } else if (grounding !== undefined && routeFiles !== undefined) {
      result = await runGroundedCachedAnalysis(ctx, grounding, routeFiles, options.ai, now)
    } else {
      result = await readFullCache(ctx)
    }
  }

  if (result === null) {
    result = await drainAnalysis(
      runAnalysis(spec, {
        ai: options.ai,
        grounding,
        now,
        ...(options.selection !== undefined ? { selection: options.selection } : {}),
      }),
      progress,
    )
    // `selection === undefined` guard: scoped results must never be cached
    // (see the read-only rule above).
    if (
      options.cache === true &&
      options.selection === undefined &&
      grounding === undefined &&
      !result.halted &&
      result.version !== null
    ) {
      await writeSidecar(ctx.sidecarPath, {
        schemaVersion: SCHEMA_VERSION,
        specHash: ctx.specHash,
        generatedAt: new Date(now()).toISOString(),
        aiEnabled: ctx.aiOn,
        groundingEnabled: false,
        findings: result.findings,
        summary: result.summary,
        operations: extractOperations(spec).map((o) => ({ label: o.label })),
      })
    }
  }
  const durationMs = now() - startedAt

  if (result.halted || result.version === null) {
    const reason = result.findings[0]?.message ?? 'Analysis could not proceed.'
    return analysisFailure(reason, options.json)
  }

  if (options.mode === 'fix') {
    return runFixMode({
      options,
      spec,
      version: result.version,
      findings: result.findings,
      agents: result.agents,
      progress,
      durationMs,
      mcpVersion,
      now,
    })
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
    const failure = await writeUserFile(
      '--report',
      options.reportPath,
      `${JSON.stringify(report, null, 2)}\n`,
      progress,
    )
    if (failure) return failure
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
