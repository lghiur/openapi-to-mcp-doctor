/**
 * Shared shape checks for GitHub API errors.
 *
 * Octokit throws `RequestError` (an Error carrying `status`), but every module
 * here talks to a narrow structural interface so tests can pass plain fakes —
 * which throw plain Errors with a `status` property. These predicates therefore
 * duck-type on `status` rather than instanceof, and are the single place that
 * knows which HTTP statuses mean what.
 */

/** HTTP status carried by an Octokit/`fetch`-style error, when present. */
export function errorStatus(error: unknown): number | undefined {
  if (typeof error !== 'object' || error === null) return undefined
  const status = (error as { status?: unknown }).status
  return typeof status === 'number' ? status : undefined
}

/** Human-readable message for logs and reports; never contains credentials. */
export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** 404 — the resource genuinely does not exist (not "we were denied"). */
export function isNotFoundError(error: unknown): boolean {
  return errorStatus(error) === 404
}

/**
 * `git.createRef` rejecting because the ref is already there — the only case in
 * which falling back to a forced `updateRef` is correct. Anything else (401,
 * 403, 429, 5xx) must propagate: retrying as `updateRef` turns an auth or
 * rate-limit failure into a baffling "Reference does not exist".
 */
export function isRefAlreadyExistsError(error: unknown): boolean {
  return errorStatus(error) === 422 || /already exists/i.test(errorMessage(error))
}

/**
 * Denied or throttled: 401 (bad credentials), 403 (missing permission OR a
 * secondary rate limit — GitHub uses 403 for both) and 429 (primary rate
 * limit). Retrying the same call in a loop after one of these only deepens the
 * throttle, so callers must stop rather than continue.
 */
export function isAuthOrRateLimitError(error: unknown): boolean {
  const status = errorStatus(error)
  return status === 401 || status === 403 || status === 429
}
