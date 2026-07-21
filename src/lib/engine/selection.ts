import type { OperationRef } from '@/lib/engine/operations'
import type { Finding, OperationSelection } from '@/types/domain'

/**
 * Operation-selection filtering: when the user picks a subset of paths/methods,
 * only those operations are analysed (workers, post-process, grounding) and only
 * findings anchored inside the selection are reported/fixed. Document-level
 * findings (version, operation count, info block…) always pass through — they
 * describe the spec, not an operation.
 */

const HTTP_METHODS = new Set([
  'get',
  'put',
  'post',
  'delete',
  'options',
  'head',
  'patch',
  'trace',
])

function toMethodMap(selection: OperationSelection): Map<string, Set<string>> {
  const map = new Map<string, Set<string>>()
  for (const { path, methods } of selection) {
    const set = map.get(path) ?? new Set<string>()
    for (const method of methods) set.add(method.toLowerCase())
    map.set(path, set)
  }
  return map
}

/** Keep only the operations covered by the selection. Undefined = keep all. */
export function filterOperations(
  operations: OperationRef[],
  selection?: OperationSelection,
): OperationRef[] {
  if (!selection) return operations
  const map = toMethodMap(selection)
  return operations.filter((op) => map.get(op.path)?.has(op.method.toLowerCase()) ?? false)
}

/**
 * Drop findings anchored under an unselected path/method. Findings not anchored
 * under `paths.<path>` (document-level) are always kept, as are findings on a
 * selected path but outside any method (e.g. path-level `parameters`).
 */
export function filterFindings(findings: Finding[], selection?: OperationSelection): Finding[] {
  if (!selection) return findings
  const map = toMethodMap(selection)
  return findings.filter((finding) => {
    const specPath = finding.path
    if (!specPath || specPath[0] !== 'paths' || typeof specPath[1] !== 'string') return true

    const methods = map.get(specPath[1])
    if (!methods) return false

    const segment = specPath[2]
    if (typeof segment === 'string' && HTTP_METHODS.has(segment.toLowerCase())) {
      return methods.has(segment.toLowerCase())
    }
    return true
  })
}
