import { describe, expect, it } from 'vitest'
import type { ReportFinding } from '@/types/api'
import {
  aiAllowedForStrategy,
  behaviorAtLeast,
  defaultFailOn,
  deltaGateSummary,
  findingMarkerKey,
  inlineCommentBody,
  isSafeGitRef,
  locateFindings,
  mdCell,
  neutralizeMentions,
  parseAppliedFixCount,
  parseBehavior,
  parseChoice,
  parseHandlerLocation,
  renamedFrom,
  renderNewFindingsSection,
  resolveGithubToken,
} from './orchestrate'

function finding(overrides: Partial<ReportFinding> = {}): ReportFinding {
  return {
    id: 'f1',
    agentId: 'structural-linter',
    rule: 'mcp-operationid-required',
    severity: 'error',
    confidence: 'HIGH',
    message: 'operationId is missing',
    autoFixed: false,
    resolution: 'pending',
    ...overrides,
  }
}

describe('behaviorAtLeast', () => {
  it('orders the ladder summary < comment < review < fix-pr', () => {
    expect(behaviorAtLeast('summary', 'summary')).toBe(true)
    expect(behaviorAtLeast('summary', 'comment')).toBe(false)
    expect(behaviorAtLeast('comment', 'comment')).toBe(true)
    expect(behaviorAtLeast('comment', 'review')).toBe(false)
    expect(behaviorAtLeast('review', 'comment')).toBe(true)
    expect(behaviorAtLeast('fix-pr', 'review')).toBe(true)
    expect(behaviorAtLeast('fix-pr', 'fix-pr')).toBe(true)
  })
})

describe('parseBehavior', () => {
  it('defaults to comment when unset', () => {
    expect(parseBehavior(undefined)).toBe('comment')
  })

  it('accepts every ladder level', () => {
    expect(parseBehavior('summary')).toBe('summary')
    expect(parseBehavior('fix-pr')).toBe('fix-pr')
  })

  it('returns undefined on an unknown value', () => {
    expect(parseBehavior('yolo')).toBeUndefined()
  })
})

describe('defaultFailOn', () => {
  it('keeps error for non-PR runs (backwards compatible)', () => {
    expect(defaultFailOn(false)).toBe('error')
  })

  it('is advisory (never) on PR runs per the design doc', () => {
    expect(defaultFailOn(true)).toBe('never')
  })
})

describe('resolveGithubToken', () => {
  it('prefers the explicit input over the env token', () => {
    expect(resolveGithubToken('input-tok', { GITHUB_TOKEN: 'env-tok' })).toBe('input-tok')
  })

  it('falls back to GITHUB_TOKEN', () => {
    expect(resolveGithubToken(undefined, { GITHUB_TOKEN: 'env-tok' })).toBe('env-tok')
  })

  it('returns undefined when neither is set', () => {
    expect(resolveGithubToken(undefined, {})).toBeUndefined()
  })
})

describe('aiAllowedForStrategy', () => {
  it('disables AI for lint-only PRs (zero LLM cost)', () => {
    expect(aiAllowedForStrategy('lint-only')).toBe(false)
  })

  it('allows AI for every other strategy', () => {
    expect(aiAllowedForStrategy('spec-verify')).toBe(true)
    expect(aiAllowedForStrategy('code-drift')).toBe(true)
    expect(aiAllowedForStrategy('full')).toBe(true)
  })
})

describe('deltaGateSummary', () => {
  it('counts only the new findings, by severity', () => {
    const summary = deltaGateSummary([
      finding({ severity: 'error' }),
      finding({ severity: 'warning' }),
      finding({ severity: 'warning' }),
      finding({ severity: 'info' }),
      finding({ severity: 'error', autoFixed: true }),
    ])
    expect(summary).toEqual({ total: 5, errors: 2, warnings: 2, info: 1, autoFixed: 1 })
  })

  it('is all-zero for an empty delta', () => {
    expect(deltaGateSummary([])).toEqual({
      total: 0,
      errors: 0,
      warnings: 0,
      info: 0,
      autoFixed: 0,
    })
  })
})

