import { parseDocument, parse as parseYaml, type Document } from 'yaml'
import { OPERATIONID_MAX_LENGTH } from '@/lib/engine/constants'
import type {
  ConfidenceThreshold,
  Confidence,
  Finding,
  MismatchMode,
  OpenApiVersion,
} from '@/types/domain'

export interface ApplyFixesOptions {
  spec: string
  findings: Finding[]
  threshold: ConfidenceThreshold
  version: OpenApiVersion
  /**
   * Spec/code mismatch findings are only appliable in 'fix' mode (and, being
   * LOW confidence, only at the 'low' threshold). Default 'flag': report only.
   */
  mismatchMode?: MismatchMode
}

export interface ApplyFixesResult {
  patched: string
  applied: Finding[]
  skipped: Finding[]
  warnings: string[]
}

const CONFIDENCE_LEVEL: Record<Confidence, number> = { LOW: 1, MEDIUM: 2, HIGH: 3 }
const THRESHOLD_LEVEL: Record<ConfidenceThreshold, number> = { low: 1, medium: 2, high: 3 }

type FixOp =
  | { op: 'set'; path: Array<string | number>; value: unknown }
  | { op: 'delete'; path: Array<string | number> }

/**
 * Path segments that reach the prototype chain instead of spec content. A fix
 * path containing one of these (LLM-emitted paths are prompt-injectable via
 * spec descriptions) must never be written — plain bracket access on
 * `__proto__` pollutes `Object.prototype` for the whole process.
 */
export const FORBIDDEN_PATH_SEGMENTS: ReadonlySet<string> = new Set([
  '__proto__',
  'constructor',
  'prototype',
])

/** True when any segment of a spec path is a forbidden (prototype-reaching) key. */
export function hasForbiddenPathSegment(path: ReadonlyArray<unknown>): boolean {
  return path.some(
    (segment) => typeof segment === 'string' && FORBIDDEN_PATH_SEGMENTS.has(segment),
  )
}

/**
 * Apply eligible fixes to a spec, gated by confidence threshold, emitting
 * version-correct syntax. Preserves YAML-vs-JSON format; for YAML specs the
 * patch is applied to the parsed Document, so comments, anchors and formatting
 * on untouched nodes survive. LOW-confidence fixes always produce a prominent
 * warning.
 */
export function applyFixes(options: ApplyFixesOptions): ApplyFixesResult {
  const isJson = options.spec.trimStart().startsWith('{')
  // Plain-JS mirror for validation/reads; parseYaml throws on invalid input
  // exactly as before.
  const doc: unknown = parseYaml(options.spec)
  const applied: Finding[] = []
  const skipped: Finding[] = []
  const warnings: string[] = []

  if (!isRecord(doc)) {
    return { patched: options.spec, applied, skipped: [...options.findings], warnings }
  }

  // For YAML input the Document is the output artifact: mutating it via
  // setIn/deleteIn keeps comments and formatting everywhere we did not touch.
  const document = isJson ? null : parseDocument(options.spec)

  const minLevel = THRESHOLD_LEVEL[options.threshold]
  const mismatchMode = options.mismatchMode ?? 'flag'
  for (const finding of options.findings) {
    if (CONFIDENCE_LEVEL[finding.confidence] < minLevel) {
      skipped.push(finding)
      continue
    }
    // Code-as-truth guardrail: mismatch corrections need explicit opt-in.
    if (finding.rule === 'SPEC_CODE_MISMATCH' && mismatchMode !== 'fix') {
      skipped.push(finding)
      continue
    }
    // Prototype-pollution guardrail: skip this fix (with a warning), never
    // throw the whole batch.
    if (finding.path !== undefined && hasForbiddenPathSegment(finding.path)) {
      skipped.push(finding)
      warnings.push(
        `Skipped fix for ${finding.rule}: its path contains a forbidden path segment ` +
          '(__proto__/constructor/prototype) and cannot be applied safely.',
      )
      continue
    }
    const ops = deriveFixOps(finding, options.version, doc)
    if (ops === null) {
      skipped.push(finding)
      continue
    }
    for (const op of ops) {
      applyOp(doc, op)
      if (document !== null) applyDocOp(document, op)
    }
    applied.push(finding)
    if (finding.confidence === 'LOW') {
      const where = finding.operation ?? finding.path?.join('/') ?? finding.rule
      const label = finding.rule === 'SPEC_CODE_MISMATCH' ? 'spec/code mismatch fix' : 'fix'
      warnings.push(
        `Applied LOW-confidence ${label} for ${finding.rule} at ${where} — review carefully.`,
      )
    }
  }

  const patched =
    document !== null ? document.toString() : `${JSON.stringify(doc, null, 2)}\n`
  return { patched, applied, skipped, warnings }
}

