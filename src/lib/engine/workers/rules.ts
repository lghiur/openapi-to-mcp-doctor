/**
 * Fixed rule taxonomy for AI worker findings.
 *
 * The GitHub Action's delta gating keys findings on rule+operation+path, so the
 * rule id must be identical across runs for the same issue. LLMs free-text rule
 * names ("description-explains-when" one run, "mcp-description-missing-when" the
 * next), which made every AI finding look new or resolved on every run. The fix
 * has two ends:
 *
 *  1. The worker schema constrains `rule` to this closed set (and the JSON
 *     Schema embedded in the prompt advertises the allowed values to the model).
 *  2. `normalizeRule` forgivingly maps whatever the model actually emitted onto
 *     the taxonomy, so one weird rule name degrades to its nearest category
 *     instead of failing the whole worker batch.
 *
 * The taxonomy mirrors the worker prompt's check categories 1:1 (description
 * when-to-call, returns, name duplication, parameter actionability) plus the
 * structural-linter gap rules workers are asked to author content for. Rules
 * emitted by non-LLM code (Spectral ruleset ids, MCP_NEAR_DUPLICATE,
 * SPEC_CODE_*) are code-authored constants and are not routed through here.
 */

export const WORKER_RULES = [
  // Operation description quality
  'mcp-description-missing-when', // does not explain WHEN an agent should call the tool
  'mcp-description-unclear', // vague, too short, or missing context (generic fallback)
  'mcp-description-name-duplication', // merely restates the operation/tool name
  // Returns / responses
  'mcp-returns-undescribed', // what the tool returns is not explained in actionable terms
  'mcp-response-ambiguous', // response semantics are ambiguous or misleading
  'mcp-response-schema-required', // authored content for the linter's missing-schema gap
  // Parameters
  'mcp-parameter-description-missing',
  'mcp-parameter-description-unclear',
  'mcp-parameter-description-misleading',
  // Nested / enum content (authored for linter gaps)
  'mcp-enum-description-required',
  'mcp-nested-description-required',
] as const

export type WorkerRule = (typeof WORKER_RULES)[number]

const CANONICAL = new Set<string>(WORKER_RULES)

/**
 * Known drift variants seen in production (or trivially predictable), keyed by
 * their slug after case/underscore normalization and mcp- prefixing.
 */
const SYNONYMS: Readonly<Record<string, WorkerRule>> = {
  // when-to-call phrasings
  'mcp-description-explains-when': 'mcp-description-missing-when',
  'mcp-missing-when-to-call': 'mcp-description-missing-when',
  'mcp-description-when-missing': 'mcp-description-missing-when',
  // generic description-quality phrasings
  'mcp-description-too-short': 'mcp-description-unclear',
  'mcp-description-missing-context': 'mcp-description-unclear',
  'mcp-description-ambiguous': 'mcp-description-unclear',
  'mcp-description-missing': 'mcp-description-unclear',
  // name-duplication phrasings
  'mcp-description-is-just-path': 'mcp-description-name-duplication',
  'mcp-description-repeats-name': 'mcp-description-name-duplication',
  'mcp-name-duplication': 'mcp-description-name-duplication',
  // returns phrasings
  'mcp-returns-unclear': 'mcp-returns-undescribed',
  'mcp-returns-underdescribed': 'mcp-returns-undescribed',
  'mcp-returns-undocumented': 'mcp-returns-undescribed',
  // response phrasings
  'mcp-response-description-ambiguous': 'mcp-response-ambiguous',
  // parameter phrasings (includes the structural linter's gap rule id)
  'mcp-param-description-required': 'mcp-parameter-description-missing',
  'mcp-parameter-description-required': 'mcp-parameter-description-missing',
  'mcp-param-description-missing': 'mcp-parameter-description-missing',
  'mcp-parameter-description-ambiguous': 'mcp-parameter-description-unclear',
  'mcp-param-description-unclear': 'mcp-parameter-description-unclear',
  'mcp-param-description-misleading': 'mcp-parameter-description-misleading',
}

/**
 * Deterministically map a model-emitted rule name onto the fixed taxonomy.
 * Exact ids pass through; known synonyms map via the table; anything else maps
 * to the nearest category by keyword; the final fallback is
 * `mcp-description-unclear`.
 */
export function normalizeRule(raw: string): WorkerRule {
  const slug = raw.trim().toLowerCase().replace(/[\s_]+/g, '-')
  const prefixed = slug.startsWith('mcp-') ? slug : `mcp-${slug}`
  if (CANONICAL.has(prefixed)) return prefixed as WorkerRule
  const synonym = SYNONYMS[prefixed]
  if (synonym !== undefined) return synonym
  return nearestCategory(prefixed)
}

/** Keyword heuristic — check order is significant and must stay deterministic. */
function nearestCategory(rule: string): WorkerRule {
  if (rule.includes('enum')) return 'mcp-enum-description-required'
  if (rule.includes('param')) {
    if (rule.includes('misleading') || rule.includes('wrong') || rule.includes('incorrect')) {
      return 'mcp-parameter-description-misleading'
    }
    if (rule.includes('missing') || rule.includes('required') || rule.includes('absent')) {
      return 'mcp-parameter-description-missing'
    }
    return 'mcp-parameter-description-unclear'
  }
  if (rule.includes('nested')) return 'mcp-nested-description-required'
  if (rule.includes('return')) return 'mcp-returns-undescribed'
  if (rule.includes('response')) {
    if (rule.includes('schema')) return 'mcp-response-schema-required'
    return 'mcp-response-ambiguous'
  }
  if (rule.includes('when')) return 'mcp-description-missing-when'
  if (rule.includes('duplicat') || rule.includes('repeat') || rule.includes('redundant')) {
    return 'mcp-description-name-duplication'
  }
  return 'mcp-description-unclear'
}
