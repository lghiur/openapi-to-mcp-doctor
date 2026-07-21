import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { Behavior } from './types'
import { effectiveBehavior, loadPrContext, parsePrContext } from './context'

const dirs: string[] = []
async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'mcp-ghctx-'))
  dirs.push(dir)
  return dir
}
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })))
})

function prPayload(overrides: { headRepo?: string; merged?: boolean; action?: string } = {}) {
  return {
    action: overrides.action ?? 'opened',
    pull_request: {
      number: 42,
      merged: overrides.merged ?? false,
      head: {
        ref: 'feature/spec-tweaks',
        sha: 'abc123def456',
        repo: { full_name: overrides.headRepo ?? 'tyk/api' },
      },
      base: {
        ref: 'master',
        repo: { full_name: 'tyk/api' },
      },
    },
  }
}

const prEnv = {
  GITHUB_EVENT_NAME: 'pull_request',
  GITHUB_REPOSITORY: 'tyk/api',
}

describe('parsePrContext', () => {
  it('parses a same-repo pull_request event', () => {
    const ctx = parsePrContext(prEnv, prPayload())
    expect(ctx).toEqual({
      eventName: 'pull_request',
      eventAction: 'opened',
      owner: 'tyk',
      repo: 'api',
      prNumber: 42,
      headRef: 'feature/spec-tweaks',
      headSha: 'abc123def456',
      baseRef: 'master',
      isFork: false,
      merged: false,
    })
  })

  it('marks fork PRs when head repo differs from base repo', () => {
    const ctx = parsePrContext(prEnv, prPayload({ headRepo: 'outsider/api' }))
    expect(ctx?.isFork).toBe(true)
  })

  it('carries merged=true on a closed+merged payload', () => {
    const ctx = parsePrContext(prEnv, prPayload({ action: 'closed', merged: true }))
    expect(ctx?.eventAction).toBe('closed')
    expect(ctx?.merged).toBe(true)
  })

  it('returns undefined for non-PR events (push)', () => {
    const ctx = parsePrContext(
      { GITHUB_EVENT_NAME: 'push', GITHUB_REPOSITORY: 'tyk/api' },
      { ref: 'refs/heads/master', commits: [] },
    )
    expect(ctx).toBeUndefined()
  })

  it('returns undefined for malformed payloads', () => {
    expect(parsePrContext(prEnv, { pull_request: { number: 'not-a-number' } })).toBeUndefined()
    expect(parsePrContext(prEnv, null)).toBeUndefined()
    expect(parsePrContext(prEnv, 'garbage')).toBeUndefined()
  })

  it('returns undefined when GITHUB_REPOSITORY is missing or malformed', () => {
    expect(parsePrContext({ GITHUB_EVENT_NAME: 'pull_request' }, prPayload())).toBeUndefined()
    expect(
      parsePrContext(
        { GITHUB_EVENT_NAME: 'pull_request', GITHUB_REPOSITORY: 'no-slash' },
        prPayload(),
      ),
    ).toBeUndefined()
  })

  it('accepts pull_request_target events', () => {
    const ctx = parsePrContext(
      { GITHUB_EVENT_NAME: 'pull_request_target', GITHUB_REPOSITORY: 'tyk/api' },
      prPayload(),
    )
    expect(ctx?.eventName).toBe('pull_request_target')
  })
})

describe('loadPrContext', () => {
  it('reads the event payload from GITHUB_EVENT_PATH', async () => {
    const dir = await tempDir()
    const eventPath = join(dir, 'event.json')
    await writeFile(eventPath, JSON.stringify(prPayload()), 'utf8')
    const ctx = await loadPrContext({ ...prEnv, GITHUB_EVENT_PATH: eventPath })
    expect(ctx?.prNumber).toBe(42)
  })

  it('returns undefined when GITHUB_EVENT_PATH is unset', async () => {
    await expect(loadPrContext(prEnv)).resolves.toBeUndefined()
  })

  it('returns undefined when the event file is missing or invalid JSON', async () => {
    const dir = await tempDir()
    await expect(
      loadPrContext({ ...prEnv, GITHUB_EVENT_PATH: join(dir, 'missing.json') }),
    ).resolves.toBeUndefined()
    const badPath = join(dir, 'bad.json')
    await writeFile(badPath, '{not json', 'utf8')
    await expect(loadPrContext({ ...prEnv, GITHUB_EVENT_PATH: badPath })).resolves.toBeUndefined()
  })
})

describe('effectiveBehavior', () => {
  const trusted = { isFork: false, hasToken: true }

  it('keeps the requested level for same-repo PRs with a token', () => {
    const behaviors: Behavior[] = ['summary', 'comment', 'review', 'fix-pr']
    for (const b of behaviors) {
      expect(effectiveBehavior(b, trusted)).toBe(b)
    }
  })

  it('degrades fork PRs to summary', () => {
    expect(effectiveBehavior('fix-pr', { isFork: true, hasToken: true })).toBe('summary')
    expect(effectiveBehavior('comment', { isFork: true, hasToken: true })).toBe('summary')
  })

  it('degrades to summary when no token is available', () => {
    expect(effectiveBehavior('review', { isFork: false, hasToken: false })).toBe('summary')
  })

  it('summary stays summary regardless of context', () => {
    expect(effectiveBehavior('summary', { isFork: true, hasToken: false })).toBe('summary')
  })
})
