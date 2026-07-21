import type { ReportFinding } from '@/types/api'
import type { LocatedFinding } from '../gh/types'

/**
 * GitHub workflow-command escaping. Message (data) escapes %, \r, \n; property
 * values (file=, title=) additionally escape : and , per the runner's parser.
 */
function escapeData(value: string): string {
  return value.replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A')
}

function escapeProperty(value: string): string {
  return escapeData(value).replace(/:/g, '%3A').replace(/,/g, '%2C')
}

const COMMAND_BY_SEVERITY: Record<ReportFinding['severity'], string> = {
  error: 'error',
  warning: 'warning',
  info: 'notice',
}

/** Render located findings as `::error file=…,line=…,title=…::message` workflow commands. */
export function renderAnnotations(located: LocatedFinding[]): string[] {
  return located.map(({ finding, file, line }) => {
    const properties = [`file=${escapeProperty(file)}`]
    if (line !== undefined) properties.push(`line=${line}`)
    properties.push(`title=${escapeProperty(finding.rule)}`)
    return `::${COMMAND_BY_SEVERITY[finding.severity]} ${properties.join(',')}::${escapeData(finding.message)}`
  })
}
