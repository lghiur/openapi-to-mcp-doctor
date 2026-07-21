import type { RulesetDefinition } from '@stoplight/spectral-core'
import spectralRulesets from '@stoplight/spectral-rulesets'
import { annotateDeterministicFixes } from '@/lib/engine/fix/annotate'
import { mcpRuleset } from '@/lib/engine/linter/rulesets/mcp'
import { mcpSecurityRuleset } from '@/lib/engine/linter/rulesets/mcp-security'
import { runStructuralLint } from '@/lib/engine/linter/spectral'
import { detectVersion } from '@/lib/engine/linter/version'
import { type StructuralSummary, summarizeFindings } from '@/lib/engine/summary'
import type { Finding, OpenApiVersion } from '@/types/domain'

const { oas } = spectralRulesets

export interface StructuralAnalysis {
  /** Detected OpenAPI version, or null when analysis halted on a version error. */
  version: OpenApiVersion | null
  findings: Finding[]
  summary: StructuralSummary
  /** True when a version error stopped analysis before any ruleset ran. */
  halted: boolean
}

/**
 * The deterministic, always-on structural analysis entry point. Composes version
 * detection with the base `oas` ruleset plus the MCP ruleset (one combined
 * Spectral pass) and returns normalized findings with a summary. Zero LLM calls.
 */
export async function runStructuralAnalysis(spec: string): Promise<StructuralAnalysis> {
  const detected = detectVersion(spec)
  const ruleset: RulesetDefinition = detected.ok
    ? combinedRuleset(detected.version)
    : (oas as RulesetDefinition)

  const result = await runStructuralLint(spec, ruleset)
  // Findings with a deterministic fix carry their preview from birth, so every
  // consumer (web review UI, CLI, PR flow) sees them as appliable suggestions.
  const findings = result.version
    ? annotateDeterministicFixes(result.findings, spec, result.version)
    : result.findings

  return {
    version: result.version,
    findings,
    halted: result.halted,
    summary: summarizeFindings(findings),
  }
}

/**
 * Base oas rules + the version-specific MCP rules + the OWASP MCP security rules,
 * as one Spectral ruleset (a single pass). Rule ids never collide (mcp-* vs owasp-*).
 */
function combinedRuleset(version: OpenApiVersion): RulesetDefinition {
  const mcp = mcpRuleset(version)
  const security = mcpSecurityRuleset(version)
  return {
    // Default (recommended) oas severities — `all` enables noisy off-by-default rules.
    extends: [oas as RulesetDefinition],
    formats: mcp.formats,
    rules: { ...mcp.rules, ...security.rules },
  }
}
