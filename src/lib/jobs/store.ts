import { randomUUID } from 'node:crypto'
import type { AnalysisResult } from '@/lib/engine'
import type {
  AnalysisMode,
  ConfidenceThreshold,
  MismatchMode,
  OperationSelection,
} from '@/types/domain'

export type JobStatus = 'pending' | 'running' | 'complete' | 'error' | 'cancelled'

/** Where a job's spec came from — present for repo-connected jobs, enabling code grounding. */
export interface JobRepoRef {
  owner: string
  repo: string
  branch: string
  /** Spec file path within the repo — the file a fix PR commits to. */
  path: string
}

export interface AnalyzeJob {
  id: string
  spec: string
  mode: AnalysisMode
  mismatchMode: MismatchMode
  confidenceThreshold: ConfidenceThreshold
  status: JobStatus
  createdAt: number
  /** Source repo for the spec; lets the stream read handler files for grounding. */
  repo?: JobRepoRef
  /** User-picked paths/methods to analyse; absent = the whole spec. */
  selection?: OperationSelection
  /** The completed analysis result, set when the stream finishes — drives the report page. */
  result?: AnalysisResult
}

export interface CreateJobInput {
  spec: string
  mode: AnalysisMode
  mismatchMode: MismatchMode
  confidenceThreshold: ConfidenceThreshold
  repo?: JobRepoRef
  selection?: OperationSelection
}

/**
 * In-memory job store. Per Architecture Decision 3, anonymous paste-mode jobs
 * live in process memory (lost on restart); authed runs are additionally
 * persisted to the SQLite run store (`lib/db`) when their stream completes.
 *
 * The maps are hoisted onto `globalThis` because Next.js compiles Server Actions
 * (RSC server layer) and Route Handlers (Node server layer) into separate module
 * graphs — a plain module-level `Map` is instantiated independently in each, so a
 * job created by the `analyzeRepoSpec` action would be invisible to the
 * `/api/jobs/[id]/stream` route handler. A process-global pins both to one
 * instance. This is the same singleton pattern Next.js uses for the Prisma client.
 */
const globalForJobs = globalThis as typeof globalThis & {
  __mcpDoctorJobs?: Map<string, AnalyzeJob>
  __mcpDoctorAborts?: Map<string, AbortController>
}

const jobs = (globalForJobs.__mcpDoctorJobs ??= new Map<string, AnalyzeJob>())

/** Abort controllers for in-flight stream runs, so a job can be cancelled. */
const aborts = (globalForJobs.__mcpDoctorAborts ??= new Map<string, AbortController>())

export function createJob(input: CreateJobInput): AnalyzeJob {
  const job: AnalyzeJob = {
    id: randomUUID(),
    spec: input.spec,
    mode: input.mode,
    mismatchMode: input.mismatchMode,
    confidenceThreshold: input.confidenceThreshold,
    status: 'pending',
    createdAt: Date.now(),
    ...(input.repo ? { repo: input.repo } : {}),
    ...(input.selection ? { selection: input.selection } : {}),
  }
  jobs.set(job.id, job)
  return job
}

export function getJob(id: string): AnalyzeJob | undefined {
  return jobs.get(id)
}

export function setJobStatus(id: string, status: JobStatus): void {
  const job = jobs.get(id)
  if (job) job.status = status
}

/** Persist the completed analysis result so the report page can render it. */
export function setJobResult(id: string, result: AnalysisResult): void {
  const job = jobs.get(id)
  if (job) job.result = result
}

export function deleteJob(id: string): void {
  jobs.delete(id)
  aborts.delete(id)
}

/** Associate an abort controller with a job's running stream. */
export function registerJobAbort(id: string, controller: AbortController): void {
  aborts.set(id, controller)
}

/** Forget a job's abort controller once its stream finishes. */
export function clearJobAbort(id: string): void {
  aborts.delete(id)
}

/**
 * Cancel a job: abort its in-flight stream and mark it cancelled (unless it has
 * already reached a terminal state). Returns whether the job exists.
 */
export function cancelJob(id: string): boolean {
  const job = jobs.get(id)
  if (!job) return false
  if (job.status === 'pending' || job.status === 'running') {
    job.status = 'cancelled'
  }
  aborts.get(id)?.abort()
  return true
}
