import { describe, expect, it } from 'vitest'
import { getJob } from '@/lib/jobs/store'
import { POST } from './route'

function postRequest(body: unknown): Request {
  return new Request('http://localhost/api/analyze', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
}

describe('POST /api/analyze', () => {
  it('creates a job and returns its id for a valid request', async () => {
    const res = await POST(postRequest({ spec: 'openapi: 3.0.3\npaths: {}' }))
    expect(res.status).toBe(200)
    const json = (await res.json()) as { jobId: string }
    expect(json.jobId).toBeTruthy()
    expect(getJob(json.jobId)?.spec).toContain('openapi: 3.0.3')
  })

  it('rejects an empty spec with 400', async () => {
    expect((await POST(postRequest({ spec: '' }))).status).toBe(400)
  })

  it('rejects invalid JSON with 400', async () => {
    const res = await POST(
      new Request('http://localhost/api/analyze', { method: 'POST', body: '{not json' }),
    )
    expect(res.status).toBe(400)
  })
})
