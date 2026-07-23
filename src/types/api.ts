import { z } from 'zod'

/**
 * Zod schemas for boundary I/O: the analyze request (from the web client / CLI)
 * and the JSON report artifact (`--output report.json`, stable v1 contract).
 *
 * These are the only place runtime validation happens. The inferred types are
 * checked against the hand-written domain unions in `@/types/domain` via
 * `expectTypeOf` in the tests, so the two can't silently drift.
 */

export const SeveritySchema = z.enum(['error', 'warning', 'info'])

export const ConfidenceSchema = z.enum(['HIGH', 'MEDIUM', 'LOW'])

export const ResolutionSchema = z.enum(['accepted', 'rejected', 'edited', 'auto-fixed', 'pending'])

export const AnalysisModeSchema = z.enum(['lint', 'fix'])

export const MismatchModeSchema = z.enum(['flag', 'fix'])

export const ConfidenceThresholdSchema = z.enum(['high', 'medium', 'low'])

export const AgentTypeSchema = z.enum(['structural-linter', 'worker', 'orchestrator'])

// ----------------------------------------------------------------------------
// Analyze request — POST /api/analyze body / CLI scan options
// ----------------------------------------------------------------------------

export const PathSelectionSchema = z.object({
  path: z.string().min(1),
  /** Lowercase HTTP methods selected under the path; at least one. */
  methods: z.array(z.string().min(1)).min(1),
})

/** Subset of paths/methods to analyse. Omitted = the whole spec. */
export const OperationSelectionSchema = z.array(PathSelectionSchema).min(1)

export const AnalyzeRequestSchema = z.object({
  /** The raw OpenAPI document (YAML or JSON text). */
  spec: z.string().min(1, 'spec must not be empty'),
  mode: AnalysisModeSchema.default('lint'),
  mismatchMode: MismatchModeSchema.default('flag'),
  confidenceThreshold: ConfidenceThresholdSchema.default('high'),
  /** Optional MCP spec version override; defaults to MCP_VERSION when omitted. */
  mcpVersion: z.string().optional(),
  selection: OperationSelectionSchema.optional(),
})

export type AnalyzeRequest = z.infer<typeof AnalyzeRequestSchema>

// ----------------------------------------------------------------------------
// Resolution request — POST /api/runs/[id]/resolution body
// ----------------------------------------------------------------------------

export const ResolutionUpdateSchema = z.object({
  findingId: z.string().min(1),
  resolution: ResolutionSchema,
})

/**
 * Accepts either a single decision (`{ findingId, resolution }`) or a batch
 * (`{ updates: [...] }`) and normalises both to an array, so bulk "accept all"
 * costs one request while the single-item shape keeps working.
 */
export const ResolutionRequestSchema = z.union([
  ResolutionUpdateSchema.transform((update) => [update]),
  z.object({ updates: z.array(ResolutionUpdateSchema).min(1) }).transform((body) => body.updates),
])

// ----------------------------------------------------------------------------
// JSON report — docs/research/ux-design.md. Stable from v1: adding fields is
// non-breaking; removing/renaming is a major version bump.
// ----------------------------------------------------------------------------

export const ReportFindingSchema = z.object({
  id: z.string(),
  agentId: z.string(),
  operation: z.string().optional(),
  operationId: z.string().optional(),
  rule: z.string(),
  /** OWASP MCP Top 10 id (e.g. 'MCP03') for security findings; absent otherwise. */
  owasp: z.string().optional(),
  severity: SeveritySchema,
  confidence: ConfidenceSchema,
  message: z.string(),
  before: z.string().optional(),
  after: z.string().optional(),
  autoFixed: z.boolean(),
  resolution: ResolutionSchema,
  path: z.array(z.union([z.string(), z.number()])).optional(),
})

export const ReportAgentSchema = z.object({
  id: z.string(),
  type: AgentTypeSchema,
  operations: z.array(z.string()),
  filesRead: z.array(z.string()),
  findingsCount: z.number(),
  durationMs: z.number(),
})

export const AnalysisReportSchema = z.object({
  runId: z.string(),
  /** ISO 8601 timestamp. */
  timestamp: z.string(),
  spec: z.object({
    file: z.string(),
    version: z.string(),
    operationCount: z.number(),
  }),
  mcpSpecVersion: z.string(),
  mode: AnalysisModeSchema,
  mismatchMode: MismatchModeSchema,
  durationMs: z.number(),
  summary: z.object({
    total: z.number(),
    errors: z.number(),
    warnings: z.number(),
    info: z.number(),
    autoFixed: z.number(),
  }),
  agents: z.array(ReportAgentSchema),
  findings: z.array(ReportFindingSchema),
})

export type AnalysisReport = z.infer<typeof AnalysisReportSchema>
export type ReportFinding = z.infer<typeof ReportFindingSchema>
export type ReportAgent = z.infer<typeof ReportAgentSchema>
