import { describe, expect, it } from 'vitest'
import { createJob, getJob, setJobResult, setJobStatus } from '@/lib/jobs/store'
import type { AnalysisResult } from '@/lib/engine'
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

  it('replays the stored result for a completed job instead of re-running the analysis', async () => {
    const job = createJob({
      spec: SPEC,
      mode: 'lint',
      mismatchMode: 'flag',
      confidenceThreshold: 'high',
    })
    const result: AnalysisResult = {
      version: '3.0',
      halted: false,
      findings: [
        {
          id: 'replayed-finding-1',
          agentId: 'structural-linter',
          operation: 'GET /users',
          rule: 'mcp-param-description-required',
          severity: 'warning',
          confidence: 'HIGH',
          message: 'Stored finding from the original run.',
          autoFixable: false,
          autoFixed: false,
          resolution: 'accepted',
        },
      ],
      summary: { total: 1, errors: 0, warnings: 1, info: 0 },
      agents: [
        {
          id: 'structural-linter',
          type: 'structural-linter',
          operations: ['GET /users'],
          filesRead: [],
          findingsCount: 1,
          durationMs: 5,
        },
      ],
    }
    setJobResult(job.id, result)
    setJobStatus(job.id, 'complete')

    const res = await GET(new Request('http://localhost'), context(job.id))
    expect(res.headers.get('content-type')).toContain('text/event-stream')
    const text = await res.text()
    // the stored result is replayed, not a fresh analysis
    expect(text).toContain(': replay')
    expect(text).toContain('replayed-finding-1')
    expect(text).toContain('event: agent_started')
    expect(text).toContain('event: analysis_complete')
    // the job is untouched: still complete, result (with user resolutions) intact
    expect(getJob(job.id)?.status).toBe('complete')
    expect(getJob(job.id)?.result?.findings[0]?.resolution).toBe('accepted')
  })

  it('returns 409 for a job that is already running (no duplicate analysis, no cancel-state corruption)', async () => {
    const job = createJob({
      spec: SPEC,
      mode: 'lint',
      mismatchMode: 'flag',
      confidenceThreshold: 'high',
    })
    setJobStatus(job.id, 'running')
    const res = await GET(new Request('http://localhost'), context(job.id))
    expect(res.status).toBe(409)
    expect(getJob(job.id)?.status).toBe('running')
    setJobStatus(job.id, 'cancelled') // clean up for other tests
  })

  it('restarts a cancelled job on reconnect (the Try-again path)', async () => {
    const job = createJob({
      spec: SPEC,
      mode: 'lint',
      mismatchMode: 'flag',
      confidenceThreshold: 'high',
    })
    setJobStatus(job.id, 'cancelled')
    const res = await GET(new Request('http://localhost'), context(job.id))
    const text = await res.text()
    expect(text).toContain('event: analysis_complete')
    expect(getJob(job.id)?.status).toBe('complete')
  })
})
