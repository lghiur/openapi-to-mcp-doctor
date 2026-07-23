/**
 * Core domain types shared by the engine, CLI, and web app.
 *
 * These are framework-agnostic and dependency-free (no Zod, no React). The Zod
 * validation schemas for boundary I/O live in `@/types/api` and are kept in sync
 * with these unions via `expectTypeOf` checks in the tests.
 */

export type Severity = 'error' | 'warning' | 'info'

export type Confidence = 'HIGH' | 'MEDIUM' | 'LOW'

/** Detected OpenAPI document version. Swagger 2.0 is rejected before this point. */
export type OpenApiVersion = '3.0' | '3.1'

export type AnalysisMode = 'lint' | 'fix'

export type MismatchMode = 'flag' | 'fix'

/** Fix-mode confidence gate (CLI `--confidence-threshold`, web fix selector). */
export type ConfidenceThreshold = 'high' | 'medium' | 'low'

export type SpecSource = 'github' | 'paste'

export type Resolution = 'accepted' | 'rejected' | 'edited' | 'auto-fixed' | 'pending'

export type RunStatus = 'running' | 'complete' | 'error'

export type AgentType = 'structural-linter' | 'worker' | 'orchestrator'

/** Version-detection halt codes (analysis cannot proceed). */
export type VersionDetectionError = 'SWAGGER_20_NOT_SUPPORTED' | 'OAS_VERSION_UNDETECTABLE'

/** A JSON path to a node in the spec, e.g. ['paths', '/users/{id}', 'get', 'operationId']. */
export type SpecPath = ReadonlyArray<string | number>

/** One selected spec path and the HTTP methods (lowercase) chosen under it. */
export interface PathSelection {
  path: string
  methods: string[]
}

/**
 * User-chosen subset of operations to analyse and fix. Absent means the whole
 * spec. Document-level findings (version, operation count) are always kept;
 * findings anchored under an unselected path/method are dropped.
 */
export type OperationSelection = PathSelection[]

/**
 * A single analysis result. Superset shape used by the engine and the JSON report.
 * `operations` (plural) is set for cross-operation findings (e.g. near-duplicates);
 * `operation` (singular) for per-operation findings. `actual`/`warning` are used by
 * v2 spec/code mismatch findings.
 */
export interface Finding {
  id: string
  agentId: string
  operation?: string
  operations?: string[]
  operationId?: string
  rule: string
  /**
   * OWASP MCP Top 10 identifier (e.g. 'MCP03') when this finding comes from the
   * security ruleset. Absent for quality/structural/conversion findings. Set by the
   * normalizer from OWASP_RULE_MAP; lets every surface badge it as "OWASP MCP03".
   */
  owasp?: string
  severity: Severity
  confidence: Confidence
  message: string
  /** Existing spec content at the finding location. */
  before?: string
  /** Suggested replacement content. */
  after?: string
  /** v2: what the handler code actually does (spec/code mismatch). */
  actual?: string
  /** Prominent caveat shown for LOW-confidence findings before acceptance. */
  warning?: string
  path?: SpecPath
  autoFixable: boolean
  autoFixed: boolean
  resolution: Resolution
}

// ----------------------------------------------------------------------------
// Run history (persisted; see docs/ideas/openapi-mcp-doctor.md "Run History")
// ----------------------------------------------------------------------------

export interface AnalysisRunSummary {
  totalFindings: number
  errors: number
  warnings: number
  info: number
  /** User-accepted suggestions. */
  accepted: number
  rejected: number
  /** HIGH-confidence fixes applied automatically. */
  autoFixed: number
}

export interface AnalysisRun {
  id: string
  createdAt: Date
  specSource: SpecSource
  /** Path within repo, or "paste" for paste mode. */
  specFile: string
  repo?: string
  branch?: string
  mode: AnalysisMode
  mismatchMode: MismatchMode
  durationMs: number
  status: RunStatus
  summary: AnalysisRunSummary
  prUrl?: string
  prBranch?: string
  commitSha?: string
  agents: AgentRecord[]
  findings: FindingRecord[]
}

export interface AgentRecord {
  id: string
  type: AgentType
  /** Operation IDs this agent handled. */
  operations: string[]
  /** Handler files read (v2+, empty in v1). */
  filesRead: string[]
  findingsCount: number
  durationMs: number
}

