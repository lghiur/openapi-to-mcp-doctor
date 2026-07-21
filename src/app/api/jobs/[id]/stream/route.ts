import { type GroundingRunner, runAnalysis } from '@/lib/engine'
import { buildAnalysisRun } from '@/lib/engine/history/record'
import { getOptionalSession } from '@/lib/auth'
import { getRunStore } from '@/lib/db'
import { createGitHubClient } from '@/lib/github/client'
import { encodeSSE, toWireEvent } from '@/lib/jobs/sse'
import { clearJobAbort, getJob, registerJobAbort, setJobResult, setJobStatus } from '@/lib/jobs/store'
import { aiCapabilityFromEnv } from '@/lib/llm/capability'
import type { AnalyzeJob } from '@/lib/jobs/store'
import type { AnalysisResult } from '@/lib/engine'

interface RouteContext {
  params: Promise<{ id: string }>
}

/** Assemble and save the history record for a completed authed run. */
function persistRun(
  id: string,
  job: AnalyzeJob,
  result: AnalysisResult,
  durationMs: number,
  userEmail: string | null | undefined,
): void {
  const record = buildAnalysisRun({
    id,
    createdAt: new Date(job.createdAt),
    specSource: job.repo ? 'github' : 'paste',
    specFile: job.repo?.path ?? 'paste',
    ...(job.repo ? { repo: `${job.repo.owner}/${job.repo.repo}`, branch: job.repo.branch } : {}),
    mode: job.mode,
    mismatchMode: job.mismatchMode,
    durationMs,
    status: 'complete',
    findings: result.findings,
    summary: result.summary,
    agents: result.agents,
  })
  getRunStore().saveRun(record, userEmail ?? undefined)
}

/**
 * GET /api/jobs/[id]/stream — drive the analysis for a job as a Server-Sent
 * Events stream. Anonymous paste jobs run structural-only (no LLM). The engine's
 * async iterator is consumed directly in the request (Architecture Decision 3).
 *
 * The run is cancellable: closing the connection (client navigates away / aborts
 * the EventSource) or POSTing /cancel aborts the shared controller, which breaks
 * the loop so the server stops doing work.
 */
export async function GET(request: Request, context: RouteContext): Promise<Response> {
  const { id } = await context.params
  const job = getJob(id)
  if (!job) {
    return new Response('Job not found.', {
      status: 404,
      headers: { 'Content-Type': 'text/plain; charset=utf-8' },
    })
  }

  // One controller drives both cancel paths: explicit /cancel and client disconnect.
  const abort = new AbortController()
  registerJobAbort(id, abort)
  if (request.signal.aborted) abort.abort()
  else request.signal.addEventListener('abort', () => abort.abort(), { once: true })
  const signal = abort.signal

  // Feature tiers: anonymous paste jobs run structural-only; authenticated runs
  // get AI workers + post-processing when an LLM is configured. aiCapabilityFromEnv
  // is undefined when LLM_* env is unset, so this is also a no-op without a model.
  // The abort signal reaches every LLM call, so cancelling the job (or closing the
  // tab) actually interrupts in-flight gateway requests instead of orphaning them.
  const session = await getOptionalSession()
  const ai = session ? aiCapabilityFromEnv(process.env, { signal }) : undefined
  const accessToken = session?.accessToken

  const encoder = new TextEncoder()
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const safeEnqueue = (chunk: string): boolean => {
        if (signal.aborted) return false
        try {
          controller.enqueue(encoder.encode(chunk))
          return true
        } catch {
          return false
        }
      }

      // Confirm the pipe immediately so the client knows the stream is live.
      safeEnqueue(': open\n\n')
      setJobStatus(id, 'running')

      try {
        // Code grounding: for a repo-connected, authenticated run with an LLM, read
        // handler files from the repo and let the worker check spec/code mismatches.
        // Best-effort — a GitHub failure degrades to spec-only analysis, never aborts.
        let grounding: GroundingRunner | undefined
        if (ai?.runGrounding && job.repo && accessToken) {
          try {
            const gh = createGitHubClient(accessToken)
            const { owner, repo, branch } = job.repo
            const paths = await gh.listSourceCandidates(owner, repo, branch)
            const routeFiles = paths.length ? await gh.readFiles(owner, repo, paths, branch) : []
            if (routeFiles.length > 0) {
              // Operator evidence that grounding really ran (paths only, no content).
              console.info(
                `[mcp-doctor] job ${id}: grounding enabled — reading ${routeFiles.length} source file(s) from ${owner}/${repo}@${branch}: ${routeFiles.map((f) => f.path).join(', ')}`,
              )
              const runGround = ai.runGrounding
              grounding = (operations, version) => runGround(operations, routeFiles, version)
            }
          } catch {
            grounding = undefined
          }
        }

        // Iterate manually so we can capture the generator's return value (the
        // final AnalysisResult) and persist it for the report page.
        const startedAt = Date.now()
        const run = runAnalysis(job.spec, { ai, grounding, selection: job.selection })
        let step = await run.next()
        while (!step.done) {
          if (signal.aborted) break
          safeEnqueue(encodeSSE(toWireEvent(step.value)))
          step = await run.next()
        }
        if (step.done && !signal.aborted) {
          setJobResult(id, step.value)
          // Authed runs land in the history DB (feature tiers: anonymous paste
          // stays in-memory only). Persistence must never sink a finished stream.
          if (session) {
            try {
              persistRun(id, job, step.value, Date.now() - startedAt, session.user?.email)
            } catch (cause) {
              console.error(
                `[mcp-doctor] job ${id}: failed to persist run history:`,
                cause instanceof Error ? cause.message : 'unknown error',
              )
            }
          }
        }
        setJobStatus(id, signal.aborted ? 'cancelled' : 'complete')
      } catch (cause) {
        // Surface as a stream close, not a fake "complete" — the client treats a
        // close-before-analysis_complete as an error. Log the message (engine
        // errors are credential-free) so operators can diagnose failed runs.
        if (!signal.aborted) {
          setJobStatus(id, 'error')
          console.error(
            `[mcp-doctor] analysis for job ${id} failed:`,
            cause instanceof Error ? cause.message : 'unknown error',
          )
        }
      } finally {
        clearJobAbort(id)
        try {
          controller.close()
        } catch {
          // already closed
        }
      }
    },
    cancel() {
      // The consumer (browser) went away — stop the work.
      abort.abort()
    },
  })

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
    },
  })
}
