import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { AnalysisRun } from '@/types/domain'
import { saveRun } from '../history/store'
import { renderDiff } from './diff'
import { renderHistoryDetail, renderHistoryList } from './history'

const dirs: string[] = []
async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'mcp-histcmd-'))
  dirs.push(dir)
  return dir
}
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })))
})

function run(id: string, iso: string, errors: number): AnalysisRun {
  return {
    id,
    createdAt: new Date(iso),
    specSource: 'paste',
    specFile: 'api.yaml',
    mode: 'lint',
    mismatchMode: 'flag',
    durationMs: 1,
    status: 'complete',
    summary: {
      totalFindings: errors,
      errors,
      warnings: 0,
      info: 0,
      accepted: 0,
      rejected: 0,
      autoFixed: 0,
    },
    agents: [],
    findings: [
      {
        id: 'f1',
        agentId: 'structural-linter',
        operation: 'GET /users',
        rule: 'mcp-operationid-required',
        severity: 'error',
        confidence: 'HIGH',
        before: '',
        after: '',
        resolution: 'pending',
        autoFixed: false,
      },
    ],
  }
}

describe('renderHistoryList', () => {
  it('lists recorded runs', async () => {
    const dir = await tempDir()
    await saveRun(run('run-a', '2026-06-24T00:00:00Z', 2), dir)
    const out = await renderHistoryList(dir)
    expect(out.stdout).toContain('run-a')
    expect(out.stdout).toContain('2E/0W/0I')
  })

  it('reports when there is no history', async () => {
    const dir = await tempDir()
    expect((await renderHistoryList(dir)).stdout).toMatch(/No analysis runs/)
  })
})

describe('renderHistoryDetail', () => {
  it('shows detail for a run', async () => {
    const dir = await tempDir()
    await saveRun(run('run-b', '2026-06-24T00:00:00Z', 1), dir)
    const out = await renderHistoryDetail(dir, 'run-b')
    expect(out.stdout).toContain('Run run-b')
    expect(out.stdout).toContain('mcp-operationid-required')
  })

  it('emits JSON with --json', async () => {
    const dir = await tempDir()
    await saveRun(run('run-c', '2026-06-24T00:00:00Z', 1), dir)
    const out = await renderHistoryDetail(dir, 'run-c', { json: true })
    expect(JSON.parse(out.stdout).id).toBe('run-c')
  })

  it('exits 3 for an unknown run', async () => {
    const dir = await tempDir()
    expect((await renderHistoryDetail(dir, 'nope')).exitCode).toBe(3)
  })
})

describe('renderDiff', () => {
  it('compares a run to the previous one', async () => {
    const dir = await tempDir()
    await saveRun(run('older', '2026-06-01T00:00:00Z', 5), dir)
    await saveRun(run('newer', '2026-06-24T00:00:00Z', 2), dir)
    const out = await renderDiff(dir, 'newer')
    expect(out.stdout).toContain('older → newer')
    expect(out.stdout).toMatch(/Errors:\s+5 → 2 \(-3\)/)
  })

  it('handles a run with no earlier comparison', async () => {
    const dir = await tempDir()
    await saveRun(run('solo', '2026-06-24T00:00:00Z', 1), dir)
    expect((await renderDiff(dir, 'solo')).stdout).toMatch(/No earlier run/)
  })
})
