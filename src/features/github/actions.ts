'use server'

import { redirect } from 'next/navigation'
import { getGitHubAccessToken } from '@/lib/auth'
import { extractOperations } from '@/lib/engine'
import { createGitHubClient } from '@/lib/github/client'
import { buildPrBody, DEFAULT_PR_TITLE } from '@/lib/github/pr'
import { createJob } from '@/lib/jobs/store'
import { OperationSelectionSchema, type AnalysisReport } from '@/types/api'
import type { OperationSelection } from '@/types/domain'

/** A spec path and its HTTP methods (lowercase), for the operation picker. */
export interface SpecPathListing {
  path: string
  methods: string[]
}

export type ListSpecOperationsResult =
  | { ok: true; paths: SpecPathListing[] }
  | { ok: false; error: string }

/**
 * Read the spec from the repo and list its paths + methods so the user can pick
 * which operations to analyse before the job is created.
 */
export async function listSpecOperations(input: {
  repo: string
  branch: string
  path: string
}): Promise<ListSpecOperationsResult> {
  const token = await getGitHubAccessToken()
  if (!token) return { ok: false, error: 'Not authenticated.' }

  const [owner, repo] = input.repo.split('/')
  if (!owner || !repo || !input.path) return { ok: false, error: 'Invalid repository or path.' }

  let spec: string
  try {
    spec = await createGitHubClient(token).readFile(owner, repo, input.path, input.branch)
  } catch {
    return { ok: false, error: `Could not read ${input.path} from ${input.repo}@${input.branch}.` }
  }

  const operations = extractOperations(spec)
  if (operations.length === 0) {
    return { ok: false, error: 'No operations found — check the spec path points at an OpenAPI document.' }
  }

  const byPath = new Map<string, string[]>()
  for (const op of operations) {
    const methods = byPath.get(op.path) ?? []
    methods.push(op.method.toLowerCase())
    byPath.set(op.path, methods)
  }
  return { ok: true, paths: [...byPath].map(([path, methods]) => ({ path, methods })) }
}

/** Parse the picker's hidden `selection` field; absent/invalid means whole spec. */
function parseSelection(formData: FormData): OperationSelection | undefined {
  const raw = formData.get('selection')
  if (typeof raw !== 'string' || raw === '') return undefined
  try {
    const parsed = OperationSelectionSchema.safeParse(JSON.parse(raw))
    return parsed.success ? parsed.data : undefined
  } catch {
    return undefined
  }
}

/** Read a spec from a connected repo, create a job, and open its analysis view. */
export async function analyzeRepoSpec(formData: FormData): Promise<void> {
  const token = await getGitHubAccessToken()
  if (!token) redirect('/?next=dashboard')

  const fullName = String(formData.get('repo') ?? '')
  const branch = String(formData.get('branch') ?? 'main')
  const path = String(formData.get('path') ?? '')
  const [owner, repo] = fullName.split('/')
  if (!owner || !repo || !path) redirect('/dashboard')

  const mode = formData.get('mode') === 'fix' ? 'fix' : 'lint'
  const thresholdRaw = String(formData.get('confidenceThreshold') ?? 'high')
  const confidenceThreshold =
    thresholdRaw === 'medium' || thresholdRaw === 'low' ? thresholdRaw : 'high'
  const mismatchMode = formData.get('mismatchMode') === 'fix' ? 'fix' : 'flag'
  const selection = parseSelection(formData)

  const spec = await createGitHubClient(token).readFile(owner, repo, path, branch)
  // Carry the repo coordinates so the stream can read handler files for code
  // grounding (done there, where the session token is available and progress shows).
  const job = createJob({
    spec,
    mode,
    mismatchMode,
    confidenceThreshold,
    repo: { owner, repo, branch, path },
    ...(selection ? { selection } : {}),
  })
  redirect(`/analysis/${job.id}`)
}

export interface CreateFixPrInput {
  repo: string
  branch: string
  path: string
  patchedSpec: string
  report: AnalysisReport
}

/** Open a fix PR with the patched spec on a new branch. */
export async function createFixPr(
  input: CreateFixPrInput,
): Promise<{ url: string; number: number }> {
  const token = await getGitHubAccessToken()
  if (!token) throw new Error('Not authenticated.')

  const [owner, repo] = input.repo.split('/')
  if (!owner || !repo) throw new Error('Invalid repository.')

  const headBranch = `mcp-doctor/fix-${input.report.runId.slice(0, 8)}`
  return createGitHubClient(token).createFixPr({
    owner,
    repo,
    baseBranch: input.branch,
    headBranch,
    path: input.path,
    content: input.patchedSpec,
    commitMessage: DEFAULT_PR_TITLE,
    title: DEFAULT_PR_TITLE,
    body: buildPrBody(input.report),
  })
}
