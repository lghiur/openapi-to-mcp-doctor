import { randomUUID } from 'node:crypto'
import { buildStructuralReport, countOperations, MCP_VERSION, runStructuralAnalysis } from '@/lib/engine'
import { applyFixes } from '@/lib/engine/fix/apply'
import { getOptionalSession } from '@/lib/auth'
import { getRunStore } from '@/lib/db'
import { createGitHubClient } from '@/lib/github/client'
import { buildPrBody, DEFAULT_PR_TITLE } from '@/lib/github/pr'
import { getJob } from '@/lib/jobs/store'
import type { Finding, OpenApiVersion } from '@/types/domain'

/**
 * POST /api/github/pr — commit the patched spec for a repo-sourced job on a new
 * branch and open a fix PR. Requires an authenticated session (the GitHub token
 * never reaches the client) and at least one accepted finding: PR creation is a
 * human-reviewed action, so acceptance overrides the confidence/mismatch gates,
 * exactly like the patch download route.
 */
export async function POST(request: Request): Promise<Response> {
  const session = await getOptionalSession()
  const token = session?.accessToken
  if (!token) return Response.json({ error: 'Not authenticated.' }, { status: 401 })

  const body = (await request.json().catch(() => ({}))) as {
    jobId?: unknown
    acceptedIds?: unknown
  }
  const jobId = typeof body.jobId === 'string' ? body.jobId : ''
  const acceptedIds = Array.isArray(body.acceptedIds)
    ? body.acceptedIds.filter((x): x is string => typeof x === 'string')
    : []

  const job = getJob(jobId)
  if (!job) return Response.json({ error: 'Job not found.' }, { status: 404 })
  if (!job.repo) {
    return Response.json(
      { error: 'This analysis is not connected to a repository.' },
      { status: 400 },
    )
  }
  if (acceptedIds.length === 0) {
    return Response.json({ error: 'Accept at least one suggestion first.' }, { status: 400 })
  }

  // Same finding source as the patch route: the stored result (structural + AI +
  // grounding findings the user reviewed), falling back to a structural re-run.
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

  const accepted = findings.filter((f) => acceptedIds.includes(f.id))
  const result = applyFixes({
    spec: job.spec,
    findings: accepted,
    threshold: 'low',
    version,
    mismatchMode: 'fix',
  })
  if (result.applied.length === 0) {
    return Response.json({ error: 'None of the accepted findings had an applicable fix.' }, {
      status: 400,
    })
  }

  const appliedIds = new Set(result.applied.map((f) => f.id))
  const report = buildStructuralReport({
    runId: jobId || randomUUID(),
    timestamp: new Date().toISOString(),
    specFile: job.repo.path,
    version,
    operationCount: countOperations(job.spec),
    mcpVersion: MCP_VERSION,
    mode: job.mode,
    mismatchMode: job.mismatchMode,
    durationMs: 0,
    findings: findings.map((f) =>
      appliedIds.has(f.id) ? { ...f, resolution: 'accepted' as const } : f,
    ),
    summary: job.result?.summary ?? { total: findings.length, errors: 0, warnings: 0, info: 0 },
    ...(job.result ? { agents: job.result.agents } : {}),
  })

  const { owner, repo, branch, path } = job.repo
  const headBranch = `mcp-doctor/fix-${jobId.slice(0, 8)}`
  try {
    const pr = await createGitHubClient(token).createFixPr({
      owner,
      repo,
      baseBranch: branch,
      headBranch,
      path,
      content: result.patched,
      commitMessage: DEFAULT_PR_TITLE,
      title: DEFAULT_PR_TITLE,
      body: buildPrBody(report),
    })
    // Best-effort: link the PR on the persisted history record (if this run was
    // saved — anonymous/unpersisted jobs simply have no record to update).
    try {
      getRunStore().setPrInfo(jobId, { prUrl: pr.url, prBranch: headBranch })
    } catch {
      // history is advisory; never fail a created PR over it
    }
    return Response.json(pr)
  } catch (cause) {
    // Octokit errors are safe to surface (no credentials in messages); the branch
    // may already exist from a previous attempt on the same job.
    const message = cause instanceof Error ? cause.message : 'Could not create the PR.'
    return Response.json({ error: message }, { status: 502 })
  }
}
