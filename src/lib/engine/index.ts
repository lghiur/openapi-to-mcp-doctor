/**
 * Public surface of the framework-agnostic analysis engine. The CLI and web app
 * consume the engine only through these exports.
 */

export { MCP_VERSION } from '@/lib/engine/constants'
export { runStructuralAnalysis, type StructuralAnalysis } from '@/lib/engine/structural'
export { summarizeFindings, type StructuralSummary } from '@/lib/engine/summary'
export {
  runAnalysis,
  type AiCapability,
  type AnalysisResult,
  type GroundingResult,
  type GroundingRunner,
  type RunAnalysisOptions,
} from '@/lib/engine/analysis'
export { runGrounding, hashHandlerFiles, type RouteFile } from '@/lib/engine/grounding'
export { computeHealthScore, healthBadge, type HealthBadge, type HealthInput } from '@/lib/engine/health'
export { buildStructuralReport, type BuildReportParams } from '@/lib/engine/report'
export { countOperations, extractOperations, type OperationRef } from '@/lib/engine/operations'
export { filterFindings, filterOperations } from '@/lib/engine/selection'
export type { StructuralLintResult } from '@/lib/engine/linter/spectral'
