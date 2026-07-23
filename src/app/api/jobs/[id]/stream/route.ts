import { type GroundingRunner, runAnalysis } from '@/lib/engine'
import { buildAnalysisRun } from '@/lib/engine/history/record'
import { getGitHubAccessToken, getOptionalSession } from '@/lib/auth'
import { getRunStore } from '@/lib/db'
import { createGitHubClient } from '@/lib/github/client'
import { encodeSSE, toWireEvent } from '@/lib/jobs/sse'
import { clearJobAbort, getJob, registerJobAbort, setJobResult, setJobStatus } from '@/lib/jobs/store'
import { aiCapabilityFromEnv } from '@/lib/llm/capability'
import type { AnalyzeJob } from '@/lib/jobs/store'
import type { AnalysisResult } from '@/lib/engine'
import type { SSEEvent } from '@/types/domain'

interface RouteContext {
  params: Promise<{ id: string }>
}

const SSE_HEADERS = {
  'Content-Type': 'text/event-stream',
  'Cache-Control': 'no-cache, no-transform',
  Connection: 'keep-alive',
} as const

/**
 * Reconstruct the SSE event sequence for a finished run from its stored result,
 * so a refresh / second tab replays the report instead of re-running the
 * (LLM-costed) analysis and overwriting the persisted run.
 */
function replayEvents(result: AnalysisResult): SSEEvent[] {
  const events: SSEEvent[] = []
  for (const agent of result.agents) {
    events.push({ type: 'agent_started', agentId: agent.id, operations: agent.operations })
    for (const path of agent.filesRead) events.push({ type: 'file_read', agentId: agent.id, path })
  }
  for (const finding of result.findings) {
    events.push(toWireEvent({ type: 'finding', agentId: finding.agentId, finding }))
  }
  for (const agent of result.agents) {
    events.push({
      type: 'agent_completed',
      agentId: agent.id,
      findingsCount: agent.findingsCount,
      durationMs: agent.durationMs,
    })
  }
  events.push({
    type: 'analysis_complete',
    totalFindings: result.summary.total,
    errors: result.summary.errors,
    warnings: result.summary.warnings,
    info: result.summary.info,
    durationMs: result.agents.reduce((sum, agent) => sum + agent.durationMs, 0),
  })
  return events
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

  // Status guard — a GET must not unconditionally (re-)run the analysis:
  // - 'complete': replay the stored result as SSE and close. Refresh, a second
  //   tab, or React StrictMode double-mount get the report without re-running
  //   the LLM-costed analysis or overwriting the persisted run (which would
  //   wipe user resolutions).
  // - 'running': 409. Attaching a second consumer to the in-flight generator
  //   would need a pub/sub layer; the conflict is the smaller correct change.
  //   Crucially this path never touches the running job's abort controller or
  //   status, so a concurrent open cannot corrupt cancel state.
  // - 'pending' starts the run; 'cancelled'/'error' restart it — that is the
  //   client's "Try again" path (those states have no stored result to protect).
  if (job.status === 'complete' && job.result) {
    const body = ': replay\n\n' + replayEvents(job.result).map(encodeSSE).join('')
    return new Response(body, { headers: SSE_HEADERS })
  }
  if (job.status === 'running') {
    return new Response('Analysis already in progress for this job.', {
      status: 409,
      headers: { 'Content-Type': 'text/plain; charset=utf-8' },
    })
  }
  // Claim the job synchronously so a concurrent GET sees 'running' and 409s
  // instead of starting a duplicate analysis.
  setJobStatus(id, 'running')

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
  // Server-side only: read the GitHub token from the JWT cookie (it is never on
  // the session object, which the browser can fetch via /api/auth/session).
  const accessToken = ai?.runGrounding && job.repo ? await getGitHubAccessToken() : undefined

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
      // (The job was already claimed as 'running' before the stream was built.)
      safeEnqueue(': open\n\n')

      try {
        // Code grounding: for a repo-connected, authenticated run with an LLM, read
        // handler files from the repo and let the worker check spec/code mismatches.
        // Best-effort — a GitHub failure degrades to spec-only analysis, never aborts.
        let grounding: GroundingRunner | undefined
        if (ai?.runGrounding && job.repo && accessToken) {
          try {
            const gh = createGitHubClient(accessToken)
            const { owner, repo, branch } = job.repo
            const listing = await gh.listSourceCandidates(owner, repo, branch)
            const read = listing.paths.length
              ? await gh.readFiles(owner, repo, listing.paths, branch)
              : { files: [], failed: 0 }
            const routeFiles = read.files
            if (routeFiles.length > 0) {
              // Operator evidence that grounding really ran (paths only, no content).
              // A truncated tree or failed reads mean the grounding view of the repo
              // is partial — say so rather than imply full coverage.
              const partial = [
                listing.truncated ? 'tree truncated' : '',
                read.failed > 0 ? `${read.failed} unreadable` : '',
              ]
                .filter(Boolean)
                .join(', ')
              console.info(
                `[mcp-doctor] job ${id}: grounding enabled — reading ${routeFiles.length} source file(s)${partial ? ` (partial: ${partial})` : ''} from ${owner}/${repo}@${branch}: ${routeFiles.map((f) => f.path).join(', ')}`,
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

  return new Response(stream, { headers: SSE_HEADERS })
}
