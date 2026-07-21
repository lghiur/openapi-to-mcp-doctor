import { createJob } from '@/lib/jobs/store'
import { AnalyzeRequestSchema } from '@/types/api'

/**
 * POST /api/analyze — validate the request, create a job, and return its id. The
 * client then opens the SSE stream at GET /api/jobs/[id]/stream. SSE from day one,
 * no polling (Architecture Decision 4).
 */
export async function POST(request: Request): Promise<Response> {
  let body: unknown
  try {
    body = await request.json()
  } catch {
    return Response.json({ error: 'Invalid JSON body.' }, { status: 400 })
  }

  const parsed = AnalyzeRequestSchema.safeParse(body)
  if (!parsed.success) {
    return Response.json({ error: 'Invalid analyze request.' }, { status: 400 })
  }

  const job = createJob({
    spec: parsed.data.spec,
    mode: parsed.data.mode,
    mismatchMode: parsed.data.mismatchMode,
    confidenceThreshold: parsed.data.confidenceThreshold,
    ...(parsed.data.selection ? { selection: parsed.data.selection } : {}),
  })

  return Response.json({ jobId: job.id })
}
