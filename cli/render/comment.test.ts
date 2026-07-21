import { describe, expect, it } from 'vitest'
import type { AnalysisReport, ReportFinding } from '@/types/api'
import { STICKY_COMMENT_MARKER, type DirectionResult, type ReportDelta } from '../gh/types'
import { renderStickyComment } from './comment'

function finding(overrides: Partial<ReportFinding> = {}): ReportFinding {
  return {
    id: 'f1',
    agentId: 'structural-linter',
    operation: 'GET /users/{id}',
    rule: 'mcp-operationid-required',
    severity: 'error',
    confidence: 'HIGH',
    message: 'operationId is missing',
    autoFixed: false,
    resolution: 'pending',
    ...overrides,
  }
}

const report: AnalysisReport = {
  runId: 'run-1',
  timestamp: '2026-07-21T10:00:00Z',
  spec: { file: 'api/openapi.yaml', version: '3.0.3', operationCount: 24 },
  mcpSpecVersion: '2025-11-25',
  mode: 'lint',
  mismatchMode: 'flag',
  durationMs: 12400,
  summary: { total: 14, errors: 3, warnings: 8, info: 3, autoFixed: 2 },
  agents: [],
  findings: [finding()],
}

const direction: DirectionResult = {
  specChanged: false,
  routesChanged: true,
  strategy: 'code-drift',
  changedFiles: ['internal/api/users.go'],
}

const delta: ReportDelta = {
  newFindings: [finding()],
  resolvedFindings: [],
  healthBase: 72,
  healthHead: 68,
}

function render(overrides: Partial<Parameters<typeof renderStickyComment>[0]> = {}): string {
  return renderStickyComment({ delta, direction, report, behavior: 'comment', ...overrides })
}

describe('renderStickyComment', () => {
  it('starts with the sticky marker on its own line', () => {
    expect(render().startsWith(`${STICKY_COMMENT_MARKER}\n`)).toBe(true)
  })

  it('renders the header with a falling health delta', () => {
    expect(render()).toContain('## MCP Doctor')
    expect(render()).toContain('72 → 68 ▼')
  })

  it('renders a rising and a flat health delta', () => {
    expect(render({ delta: { ...delta, healthBase: 60, healthHead: 75 } })).toContain('60 → 75 ▲')
    expect(render({ delta: { ...delta, healthBase: 70, healthHead: 70 } })).toContain('70 → 70 =')
  })

  it('omits the health delta when either side is missing', () => {
    const md = render({ delta: { ...delta, healthBase: undefined } })
    expect(md).not.toContain('→')
    expect(md).not.toContain('▼')
  })

  it('narrates the scan direction', () => {
    expect(render()).toContain('Route files changed — checked the spec for missing endpoints.')
    const specDirection: DirectionResult = { ...direction, strategy: 'spec-verify' }
    expect(render({ direction: specDirection })).toContain(
      'Spec changed — verified it against the handler code.',
    )
  })

  it('renders new findings as a table with severity emoji', () => {
    const md = render()
    expect(md).toContain('### New in this PR')
    expect(md).toContain(
      '| 🔴 | `mcp-operationid-required` | `GET /users/{id}` | operationId is missing |',
    )
  })

  it('caps the findings table at 20 rows with a +N more line', () => {
    const many = Array.from({ length: 25 }, (_, i) => finding({ id: `f${i}`, rule: `rule-${i}` }))
    const md = render({ delta: { ...delta, newFindings: many } })
    expect(md).toContain('rule-19')
    expect(md).not.toContain('rule-20')
    expect(md).toContain('+5 more')
  })

  it('says so when the PR introduces no new findings', () => {
    const md = render({ delta: { ...delta, newFindings: [] } })
    expect(md).toContain('No new findings')
  })

  it('mentions resolved findings only when there are some', () => {
    expect(render()).not.toContain('resolved')
    const md = render({ delta: { ...delta, resolvedFindings: [finding(), finding({ id: 'f2' })] } })
    expect(md).toContain('2 findings resolved')
  })

  it('renders the fix-PR call-out with the applied-fix count from the fix pass', () => {
    const md = render({
      fixPr: { url: 'https://github.com/o/r/pull/12', number: 12 },
      appliedFixCount: 5,
    })
    expect(md).toContain('5 fixes ready')
    expect(md).toContain('[#12](https://github.com/o/r/pull/12)')
    expect(md).toContain('merge')
  })

  it('falls back to summary.autoFixed when no applied-fix count is threaded', () => {
    const md = render({ fixPr: { url: 'https://github.com/o/r/pull/12', number: 12 } })
    expect(md).toContain('2 fixes ready')
  })

  it('omits the fix-PR call-out otherwise', () => {
    expect(render()).not.toContain('fixes ready')
  })

  it("labels the fix call-out as scoped to the PR's changes when fixScope is pr", () => {
    const md = render({
      fixPr: { url: 'https://github.com/o/r/pull/12', number: 12 },
      appliedFixCount: 3,
      fixScope: 'pr',
    })
    expect(md).toContain("3 fixes ready** (scoped to this PR's changes)")
  })

  it('labels the fix call-out as whole-spec when fixScope is full', () => {
    const md = render({
      fixPr: { url: 'https://github.com/o/r/pull/12', number: 12 },
      appliedFixCount: 7,
      fixScope: 'full',
    })
    expect(md).toContain('7 fixes ready** (whole spec)')
  })

  it('notes skipped inline comments only when > 0', () => {
    expect(render()).not.toContain('inline')
    expect(render({ skippedInline: 0 })).not.toContain('inline')
    expect(render({ skippedInline: 3 })).toContain('3')
  })

  it('collapses pre-existing totals into a details block with a Job Summary link', () => {
    const md = render({ jobSummaryUrl: 'https://github.com/o/r/actions/runs/1' })
    expect(md).toContain('<details>')
    expect(md).toContain('3 errors')
    expect(md).toContain('8 warnings')
    expect(md).toContain('[Job Summary](https://github.com/o/r/actions/runs/1)')
    expect(md).toContain('</details>')
  })

  it('neutralizes @-mentions and escapes pipes in table cells', () => {
    const md = render({
      delta: {
        ...delta,
        newFindings: [finding({ message: 'evil | cell mentioning @octocat here' })],
      },
    })
    expect(md).toContain('evil \\| cell')
    expect(md).not.toContain('@octocat')
  })

  it('still points at the Job Summary without a URL', () => {
    const md = render()
    expect(md).toContain('Job Summary')
    expect(md).not.toContain('[Job Summary](')
  })
})
