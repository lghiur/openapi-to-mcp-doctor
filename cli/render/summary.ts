import type { AnalysisReport } from '@/types/api'
import type { Severity } from '@/types/domain'

export type FailOn = 'error' | 'warning' | 'never'

/**
 * One-line, pipe-safe, mention-safe markdown table cell for untrusted
 * spec/LLM-derived text. Deliberately replicated from `cli/gh/orchestrate.ts`
 * (`mdCell`) rather than imported — `cli/render/` stays dependency-light.
 */
function cell(value: string): string {
  return value
    .replace(/\r?\n/g, ' ')
    .replace(/\|/g, '\\|')
    .replace(/@(?=\w)/g, '@\u200b')
}

const SEVERITY_RANK: Record<Severity, number> = { error: 0, warning: 1, info: 2 }

/** Render the GitHub Actions Job Summary markdown (docs/research/ux-design.md). */
export function renderJobSummary(report: AnalysisReport): string {
  const durationSeconds = (report.durationMs / 1000).toFixed(1)

  const agentRows = report.agents
    .map(
      (agent) =>
        `| ${agent.id} | ${agent.operations.length || 'all'} | ${agent.findingsCount} | ${(agent.durationMs / 1000).toFixed(1)}s |`,
    )
    .join('\n')

  // Errors first (then warnings, then info) so severe findings never fall off
  // the top-10 slice; Array#sort is stable, so emission order holds per group.
  const topFindings = [...report.findings]
    .sort((a, b) => SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity])
    .slice(0, 10)
    .map(
      (finding) =>
        `| \`${cell(finding.operation ?? '—')}\` | ${cell(finding.rule)} | ${finding.severity} | ${finding.confidence} |`,
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
