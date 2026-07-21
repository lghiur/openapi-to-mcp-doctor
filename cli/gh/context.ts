import { readFile } from 'node:fs/promises'
import { z } from 'zod'
import type { Behavior, PrContext } from './types'

/** Events that carry a pull_request payload we can act on. */
const PR_EVENT_NAMES = new Set(['pull_request', 'pull_request_target'])

const pullRequestEventSchema = z.object({
  action: z.string().optional(),
  pull_request: z.object({
    number: z.number().int(),
    merged: z.boolean().optional(),
    head: z.object({
      ref: z.string(),
      sha: z.string(),
      repo: z.object({ full_name: z.string() }),
    }),
    base: z.object({
      ref: z.string(),
      repo: z.object({ full_name: z.string() }),
    }),
  }),
})

/**
 * Parse a PR context from Actions env + the pull_request event payload.
 * Returns undefined for non-PR events or payloads that don't validate —
 * callers fall back to plain scan mode rather than erroring.
 */
export function parsePrContext(
  env: Record<string, string | undefined>,
  eventPayload: unknown,
): PrContext | undefined {
  const eventName = env.GITHUB_EVENT_NAME
  if (!eventName || !PR_EVENT_NAMES.has(eventName)) return undefined

  const [owner, repo] = (env.GITHUB_REPOSITORY ?? '').split('/')
  if (!owner || !repo) return undefined

  const parsed = pullRequestEventSchema.safeParse(eventPayload)
  if (!parsed.success) return undefined
  const { action, pull_request: pr } = parsed.data

  return {
    eventName,
    eventAction: action,
    owner,
    repo,
    prNumber: pr.number,
    headRef: pr.head.ref,
    headSha: pr.head.sha,
    baseRef: pr.base.ref,
    isFork: pr.head.repo.full_name !== pr.base.repo.full_name,
    merged: pr.merged,
  }
}

/** Read the event payload from GITHUB_EVENT_PATH and parse the PR context. */
export async function loadPrContext(
  env: Record<string, string | undefined> = process.env,
): Promise<PrContext | undefined> {
  const eventPath = env.GITHUB_EVENT_PATH
  if (!eventPath) return undefined
  let payload: unknown
  try {
    payload = JSON.parse(await readFile(eventPath, 'utf8'))
  } catch {
    return undefined
  }
  return parsePrContext(env, payload)
}

/**
 * Degrade the requested behavior to what the run can actually do.
 * Fork PRs get read-only tokens and no secrets, so anything above 'summary'
 * would fail at the API call — same when no token was provided at all.
 * Missing LLM creds do NOT downgrade: structural fixes still work.
 */
export function effectiveBehavior(
  requested: Behavior,
  opts: { isFork: boolean; hasToken: boolean },
): Behavior {
  if (opts.isFork || !opts.hasToken) return 'summary'
  return requested
}
