import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { AnalysisRun } from '@/types/domain'

vi.mock('@/lib/auth', () => ({
  getOptionalSession: vi.fn(),
}))
vi.mock('@/lib/db', async () => {
  const { openRunStore } = await import('@/lib/db/runs')
  const store = openRunStore(':memory:')
  return { getRunStore: () => store }
})

import { getOptionalSession } from '@/lib/auth'
import { getRunStore } from '@/lib/db'
import { POST } from './route'

function sampleRun(id: string): AnalysisRun {
  return {
    id,
    createdAt: new Date('2026-06-24T00:00:00Z'),
    specSource: 'github',
    specFile: 'api/openapi.yaml',
    mode: 'lint',
    mismatchMode: 'flag',
    durationMs: 10,
    status: 'complete',
    summary: {
      totalFindings: 1,
      errors: 0,
      warnings: 1,
      info: 0,
      accepted: 0,
      rejected: 0,
      autoFixed: 0,
    },
    agents: [],
    findings: [
      {
        id: 'find-1',
        agentId: 'worker-1',
        operation: 'GET /users',
        rule: 'MCP_NO_WHEN_TO_USE',
        severity: 'warning',
        confidence: 'MEDIUM',
        before: '',
        after: 'Better description.',
        resolution: 'pending',
        autoFixed: false,
      },
    ],
  }
}

function resolutionRequest(body: unknown): Request {
  return new Request('http://localhost', { method: 'POST', body: JSON.stringify(body) })
}

function context(id: string) {
  return { params: Promise.resolve({ id }) }
}

function signIn(): void {
  vi.mocked(getOptionalSession).mockResolvedValue({ expires: '2099-01-01' } as never)
}

beforeEach(() => {
  vi.mocked(getOptionalSession).mockReset()
})

describe('POST /api/runs/[id]/resolution', () => {
  it('requires authentication', async () => {
    vi.mocked(getOptionalSession).mockResolvedValue(null)
    const res = await POST(
      resolutionRequest({ findingId: 'find-1', resolution: 'accepted' }),
      context('run-1'),
    )
    expect(res.status).toBe(401)
  })

  it('returns 404 for an unknown run', async () => {
    signIn()
    const res = await POST(
      resolutionRequest({ findingId: 'find-1', resolution: 'accepted' }),
      context('missing'),
    )
    expect(res.status).toBe(404)
  })

  it('rejects an invalid resolution value', async () => {
    signIn()
    getRunStore().saveRun(sampleRun('run-bad'), 'dev@tyk.io')
    const res = await POST(
      resolutionRequest({ findingId: 'find-1', resolution: 'maybe' }),
      context('run-bad'),
    )
    expect(res.status).toBe(400)
  })

  it('updates the finding resolution and recomputed counts', async () => {
    signIn()
    getRunStore().saveRun(sampleRun('run-1'), 'dev@tyk.io')
    const res = await POST(
      resolutionRequest({ findingId: 'find-1', resolution: 'accepted' }),
      context('run-1'),
    )
    expect(res.status).toBe(200)
    const run = getRunStore().getRun('run-1')
    expect(run?.findings[0]?.resolution).toBe('accepted')
    expect(run?.summary.accepted).toBe(1)
  })
})
