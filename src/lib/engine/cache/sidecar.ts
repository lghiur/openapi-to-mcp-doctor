import { createHash } from 'node:crypto'
import { readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml'
import { z } from 'zod'
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
  /**
   * Whether AI (worker/post-process) analysis produced these findings. Absent on
   * pre-upgrade sidecars — consumers must treat "absent" as `false`: such a
   * cache still satisfies a structural-only run, but is a MISS for an AI run
   * (it would otherwise silently serve structural-only findings).
   */
  aiEnabled?: boolean
  /** Whether codebase grounding ran for this record. Absent = `false` (see `aiEnabled`). */
  groundingEnabled?: boolean
  /**
   * Marks a record whose findings cover only a selected subset of operations.
   * Such a record must never be persisted (its partial findings would be reused
   * as complete by a later full run), so the module refuses to write it and
   * treats any it reads — hand-planted or merge-mangled — as a miss. It exists
   * as a field only to make that refusal explicit and testable.
   */
  scoped?: boolean
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

/**
 * Structural validation of a stored finding. Loose: fields beyond the required
 * core (`before`/`after`/`operation`/…) ride along unvalidated — the cache must
 * round-trip them, not re-type them. What matters is that a poisoned sidecar
 * cannot smuggle wrong-typed values into the fields every consumer touches.
 */
const StoredFindingSchema = z.looseObject({
  id: z.string(),
  agentId: z.string(),
  rule: z.string(),
  severity: z.enum(['error', 'warning', 'info']),
  confidence: z.enum(['HIGH', 'MEDIUM', 'LOW']),
  message: z.string(),
  autoFixable: z.boolean(),
  autoFixed: z.boolean(),
  resolution: z.enum(['accepted', 'rejected', 'edited', 'auto-fixed', 'pending']),
  path: z.array(z.union([z.string(), z.number()])).optional(),
})

const SidecarCacheSchema = z.object({
  schemaVersion: z.number(),
  specHash: z.string(),
  generatedAt: z.string(),
  aiEnabled: z.boolean().optional(),
  groundingEnabled: z.boolean().optional(),
  scoped: z.boolean().optional(),
  findings: z.array(StoredFindingSchema),
  summary: z.object({
    total: z.number(),
    errors: z.number(),
    warnings: z.number(),
    info: z.number(),
  }),
  operations: z.array(
    z.object({
      label: z.string(),
      handlerHash: z.string().optional(),
      groundingFindings: z.array(StoredFindingSchema).optional(),
    }),
  ),
})

/**
 * Read and validate the sidecar. The file is committed/committable, so its
 * content is untrusted: anything that does not match the schema — hand-edited,
 * merge-mangled, or deliberately poisoned — is a cache miss (`null`), never a
 * crash and never spoofed findings.
 */
export async function readSidecar(sidecarPath: string): Promise<SidecarCache | null> {
  let raw: string
  try {
    raw = await readFile(sidecarPath, 'utf8')
  } catch {
    return null
  }
  try {
    const result = SidecarCacheSchema.safeParse(parseYaml(raw))
    if (!result.success) return null
    // A persisted scoped record is illegitimate (writeSidecar refuses to create
    // one); if one exists it was planted out-of-band — treat it as a miss.
    if (result.data.scoped === true) return null
    // Validated structurally above; the loose finding objects carry their extra
    // fields through, so the record is a faithful SidecarCache.
    return result.data as unknown as SidecarCache
  } catch {
    return null
  }
}

export async function writeSidecar(sidecarPath: string, cache: SidecarCache): Promise<void> {
  // Persisting a scoped (subset) record would let a later full run reuse its
  // partial findings as complete. Refuse at the one choke point every write
  // passes through, rather than trusting each caller.
  if (cache.scoped === true) {
    throw new Error('refusing to persist a scoped sidecar record (partial findings)')
  }
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
  /**
   * The computation covers only a selected subset of operations. A scoped run
   * still reads a fresh full-spec cache, but its own partial result is never
   * persisted — writing it would poison a later full run.
   */
  scoped?: boolean
}): Promise<{ findings: Finding[]; summary: StructuralSummary; fromCache: boolean }> {
  const existing = await readSidecar(options.sidecarPath)
  if (existing && existing.specHash === options.specHash) {
    return { findings: existing.findings, summary: existing.summary, fromCache: true }
  }

  const computed = await options.compute()
  if (!options.scoped) {
    await writeSidecar(options.sidecarPath, {
      schemaVersion: SCHEMA_VERSION,
      specHash: options.specHash,
      generatedAt: options.generatedAt ?? new Date().toISOString(),
      findings: computed.findings,
      summary: computed.summary,
      operations: computed.operations.map((label) => ({ label })),
    })
  }
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
