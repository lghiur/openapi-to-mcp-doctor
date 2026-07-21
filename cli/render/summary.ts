import type { AnalysisReport } from '@/types/api'

export type FailOn = 'error' | 'warning' | 'never'

/** Render the GitHub Actions Job Summary markdown (docs/research/ux-design.md). */
export function renderJobSummary(report: AnalysisReport): string {
  const durationSeconds = (report.durationMs / 1000).toFixed(1)

  const agentRows = report.agents
    .map(
      (agent) =>
        `| ${agent.id} | ${agent.operations.length || 'all'} | ${agent.findingsCount} | ${(agent.durationMs / 1000).toFixed(1)}s |`,
    )
    .join('\n')

  const topFindings = report.findings
    .slice(0, 10)
    .map(
      (finding) =>
        `| \`${finding.operation ?? '—'}\` | ${finding.rule} | ${finding.severity} | ${finding.confidence} |`,
    )
    .join('\n')

  return `## ⚕ MCP Doctor — Run Summary

|          |   |
| -------- | - |
| Spec     | \`${report.spec.file}\` (OpenAPI ${report.spec.version}) |
| Duration | ${durationSeconds}s |
| MCP spec | ${report.mcpSpecVersion} |

### Results

| Severity | Count |
| -------- | ----- |
| 🔴 Errors | ${report.summary.errors} |
| 🟡 Warnings | ${report.summary.warnings} |
| 🔵 Info | ${report.summary.info} |
| ✅ Auto-fixed | ${report.summary.autoFixed} |

### Agent Activity

| Agent | Operations | Findings | Duration |
| ----- | ---------- | -------- | -------- |
${agentRows}

### Top Findings

| Operation | Rule | Severity | Confidence |
| --------- | ---- | -------- | ---------- |
${topFindings}
`
}

/** Decide whether the CI step should fail, given the gate and severity counts. */
export function failOnGate(
  failOn: FailOn,
  summary: { errors: number; warnings: number; info: number },
): boolean {
  if (failOn === 'never') return false
  if (failOn === 'warning') return summary.errors + summary.warnings > 0
  return summary.errors > 0
}
