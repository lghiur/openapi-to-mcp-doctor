import { EXIT_CODES } from '@/lib/engine/constants'
import { getRun, listRuns } from '../history/store'

export interface CommandOutput {
  stdout: string
  exitCode: number
}

/** `mcp-doctor history` — list recorded runs, newest first. */
export async function renderHistoryList(baseDir: string): Promise<CommandOutput> {
  const runs = await listRuns(baseDir)
  if (runs.length === 0) {
    return { stdout: 'No analysis runs recorded yet.', exitCode: EXIT_CODES.OK }
  }
  const lines = runs.map((run) => {
    const { errors, warnings, info } = run.summary
    return `${run.id}  ${run.createdAt.toISOString()}  ${run.specFile}  ${errors}E/${warnings}W/${info}I`
  })
  return { stdout: lines.join('\n'), exitCode: EXIT_CODES.OK }
}

/** `mcp-doctor history <id>` (+ `--json`) — show one run's detail. */
export async function renderHistoryDetail(
  baseDir: string,
  id: string,
  options: { json?: boolean } = {},
): Promise<CommandOutput> {
  const run = await getRun(baseDir, id)
  if (!run) {
    return { stdout: `Run not found: ${id}`, exitCode: EXIT_CODES.INVALID_ARGS }
  }
  if (options.json) {
    return { stdout: JSON.stringify(run, null, 2), exitCode: EXIT_CODES.OK }
  }

  const { summary } = run
  const lines = [
    `Run ${run.id} — ${run.createdAt.toISOString()}`,
    `Spec: ${run.specFile} (mode ${run.mode})`,
    `Findings: ${summary.totalFindings} (${summary.errors} errors, ${summary.warnings} warnings, ${summary.info} info)`,
    `Auto-fixed: ${summary.autoFixed}   Accepted: ${summary.accepted}   Rejected: ${summary.rejected}`,
    '',
    'Findings:',
    // `operation` can be empty (document-level findings) — show a placeholder.
    ...run.findings.map((f) => `  [${f.severity}] ${f.rule}  ${f.operation || '—'}`),
  ]
  return { stdout: lines.join('\n'), exitCode: EXIT_CODES.OK }
}
