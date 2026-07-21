import type { LanguageModel } from 'ai'
import type { ZodType } from 'zod'
import { type OperationRef, operationBasePath } from '@/lib/engine/operations'
import { generateStructured } from '@/lib/llm/client'
import { type MismatchOutput, MismatchOutputSchema } from '@/lib/llm/schemas'
import type { Finding, OpenApiVersion } from '@/types/domain'

const MISMATCH_WARNING =
  'Confirm this is a code bug before accepting — the spec may be intentionally documenting desired behaviour.'

export type GenerateMismatch = (args: {
  schema: ZodType<MismatchOutput>
  prompt: string
  system?: string
  model: LanguageModel
  abortSignal?: AbortSignal
}) => Promise<MismatchOutput>

export interface DetectMismatchesInput {
  operation: OperationRef
  /** Handler source: the registration site plus the followed handler implementation. */
  handlerCode: string
  version: OpenApiVersion
}

export interface DetectMismatchesDeps {
  model: LanguageModel
  signal?: AbortSignal
  generate?: GenerateMismatch
  agentId?: string
}

/**
 * Detect spec/code mismatches for one operation by reading its handler code.
 * Mismatch findings are always LOW confidence and never auto-applied — the spec
 * may be documenting desired (not current) behaviour.
 */
export async function detectMismatches(
  input: DetectMismatchesInput,
  deps: DetectMismatchesDeps,
): Promise<Finding[]> {
  const generate = deps.generate ?? generateStructured
  const agentId = deps.agentId ?? 'worker'

  const output = await generate({
    schema: MismatchOutputSchema,
    system: buildSystemPrompt(input.version),
    prompt: buildPrompt(input),
    model: deps.model,
    ...(deps.signal ? { abortSignal: deps.signal } : {}),
  })

  const base = operationBasePath(input.operation)
  return output.mismatches.map((mismatch, index) => ({
    id: `${agentId}-mismatch-${index}-${input.operation.id}`,
    agentId,
    operation: input.operation.label,
    rule: 'SPEC_CODE_MISMATCH',
    severity: 'error',
    confidence: 'LOW',
    message: `${mismatch.field}: spec says "${mismatch.specClaims}", code does "${mismatch.codeDoes}".`,
    before: mismatch.specClaims,
    actual: mismatch.codeDoes,
    ...(mismatch.suggested !== undefined ? { after: mismatch.suggested } : {}),
    ...(mismatch.path !== undefined ? { path: [...base, ...mismatch.path] } : {}),
    warning: MISMATCH_WARNING,
    autoFixable: false,
    autoFixed: false,
    resolution: 'pending',
  }))
}

function buildSystemPrompt(version: OpenApiVersion): string {
  return [
    `You compare an OpenAPI ${version} operation against its handler implementation.`,
    `Report only genuine mismatches between what the spec documents and what the code does:`,
    `status codes, response shapes, required vs optional fields, and auth requirements.`,
    `The code is the source of truth. Do not invent mismatches. Return an empty list when`,
    `the spec and code agree. Behaviour that matches the spec by default or convention`,
    `(e.g. an implicit content type or status code that equals the documented one) is`,
    `agreement, not a mismatch.`,
    ``,
    `When the spec should be corrected to match the code, provide "suggested" — the exact`,
    `corrected value for the spec field — and "path": the location of that field relative`,
    `to the operation object, as an array of keys and array indexes, e.g.`,
    `["responses", "200", "description"]. Encode non-string values as JSON (e.g. "true").`,
    `Never use OpenAPI ${version === '3.1' ? '3.0' : '3.1'} syntax in a suggestion.`,
  ].join('\n')
}

function buildPrompt(input: DetectMismatchesInput): string {
  return [
    `Operation: ${input.operation.label}`,
    `Spec definition:`,
    '```json',
    JSON.stringify(input.operation.definition, null, 2),
    '```',
    `Handler code:`,
    '```',
    input.handlerCode,
    '```',
  ].join('\n')
}
