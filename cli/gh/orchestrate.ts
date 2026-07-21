import { createHash } from 'node:crypto'
import { resolveSpecLine } from '@/lib/engine/lines/resolve'
import type { ReportFinding } from '@/types/api'
import type { FailOn } from '../render/summary'
import { findingKey } from './delta'
import { BEHAVIORS, type Behavior, type DirectionResult, type LocatedFinding } from './types'

/**
 * Pure decision logic for the GitHub Action behavior ladder — which levels
 * run, how the delta gates CI, and where findings land as annotations /
 * review comments. `cli/action.ts` stays a thin I/O shell over this module.
 */

/** The ladder is cumulative: each level does everything below it. */
export function behaviorAtLeast(behavior: Behavior, min: Behavior): boolean {
  return BEHAVIORS.indexOf(behavior) >= BEHAVIORS.indexOf(min)
}

/** Parse the `behavior` input; unset → 'comment', unknown → undefined (caller errors). */
export function parseBehavior(raw: string | undefined): Behavior | undefined {
  if (raw === undefined) return 'comment'
  return (BEHAVIORS as readonly string[]).includes(raw) ? (raw as Behavior) : undefined
}

/**
 * `fail-on` default: non-PR runs keep the historical 'error' gate; PR runs are
 * advisory ('never') per the design doc — the sticky comment is the signal.
 */
export function defaultFailOn(isPr: boolean): FailOn {
  return isPr ? 'never' : 'error'
}

/** Explicit `github-token` input wins; otherwise the workflow's GITHUB_TOKEN env. */
export function resolveGithubToken(
  inputToken: string | undefined,
  env: Record<string, string | undefined>,
): string | undefined {
  return inputToken ?? env.GITHUB_TOKEN ?? undefined
}

/** lint-only PRs (no spec/route changes) must cost zero LLM calls. */
export function aiAllowedForStrategy(strategy: DirectionResult['strategy']): boolean {
  return strategy !== 'lint-only'
}

/**
 * Summary-shaped counts over the delta's new findings only — the CI gate must
 * never fail a PR for pre-existing debt.
 */
export function deltaGateSummary(newFindings: ReportFinding[]): {
  total: number
  errors: number
  warnings: number
  info: number
  autoFixed: number
} {
  return {
    total: newFindings.length,
    errors: newFindings.filter((f) => f.severity === 'error').length,
    warnings: newFindings.filter((f) => f.severity === 'warning').length,
    info: newFindings.filter((f) => f.severity === 'info').length,
    autoFixed: newFindings.filter((f) => f.autoFixed).length,
  }
}

/**
 * Validate an enum-valued action input. Unset is fine (caller applies the
 * default); anything not in the union is an error the caller must surface.
 */
export function parseChoice<T extends string>(
  raw: string | undefined,
  allowed: readonly T[],
): { ok: true; value: T | undefined } | { ok: false; message: string } {
  if (raw === undefined) return { ok: true, value: undefined }
  if ((allowed as readonly string[]).includes(raw)) return { ok: true, value: raw as T }
  return { ok: false, message: `'${raw}' is not one of: ${allowed.join(' | ')}` }
}

/**
 * Stable review-comment key for a finding: hash of the delta identity
 * (rule + operation + spec path) — never the LLM-worded message, so re-runs
 * with different wording keep the same inline comment.
 */
export function findingMarkerKey(finding: ReportFinding): string {
  return createHash('sha256').update(findingKey(finding)).digest('hex').slice(0, 16)
}

/**
 * From `git diff --name-status` output, the OLD path of a rename whose new
 * path is `headPath` (lines look like `R100\told\tnew`). Undefined when the
 * file was not renamed.
 */
export function renamedFrom(nameStatus: string, headPath: string): string | undefined {
  for (const line of nameStatus.split('\n')) {
    const parts = line.split('\t')
    if (parts.length >= 3 && parts[0]?.startsWith('R') && parts[2] === headPath) {
      return parts[1]
    }
  }
  return undefined
}

/**
 * The consumer repo hasn't enabled "Allow GitHub Actions to create and approve
 * pull requests" (Settings → Actions → General). A normal condition across
 * GitHub, not a failure: fix-pr degrades to review with a notice.
 */
export function isPrCreationForbidden(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false
  const { status, message } = error as { status?: unknown; message?: unknown }
  return (
    status === 403 &&
    typeof message === 'string' &&
    message.includes('not permitted to create or approve pull requests')
  )
}

/**
 * Failed-agent lines from scan stderr ("✗ worker-1 failed: …"). AI workers
 * fail soft (structural findings still ship), so the action must surface the
 * failures — a silent fallback would let "AI never ran" masquerade as clean.
 */
