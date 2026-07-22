import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createJob } from '@/lib/jobs/store'

vi.mock('@/lib/auth', () => ({
  getOptionalSession: vi.fn(),
  // Present for the route's grounding path; unused here (no LLM configured).
  getGitHubAccessToken: vi.fn(async () => undefined),
}))
// One in-memory store shared by the route and the assertions below.
vi.mock('@/lib/db', async () => {
  const { openRunStore } = await import('@/lib/db/runs')
  const store = openRunStore(':memory:')
  return { getRunStore: () => store }
})

import { getOptionalSession } from '@/lib/auth'
import { getRunStore } from '@/lib/db'
import { GET } from './route'

const SPEC = `openapi: 3.0.3
info:
  title: T
  version: 1.0.0
paths:
  /users:
    get:
      operationId: list_users
      responses:
        '200':
          description: ok
`

function context(id: string) {
  return { params: Promise.resolve({ id }) }
}

beforeEach(() => {
  vi.mocked(getOptionalSession).mockReset()
})

describe('stream route — run persistence', () => {
  it('persists a completed authed run so history and dashboard can show it', async () => {
    vi.mocked(getOptionalSession).mockResolvedValue({
      user: { email: 'dev@tyk.io' },
      expires: '2099-01-01',
    } as never)
    const job = createJob({
      spec: SPEC,
      mode: 'lint',
      mismatchMode: 'flag',
      confidenceThreshold: 'high',
      repo: { owner: 'tyk', repo: 'petstore', branch: 'main', path: 'api/openapi.yaml' },
    })
    const res = await GET(new Request('http://localhost'), context(job.id))
    await res.text() // drain the stream so the run completes

    const run = getRunStore().getRun(job.id)
    expect(run).not.toBeNull()
    expect(run?.specSource).toBe('github')
    expect(run?.specFile).toBe('api/openapi.yaml')
    expect(run?.repo).toBe('tyk/petstore')
    expect(run?.branch).toBe('main')
    expect(run?.status).toBe('complete')
    expect(run?.findings.length).toBeGreaterThan(0)
    // scoped to the signed-in user
    expect(getRunStore().listRuns('dev@tyk.io').some((r) => r.id === job.id)).toBe(true)
  })

  it('does not persist anonymous paste runs', async () => {
    vi.mocked(getOptionalSession).mockResolvedValue(null)
    const job = createJob({
      spec: SPEC,
      mode: 'lint',
      mismatchMode: 'flag',
      confidenceThreshold: 'high',
    })
    const res = await GET(new Request('http://localhost'), context(job.id))
    await res.text()
    expect(getRunStore().getRun(job.id)).toBeNull()
  })
})
