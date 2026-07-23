import spectralCore, { type RulesetDefinition } from '@stoplight/spectral-core'
import spectralParsers from '@stoplight/spectral-parsers'
import { Resolver } from '@stoplight/spectral-ref-resolver'
import spectralRulesets from '@stoplight/spectral-rulesets'
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml'

// CJS packages — default-import + destructure for native-ESM compatibility.
const { Document, Spectral } = spectralCore
const { Yaml } = spectralParsers
const { oas } = spectralRulesets

/**
 * Resolve INTERNAL refs (`#/components/…`) but never fetch REMOTE ones
 * (`http(s):`/`file:`). Two reasons:
 *
 *  1. Hang: Spectral's default resolver fetches and inlines remote $refs. On specs
 *     that point at large external schemas (Tyk's references a 35KB schema 11×),
 *     resolving + validating the inlined tree blocks the Node event loop
 *     synchronously for minutes — freezing the whole server.
 *  2. Security: auto-fetching whatever URL appears in a pasted/untrusted spec is an
 *     SSRF vector (e.g. `$ref: http://169.254.169.254/…`).
 *
 * `dereferenceInline: true` keeps multi-part specs that use internal $refs fully
 * working; `dereferenceRemote: false` leaves remote refs in place as `{ $ref }`
 * (not null), so rules see a harmless node instead of crashing.
 */
const localOnlyResolver = new Resolver({ dereferenceInline: true, dereferenceRemote: false })
import { detectVersion, type VersionDetectionResult } from '@/lib/engine/linter/version'
import { OWASP_RULE_MAP } from '@/lib/engine/linter/rulesets/owasp-meta'
import type { Finding, OpenApiVersion, Severity } from '@/types/domain'

const STRUCTURAL_AGENT_ID = 'structural-linter'

const HTTP_METHODS = new Set(['get', 'put', 'post', 'delete', 'options', 'head', 'patch', 'trace'])

/**
 * The subset of a Spectral diagnostic the normalizer needs. Real Spectral
 * results carry more (range, source), but decoupling keeps the normalizer pure
 * and trivially unit-testable.
 */
export interface SpectralResultLike {
  code: string | number
  message: string
  path: ReadonlyArray<string | number>
  /** Spectral DiagnosticSeverity: 0=error, 1=warning, 2=information, 3=hint. */
  severity: number
}

export interface StructuralLintResult {
  /** Detected OpenAPI version, or null when analysis halted on a version error. */
  version: OpenApiVersion | null
  findings: Finding[]
  /** True when a version error stopped analysis before any ruleset ran. */
  halted: boolean
}

/**
 * Run the deterministic structural linter: detect the version, then run the
 * given Spectral ruleset (the built-in `oas` ruleset by default; Task 6 passes a
 * combined oas+MCP ruleset). Halts before linting on an unsupported/undetectable
 * version. Zero LLM calls.
 */
export async function runStructuralLint(
  spec: string,
  ruleset: RulesetDefinition = oas as RulesetDefinition,
): Promise<StructuralLintResult> {
  const detected = detectVersion(spec)
  if (!detected.ok) {
    return { version: null, halted: true, findings: [versionErrorToFinding(detected)] }
  }

  const spectral = new Spectral({ resolver: localOnlyResolver })
  spectral.setRuleset(ruleset)
  const results = await spectral.run(new Document(sanitizeNullsInYaml(spec), Yaml))

  return { version: detected.version, halted: false, findings: normalizeSpectralResults(results) }
}

/**
 * Replace every `null` value (object property OR array element) with an empty
 * string, recursively, and cut any reference cycle the same way.
 *
 * Why nulls: nimma — the JSONPath engine Spectral and its built-in `oas` ruleset
 * use — throws `Cannot read properties of null (reading 'enum')` when a recursive
 * `$..[?(@.x)]` filter descends into a literal `null` node. Real specs are full of
 * nulls (Tyk's has dozens, e.g. `Locality: null`), so a single one would otherwise
 * abort the entire structural run.
 *
 * Why cycles: YAML anchors may reference an ancestor (`Node: &n {child: *n}`),
 * which the parser faithfully turns into a cyclic object graph. Walking it —
 * here, in the ruleset walks, or in nimma's traversal — never terminates. Cutting
 * a back-edge yields a finite document that still lints; only the infinitely deep
 * expansion is lost, which no rule could have inspected anyway.
 *
 * The replacement is an empty string in both cases: inert (it matches no schema,
 * enum, or properties rule) while preserving array indices and object keys, so
 * the paths in our findings stay accurate.
 */
