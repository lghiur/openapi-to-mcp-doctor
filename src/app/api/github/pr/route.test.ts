import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createJob, setJobResult } from '@/lib/jobs/store'
import type { Finding } from '@/types/domain'

vi.mock('@/lib/auth', () => ({
  getGitHubAccessToken: vi.fn(),
}))
vi.mock('@/lib/github/client', () => ({
  createGitHubClient: vi.fn(),
}))
vi.mock('@/lib/db', async () => {
  const { openRunStore } = await import('@/lib/db/runs')
  const store = openRunStore(':memory:')
  return { getRunStore: () => store }
})

import { getGitHubAccessToken } from '@/lib/auth'
import { getRunStore } from '@/lib/db'
import { createGitHubClient } from '@/lib/github/client'
import { buildAnalysisRun } from '@/lib/engine/history/record'
import { POST } from './route'

const SPEC = `openapi: 3.0.3
info:
  title: T
  version: 1.0.0
paths:
  /users/{id}:
    get:
      operationId: get_user
      description: Fetch one user.
      parameters:
        - name: id
          in: path
          required: true
          schema:
            type: string
      responses:
        '200':
          description: ok
`

const ACCEPTED_FINDING: Finding = {
  id: 'worker-1-0-MCP_NO_WHEN_TO_USE',
  agentId: 'worker-1',
  operation: 'GET /users/{id}',
  rule: 'MCP_NO_WHEN_TO_USE',
  severity: 'warning',
  confidence: 'MEDIUM',
  message: 'No when-to-use guidance.',
  after: 'Fetch one user by ID. Use when you already know the exact user id.',
  path: ['paths', '/users/{id}', 'get', 'description'],
  autoFixable: false,
  autoFixed: false,
  resolution: 'pending',
}

function repoJob() {
  const job = createJob({
    spec: SPEC,
    mode: 'fix',
    mismatchMode: 'flag',
    confidenceThreshold: 'high',
    repo: { owner: 'tyk', repo: 'petstore', branch: 'main', path: 'api/openapi.yaml' },
  })
  setJobResult(job.id, {
    version: '3.0',
    halted: false,
    findings: [ACCEPTED_FINDING],
    summary: { total: 1, errors: 0, warnings: 1, info: 0 },
    agents: [],
  })
  return job
}

function prRequest(body: unknown): Request {
  return new Request('http://localhost/api/github/pr', {
    method: 'POST',
    body: JSON.stringify(body),
  })
}

function signIn(): void {
  // The token comes from the server-only JWT helper, never from the session.
  vi.mocked(getGitHubAccessToken).mockResolvedValue('gh-token')
}

const createFixPr = vi.fn()

beforeEach(() => {
  vi.mocked(getGitHubAccessToken).mockReset()
  vi.mocked(createGitHubClient).mockReset()
  createFixPr.mockReset()
  createFixPr.mockResolvedValue({ url: 'https://github.com/tyk/petstore/pull/7', number: 7 })
  vi.mocked(createGitHubClient).mockReturnValue({ createFixPr } as never)
})

describe('POST /api/github/pr', () => {
  it('returns 401 when not authenticated', async () => {
    vi.mocked(getGitHubAccessToken).mockResolvedValue(undefined)
    const job = repoJob()
    const res = await POST(prRequest({ jobId: job.id, acceptedIds: [ACCEPTED_FINDING.id] }))
    expect(res.status).toBe(401)
    expect(createFixPr).not.toHaveBeenCalled()
  })

  it('returns 404 for an unknown job', async () => {
    signIn()
    const res = await POST(prRequest({ jobId: 'missing', acceptedIds: ['x'] }))
    expect(res.status).toBe(404)
  })

  it('returns 400 for a paste job with no repo source', async () => {
    signIn()
    const job = createJob({
      spec: SPEC,
      mode: 'lint',
      mismatchMode: 'flag',
      confidenceThreshold: 'high',
    })
    const res = await POST(prRequest({ jobId: job.id, acceptedIds: [ACCEPTED_FINDING.id] }))
    expect(res.status).toBe(400)
  })

  it('returns 400 when nothing was accepted (no fixes to commit)', async () => {
    signIn()
    const job = repoJob()
    const res = await POST(prRequest({ jobId: job.id, acceptedIds: [] }))
    expect(res.status).toBe(400)
    expect(createFixPr).not.toHaveBeenCalled()
  })

  it('creates a PR with the patched spec on a new branch and returns its link', async () => {
    signIn()
    const job = repoJob()
    const res = await POST(prRequest({ jobId: job.id, acceptedIds: [ACCEPTED_FINDING.id] }))
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ url: 'https://github.com/tyk/petstore/pull/7', number: 7 })

    expect(vi.mocked(createGitHubClient)).toHaveBeenCalledWith('gh-token')
    expect(createFixPr).toHaveBeenCalledOnce()
    const params = createFixPr.mock.calls[0]?.[0] as {
      owner: string
      repo: string
      baseBranch: string
      headBranch: string
      path: string
      content: string
      body: string
    }
    expect(params.owner).toBe('tyk')
    expect(params.repo).toBe('petstore')
    expect(params.baseBranch).toBe('main')
    expect(params.headBranch).toMatch(/^mcp-doctor\/fix-/)
    expect(params.path).toBe('api/openapi.yaml')
    // the committed content is the patched spec, with the accepted fix applied
    expect(params.content).toContain('Use when you already know the exact user id.')
    // the PR body lists the applied change against the right file
    expect(params.body).toContain('api/openapi.yaml')
    expect(params.body).toContain('MCP_NO_WHEN_TO_USE')
  })

  it('records the PR link on the persisted run when one exists', async () => {
    signIn()
    const job = repoJob()
    getRunStore().saveRun(
      buildAnalysisRun({
        id: job.id,
        createdAt: new Date('2026-06-24T00:00:00Z'),
        specSource: 'github',
        specFile: 'api/openapi.yaml',
        repo: 'tyk/petstore',
        branch: 'main',
        mode: 'fix',
        mismatchMode: 'flag',
        durationMs: 10,
        findings: [ACCEPTED_FINDING],
        summary: { total: 1, errors: 0, warnings: 1, info: 0 },
        agents: [],
      }),
      'dev@tyk.io',
    )
    const res = await POST(prRequest({ jobId: job.id, acceptedIds: [ACCEPTED_FINDING.id] }))
    expect(res.status).toBe(200)
    const run = getRunStore().getRun(job.id)
    expect(run?.prUrl).toBe('https://github.com/tyk/petstore/pull/7')
    expect(run?.prBranch).toBe(`mcp-doctor/fix-${job.id.slice(0, 8)}`)
  })
})
