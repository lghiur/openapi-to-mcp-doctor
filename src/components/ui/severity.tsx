import { AlertTriangle, CircleAlert, Info, ShieldAlert, ShieldCheck, ShieldQuestion } from 'lucide-react'
import type { Confidence, Severity } from '@/types/domain'
import { Badge } from '@/components/ui/badge'
import { OWASP_RISK_NAMES } from '@/lib/engine/linter/rulesets/owasp-meta'

const SEVERITY_TONE = { error: 'error', warning: 'warning', info: 'info' } as const
const SEVERITY_ICON = { error: CircleAlert, warning: AlertTriangle, info: Info } as const

/** Colour-coded severity pill with icon (error/warning/info). */
export function SeverityBadge({ severity }: { severity: Severity }) {
  const Icon = SEVERITY_ICON[severity]
  return (
    <Badge tone={SEVERITY_TONE[severity]}>
      <Icon className="size-3" />
      {severity}
    </Badge>
  )
}

const CONFIDENCE_TONE = { HIGH: 'success', MEDIUM: 'warning', LOW: 'error' } as const
const CONFIDENCE_ICON = { HIGH: ShieldCheck, MEDIUM: ShieldQuestion, LOW: ShieldAlert } as const

/** Confidence pill: HIGH (green) / MEDIUM (amber) / LOW (red, alarming). */
export function ConfidenceBadge({ confidence }: { confidence: Confidence }) {
  const Icon = CONFIDENCE_ICON[confidence]
  return (
    <Badge tone={CONFIDENCE_TONE[confidence]} className="font-semibold tracking-wide">
      <Icon className="size-3" />
      {confidence}
    </Badge>
  )
}

/**
 * Marks a finding produced by the OWASP MCP security ruleset, e.g. "OWASP MCP03".
 * Render only when `finding.owasp` is set; hover shows the risk name.
 */
export function OwaspBadge({ owasp }: { owasp: string }) {
  const name = OWASP_RISK_NAMES[owasp]
  return (
    <Badge
      tone="error"
      className="font-semibold tracking-wide"
      title={name ? `OWASP MCP Top 10 — ${owasp}: ${name}` : `OWASP MCP Top 10 — ${owasp}`}
    >
      <ShieldAlert className="size-3" />
      OWASP {owasp}
    </Badge>
  )
}

export { ShieldAlert }