export function extractAgentFailures(stderr: string): string[] {
  return stderr
    .split('\n')
    .filter((line) => line.startsWith('✗ '))
    .map((line) => line.slice(2).trim())
    .filter((line) => line.length > 0)
}

/** Applied-fix count from a fix-mode scan's stdout ("Applied N fix(es), …"). */
export function parseAppliedFixCount(fixStdout: string): number | undefined {
  const match = /Applied (\d+) fix\(es\)/.exec(fixStdout)
  return match ? Number(match[1]) : undefined
}

/**
 * Untrusted spec/LLM text must never ping GitHub users or teams: a zero-width
 * space after each `@` keeps the text readable but kills the mention.
 */
export function neutralizeMentions(text: string): string {
  return text.replace(/@(?=\w)/g, '@\u200b')
}

/** One-line, pipe-safe, mention-safe markdown table cell. */
export function mdCell(value: string): string {
  return neutralizeMentions(value.replace(/\r?\n/g, ' ').replace(/\|/g, '\\|'))
}

/**
 * Refs passed to git must never carry shell metacharacters, and must not start
 * with `-` (execFile is shell-safe, but a leading dash would be parsed as an
 * option by git itself).
 */
export function isSafeGitRef(ref: string): boolean {
  return /^[\w./-]+$/.test(ref) && !ref.startsWith('-')
}

/**
 * Grounding findings carry their handler location only inside the message
 * ("… registered in internal/routes.go:42 …") — `Finding` has no structured
 * file/line field (see src/lib/engine/grounding/discover.ts). Parse it out.
 */
export function parseHandlerLocation(message: string): { file: string; line: number } | undefined {
  const match = /(?:registered|discovered) in (\S+):(\d+)\b/.exec(message)
  if (!match) return undefined
  return { file: match[1] as string, line: Number(match[2]) }
}

/** Grounding rules whose natural anchor is the handler file, not the spec. */
const HANDLER_SIDE_RULES = new Set(['SPEC_CODE_UNDOCUMENTED_ENDPOINT', 'SPEC_CODE_MISMATCH'])

/**
 * Resolve findings to concrete file+line locations: handler-side rules anchor
 * to the code line parsed from the message; everything else anchors to the
 * spec via the JSON-path→line resolver. Findings with no usable location are
 * dropped here — they still appear in the sticky comment and Job Summary.
 */
export function locateFindings(
  findings: ReportFinding[],
  specText: string,
  specPath: string,
): LocatedFinding[] {
  const located: LocatedFinding[] = []
  for (const finding of findings) {
    const handler = HANDLER_SIDE_RULES.has(finding.rule)
      ? parseHandlerLocation(finding.message)
      : undefined
    if (handler) {
      located.push({ finding, file: handler.file, line: handler.line, target: 'handler' })
      continue
    }
    if (finding.path && finding.path.length > 0) {
      const line = resolveSpecLine(specText, finding.path)
      located.push({
        finding,
        file: specPath,
        ...(line !== undefined ? { line } : {}),
        target: 'spec',
      })
    }
  }
  return located
}

/**
 * Fence a spec snippet for a review comment. The fence is always longer than
 * any backtick run inside the (untrusted) content, so the snippet can never
 * break out of the code block into raw markdown.
 */
function fence(label: string, content: string): string {
  const longestRun = (content.match(/`+/g) ?? []).reduce((max, run) => Math.max(max, run.length), 0)
  const marks = '`'.repeat(Math.max(3, longestRun + 1))
  return `**${label}**\n\n${marks}yaml\n${content}\n${marks}`
}

/** Body of one inline review comment (marker is added by syncPrReview). */
export function inlineCommentBody(finding: ReportFinding): string {
  const parts: string[] = [`**${mdCell(finding.rule)}** · ${finding.severity}`]
  if (finding.confidence === 'LOW') {
    parts.push('⚠ **LOW confidence** — verify against the handler code before accepting.')
  }
  parts.push(neutralizeMentions(finding.message))
  if (finding.before !== undefined) parts.push(fence('Current', finding.before))
  if (finding.after !== undefined) parts.push(fence('Suggested', finding.after))
  return parts.join('\n\n')
}

/** Extra Job Summary section listing what this PR introduced (delta-gated). */
export function renderNewFindingsSection(newFindings: ReportFinding[]): string {
  if (newFindings.length === 0) {
    return '### New in this PR\n\nNo new findings introduced by this PR. ✨\n'
  }
  const rows = newFindings
    .map(
      (f) =>
        `| \`${mdCell(f.operation ?? '—')}\` | ${mdCell(f.rule)} | ${f.severity} | ${mdCell(f.message)} |`,
    )
    .join('\n')
  return `### New in this PR

| Operation | Rule | Severity | Message |
| --------- | ---- | -------- | ------- |
${rows}
`
}
