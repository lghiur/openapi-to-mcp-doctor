import { z } from 'zod'
import { WORKER_RULES, normalizeRule } from '@/lib/engine/workers/rules'

/**
 * Zod schemas for LLM structured output. Validation happens at this boundary so
 * the rest of the engine receives typed, trusted data — never `any`.
 */

export const LlmSeveritySchema = z.enum(['error', 'warning', 'info'])
export const LlmConfidenceSchema = z.enum(['HIGH', 'MEDIUM', 'LOW'])

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
  findings: z.array(LlmFindingSchema),
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
  suggestions: z.array(SuggestionSchema),
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
  mismatches: z.array(MismatchSchema),
})

export type MismatchOutput = z.infer<typeof MismatchOutputSchema>
