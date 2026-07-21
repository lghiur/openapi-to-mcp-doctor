import { describe, expect, it } from 'vitest'
import { createJob, getJob, setJobStatus } from '@/lib/jobs/store'
import { POST } from './route'

function context(id: string) {
  return { params: Promise.resolve({ id }) }
}

describe('POST /api/jobs/[id]/cancel', () => {
  it('cancels a running job and reports it cancelled', async () => {
    const job = createJob({
      spec: 'openapi: 3.0.3',
      mode: 'lint',
      mismatchMode: 'flag',
      confidenceThreshold: 'high',
    })
    setJobStatus(job.id, 'running')

    const res = await POST(new Request('http://localhost', { method: 'POST' }), context(job.id))
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ cancelled: true })
    expect(getJob(job.id)?.status).toBe('cancelled')
  })

  it('returns 404 for an unknown job', async () => {
    const res = await POST(new Request('http://localhost', { method: 'POST' }), context('missing'))
    expect(res.status).toBe(404)
  })
})