export interface FindingRecord {
  id: string
  agentId: string
  operation: string
  rule: string
  /** OWASP MCP Top 10 id (e.g. 'MCP03') for security findings; absent otherwise. */
  owasp?: string
  severity: Severity
  confidence: Confidence
  /** Exact spec content before change. */
  before: string
  /** Suggested replacement. */
  after: string
  resolution: Resolution
  /** If edited: the actual content the user wrote. */
  resolvedContent?: string
  autoFixed: boolean
}

// ----------------------------------------------------------------------------
// SSE event stream (backend -> client). Authoritative schema:
// docs/research/agentic-architecture.md. Serialized at the HTTP boundary as
// `event: <type>` + `data: <json>`; represented internally as this union.
// ----------------------------------------------------------------------------

/** The finding payload as streamed over SSE (wire field names differ from `Finding`). */
export interface SSEFinding {
  /** Stable finding id (lets the client track accept/reject and apply fixes). */
  id: string
  agentId: string
  operation?: string
  operations?: string[]
  rule: string
  /** OWASP MCP Top 10 id (e.g. 'MCP03') for security-ruleset findings. */
  owasp?: string
  severity: Severity
  confidence: Confidence
  message: string
  /** Existing spec content (maps to `Finding.before`). */
  current?: string
  /** Suggested replacement (maps to `Finding.after`). */
  suggested?: string
  /** v2 mismatch: what the code actually does. */
  actual?: string
  warning?: string
  /** JSON path to the offending node (enables client-side fix application). */
  path?: ReadonlyArray<string | number>
  autoFixable: boolean
}

/** The ordered pipeline stages an analysis run may go through. */
export type AnalysisPhase = 'structural' | 'workers' | 'postprocess' | 'grounding'

/** Why a grounding agent read a file: the route registration site, or the handler implementation it followed a symbol into. */
export type FileReadRole = 'registration' | 'handler'

export type SSEEvent =
  | { type: 'analysis_started'; operations: string[]; phases: AnalysisPhase[] }
  | { type: 'agent_started'; agentId: string; operations: string[] }
  | {
      type: 'file_read'
      agentId: string
      path: string
      operation?: string
      linesRead?: number
      /** Line where the route match / symbol definition was found. */
      line?: number
      role?: FileReadRole
      /** Handler symbol that led the agent to this file. */
      symbol?: string
    }
  | ({ type: 'finding' } & SSEFinding)
  | {
      type: 'agent_completed'
      agentId: string
      findingsCount: number
      durationMs: number
      /** Set when the agent failed — its zero findings mean "errored", not "clean". */
      error?: string
    }
  | { type: 'postprocess_started'; check: string; operationCount?: number }
  | {
      type: 'analysis_complete'
      totalFindings: number
      errors: number
      warnings: number
      info: number
      durationMs: number
    }
  /**
   * A caveat about this run that the user must see — e.g. GitHub truncated the
   * repository tree, so code grounding only saw part of the codebase. Emitted
   * by the stream route, never by the engine, so it has no `EngineEvent` twin.
   */
  | { type: 'notice'; level: 'warning'; message: string }

/**
 * Internal streaming event used by the engine (orchestrator, runAnalysis). Unlike
 * the wire `SSEEvent`, the `finding` variant carries the full `Finding` object so
 * the engine can accumulate results; the HTTP boundary maps these to `SSEEvent`.
 */
export type EngineEvent =
  | { type: 'analysis_started'; operations: string[]; phases: AnalysisPhase[] }
  | { type: 'agent_started'; agentId: string; operations: string[] }
  | {
      type: 'file_read'
      agentId: string
      path: string
      operation?: string
      linesRead?: number
      line?: number
      role?: FileReadRole
      symbol?: string
    }
  | { type: 'finding'; agentId: string; finding: Finding }
  | {
      type: 'agent_completed'
      agentId: string
      findingsCount: number
      durationMs: number
      /** Set when the agent failed — its zero findings mean "errored", not "clean". */
      error?: string
    }
  | { type: 'postprocess_started'; check: string; operationCount?: number }
  | {
      type: 'analysis_complete'
      totalFindings: number
      errors: number
      warnings: number
      info: number
      durationMs: number
    }
