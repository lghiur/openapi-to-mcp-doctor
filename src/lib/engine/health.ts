/**
 * A 0–100 spec health score derived from finding severities. Used by the JSON
 * report, the README badge, and the dogfood CI gate (a regression below the
 * committed baseline fails the build).
 *
 * Weights: an error costs more than a warning, which costs more than info.
 * Deliberately simple and monotonic — easy to reason about in a CI gate.
 */
export interface HealthInput {
  errors: number
  warnings: number
  info: number
}

const ERROR_PENALTY = 10
const WARNING_PENALTY = 3
const INFO_PENALTY = 1

export function computeHealthScore(input: HealthInput): number {
  const penalty =
    input.errors * ERROR_PENALTY + input.warnings * WARNING_PENALTY + input.info * INFO_PENALTY
  return Math.max(0, Math.min(100, 100 - penalty))
}

/** shields.io endpoint-badge payload (https://shields.io/badges/endpoint-badge). */
export interface HealthBadge {
  schemaVersion: 1
  label: string
  message: string
  color: 'brightgreen' | 'yellow' | 'red'
}

/** The README health badge for a score — written by `npm run dogfood`. */
export function healthBadge(score: number): HealthBadge {
  return {
    schemaVersion: 1,
    label: 'MCP health',
    message: `${score}/100`,
    color: score >= 90 ? 'brightgreen' : score >= 70 ? 'yellow' : 'red',
  }
}
