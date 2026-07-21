import type {
  AgentRecord,
  AnalysisMode,
  AnalysisRun,
  Finding,
  FindingRecord,
  MismatchMode,
  RunStatus,
  SpecSource,
} from '@/types/domain'

export interface BuildRunParams {
  id: string
  createdAt: Date
  specSource: SpecSource
  specFile: string
  repo?: string
  branch?: string
  mode: AnalysisMode
  mismatchMode: MismatchMode
  durationMs: number
  status?: RunStatus
  findings: Finding[]
  summary: { total: number; errors: number; warnings: number; info: number }
  agents: AgentRecord[]
  prUrl?: string
  prBranch?: string
  commitSha?: string
}

/**
 * Assemble a persisted `AnalysisRun` record from an analysis result. Append-only:
 * once written, only each `FindingRecord.resolution` is mutated (when a user
 * accepts/rejects in the web UI).
 */
export function buildAnalysisRun(params: BuildRunParams): AnalysisRun {
  const findingRecords = params.findings.map(toFindingRecord)
  const counts = countResolutions(findingRecords)

  return {
    id: params.id,
    createdAt: params.createdAt,
    specSource: params.specSource,
    specFile: params.specFile,
    ...(params.repo !== undefined ? { repo: params.repo } : {}),
    ...(params.branch !== undefined ? { branch: params.branch } : {}),
    mode: params.mode,
    mismatchMode: params.mismatchMode,
    durationMs: params.durationMs,
    status: params.status ?? 'complete',
    summary: {
      totalFindings: params.summary.total,
      errors: params.summary.errors,
      warnings: params.summary.warnings,
      info: params.summary.info,
      accepted: counts.accepted,
      rejected: counts.rejected,
      autoFixed: counts.autoFixed,
    },
    ...(params.prUrl !== undefined ? { prUrl: params.prUrl } : {}),
    ...(params.prBranch !== undefined ? { prBranch: params.prBranch } : {}),
    ...(params.commitSha !== undefined ? { commitSha: params.commitSha } : {}),
    agents: params.agents,
    findings: findingRecords,
  }
}

function toFindingRecord(finding: Finding): FindingRecord {
  return {
    id: finding.id,
    agentId: finding.agentId,
    operation: finding.operation ?? finding.operations?.join(', ') ?? '',
    rule: finding.rule,
    ...(finding.owasp !== undefined ? { owasp: finding.owasp } : {}),
    severity: finding.severity,
    confidence: finding.confidence,
    before: finding.before ?? '',
    after: finding.after ?? '',
    resolution: finding.resolution,
    autoFixed: finding.autoFixed,
  }
}

function countResolutions(records: FindingRecord[]): {
  accepted: number
  rejected: number
  autoFixed: number
} {
  let accepted = 0
  let rejected = 0
  let autoFixed = 0
  for (const record of records) {
    if (record.autoFixed || record.resolution === 'auto-fixed') autoFixed += 1
    if (record.resolution === 'accepted' || record.resolution === 'edited') accepted += 1
    if (record.resolution === 'rejected') rejected += 1
  }
  return { accepted, rejected, autoFixed }
}
