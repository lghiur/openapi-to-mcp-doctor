import { getOptionalSession } from '@/lib/auth'
import { getRunStore } from '@/lib/db'
import { ResolutionSchema } from '@/types/api'

interface RouteContext {
  params: Promise<{ id: string }>
}

/**
 * POST /api/runs/[id]/resolution — record a user's accept/reject/edit decision
 * on a persisted run's finding. This is the single sanctioned post-run mutation
 * on history records (append-only otherwise).
 */
export async function POST(request: Request, context: RouteContext): Promise<Response> {
  const session = await getOptionalSession()
  if (!session) return Response.json({ error: 'Not authenticated.' }, { status: 401 })

  const { id } = await context.params
  const body = (await request.json().catch(() => ({}))) as {
    findingId?: unknown
    resolution?: unknown
  }
  const findingId = typeof body.findingId === 'string' ? body.findingId : ''
  const resolution = ResolutionSchema.safeParse(body.resolution)
  if (!findingId || !resolution.success) {
    return Response.json({ error: 'Invalid resolution request.' }, { status: 400 })
  }

  const store = getRunStore()
  if (!store.getRun(id)) return Response.json({ error: 'Run not found.' }, { status: 404 })

  store.updateResolution(id, findingId, resolution.data)
  return Response.json({ ok: true })
}
