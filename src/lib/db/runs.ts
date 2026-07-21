import Database from 'better-sqlite3'
import type { AgentRecord, AnalysisRun, FindingRecord, Resolution } from '@/types/domain'

export interface RunStore {
  saveRun(run: AnalysisRun, userId?: string): void
  listRuns(userId?: string): AnalysisRun[]
  getRun(id: string): AnalysisRun | null
  updateResolution(runId: string, findingId: string, resolution: Resolution): void
  /** Record the fix PR opened for a run (the only other post-run mutation). */
  setPrInfo(runId: string, info: { prUrl: string; prBranch: string }): void
  close(): void
}

interface RunRow {
  id: string
  created_at: string
  user_id: string | null
  spec_source: string
  spec_file: string
  repo: string | null
  branch: string | null
  mode: string
  mismatch_mode: string
  duration_ms: number
  status: string
  total_findings: number
  errors: number
  warnings: number
  info: number
  accepted: number
  rejected: number
  auto_fixed: number
  pr_url: string | null
  pr_branch: string | null
  commit_sha: string | null
  agents_json: string
  findings_json: string
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS analysis_run (
  id TEXT PRIMARY KEY,
  created_at TEXT NOT NULL,
  user_id TEXT,
  spec_source TEXT NOT NULL,
  spec_file TEXT NOT NULL,
  repo TEXT,
  branch TEXT,
  mode TEXT NOT NULL,
  mismatch_mode TEXT NOT NULL,
  duration_ms INTEGER NOT NULL,
  status TEXT NOT NULL,
  total_findings INTEGER NOT NULL,
  errors INTEGER NOT NULL,
  warnings INTEGER NOT NULL,
  info INTEGER NOT NULL,
  accepted INTEGER NOT NULL,
  rejected INTEGER NOT NULL,
  auto_fixed INTEGER NOT NULL,
  pr_url TEXT,
  pr_branch TEXT,
  commit_sha TEXT,
  agents_json TEXT NOT NULL,
  findings_json TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_run_user_created ON analysis_run (user_id, created_at);
`

/** Open a SQLite-backed run store. Pass ':memory:' for tests. */
export function openRunStore(file: string): RunStore {
  const db = new Database(file)
  db.pragma('journal_mode = WAL')
  db.exec(SCHEMA)

  return {
    saveRun(run, userId) {
      db.prepare(
        `INSERT OR REPLACE INTO analysis_run (
          id, created_at, user_id, spec_source, spec_file, repo, branch, mode, mismatch_mode,
          duration_ms, status, total_findings, errors, warnings, info, accepted, rejected,
          auto_fixed, pr_url, pr_branch, commit_sha, agents_json, findings_json
        ) VALUES (
          @id, @created_at, @user_id, @spec_source, @spec_file, @repo, @branch, @mode, @mismatch_mode,
          @duration_ms, @status, @total_findings, @errors, @warnings, @info, @accepted, @rejected,
          @auto_fixed, @pr_url, @pr_branch, @commit_sha, @agents_json, @findings_json
        )`,
      ).run(toRow(run, userId))
    },

    listRuns(userId) {
      const rows = userId
        ? (db
            .prepare('SELECT * FROM analysis_run WHERE user_id = ? ORDER BY created_at DESC')
            .all(userId) as RunRow[])
        : (db.prepare('SELECT * FROM analysis_run ORDER BY created_at DESC').all() as RunRow[])
      return rows.map(fromRow)
    },

    getRun(id) {
      const row = db.prepare('SELECT * FROM analysis_run WHERE id = ?').get(id) as
        | RunRow
        | undefined
      return row ? fromRow(row) : null
    },

    updateResolution(runId, findingId, resolution) {
      const run = this.getRun(runId)
      if (!run) return
      const findings = run.findings.map((f) => (f.id === findingId ? { ...f, resolution } : f))
      const counts = countResolutions(findings)
      db.prepare(
        `UPDATE analysis_run
         SET findings_json = @findings_json, accepted = @accepted, rejected = @rejected, auto_fixed = @auto_fixed
         WHERE id = @id`,
      ).run({
        id: runId,
        findings_json: JSON.stringify(findings),
        accepted: counts.accepted,
        rejected: counts.rejected,
        auto_fixed: counts.autoFixed,
      })
    },

    setPrInfo(runId, info) {
      db.prepare('UPDATE analysis_run SET pr_url = @pr_url, pr_branch = @pr_branch WHERE id = @id').run({
        id: runId,
        pr_url: info.prUrl,
        pr_branch: info.prBranch,
      })
    },

    close() {
      db.close()
    },
  }
}

function toRow(run: AnalysisRun, userId?: string): RunRow {
  return {
    id: run.id,
    created_at: run.createdAt.toISOString(),
    user_id: userId ?? null,
    spec_source: run.specSource,
    spec_file: run.specFile,
    repo: run.repo ?? null,
    branch: run.branch ?? null,
    mode: run.mode,
    mismatch_mode: run.mismatchMode,
    duration_ms: run.durationMs,
    status: run.status,
    total_findings: run.summary.totalFindings,
    errors: run.summary.errors,
    warnings: run.summary.warnings,
    info: run.summary.info,
    accepted: run.summary.accepted,
    rejected: run.summary.rejected,
    auto_fixed: run.summary.autoFixed,
    pr_url: run.prUrl ?? null,
    pr_branch: run.prBranch ?? null,
    commit_sha: run.commitSha ?? null,
    agents_json: JSON.stringify(run.agents),
    findings_json: JSON.stringify(run.findings),
  }
}

function fromRow(row: RunRow): AnalysisRun {
  return {
    id: row.id,
    createdAt: new Date(row.created_at),
    specSource: row.spec_source as AnalysisRun['specSource'],
    specFile: row.spec_file,
    ...(row.repo !== null ? { repo: row.repo } : {}),
    ...(row.branch !== null ? { branch: row.branch } : {}),
    mode: row.mode as AnalysisRun['mode'],
    mismatchMode: row.mismatch_mode as AnalysisRun['mismatchMode'],
    durationMs: row.duration_ms,
    status: row.status as AnalysisRun['status'],
    summary: {
      totalFindings: row.total_findings,
      errors: row.errors,
      warnings: row.warnings,
      info: row.info,
      accepted: row.accepted,
      rejected: row.rejected,
      autoFixed: row.auto_fixed,
    },
    ...(row.pr_url !== null ? { prUrl: row.pr_url } : {}),
    ...(row.pr_branch !== null ? { prBranch: row.pr_branch } : {}),
    ...(row.commit_sha !== null ? { commitSha: row.commit_sha } : {}),
    agents: JSON.parse(row.agents_json) as AgentRecord[],
    findings: JSON.parse(row.findings_json) as FindingRecord[],
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
