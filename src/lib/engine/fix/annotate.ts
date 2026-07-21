import { parse as parseYaml } from 'yaml'
import { getIn, toSnakeCase } from '@/lib/engine/fix/apply'
import type { Finding, OpenApiVersion } from '@/types/domain'

/**
 * Attach before/after previews to structural findings whose fix is derivable
 * deterministically (the same rules `applyFixes` special-cases). This is what
 * makes them actionable in the review UI — an Accept button and inclusion in
 * "Accept all" / the fix PR — instead of read-only diagnostics. The applier's
 * rule-specific branches still perform the actual write; the preview is display.
 */
export function annotateDeterministicFixes(
  findings: Finding[],
  spec: string,
  version: OpenApiVersion,
): Finding[] {
  let doc: unknown
  try {
    doc = parseYaml(spec)
  } catch {
    return findings
  }
  if (typeof doc !== 'object' || doc === null) return findings

  return findings.map((finding) => {
    if (finding.after !== undefined || !finding.path || finding.path.length === 0) return finding

    if (finding.rule === 'mcp-operationid-format') {
      const current = getIn(doc, finding.path)
      if (typeof current !== 'string') return finding
      const renamed = toSnakeCase(current)
      if (renamed === current) return finding
      return { ...finding, before: current, after: renamed, autoFixable: true }
    }

    if (finding.rule === 'mcp-nullable-deprecated' && version === '3.1') {
      const schemaPath = finding.path.slice(0, -1)
      const currentType = getIn(doc, [...schemaPath, 'type'])
      const newType = Array.isArray(currentType)
        ? [...currentType.filter((t) => t !== 'null'), 'null']
        : [currentType ?? 'string', 'null']
      return {
        ...finding,
        before: 'nullable: true',
        after: `type: ${JSON.stringify(newType)}`,
        autoFixable: true,
      }
    }

    return finding
  })
}
