import { EXIT_CODES } from '@/lib/engine/constants'
import { listRuns } from '../history/store'
import type { CommandOutput } from './history'

function delta(current: number, previous: number): string {
  const change = current - previous
  return change > 0 ? `+${change}` : `${change}`
}

/** `mcp-doctor diff <id>` — compare a run to the chronologically previous one. */
export async function renderDiff(baseDir: string, id: string): Promise<CommandOutput> {
  const runs = await listRuns(baseDir) // newest first
  const index = runs.findIndex((r) => r.id === id)
  if (index === -1) {
    return { stdout: `Run not found: ${id}`, exitCode: EXIT_CODES.INVALID_ARGS }
  }
  const current = runs[index]
  const previous = runs[index + 1]
  if (!current) {
    return { stdout: `Run not found: ${id}`, exitCode: EXIT_CODES.INVALID_ARGS }
  }
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
