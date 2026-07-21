import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { AnalysisRun } from '@/types/domain'
import { getRun, listRuns, saveRun } from './store'

const dirs: string[] = []
async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'mcp-hist-'))
  dirs.push(dir)
  return dir
}
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })))
})

function run(id: string, isoDate: string): AnalysisRun {
  return {
    id,
    createdAt: new Date(isoDate),
    specSource: 'paste',
    specFile: 'paste',
    mode: 'lint',
    mismatchMode: 'flag',
    durationMs: 1,
    status: 'complete',
    summary: {
      totalFindings: 0,
      errors: 0,
      warnings: 0,
      info: 0,
      accepted: 0,
      rejected: 0,
      autoFixed: 0,
    },
    agents: [],
    findings: [],
  }
}

describe('history store', () => {
  it('saves a run and lists it back', async () => {
    const dir = await tempDir()
    await saveRun(run('run-1', '2026-06-24T00:00:00Z'), dir)
    const runs = await listRuns(dir)
    expect(runs.map((r) => r.id)).toEqual(['run-1'])
  })

  it('lists runs newest-first', async () => {
    const dir = await tempDir()
    await saveRun(run('old', '2026-06-01T00:00:00Z'), dir)
    await saveRun(run('new', '2026-06-24T00:00:00Z'), dir)
    expect((await listRuns(dir)).map((r) => r.id)).toEqual(['new', 'old'])
  })

  it('gets a run by id', async () => {
    const dir = await tempDir()
    await saveRun(run('run-x', '2026-06-24T00:00:00Z'), dir)
    expect((await getRun(dir, 'run-x'))?.id).toBe('run-x')
    expect(await getRun(dir, 'missing')).toBeNull()
  })

  it('prunes to the last N runs', async () => {
    const dir = await tempDir()
    for (let i = 0; i < 5; i++) {
      await saveRun(run(`run-${i}`, `2026-06-0${i + 1}T00:00:00Z`), dir, 3)
    }
    const runs = await listRuns(dir)
    expect(runs).toHaveLength(3)
    // newest three kept
    expect(runs.map((r) => r.id)).toEqual(['run-4', 'run-3', 'run-2'])
  })

  it('returns [] when no history directory exists', async () => {
    const dir = await tempDir()
    expect(await listRuns(join(dir, 'nope'))).toEqual([])
  })
})
