import { existsSync, readFileSync } from 'node:fs'
import { join, relative } from 'node:path'
import type { LanguageModel } from 'ai'
import { detectMismatches } from '@/lib/engine/grounding/read'
import { detectVersion } from '@/lib/engine/linter/version'
import { extractOperations } from '@/lib/engine/operations'
import type { Finding } from '@/types/domain'

/**
 * DF3 — grounded self-analysis: run the real spec/code mismatch detector over
 * this app's own `openapi.yaml` and Route Handlers. The route→handler mapping is
 * Next.js's file convention (`/api/jobs/{id}/stream` → `src/app/api/jobs/[id]/
 * stream/route.ts`), so no registration-site matching is needed — each
 * documented operation grounds directly against its handler file.
 */

export interface SelfGroundingResult {
  /** LOW-confidence SPEC_CODE_MISMATCH findings — spec drift caught in CI. */
  findings: Finding[]
  /** Operation labels that were grounded against a handler file. */
  checked: string[]
  /** Documented paths whose route file does not exist (structural drift). */
  missing: string[]
  /** Operations whose detection errored — zero findings there ≠ "code matches". */
  failures: Array<{ operation: string; error: string }>
}

export interface SelfGroundingDeps {
  model: LanguageModel
  /** Injectable for tests; defaults to the real LLM-backed detector. */
  detect?: typeof detectMismatches
}

/** The Next.js route file a documented API path maps to. */
export function routeFileFor(root: string, apiPath: string): string {
  const segments = apiPath.replace(/^\//, '').replace(/\{([^}]+)\}/g, '[$1]').split('/')
  return join(root, 'src', 'app', ...segments, 'route.ts')
}

export async function checkSelfGrounding(
  root: string,
  deps: SelfGroundingDeps,
): Promise<SelfGroundingResult> {
  const spec = readFileSync(join(root, 'openapi.yaml'), 'utf8')
  const detected = detectVersion(spec)
  if (!detected.ok) {
    throw new Error(`Self-spec version undetectable: ${detected.message}`)
  }
  const detect = deps.detect ?? detectMismatches

  const findings: Finding[] = []
  const checked: string[] = []
  const missing: string[] = []
  const failures: Array<{ operation: string; error: string }> = []
  const seenMissingPaths = new Set<string>()

  for (const operation of extractOperations(spec)) {
    const routeFile = routeFileFor(root, operation.path)
    if (!existsSync(routeFile)) {
      if (!seenMissingPaths.has(operation.path)) {
        seenMissingPaths.add(operation.path)
        missing.push(`${operation.path} -> ${relative(root, routeFile)}`)
      }
      continue
    }
    const content = readFileSync(routeFile, 'utf8')
    try {
      const detectedFindings = await detect(
        {
          operation,
          handlerCode: `// --- ${relative(root, routeFile)} ---\n${content}`,
          version: detected.version,
        },
        { model: deps.model, agentId: 'dogfood-grounding' },
      )
      checked.push(operation.label)
      findings.push(...detectedFindings.filter((f) => f.rule === 'SPEC_CODE_MISMATCH'))
    } catch (cause) {
      // One flaky LLM call must not sink the whole gate — record and continue.
      failures.push({
        operation: operation.label,
        error: cause instanceof Error ? cause.message : 'Mismatch detection failed.',
      })
    }
  }

  return { findings, checked, missing, failures }
}
