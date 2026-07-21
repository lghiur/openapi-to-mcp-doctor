import { runStructuralAnalysis } from '@/lib/engine/structural'
import type { Finding } from '@/types/domain'

export interface VerifyFixesOptions {
  /** The spec after fixes were applied. */
  patched: string
  /** The findings whose fixes were applied — what we claim to have resolved. */
  applied: Finding[]
  /** Every finding from the original analysis — the baseline for regressions. */
  originalFindings: Finding[]
}

export interface VerifyFixesResult {
  /** False when the patched spec no longer parses as a supported OpenAPI document. */
  valid: boolean
  /** Applied findings the deterministic linter no longer reports. */
  resolved: Finding[]
  /** Applied findings the linter STILL reports on the patched spec — the fix did not take. */
  unresolved: Finding[]
  /** Findings on the patched spec that did not exist before — problems the fixes introduced. */
  regressions: Finding[]
}

/**
 * Re-examine the patient after surgery: re-run the deterministic structural
 * linter on the patched spec and compare against the original run. Finding ids
 * are deterministic (rule + document path), so an applied fix whose id still
 * appears afterwards demonstrably did not take, and any id that appears only
 * afterwards was introduced by the patch.
 *
 * Only linter-detectable findings can be contradicted; AI-authored findings
 * (worker/grounding) that the linter never reports count as resolved.
 */
export async function verifyFixes(options: VerifyFixesOptions): Promise<VerifyFixesResult> {
  const analysis = await runStructuralAnalysis(options.patched)
  if (analysis.halted || analysis.version === null) {
    return { valid: false, resolved: [], unresolved: [...options.applied], regressions: [] }
  }

  const after = new Set(analysis.findings.map((f) => f.id))
  const before = new Set(options.originalFindings.map((f) => f.id))

  return {
    valid: true,
    resolved: options.applied.filter((f) => !after.has(f.id)),
    unresolved: options.applied.filter((f) => after.has(f.id)),
    regressions: analysis.findings.filter((f) => !before.has(f.id)),
  }
}
