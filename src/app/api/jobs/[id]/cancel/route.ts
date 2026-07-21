import { cancelJob } from '@/lib/jobs/store'

interface RouteContext {
  params: Promise<{ id: string }>
}

/**
 * POST /api/jobs/[id]/cancel — stop an in-flight analysis. Aborts the running
 * stream (via the job's AbortController) and marks the job cancelled. Idempotent.
 */
export async function POST(_request: Request, context: RouteContext): Promise<Response> {
  const { id } = await context.params
  if (!cancelJob(id)) {
    return Response.json({ error: 'Job not found.' }, { status: 404 })
  }
  return Response.json({ cancelled: true })
}
