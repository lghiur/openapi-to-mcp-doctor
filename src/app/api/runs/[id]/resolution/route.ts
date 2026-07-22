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

  // Ownership check (IDOR guard): only the run's owner may mutate it. A run
  // owned by someone else answers 404 — identical to "does not exist" — so
  // authenticated users cannot probe which run ids are valid. Sessions without
  // an email own nothing.
  const email = session.user?.email
  const store = getRunStore()
  const run = email ? store.getRunForUser(id, email) : null
  if (!run) return Response.json({ error: 'Run not found.' }, { status: 404 })

  store.updateResolution(id, findingId, resolution.data)
  return Response.json({ ok: true })
}