export function sanitizeNulls(value: unknown): unknown {
  return sanitize(value, new Set<object>())
}

/** `ancestors` holds the nodes on the current path — membership means a cycle. */
function sanitize(value: unknown, ancestors: Set<object>): unknown {
  if (value === null) return ''
  if (typeof value !== 'object') return value
  if (ancestors.has(value)) return ''

  ancestors.add(value)
  try {
    if (Array.isArray(value)) return value.map((item) => sanitize(item, ancestors))
    const out: Record<string, unknown> = {}
    for (const [key, val] of Object.entries(value as Record<string, unknown>)) {
      // Plain assignment would treat a literal `__proto__` key (legal in YAML and
      // JSON) as a prototype write: the key vanishes from the output and the
      // node inherits the value's members, inventing findings that aren't there.
      Object.defineProperty(out, key, {
        value: sanitize(val, ancestors),
        enumerable: true,
        writable: true,
        configurable: true,
      })
    }
    return out
  } finally {
    // Siblings are not ancestors: a node shared by two branches must expand in
    // both. Only a node still on the current path is a cycle.
    ancestors.delete(value)
  }
}

/**
 * Parse YAML, strip nulls, re-serialise. Falls back to the original text if the
 * spec can't be parsed here (the caller has already confirmed the version, so this
 * is only a guard against an unexpected parser disagreement).
 */
function sanitizeNullsInYaml(spec: string): string {
  try {
    return stringifyYaml(sanitizeNulls(parseYaml(spec)))
  } catch {
    return spec
  }
}

/** Normalize raw Spectral diagnostics into our `Finding` type (all HIGH confidence). */
export function normalizeSpectralResults(
  results: readonly SpectralResultLike[],
  agentId: string = STRUCTURAL_AGENT_ID,
): Finding[] {
  const seenIds = new Map<string, number>()

  return results.map((result) => {
    const path = [...result.path]
    const rule = String(result.code)
    const operation = deriveOperation(path)

    const owasp = OWASP_RULE_MAP[rule]

    return {
      id: buildId(rule, path, seenIds),
      agentId,
      ...(operation ? { operation } : {}),
      rule,
      ...(owasp ? { owasp } : {}),
      severity: mapSeverity(result.severity),
      confidence: 'HIGH',
      message: result.message,
      path,
      autoFixable: false,
      autoFixed: false,
      resolution: 'pending',
    }
  })
}

function mapSeverity(severity: number): Severity {
  if (severity === 0) return 'error'
  if (severity === 1) return 'warning'
  return 'info'
}

/** Derive an "GET /users/{id}" label from a paths.<route>.<method> JSON path. */
function deriveOperation(path: ReadonlyArray<string | number>): string | undefined {
  if (path[0] !== 'paths' || typeof path[1] !== 'string') return undefined
  const method = path[2]
  if (typeof method === 'string' && HTTP_METHODS.has(method)) {
    return `${method.toUpperCase()} ${path[1]}`
  }
  return undefined
}

/** Build a deterministic, collision-free id from the rule and its location. */
function buildId(
  rule: string,
  path: ReadonlyArray<string | number>,
  seenIds: Map<string, number>,
): string {
  const base = `${rule}:${path.length > 0 ? path.join('/') : '$'}`
  const count = seenIds.get(base) ?? 0
  seenIds.set(base, count + 1)
  return count === 0 ? base : `${base}#${count}`
}

function versionErrorToFinding(result: Extract<VersionDetectionResult, { ok: false }>): Finding {
  return {
    id: result.error,
    agentId: STRUCTURAL_AGENT_ID,
    rule: result.error,
    severity: 'error',
    confidence: 'HIGH',
    message: result.message,
    path: [],
    autoFixable: false,
    autoFixed: false,
    resolution: 'pending',
  }
}
