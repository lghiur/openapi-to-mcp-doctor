import { describe, expect, it, vi } from 'vitest'
import {
  cancelJob,
  createJob,
  getJob,
  registerJobAbort,
  setJobStatus,
} from '@/lib/jobs/store'

describe('in-memory job store', () => {
  it('creates a job with an id and pending status', () => {
    const job = createJob({
      spec: 'openapi: 3.0.3',
      mode: 'lint',
      mismatchMode: 'flag',
      confidenceThreshold: 'high',
    })
    expect(job.id).toBeTruthy()
    expect(job.status).toBe('pending')
    expect(getJob(job.id)?.spec).toBe('openapi: 3.0.3')
  })

  it('updates job status', () => {
    const job = createJob({
      spec: 's',
      mode: 'lint',
      mismatchMode: 'flag',
      confidenceThreshold: 'high',
    })
    setJobStatus(job.id, 'running')
    expect(getJob(job.id)?.status).toBe('running')
  })

  it('returns undefined for an unknown job', () => {
    expect(getJob('nope')).toBeUndefined()
  })

  it('cancelJob marks a running job cancelled and aborts its controller', () => {
    const job = createJob({
      spec: 's',
      mode: 'lint',
      mismatchMode: 'flag',
      confidenceThreshold: 'high',
    })
    const controller = new AbortController()
    const onAbort = vi.fn()
    controller.signal.addEventListener('abort', onAbort)
    registerJobAbort(job.id, controller)
    setJobStatus(job.id, 'running')

    expect(cancelJob(job.id)).toBe(true)
    expect(getJob(job.id)?.status).toBe('cancelled')
    expect(controller.signal.aborted).toBe(true)
    expect(onAbort).toHaveBeenCalledOnce()
  })

  it('cancelJob does not overwrite a completed job but still returns true', () => {
    const job = createJob({
      spec: 's',
      mode: 'lint',
      mismatchMode: 'flag',
      confidenceThreshold: 'high',
    })
    setJobStatus(job.id, 'complete')
    expect(cancelJob(job.id)).toBe(true)
    expect(getJob(job.id)?.status).toBe('complete')
  })

  it('cancelJob returns false for an unknown job', () => {
    expect(cancelJob('nope')).toBe(false)
  })
})
