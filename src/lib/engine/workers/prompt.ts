import type { OperationRef } from '@/lib/engine/operations'
import type { StructuralGapsByOperation } from '@/lib/engine/workers/gaps'
import type { WorkerRule } from '@/lib/engine/workers/rules'
import type { OpenApiVersion } from '@/types/domain'

/**
 * The allowed rule ids and what each covers, rendered into the system prompt.
 * Stable rule ids are what make delta gating work — the model must never
 * free-text its own. Keep in sync with WORKER_RULES (the Record key type
 * enforces exhaustiveness at compile time).
 */
const RULE_GUIDE: Record<WorkerRule, string> = {
  'mcp-description-missing-when':
    'the description does not explain WHEN an agent should call this tool',
  'mcp-description-unclear': 'the description is vague, too short, or missing key context',
  'mcp-description-name-duplication': 'the description merely restates the operation/tool name',
  'mcp-returns-undescribed': 'what the operation returns is not explained in actionable terms',
  'mcp-response-ambiguous': 'the response semantics are ambiguous or misleading',
  'mcp-response-schema-required': 'a 2xx response is missing a schema (author one)',
  'mcp-parameter-description-missing': 'a parameter has no description (author one)',
  'mcp-parameter-description-unclear': 'a parameter description is vague or ambiguous',
  'mcp-parameter-description-misleading':
    'a parameter description contradicts its name, type, or actual behaviour',
  'mcp-enum-description-required': 'enum values lack descriptions (author them)',
  'mcp-nested-description-required': 'a nested schema property lacks a description (author one)',
}

/**
 * System prompt for a worker agent. Includes the detected OpenAPI version and
 * explicitly forbids generating suggestions in the wrong version's syntax.
 */
export function buildWorkerSystemPrompt(version: OpenApiVersion): string {
  const wrongVersion = version === '3.1' ? '3.0' : '3.1'
  return [
    `You are an expert reviewer assessing how usable an OpenAPI ${version} operation is`,
    `as an MCP (Model Context Protocol) tool for LLM agents. For each operation, judge:`,
    `- Description quality: does it explain WHEN to call the tool, not only what it does?`,
    `- Returns: does it explain what the tool returns in actionable terms?`,
    `- Name duplication: does the description merely repeat the tool/operation name?`,
    `- Parameters: are descriptions actionable for an LLM constructing arguments?`,
    ``,
    `Set each finding's "rule" to ONLY these rule ids — never invent your own; pick the`,
    `closest match:`,
    ...Object.entries(RULE_GUIDE).map(([rule, meaning]) => `- ${rule} — ${meaning}`),
    ``,
    `Report only genuine problems. Use confidence MEDIUM for judgment calls, and HIGH`,
    `only when you can cite an unambiguous rule violation. This spec is OpenAPI ${version} —`,
    `never use OpenAPI ${wrongVersion} syntax in any suggestion. Key each finding to the exact`,
    `operation label provided (e.g. "GET /users/{id}").`,
    ``,
    `When you provide a "suggested" replacement, also provide "path": the location of the`,
    `field being changed, relative to the operation object you were shown, as an array of`,
    `keys and array indexes — e.g. ["description"] or ["parameters", 0, "description"].`,
    `The path must point into the structure you can actually see; only its final key may`,
    `be a field you are adding (e.g. a missing "description"). A suggestion without a`,
    `path cannot be applied automatically.`,
  ].join('\n')
}

/**
 * User prompt: the batch's operation definitions — and nothing else from the
 * spec — plus any structural-linter gaps for those operations, so the model can
 * author the missing content the deterministic linter could only detect.
 */
export function buildWorkerUserPrompt(
  batch: OperationRef[],
  gaps?: StructuralGapsByOperation,
): string {
  const sections = batch.map((operation) => {
    const section = `### ${operation.label}\n\`\`\`json\n${JSON.stringify(operation.definition, null, 2)}\n\`\`\``
    const operationGaps = gaps?.[operation.label]
    if (!operationGaps || operationGaps.length === 0) return section
    const lines = operationGaps.map(
      (gap) => `- ${gap.rule} at ${JSON.stringify(gap.path)}: ${gap.message}`,
    )
    return [
      section,
      `Known gaps flagged by the structural linter for this operation. For each one,`,
      `emit a finding that authors the missing content: set "suggested" to the exact`,
      `value to insert and "path" to the location given below.`,
      ...lines,
    ].join('\n')
  })
  return `Review the following ${batch.length} operation(s):\n\n${sections.join('\n\n')}`
}
