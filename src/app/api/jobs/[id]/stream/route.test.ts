import { describe, expect, it } from 'vitest'
import { createJob } from '@/lib/jobs/store'
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

describe('GET /api/jobs/[id]/stream', () => {
  it('streams SSE events ending in analysis_complete for a valid job', async () => {
    const job = createJob({
      spec: SPEC,
      mode: 'lint',
      mismatchMode: 'flag',
      confidenceThreshold: 'high',
    })
    const res = await GET(new Request('http://localhost'), context(job.id))
    expect(res.headers.get('content-type')).toContain('text/event-stream')
    const text = await res.text()
    expect(text).toContain('event: agent_started')
    expect(text).toContain('event: analysis_complete')
  })

  it('returns 404 for an unknown job', async () => {
    const res = await GET(new Request('http://localhost'), context('missing'))
    expect(res.status).toBe(404)
  })
})
