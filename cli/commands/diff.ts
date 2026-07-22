import { EXIT_CODES } from '@/lib/engine/constants'
import { listRuns } from '../history/store'
import type { CommandOutput } from './history'

function delta(current: number, previous: number): string {
  const change = current - previous
  return change > 0 ? `+${change}` : `${change}`
}

/** `mcp-doctor diff <id>` — compare a run to the previous run of the SAME spec. */
export async function renderDiff(baseDir: string, id: string): Promise<CommandOutput> {
  const runs = await listRuns(baseDir) // newest first
  const index = runs.findIndex((r) => r.id === id)
  const current = runs[index]
  if (index === -1 || !current) {
    return { stdout: `Run not found: ${id}`, exitCode: EXIT_CODES.INVALID_ARGS }
  }
  // Comparing across different spec files would produce a meaningless delta —
  // only an earlier run of the same spec is a valid baseline.
  const previous = runs.slice(index + 1).find((r) => r.specFile === current.specFile)
  if (!previous) {
    return { stdout: `No earlier run to compare ${id} against.`, exitCode: EXIT_CODES.OK }
  }

  const lines = [
    `Diff ${previous.id} → ${current.id}`,
    `Errors:   ${previous.summary.errors} → ${current.summary.errors} (${delta(current.summary.errors, previous.summary.errors)})`,
    `Warnings: ${previous.summary.warnings} → ${current.summary.warnings} (${delta(current.summary.warnings, previous.summary.warnings)})`,
    `Info:     ${previous.summary.info} → ${current.summary.info} (${delta(current.summary.info, previous.summary.info)})`,
  ]
  return { stdout: lines.join('\n'), exitCode: EXIT_CODES.OK }
}
