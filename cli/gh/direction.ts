import { SOURCE_EXCLUDE, SOURCE_PATTERN, SPEC_FILE_PATTERN } from '@/lib/github/source-patterns'
import type { DirectionResult } from './types'

/** Thrown when the changed-file listing cannot be computed (e.g. shallow clone). */
export class DirectionError extends Error {}

/** Strip a leading `./` so paths compare consistently regardless of origin. */
function normalize(path: string): string {
  return path.replace(/^\.\//, '')
}

/** Classify what a PR touched into the scan strategy to run. */
export function detectDirection(params: {
  changedFiles: string[]
  specPath: string
}): DirectionResult {
  const spec = normalize(params.specPath)
  const changedFiles = params.changedFiles.map(normalize)

  const specChanged = changedFiles.some((f) => f === spec || SPEC_FILE_PATTERN.test(f))
  const routesChanged = changedFiles.some((f) => SOURCE_PATTERN.test(f) && !SOURCE_EXCLUDE.test(f))

  const strategy = specChanged
    ? routesChanged
      ? 'full'
      : 'spec-verify'
    : routesChanged
      ? 'code-drift'
      : 'lint-only'

  return { specChanged, routesChanged, strategy, changedFiles }
}

/**
 * List files changed between the PR base and head via `git diff --name-only`.
 * Throws {@link DirectionError} on failure (typically a shallow clone missing
 * the base ref) so the integrator can fetch the base and retry — silently
 * returning [] would misclassify the PR as lint-only.
 */
export async function changedFilesViaGit(
  baseRef: string,
  headSha: string,
  exec: (cmd: string, args: string[]) => Promise<{ stdout: string; exitCode: number }>,
): Promise<string[]> {
  const range = `${baseRef}...${headSha}`
  const { stdout, exitCode } = await exec('git', ['diff', '--name-only', range])
  if (exitCode !== 0) {
    throw new DirectionError(
      `git diff --name-only ${range} exited with ${exitCode} — base ref may be missing (shallow clone); fetch it and retry`,
    )
  }
  return stdout
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
}
