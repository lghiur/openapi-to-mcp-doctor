import { createHash } from 'node:crypto'
import { readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml'
import type { StructuralSummary } from '@/lib/engine/summary'
import type { Finding } from '@/types/domain'

const SIDECAR_FILENAME = '.mcp-doctor.yaml'
export const SCHEMA_VERSION = 2

/**
 * The sidecar cache record. Stored as `.mcp-doctor.yaml` alongside the spec —
 * never inside the spec file, and gitignored. Two independent dimensions:
 * `specHash` gates the spec-quality findings; each operation's `handlerHash`
 * gates its cached grounding (spec/code mismatch) findings — v2, schema v2.
 */
export interface SidecarCache {
  schemaVersion: number
  specHash: string
  generatedAt: string
  findings: Finding[]
  summary: StructuralSummary
  operations: Array<{ label: string; handlerHash?: string; groundingFindings?: Finding[] }>
}

export interface CachedComputation {
  findings: Finding[]
  summary: StructuralSummary
  operations: string[]
}

export function hashSpec(spec: string): string {
  return createHash('sha256').update(spec, 'utf8').digest('hex')
}

export function sidecarPathFor(specPath: string): string {
  return join(dirname(specPath), SIDECAR_FILENAME)
}

export async function readSidecar(sidecarPath: string): Promise<SidecarCache | null> {
  let raw: string
  try {
    raw = await readFile(sidecarPath, 'utf8')
  } catch {
    return null
  }
  try {
    const parsed = parseYaml(raw) as SidecarCache
    if (!parsed || typeof parsed.specHash !== 'string') return null
    return parsed
  } catch {
    return null
  }
}

export async function writeSidecar(sidecarPath: string, cache: SidecarCache): Promise<void> {
  await writeFile(sidecarPath, stringifyYaml(cache))
}

/**
 * Return cached findings when the spec hash is unchanged (zero compute), else run
 * `compute`, persist the result to the sidecar, and return it.
 */
export async function withSpecCache(options: {
  sidecarPath: string
  specHash: string
  generatedAt?: string
  compute: () => Promise<CachedComputation>
}): Promise<{ findings: Finding[]; summary: StructuralSummary; fromCache: boolean }> {
  const existing = await readSidecar(options.sidecarPath)
  if (existing && existing.specHash === options.specHash) {
    return { findings: existing.findings, summary: existing.summary, fromCache: true }
  }

  const computed = await options.compute()
  const cache: SidecarCache = {
    schemaVersion: SCHEMA_VERSION,
    specHash: options.specHash,
    generatedAt: options.generatedAt ?? new Date().toISOString(),
    findings: computed.findings,
    summary: computed.summary,
    operations: computed.operations.map((label) => ({ label })),
  }
  await writeSidecar(options.sidecarPath, cache)
  return { findings: computed.findings, summary: computed.summary, fromCache: false }
}

export interface AnalysisCacheOptions {
  sidecarPath: string
  specHash: string
  generatedAt?: string
  /** Spec-quality analysis (structural + AI workers + post-process). */
  computeSpec: () => Promise<CachedComputation>
  /** Current per-operation handler hashes (label → hash). Enables the grounding dimension. */
  handlerHashes?: Record<string, string>
  /**
   * Grounding for the given stale operations only. Return a findings array per
   * operation label; omit a label to mark its detection failed (it will be
   * recomputed on the next run rather than cached as "clean").
   */
  computeGrounding?: (staleOperations: string[]) => Promise<Record<string, Finding[]>>
}

export interface AnalysisCacheResult {
  /** Spec-quality findings (cached or freshly computed). */
  findings: Finding[]
  summary: StructuralSummary
  /** Grounding findings per operation label (cached + recomputed merged). */
  groundingFindings: Record<string, Finding[]>
  specFromCache: boolean
  groundingReused: string[]
  groundingRecomputed: string[]
}

/**
 * Two-dimension cache (scenarios 1–4): the spec hash and each operation's
 * handler hash are checked independently — spec-only changes reuse grounding,
 * handler-only changes reuse spec quality and re-run just the changed handlers,
 * and a cold start computes everything. No scenario is special-cased.
 */
export async function withAnalysisCache(options: AnalysisCacheOptions): Promise<AnalysisCacheResult> {
  const existing = await readSidecar(options.sidecarPath)
  const specFresh = existing !== null && existing.specHash === options.specHash

  const computed = specFresh ? null : await options.computeSpec()
  const spec = computed ?? {
    findings: existing?.findings ?? [],
    summary: existing?.summary ?? { total: 0, errors: 0, warnings: 0, info: 0 },
  }

  const groundingFindings: Record<string, Finding[]> = {}
  const groundingReused: string[] = []
  const groundingRecomputed: string[] = []
  const hashes = options.handlerHashes ?? {}
  const cachedOps = new Map((existing?.operations ?? []).map((op) => [op.label, op]))

  if (options.computeGrounding) {
    const stale: string[] = []
    for (const [label, hash] of Object.entries(hashes)) {
      const cached = cachedOps.get(label)
      if (cached?.handlerHash === hash && cached.groundingFindings !== undefined) {
        groundingFindings[label] = cached.groundingFindings
        groundingReused.push(label)
      } else {
        stale.push(label)
      }
    }
    if (stale.length > 0) {
      const computed = await options.computeGrounding(stale)
      for (const label of stale) {
        const findings = computed[label]
        if (findings !== undefined) {
          groundingFindings[label] = findings
          groundingRecomputed.push(label)
        }
        // labels missing from the result failed detection: leave them uncached
      }
    }
  }

  const operationLabels =
    Object.keys(hashes).length > 0
      ? Object.keys(hashes)
      : (computed?.operations ?? (existing?.operations ?? []).map((o) => o.label))

  await writeSidecar(options.sidecarPath, {
    schemaVersion: SCHEMA_VERSION,
    specHash: options.specHash,
    generatedAt: options.generatedAt ?? new Date().toISOString(),
    findings: spec.findings,
    summary: spec.summary,
    operations: operationLabels.map((label) => ({
      label,
      ...(hashes[label] !== undefined ? { handlerHash: hashes[label] } : {}),
      ...(groundingFindings[label] !== undefined
        ? { groundingFindings: groundingFindings[label] }
        : {}),
    })),
  })

  return {
    findings: spec.findings,
    summary: spec.summary,
    groundingFindings,
    specFromCache: specFresh,
    groundingReused,
    groundingRecomputed,
  }
}
