import { parse as parseYaml } from 'yaml'
import { describe, expect, it } from 'vitest'
import { createJob, setJobResult } from '@/lib/jobs/store'
import type { Finding } from '@/types/domain'
import { POST } from './route'

const SPEC = `openapi: 3.0.3
info:
  title: T
  version: 1.0.0
paths:
  /users/{id}:
    get:
      operationId: GetUser
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

function context(id: string) {
  return { params: Promise.resolve({ id }) }
}

function patchRequest(body: unknown): Request {
  return new Request('http://localhost', { method: 'POST', body: JSON.stringify(body) })
}

describe('POST /api/jobs/[id]/patch', () => {
  it('returns a patched spec with high-confidence fixes applied', async () => {
    const job = createJob({
      spec: SPEC,
      mode: 'fix',
      mismatchMode: 'flag',
      confidenceThreshold: 'high',
    })
    const res = await POST(patchRequest({ threshold: 'high' }), context(job.id))
    expect(res.status).toBe(200)
    expect(res.headers.get('content-disposition')).toContain('attachment')
    const patched = await res.text()
    expect(patched).toContain('get_user')
  })

  it('returns 404 for an unknown job', async () => {
    const res = await POST(patchRequest({}), context('missing'))
    expect(res.status).toBe(404)
  })

  it('applies accepted AI findings from the stored result (not just structural re-runs)', async () => {
    const job = createJob({
      spec: SPEC,
      mode: 'fix',
      mismatchMode: 'flag',
      confidenceThreshold: 'high',
    })
    const aiFinding: Finding = {
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
    setJobResult(job.id, {
      version: '3.0',
      halted: false,
      findings: [aiFinding],
      summary: { total: 1, errors: 0, warnings: 1, info: 0 },
      agents: [],
    })

    const res = await POST(patchRequest({ acceptedIds: [aiFinding.id] }), context(job.id))
    expect(res.status).toBe(200)
    const patched = parseYaml(await res.text())
    expect(patched.paths['/users/{id}'].get.description).toBe(
      'Fetch one user by ID. Use when you already know the exact user id.',
    )
    expect(res.headers.get('x-fixes-applied')).toBe('1')
  })

  it('human acceptance overrides the confidence and mismatch gates', async () => {
    const job = createJob({
      spec: SPEC,
      mode: 'fix',
      mismatchMode: 'flag',
      confidenceThreshold: 'high',
    })
    const mismatch: Finding = {
      id: 'worker-mismatch-0-get_user',
      agentId: 'worker',
      operation: 'GET /users/{id}',
      rule: 'SPEC_CODE_MISMATCH',
      severity: 'error',
      confidence: 'LOW',
      message: 'spec says 200, code returns 204',
      after: 'No Content',
      path: ['paths', '/users/{id}', 'get', 'responses', '200', 'description'],
      autoFixable: false,
      autoFixed: false,
      resolution: 'pending',
    }
    setJobResult(job.id, {
      version: '3.0',
      halted: false,
      findings: [mismatch],
      summary: { total: 1, errors: 1, warnings: 0, info: 0 },
      agents: [],
    })

    const res = await POST(patchRequest({ acceptedIds: [mismatch.id] }), context(job.id))
    const patched = parseYaml(await res.text())
    expect(patched.paths['/users/{id}'].get.responses['200'].description).toBe('No Content')
  })

  it('verifies applied fixes by re-lint and reports the outcome in headers', async () => {
    const job = createJob({
      spec: SPEC,
      mode: 'fix',
      mismatchMode: 'flag',
      confidenceThreshold: 'high',
    })
    const res = await POST(patchRequest({ threshold: 'high' }), context(job.id))
    expect(res.status).toBe(200)
    // the GetUser → get_user rename is confirmed resolved by the re-lint
    expect(Number(res.headers.get('x-fixes-verified'))).toBeGreaterThan(0)
    expect(res.headers.get('x-fixes-unresolved')).toBe('0')
    expect(res.headers.get('x-fixes-regressions')).toBe('0')
  })

  it('rejects a patch whose fixes break the spec (422, no document returned)', async () => {
    const job = createJob({
      spec: SPEC,
      mode: 'fix',
      mismatchMode: 'flag',
      confidenceThreshold: 'high',
    })
    const evil: Finding = {
      id: 'worker-evil-0',
      agentId: 'worker-1',
      rule: 'EVIL_DOWNGRADE',
      severity: 'warning',
      confidence: 'MEDIUM',
      message: 'downgrade the document',
      after: '2.0',
      path: ['openapi'],
      autoFixable: false,
      autoFixed: false,
      resolution: 'pending',
    }
    setJobResult(job.id, {
      version: '3.0',
      halted: false,
      findings: [evil],
      summary: { total: 1, errors: 0, warnings: 1, info: 0 },
      agents: [],
    })
    const res = await POST(patchRequest({ acceptedIds: [evil.id] }), context(job.id))
    expect(res.status).toBe(422)
    const body = (await res.json()) as { error: string }
    expect(body.error).toMatch(/invalid/i)
  })

  it('applies nothing when the user accepted nothing', async () => {
    const job = createJob({
      spec: SPEC,
      mode: 'fix',
      mismatchMode: 'flag',
      confidenceThreshold: 'high',
    })
    const res = await POST(patchRequest({ acceptedIds: [] }), context(job.id))
    expect(res.headers.get('x-fixes-applied')).toBe('0')
    const patched = await res.text()
    expect(patched).toContain('GetUser')
  })
})