describe('isSafeGitRef', () => {
  it('accepts normal branch names', () => {
    expect(isSafeGitRef('main')).toBe(true)
    expect(isSafeGitRef('release-1.x')).toBe(true)
    expect(isSafeGitRef('feature/foo_bar.2')).toBe(true)
  })

  it('rejects refs with shell metacharacters or spaces', () => {
    expect(isSafeGitRef('main; rm -rf /')).toBe(false)
    expect(isSafeGitRef('a b')).toBe(false)
    expect(isSafeGitRef('$(evil)')).toBe(false)
    expect(isSafeGitRef('')).toBe(false)
  })

  it('rejects refs that would parse as git options', () => {
    expect(isSafeGitRef('--mirror')).toBe(false)
  })
})

describe('parseHandlerLocation', () => {
  it('parses the grounding "registered in file:line" message', () => {
    const location = parseHandlerLocation(
      'GET /users is registered in internal/routes.go:42 but not documented in the spec.',
    )
    expect(location).toEqual({ file: 'internal/routes.go', line: 42 })
  })

  it('parses the "discovered in file:line" variant', () => {
    const location = parseHandlerLocation(
      'Endpoint discovered in api/handlers.go:7 but not documented in the OpenAPI spec.',
    )
    expect(location).toEqual({ file: 'api/handlers.go', line: 7 })
  })

  it('returns undefined when the message has no handler location', () => {
    expect(parseHandlerLocation('operationId is missing')).toBeUndefined()
  })
})

describe('locateFindings', () => {
  const spec = [
    'openapi: 3.0.3',
    'info:',
    '  title: Demo',
    'paths:',
    '  /users:',
    '    get:',
    '      summary: List',
  ].join('\n')

  it('resolves spec-path findings to a spec line', () => {
    const located = locateFindings(
      [finding({ path: ['paths', '/users', 'get'] })],
      spec,
      'api/openapi.yaml',
    )
    expect(located).toEqual([
      {
        finding: expect.objectContaining({ id: 'f1' }) as ReportFinding,
        file: 'api/openapi.yaml',
        line: 6,
        target: 'spec',
      },
    ])
  })

  it('locates undocumented-endpoint findings on the handler file', () => {
    const undocumented = finding({
      rule: 'SPEC_CODE_UNDOCUMENTED_ENDPOINT',
      message: 'GET /orders is registered in routes.go:12 but not documented in the spec.',
      path: ['paths', '/orders'],
    })
    const located = locateFindings([undocumented], spec, 'api/openapi.yaml')
    expect(located).toHaveLength(1)
    expect(located[0]).toMatchObject({ file: 'routes.go', line: 12, target: 'handler' })
  })

  it('drops findings with neither a spec path nor a handler location', () => {
    expect(locateFindings([finding()], spec, 'api/openapi.yaml')).toEqual([])
  })
})

describe('inlineCommentBody', () => {
  it('includes rule, message and the suggested change', () => {
    const body = inlineCommentBody(
      finding({ before: 'summary: List', after: 'summary: List all users' }),
    )
    expect(body).toContain('mcp-operationid-required')
    expect(body).toContain('operationId is missing')
    expect(body).toContain('summary: List all users')
    expect(body).toContain('```')
  })

  it('surfaces the LOW-confidence warning prominently', () => {
    const body = inlineCommentBody(finding({ confidence: 'LOW', message: 'spec/code mismatch' }))
    expect(body).toContain('⚠')
    expect(body).toContain('LOW confidence')
  })
})

describe('parseChoice', () => {
  it('accepts values from the union and passes undefined through', () => {
    expect(parseChoice(undefined, ['high', 'medium', 'low'] as const)).toEqual({
      ok: true,
      value: undefined,
    })
    expect(parseChoice('medium', ['high', 'medium', 'low'] as const)).toEqual({
      ok: true,
      value: 'medium',
    })
  })

  it('rejects unknown values with the allowed list in the message', () => {
    const result = parseChoice('yolo', ['error', 'warning', 'never'] as const)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.message).toContain('error | warning | never')
  })
})

