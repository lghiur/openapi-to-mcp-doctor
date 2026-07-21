import type { OperationRef } from '@/lib/engine/operations'
import type { StructuralGapsByOperation } from '@/lib/engine/workers/gaps'
import type { OpenApiVersion } from '@/types/domain'

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
