import { runStructuralAnalysis } from '@/lib/engine'
import { applyFixes } from '@/lib/engine/fix/apply'
import { verifyFixes } from '@/lib/engine/fix/verify'
import { getJob } from '@/lib/jobs/store'
import type { ConfidenceThreshold, Finding, OpenApiVersion } from '@/types/domain'

interface RouteContext {
  params: Promise<{ id: string }>
}

/**
 * POST /api/jobs/[id]/patch — apply accepted/eligible fixes to the job's spec and
 * return the patched document for download.
 *
 * Fixes are applied against the job's stored analysis result — the exact findings
 * (structural, AI worker, and grounding) whose ids the client reviewed. Falling
 * back to a structural re-run only when no stored result exists (e.g. the stream
 * has not completed); in that case only structural fixes are available.
 *
 * Gating semantics: the confidence threshold and mismatch mode gate *automatic*
 * application. When the client sends explicit `acceptedIds`, a human has reviewed
 * each finding — acceptance overrides both gates.
 */
export async function POST(request: Request, context: RouteContext): Promise<Response> {
  const { id } = await context.params
  const job = getJob(id)
  if (!job) {
    return new Response('Job not found.', {
      status: 404,
      headers: { 'Content-Type': 'text/plain; charset=utf-8' },
    })
  }

  const body = (await request.json().catch(() => ({}))) as {
    acceptedIds?: unknown
    threshold?: unknown
  }
  const acceptedIds = Array.isArray(body.acceptedIds)
    ? body.acceptedIds.filter((x): x is string => typeof x === 'string')
    : undefined
  const threshold: ConfidenceThreshold =
    body.threshold === 'low' || body.threshold === 'medium' || body.threshold === 'high'
      ? body.threshold
      : job.confidenceThreshold

  let findings: Finding[]
  let version: OpenApiVersion
  if (job.result && !job.result.halted && job.result.version !== null) {
    findings = job.result.findings
    version = job.result.version
  } else {
    const analysis = await runStructuralAnalysis(job.spec)
    if (analysis.version === null) {
      return Response.json({ error: 'Spec could not be analyzed.' }, { status: 400 })
    }
    findings = analysis.findings
    version = analysis.version
  }

  const selected = acceptedIds ? findings.filter((f) => acceptedIds.includes(f.id)) : findings
  const humanReviewed = acceptedIds !== undefined
  const result = applyFixes({
    spec: job.spec,
    findings: selected,
    threshold: humanReviewed ? 'low' : threshold,
    version,
    mismatchMode: humanReviewed ? 'fix' : job.mismatchMode,
  })

  // Re-lint the patched document before handing it out — a patch that produced
  // an invalid spec is rejected, never downloaded.
  const verification =
    result.applied.length > 0
      ? await verifyFixes({
          patched: result.patched,
          applied: result.applied,
          originalFindings: findings,
        })
      : null
  if (verification !== null && !verification.valid) {
    return Response.json(
      { error: 'Applied fixes produced an invalid OpenAPI document — patch rejected.' },
      { status: 422 },
    )
  }

  return new Response(result.patched, {
    headers: {
      'Content-Type': 'text/yaml; charset=utf-8',
      'Content-Disposition': 'attachment; filename="openapi.patched.yaml"',
      'X-Fixes-Applied': String(result.applied.length),
      'X-Fixes-Skipped': String(result.skipped.length),
      'X-Fixes-Verified': String(verification?.resolved.length ?? 0),
      'X-Fixes-Unresolved': String(verification?.unresolved.length ?? 0),
      'X-Fixes-Regressions': String(verification?.regressions.length ?? 0),
    },
  })
}