describe('findingMarkerKey', () => {
  it('is stable across message re-wordings and run-scoped ids', () => {
    const a = finding({ id: 'x', message: 'first wording', path: ['paths', '/users', 'get'] })
    const b = finding({
      id: 'y',
      message: 'totally different words',
      path: ['paths', '/users', 'get'],
    })
    expect(findingMarkerKey(a)).toBe(findingMarkerKey(b))
  })

  it('differs per rule/operation/path and is marker-safe', () => {
    const a = finding({ path: ['paths', '/users', 'get'] })
    const b = finding({ path: ['paths', '/orders', 'get'] })
    expect(findingMarkerKey(a)).not.toBe(findingMarkerKey(b))
    expect(findingMarkerKey(a)).toMatch(/^[0-9a-f]{16}$/)
  })
})

describe('renamedFrom', () => {
  const nameStatus = [
    'M\tsrc/main.go',
    'R097\tapi/openapi.yaml\tspec/openapi.yaml',
    'A\tdocs/new.md',
  ].join('\n')

  it('returns the old path for a renamed head path', () => {
    expect(renamedFrom(nameStatus, 'spec/openapi.yaml')).toBe('api/openapi.yaml')
  })

  it('returns undefined for non-renamed paths', () => {
    expect(renamedFrom(nameStatus, 'src/main.go')).toBeUndefined()
    expect(renamedFrom(nameStatus, 'api/openapi.yaml')).toBeUndefined()
    expect(renamedFrom('', 'spec/openapi.yaml')).toBeUndefined()
  })
})

describe('parseAppliedFixCount', () => {
  it('reads the applied count from fix-mode stdout', () => {
    expect(parseAppliedFixCount('Applied 7 fix(es), skipped 2.')).toBe(7)
    expect(parseAppliedFixCount('⚠ warning\nApplied 0 fix(es), skipped 0.\nMore')).toBe(0)
  })

  it('returns undefined when the line is absent', () => {
    expect(parseAppliedFixCount('Could not read spec file')).toBeUndefined()
  })
})

describe('neutralizeMentions / mdCell', () => {
  it('breaks @-mentions with a zero-width space', () => {
    const out = neutralizeMentions('ping @octocat and @org/team')
    expect(out).not.toContain('@octocat')
    expect(out).toContain('@\u200bocto')
  })

  it('keeps table cells one line, pipe-safe and mention-safe', () => {
    expect(mdCell('a|b\nc @user')).toBe('a\\|b c @\u200buser')
  })
})

describe('markdown injection hardening', () => {
  it('escapes pipes and mentions in the new-findings table', () => {
    const section = renderNewFindingsSection([
      finding({ operation: 'GET /x', message: 'evil | cell @octocat' }),
    ])
    expect(section).toContain('evil \\| cell')
    expect(section).not.toContain('@octocat')
  })

  it('uses a fence longer than any backtick run in the snippet', () => {
    const body = inlineCommentBody(
      finding({ before: 'x', after: 'description: ```\nescape attempt\n```' }),
    )
    expect(body).toContain('````yaml')
    expect(body).toContain('\n````')
  })

  it('neutralizes mentions in the inline comment message', () => {
    const body = inlineCommentBody(finding({ message: 'thanks @octocat' }))
    expect(body).not.toContain('@octocat')
  })
})

describe('renderNewFindingsSection', () => {
  it('renders a table of new findings', () => {
    const section = renderNewFindingsSection([finding({ operation: 'GET /users' })])
    expect(section).toContain('New in this PR')
    expect(section).toContain('mcp-operationid-required')
    expect(section).toContain('GET /users')
  })

  it('says so when the PR introduces nothing new', () => {
    expect(renderNewFindingsSection([])).toContain('No new findings')
  })
})
