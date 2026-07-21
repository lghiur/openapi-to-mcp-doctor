import type { ConfidenceThreshold, OpenApiVersion } from '@/types/domain'

/**
 * The MCP specification version this tool's rules target.
 *
 * Single source of truth — surfaced to the CLI (`--mcp-version`) and web Settings,
 * and injected into LLM worker prompts. This is a deliberate, reviewed value; see
 * CLAUDE.md and docs/research/mcp-spec.md before changing it.
 */
export const MCP_VERSION = '2025-11-25' as const

/** OpenAPI versions the engine analyzes. Swagger 2.0 is explicitly rejected. */
export const SUPPORTED_OPENAPI_VERSIONS: readonly OpenApiVersion[] = ['3.0', '3.1']

/**
 * CLI exit-code contract (docs/research/ux-design.md). These are machine contracts:
 * a breaking change to them is a major version bump.
 */
export const EXIT_CODES = {
  /** No errors found (warnings allowed), or fix mode applied all changes. */
  OK: 0,
  /** One or more ERROR-severity findings. */
  FINDINGS_ERROR: 1,
  /** Analysis failed (network error, spec unreadable, LLM unreachable). */
  ANALYSIS_FAILED: 2,
  /** Invalid arguments or configuration. */
  INVALID_ARGS: 3,
} as const

/**
 * Operation-count thresholds. Provenance, stated honestly in findings:
 * - 40 (warn): Cursor's hard 40-tool client limit.
 * - 80 (error): a heuristic upper bound, not a benchmarked client cliff.
 */
export const OPERATION_COUNT_WARN = 40
export const OPERATION_COUNT_ERROR = 80

/**
 * Max operationId length we lint to. This is the vendor LLM tool-API limit
 * (Anthropic 64 / OpenAI `^[a-zA-Z0-9_-]{1,64}$`), NOT an MCP-spec rule — MCP's own
 * ceiling is 128 per SEP-986. Attribute findings to "LLM tool-API compatibility."
 */
export const OPERATIONID_MAX_LENGTH = 64

/** MCP tool-name length the spec itself permits (SEP-986, SHOULD-level). */
export const MCP_TOOL_NAME_MAX_LENGTH = 128

/**
 * Operations per worker agent. Internal heuristic (3-5) for keeping a worker's
 * context focused — not an externally-sourced batch size. Tune empirically.
 */
export const DEFAULT_WORKER_BATCH_SIZE = 4

/** Default fix-mode confidence threshold: apply only HIGH-confidence fixes. */
export const DEFAULT_CONFIDENCE_THRESHOLD: ConfidenceThreshold = 'high'

/** CLI keeps the last N run-history records by default (`--history-limit`). */
export const DEFAULT_HISTORY_LIMIT = 100
