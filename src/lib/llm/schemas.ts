import { z } from 'zod'
import { hasForbiddenPathSegment } from '@/lib/engine/fix/apply'
import { WORKER_RULES, normalizeRule } from '@/lib/engine/workers/rules'

/**
 * Zod schemas for LLM structured output. Validation happens at this boundary so
 * the rest of the engine receives typed, trusted data — never `any`.
 */

/**
 * Models drift on enum casing ("Warning", "high"). Like rule-name
 * normalization, casing is normalized forgivingly — one sloppy value must not
 * fail the whole worker batch. `z.toJSONSchema` still advertises the canonical
 * casing to the model.
 */
export const LlmSeveritySchema = z.preprocess(
  (value) => (typeof value === 'string' ? value.toLowerCase() : value),
  z.enum(['error', 'warning', 'info']),
)
export const LlmConfidenceSchema = z.preprocess(
  (value) => (typeof value === 'string' ? value.toUpperCase() : value),
  z.enum(['HIGH', 'MEDIUM', 'LOW']),
)

/**
 * A spec value the model was asked to return as a string. Models routinely
 * ignore the "encode non-strings as JSON" instruction and return raw objects
 * (e.g. a corrected schema), so coerce instead of rejecting the whole response.
 * `z.toJSONSchema` still advertises plain `string` to the model.
 */
const LenientStringSchema = z.preprocess(
  (value) => (typeof value === 'string' || value === undefined ? value : JSON.stringify(value)),
  z.string(),
)

/**
 * Location of a suggested change, relative to the operation object the agent was
 * shown (e.g. ["description"] or ["parameters", 0, "description"]). The engine
 * prefixes it with ["paths", <path>, <method>] to address the full document —
 * agents never need to know (or guess) where their operation sits in the spec.
 */
export const LlmPathSchema = z
  .array(z.union([z.string(), z.number()]))
  .describe(
    'Location of the field the suggestion applies to, relative to the operation object, ' +
      'as an array of keys/array-indexes. Example: ["parameters", 0, "description"]. ' +
      'Required for a suggestion to be appliable.',
  )

/**
 * Rule id pinned to the fixed worker taxonomy. Delta gating keys findings on
 * rule+operation+path, so free-text rule names that drift between runs make
 * every AI finding look new. `z.toJSONSchema` advertises the closed enum to the
 * model; parsing forgivingly normalizes any drifted name onto the taxonomy
 * (deterministically) instead of failing the whole worker batch over one
 * invented rule id.
 */
const WorkerRuleSchema = z.preprocess(
  (value) => (typeof value === 'string' ? normalizeRule(value) : value),
  z.enum(WORKER_RULES),
)

function isRecordValue(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Drop output entries whose `path` contains a forbidden segment (`__proto__`,
 * `constructor`, `prototype`). LLM-emitted paths are prompt-injectable via spec
 * descriptions, and downstream fix application walks them with bracket access —
 * so the pollution vector is closed here at the boundary too. Fail-soft, like
 * rule normalization: the poisoned entry is dropped (the count is the
 * difference between the raw and parsed array lengths), never the whole batch.
 */
function withoutUnsafePaths<Schema extends z.ZodType>(item: Schema) {
  return z.preprocess(
    (value) =>
      Array.isArray(value)
        ? value.filter(
            (entry) =>
              !(
                isRecordValue(entry) &&
                Array.isArray(entry.path) &&
                hasForbiddenPathSegment(entry.path)
              ),
          )
        : value,
    z.array(item),
  )
}

/** One finding produced by a worker agent for a single operation. */
export const LlmFindingSchema = z.object({
  operation: z.string(),
  rule: WorkerRuleSchema,
  severity: LlmSeveritySchema,
  confidence: LlmConfidenceSchema,
  message: z.string(),
  current: LenientStringSchema.optional(),
  suggested: LenientStringSchema.optional(),
  path: LlmPathSchema.optional(),
})

export type LlmFinding = z.infer<typeof LlmFindingSchema>

/** A worker agent's full output for its batch of operations. */
export const WorkerOutputSchema = z.object({
  findings: withoutUnsafePaths(LlmFindingSchema),
})

export type WorkerOutput = z.infer<typeof WorkerOutputSchema>

/** A near-duplicate pair flagged by the post-processing stage. */
export const NearDuplicateSchema = z.object({
  operations: z.array(z.string()).min(2),
  suggested: z.string(),
})

/** The post-processing stage output (cross-operation checks). */
export const PostProcessOutputSchema = z.object({
  nearDuplicates: z.array(NearDuplicateSchema),
})

export type PostProcessOutput = z.infer<typeof PostProcessOutputSchema>

/** One authored fix for a structural-linter finding, keyed by the finding's id. */
export const SuggestionSchema = z.object({
  findingId: z.string(),
  suggested: LenientStringSchema,
  path: LlmPathSchema.optional(),
})

/** The fix-suggester's output for one chunk of structural findings. */
export const SuggestionOutputSchema = z.object({
  suggestions: withoutUnsafePaths(SuggestionSchema),
})

export type SuggestionOutput = z.infer<typeof SuggestionOutputSchema>

/** A single spec/code mismatch detected by codebase grounding (v2). */
export const MismatchSchema = z.object({
  field: z.string(),
  specClaims: LenientStringSchema,
  codeDoes: LenientStringSchema,
  suggested: LenientStringSchema.optional(),
  path: LlmPathSchema.optional(),
})

export const MismatchOutputSchema = z.object({
  mismatches: withoutUnsafePaths(MismatchSchema),
})

export type MismatchOutput = z.infer<typeof MismatchOutputSchema>
