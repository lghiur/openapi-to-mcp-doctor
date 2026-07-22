import { afterEach, describe, expect, it } from 'vitest'
import { openRunStore, type RunStore } from '@/lib/db/runs'
import type { AnalysisRun } from '@/types/domain'

let store: RunStore
afterEach(() => store?.close())

function run(id: string, iso: string): AnalysisRun {
  return {
    id,
    createdAt: new Date(iso),
    specSource: 'github',
    specFile: 'api/openapi.yaml',
    repo: 'acme/api',
    branch: 'main',
    mode: 'lint',
    mismatchMode: 'flag',
    durationMs: 10,
    status: 'complete',
    summary: {
      totalFindings: 1,
      errors: 1,
      warnings: 0,
      info: 0,
      accepted: 0,
      rejected: 0,
      autoFixed: 0,
    },
    agents: [
      {
        id: 'structural-linter',
        type: 'structural-linter',
        operations: [],
        filesRead: [],
        findingsCount: 1,
        durationMs: 5,
      },
    ],
    findings: [
      {
        id: 'find-1',
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

describe('RunStore', () => {
  it('saves and retrieves a run by id', () => {
    store = openRunStore(':memory:')
    store.saveRun(run('r1', '2026-06-24T00:00:00Z'), 'user-1')
    const fetched = store.getRun('r1')
    expect(fetched?.id).toBe('r1')
    expect(fetched?.createdAt).toBeInstanceOf(Date)
    expect(fetched?.findings[0]?.rule).toBe('mcp-operationid-required')
    expect(fetched?.agents[0]?.type).toBe('structural-linter')
  })

  it('lists runs for a user, newest first', () => {
    store = openRunStore(':memory:')
    store.saveRun(run('old', '2026-06-01T00:00:00Z'), 'user-1')
    store.saveRun(run('new', '2026-06-24T00:00:00Z'), 'user-1')
    store.saveRun(run('other', '2026-06-30T00:00:00Z'), 'user-2')
    expect(store.listRuns('user-1').map((r) => r.id)).toEqual(['new', 'old'])
  })

  it('returns NO runs when no user id is given — never the whole table', () => {
    store = openRunStore(':memory:')
    store.saveRun(run('r1', '2026-06-01T00:00:00Z'), 'user-1')
    store.saveRun(run('r2', '2026-06-02T00:00:00Z'), 'user-2')
    // A session without an email must see zero runs, not every user's history.
    expect(store.listRuns(undefined)).toEqual([])
    expect(store.listRuns('')).toEqual([])
  })

  it('getRunForUser returns the run only for its owner', () => {
    store = openRunStore(':memory:')
    store.saveRun(run('r1', '2026-06-01T00:00:00Z'), 'owner@x.io')
    expect(store.getRunForUser('r1', 'owner@x.io')?.id).toBe('r1')
    // someone else's run is indistinguishable from a missing one (no id probing)
    expect(store.getRunForUser('r1', 'attacker@x.io')).toBeNull()
    expect(store.getRunForUser('missing', 'owner@x.io')).toBeNull()
    expect(store.getRunForUser('r1', '')).toBeNull()
  })

  it('updates a finding resolution and recomputes summary counts', () => {
    store = openRunStore(':memory:')
    store.saveRun(run('r1', '2026-06-24T00:00:00Z'), 'user-1')
    store.updateResolution('r1', 'find-1', 'accepted')
    const updated = store.getRun('r1')
    expect(updated?.findings[0]?.resolution).toBe('accepted')
    expect(updated?.summary.accepted).toBe(1)
  })

  it('returns null for an unknown run', () => {
    store = openRunStore(':memory:')
    expect(store.getRun('nope')).toBeNull()
  })

  it('records PR info on an existing run without touching its findings', () => {
    store = openRunStore(':memory:')
    store.saveRun(run('r1', '2026-06-24T00:00:00Z'), 'user-1')
    store.setPrInfo('r1', {
      prUrl: 'https://github.com/acme/api/pull/9',
      prBranch: 'mcp-doctor/fix-r1',
    })
    const updated = store.getRun('r1')
    expect(updated?.prUrl).toBe('https://github.com/acme/api/pull/9')
    expect(updated?.prBranch).toBe('mcp-doctor/fix-r1')
    expect(updated?.findings).toHaveLength(1)
  })

  it('setPrInfo on an unknown run is a no-op', () => {
    store = openRunStore(':memory:')
    expect(() =>
      store.setPrInfo('nope', { prUrl: 'https://x', prBranch: 'b' }),
    ).not.toThrow()
  })
})
