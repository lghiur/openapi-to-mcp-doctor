#!/usr/bin/env node
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parse as parseYaml } from 'yaml'
import { computeHealthScore, healthBadge, runStructuralAnalysis } from '@/lib/engine'
import { createModel, readLlmConfig } from '@/lib/llm/client'
import { checkSelfGrounding } from './self-grounding'

/**
 * Continuous dogfooding gate (Architecture Decision 8). Runs the structural
 * engine against the app's own openapi.yaml plus the fixture corpus and fails if
 * any health score regresses below the committed baseline.
 *
 * Update the baseline deliberately with: UPDATE_BASELINE=1 npm run dogfood
 */

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const baselinePath = join(root, 'dogfood-baseline.json')
const UPDATE = process.env.UPDATE_BASELINE === '1'

interface Baseline {
  [target: string]: number
}

async function scoreOf(spec: string): Promise<number> {
  const analysis = await runStructuralAnalysis(spec)
  if (analysis.halted) return 0
  return computeHealthScore(analysis.summary)
}

async function main(): Promise<void> {
  const targets: Record<string, string> = {}

  // The self-spec.
  targets['openapi.yaml'] = readFileSync(join(root, 'openapi.yaml'), 'utf8')

  // The fixture corpus (skip the deliberate halts).
  const specsDir = join(root, 'fixtures', 'specs')
  for (const file of readdirSync(specsDir).filter(
    (f) => /\.(ya?ml|json)$/.test(f) && !f.startsWith('.'), // dotfiles: sidecar caches, not specs
  )) {
    if (file.startsWith('swagger-2.0') || file.startsWith('undetectable')) continue
    targets[`fixtures/${file}`] = readFileSync(join(specsDir, file), 'utf8')
  }

  const scores: Baseline = {}
  for (const [name, spec] of Object.entries(targets)) {
    scores[name] = await scoreOf(spec)
  }

  // README health badge (DF2): shields.io endpoint payload for the self-spec score.
  const badgeDir = join(root, 'badges')
  mkdirSync(badgeDir, { recursive: true })
  writeFileSync(
    join(badgeDir, 'health.json'),
    `${JSON.stringify(healthBadge(scores['openapi.yaml'] ?? 0), null, 2)}\n`,
  )

  if (UPDATE) {
    writeFileSync(baselinePath, `${JSON.stringify(scores, null, 2)}\n`)
    process.stdout.write('Baseline updated.\n')
    return
  }

  const baseline = JSON.parse(readFileSync(baselinePath, 'utf8')) as Baseline
  let regressed = false
  for (const [name, score] of Object.entries(scores)) {
    const previous = baseline[name] ?? 0
    const status = score < previous ? 'REGRESSED' : 'ok'
    if (score < previous) regressed = true
    process.stdout.write(`${status.padEnd(10)} ${name}: ${score} (baseline ${previous})\n`)
  }

  // DF3: self spec/handler drift. With an LLM configured this is the real
  // grounded run — every documented operation's route.ts is read and checked for
  // SPEC_CODE_MISMATCH (Next.js file routing gives the operation→handler map).
  // Without one (e.g. a fork's CI), it degrades to the deterministic check that
  // every documented path has a handler file at all.
  let drift: string[]
  let mismatches: Array<{ operation?: string; message: string }> = []
  const llm = readLlmConfig(process.env)
  if (llm) {
    const grounded = await checkSelfGrounding(root, { model: createModel(llm) })
    drift = grounded.missing
    mismatches = grounded.findings
    process.stdout.write(
      `\nGrounded self-check: ${grounded.checked.length} operation(s) checked against their handlers.\n`,
    )
    // Failed detections degrade to a warning — flaky LLM calls must not block CI,
    // but their operations were NOT verified and that should be visible.
    for (const failure of grounded.failures) {
      process.stderr.write(`warning: mismatch check failed for ${failure.operation}: ${failure.error}\n`)
    }
  } else {
    drift = checkRouteDrift()
    process.stdout.write(
      '\nGrounded self-check skipped (no LLM configured) — verified handler files exist instead.\n',
    )
  }

  if (regressed || drift.length > 0 || mismatches.length > 0) {
    if (drift.length > 0) {
      process.stderr.write(`\nDocumented routes with no handler file:\n  ${drift.join('\n  ')}\n`)
    }
    for (const mismatch of mismatches) {
      process.stderr.write(
        `\nSPEC_CODE_MISMATCH ${mismatch.operation ?? ''}: ${mismatch.message}\n`,
      )
    }
    if (regressed) {
      process.stderr.write(
        '\nHealth-score regression detected. Fix the spec or update the baseline.\n',
      )
    }
    process.exit(1)
  }
  process.stdout.write('\nNo regressions, no spec/handler drift.\n')
}

/** Map each openapi.yaml path to its expected Next route file and report missing ones. */
function checkRouteDrift(): string[] {
  const doc = parseYaml(readFileSync(join(root, 'openapi.yaml'), 'utf8')) as {
    paths?: Record<string, unknown>
  }
  const missing: string[] = []
  for (const apiPath of Object.keys(doc.paths ?? {})) {
    // /api/jobs/{id}/stream -> src/app/api/jobs/[id]/stream/route.ts
    const segments = apiPath.replace(/^\//, '').replace(/\{([^}]+)\}/g, '[$1]')
    const routeFile = join(root, 'src', 'app', segments, 'route.ts')
    if (!existsSync(routeFile)) missing.push(`${apiPath} -> ${routeFile}`)
  }
  return missing
}

void main()
