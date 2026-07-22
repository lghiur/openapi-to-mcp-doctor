import type { Finding, OpenApiVersion, Severity } from '@/types/domain'

const ANSI = {
  reset: '\x1b[0m',
  bold: '\x1b[1m',
  red: '\x1b[31m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  green: '\x1b[32m',
  gray: '\x1b[90m',
} as const

export interface HumanReportInput {
  specFile: string
  version: OpenApiVersion
  mcpVersion: string
  healthScore: number
  summary: { total: number; errors: number; warnings: number; info: number }
  findings: Finding[]
  color: boolean
  /** MCP simulation summary — how many operations would load as MCP tools today. */
  mcp?: { loadable: number; total: number }
}

interface SeverityGroup {
  severity: Severity
  label: string
  color: string
  icon: string
}

const GROUPS: SeverityGroup[] = [
  { severity: 'error', label: 'Errors', color: ANSI.red, icon: '✖' },
  { severity: 'warning', label: 'Warnings', color: ANSI.yellow, icon: '⚠' },
  { severity: 'info', label: 'Info', color: ANSI.blue, icon: 'ℹ' },
]

/**
 * Strip C0/C1 control characters (keeping \n and \t) from untrusted spec/LLM
 * text before it reaches the terminal — raw ESC/CSI sequences could otherwise
 * spoof or hide output (ANSI escape injection). Applied at the render boundary
 * only, so the tool's own coloring is unaffected.
 */
function sanitize(text: string): string {
  return text.replace(/[\u0000-\u0008\u000B-\u001F\u007F-\u009F]/g, '')
}

/** Render the human-readable scan report. ANSI color is applied only when enabled. */
export function renderHuman(input: HumanReportInput): string {
  const paint = (text: string, code: string): string =>
    input.color ? `${code}${text}${ANSI.reset}` : text

  const lines: string[] = []
  lines.push(
    `${paint('mcp-doctor', ANSI.bold)} — ${input.specFile} ` +
      `(OpenAPI ${input.version}, MCP ${input.mcpVersion})`,
  )
  lines.push('')

  const scoreColor =
    input.healthScore >= 80 ? ANSI.green : input.healthScore >= 50 ? ANSI.yellow : ANSI.red
  lines.push(`Health score: ${paint(`${input.healthScore}/100`, scoreColor)}`)
  lines.push(
    `${input.summary.total} findings: ` +
      `${paint(`${input.summary.errors} ${plural(input.summary.errors, 'error')}`, ANSI.red)}, ` +
      `${paint(`${input.summary.warnings} ${plural(input.summary.warnings, 'warning')}`, ANSI.yellow)}, ` +
      `${paint(`${input.summary.info} info`, ANSI.blue)}`,
  )
  if (input.mcp) {
    const allLoadable = input.mcp.loadable === input.mcp.total
    lines.push(
      `MCP tools: ${paint(
        `${input.mcp.loadable}/${input.mcp.total} operations loadable`,
        allLoadable ? ANSI.green : ANSI.yellow,
      )}`,
    )
  }

  for (const group of GROUPS) {
    const groupFindings = input.findings.filter((f) => f.severity === group.severity)
    if (groupFindings.length === 0) continue
    lines.push('')
    lines.push(paint(group.label, ANSI.bold))
    for (const finding of groupFindings) {
      const location = sanitize(locationOf(finding))
      const suffix = location ? `  ${paint(location, ANSI.gray)}` : ''
      lines.push(
        `  ${paint(group.icon, group.color)} ${paint(sanitize(finding.rule), ANSI.bold)}${suffix}`,
      )
      lines.push(`     ${sanitize(finding.message)}`)
    }
  }

  if (input.summary.total === 0) {
    lines.push('')
    lines.push(paint('No findings — looks MCP-ready.', ANSI.green))
  }

  return lines.join('\n')
}

function locationOf(finding: Finding): string {
  if (finding.operation) return finding.operation
  if (finding.operations && finding.operations.length > 0) return finding.operations.join(', ')
  if (finding.path && finding.path.length > 0) return finding.path.join('/')
  return ''
}

function plural(count: number, word: string): string {
  return count === 1 ? word : `${word}s`
}
