import type { AnalysisReport, ReportFinding } from '@/types/api'
import type {
  AgentRecord,
  AnalysisMode,
  Finding,
  MismatchMode,
  OpenApiVersion,
} from '@/types/domain'

export interface BuildReportParams {
  runId: string
  /** ISO 8601 timestamp (injected by the caller — keeps this function pure). */
  timestamp: string
  specFile: string
  version: OpenApiVersion
  operationCount: number
  mcpVersion: string
  mode: AnalysisMode
  mismatchMode: MismatchMode
  durationMs: number
  findings: Finding[]
  summary: { total: number; errors: number; warnings: number; info: number }
  /** Agent records (structural-linter + workers + orchestrator). Defaults to a single linter. */
  agents?: AgentRecord[]
}

/**
 * Assemble the stable JSON report (docs/research/ux-design.md) from a structural
 * run. Pure — `runId`/`timestamp` are injected so the engine takes no dependency
 * on the clock or a UUID source. In v1 there is exactly one agent (the linter)
 * and no auto-fixes.
 */
export function buildStructuralReport(params: BuildReportParams): AnalysisReport {
  return {
    runId: params.runId,
    timestamp: params.timestamp,
    spec: {
      file: params.specFile,
      version: params.version,
      operationCount: params.operationCount,
    },
    mcpSpecVersion: params.mcpVersion,
    mode: params.mode,
    mismatchMode: params.mismatchMode,
    durationMs: params.durationMs,
    summary: {
      total: params.summary.total,
      errors: params.summary.errors,
      warnings: params.summary.warnings,
      info: params.summary.info,
      autoFixed: 0,
    },
    agents: params.agents ?? [
      {
        id: 'structural-linter',
        type: 'structural-linter',
        operations: [],
        filesRead: [],
        findingsCount: params.findings.length,
        durationMs: params.durationMs,
      },
    ],
    findings: params.findings.map(toReportFinding),
  }
}

function toReportFinding(finding: Finding): ReportFinding {
  return {
    id: finding.id,
    agentId: finding.agentId,
    ...(finding.operation !== undefined ? { operation: finding.operation } : {}),
    ...(finding.operationId !== undefined ? { operationId: finding.operationId } : {}),
    rule: finding.rule,
    ...(finding.owasp !== undefined ? { owasp: finding.owasp } : {}),
    severity: finding.severity,
    confidence: finding.confidence,
    message: finding.message,
    ...(finding.before !== undefined ? { before: finding.before } : {}),
    ...(finding.after !== undefined ? { after: finding.after } : {}),
    autoFixed: finding.autoFixed,
    resolution: finding.resolution,
    ...(finding.path !== undefined ? { path: [...finding.path] } : {}),
  }
}