function deriveFixOps(
  finding: Finding,
  version: OpenApiVersion,
  doc: Record<string, unknown>,
): FixOp[] | null {
  const path = finding.path

  if (finding.rule === 'mcp-operationid-format' && path && path.length > 0) {
    const current = getIn(doc, path)
    if (typeof current !== 'string') return null
    return [{ op: 'set', path: [...path], value: toSnakeCase(current) }]
  }

  if (finding.rule === 'mcp-nullable-deprecated' && version === '3.1' && path && path.length > 0) {
    const schemaPath = path.slice(0, -1)
    // Same parent-existence validation as the generic branch: a hallucinated
    // schema location must skip the fix, never count it as applied.
    if (!isRecord(getIn(doc, schemaPath))) return null
    const currentType = getIn(doc, [...schemaPath, 'type'])
    const newType = Array.isArray(currentType)
      ? [...currentType.filter((t) => t !== 'null'), 'null']
      : [currentType ?? 'string', 'null']
    return [
      { op: 'set', path: [...schemaPath, 'type'], value: newType },
      { op: 'delete', path: [...path] },
    ]
  }

  // Generic: apply an agent-provided suggestion at its path. Agent paths are
  // validated against the document before writing — an LLM-hallucinated location
  // must skip the fix (and count as skipped), never invent spec structure.
  if (finding.after !== undefined && path && path.length > 0) {
    const parent = getIn(doc, path.slice(0, -1))
    const lastKey = path[path.length - 1]
    const parentIsValid =
      (isRecord(parent) && lastKey !== undefined) ||
      (Array.isArray(parent) && typeof lastKey === 'number' && lastKey <= parent.length)
    if (!parentIsValid) return null
    const current = getIn(doc, path)
    return [{ op: 'set', path: [...path], value: coerceValue(finding.after, current) }]
  }

  return null
}

/**
 * Agent suggestions arrive as strings. When the target is not currently a string
 * (a boolean `required`, a numeric bound, a schema object), a JSON-parseable
 * suggestion is applied as its parsed value — `"true"` must become `true`, not
 * the string. Existing string fields (descriptions) always stay strings.
 */
function coerceValue(suggested: string, current: unknown): unknown {
  if (typeof current === 'string') return suggested
  try {
    return JSON.parse(suggested) as unknown
  } catch {
    return suggested
  }
}

export function toSnakeCase(value: string): string {
  return value
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .replace(/[\s-]+/g, '_')
    .toLowerCase()
    .replace(/[^a-z0-9_]/g, '')
    .replace(/^_+|_+$/g, '')
    .slice(0, OPERATIONID_MAX_LENGTH)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export function getIn(root: unknown, path: ReadonlyArray<string | number>): unknown {
  let current: unknown = root
  for (const key of path) {
    // Defense in depth: never traverse into the prototype chain.
    if (typeof key === 'string' && FORBIDDEN_PATH_SEGMENTS.has(key)) return undefined
    if (Array.isArray(current) && typeof key === 'number') current = current[key]
    else if (isRecord(current)) current = Object.hasOwn(current, String(key)) ? current[String(key)] : undefined
    else return undefined
  }
  return current
}

function applyOp(root: Record<string, unknown>, op: FixOp): void {
  // Defense in depth: the caller already skips findings with forbidden path
  // segments; a write through one must still be impossible.
  if (hasForbiddenPathSegment(op.path)) return
  const parentPath = op.path.slice(0, -1)
  const lastKey = op.path[op.path.length - 1]
  if (lastKey === undefined) return
  const parent = getIn(root, parentPath)

  if (op.op === 'set') {
    if (Array.isArray(parent) && typeof lastKey === 'number') parent[lastKey] = op.value
    else if (isRecord(parent)) parent[String(lastKey)] = op.value
  } else {
    if (Array.isArray(parent) && typeof lastKey === 'number') parent.splice(lastKey, 1)
    else if (isRecord(parent)) delete parent[String(lastKey)]
  }
}

/**
 * Mirror of `applyOp` against the YAML Document (the output artifact for YAML
 * specs). setIn/deleteIn only touch the addressed node, so comments, anchors
 * and formatting everywhere else survive the fix pass. `deriveFixOps` has
 * already validated the location against the JS mirror, so setIn never invents
 * structure beyond the final key.
 */
function applyDocOp(document: Document, op: FixOp): void {
  if (hasForbiddenPathSegment(op.path)) return
  if (op.op === 'set') document.setIn(op.path, document.createNode(op.value))
  else document.deleteIn(op.path)
}
