import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { runStructuralAnalysis } from '@/lib/engine'
import { computeHealthScore } from '@/lib/engine/health'

/**
 * The golden-corpus regression harness — the deterministic core of continuous
 * dogfooding (Architecture Decision 8). Every spec under fixtures/specs is run
 * through the structural engine and its projection diffed against a committed
 * golden. A behavior change flips the matching golden test red.
 *
 * Regenerate goldens after an intentional change with:
 *   UPDATE_GOLDENS=1 npm test -- golden-corpus
 * and review the diff before committing.
 */

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, '..')
const specsDir = join(root, 'fixtures', 'specs')
const goldenDir = join(root, 'fixtures', 'golden')
const UPDATE = process.env.UPDATE_GOLDENS === '1'

interface GoldenFinding {
  rule: string
  severity: string
  path: string
}

interface GoldenProjection {
  version: string | null
  halted: boolean
  summary: { total: number; errors: number; warnings: number; info: number }
  healthScore: number
  findings: GoldenFinding[]
}

async function project(spec: string): Promise<GoldenProjection> {
  const result = await runStructuralAnalysis(spec)
  const findings = result.findings
    .map((f) => ({ rule: f.rule, severity: f.severity, path: (f.path ?? []).join('/') }))
    .sort((a, b) =>
      `${a.rule}|${a.path}|${a.severity}`.localeCompare(`${b.rule}|${b.path}|${b.severity}`),
    )
  return {
    version: result.version,
    halted: result.halted,
    summary: result.summary,
    healthScore: computeHealthScore(result.summary),
    findings,
  }
}

const specFiles = readdirSync(specsDir)
  .filter((f) => /\.(ya?ml|json)$/.test(f))
  .sort()

describe('golden fixture corpus', () => {
  it('has at least one fixture', () => {
    expect(specFiles.length).toBeGreaterThan(0)
  })

  for (const file of specFiles) {
    it(file, async () => {
      const spec = readFileSync(join(specsDir, file), 'utf8')
      const projection = await project(spec)
      const goldenPath = join(goldenDir, `${file.replace(/\.(ya?ml|json)$/, '')}.json`)

      if (UPDATE) {
        if (!existsSync(goldenDir)) mkdirSync(goldenDir, { recursive: true })
        writeFileSync(goldenPath, `${JSON.stringify(projection, null, 2)}\n`)
        return
      }

      expect(existsSync(goldenPath), `missing golden for ${file} — run UPDATE_GOLDENS=1`).toBe(true)
      const golden = JSON.parse(readFileSync(goldenPath, 'utf8')) as GoldenProjection
      expect(projection).toEqual(golden)
    })
  }
})
