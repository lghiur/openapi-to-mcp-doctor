import type { Octokit } from '@octokit/rest'
import { describe, expect, it, vi } from 'vitest'
import { githubClient, MAX_REPO_PAGES, READ_CONCURRENCY } from '@/lib/github/client'
import { buildPrBody } from '@/lib/github/pr'
import type { AnalysisReport } from '@/types/api'

function mockOctokit(overrides: Record<string, unknown>): Octokit {
  return overrides as unknown as Octokit
}

describe('githubClient.readFile', () => {
  it('decodes base64 file content', async () => {
    const octokit = mockOctokit({
      repos: {
        getContent: vi.fn().mockResolvedValue({
          data: { type: 'file', content: Buffer.from('openapi: 3.0.3').toString('base64') },
        }),
      },
    })
    const content = await githubClient(octokit).readFile('o', 'r', 'api.yaml', 'main')
    expect(content).toBe('openapi: 3.0.3')
  })
})

describe('githubClient.listRepos', () => {
  it('paginates until a short page', async () => {
    const page = (n: number, count: number) =>
      Array.from({ length: count }, (_, i) => ({
        full_name: `o/repo-${n}-${i}`,
        default_branch: 'main',
        private: false,
      }))
    const listForAuthenticatedUser = vi
      .fn()
      .mockResolvedValueOnce({ data: page(1, 100) })
      .mockResolvedValueOnce({ data: page(2, 100) })
      .mockResolvedValueOnce({ data: page(3, 7) })
    const repos = await githubClient(
      mockOctokit({ repos: { listForAuthenticatedUser } }),
    ).listRepos()

    expect(listForAuthenticatedUser).toHaveBeenCalledTimes(3)
    expect(repos).toHaveLength(207)
    expect(repos[206]?.fullName).toBe('o/repo-3-6')
  })

  it('stops at the page cap so a pathological account cannot hang the UI', async () => {
    const listForAuthenticatedUser = vi.fn().mockResolvedValue({
      data: Array.from({ length: 100 }, (_, i) => ({
        full_name: `o/repo-${i}`,
        default_branch: 'main',
        private: false,
      })),
    })
    const repos = await githubClient(
      mockOctokit({ repos: { listForAuthenticatedUser } }),
    ).listRepos()

    expect(listForAuthenticatedUser).toHaveBeenCalledTimes(MAX_REPO_PAGES)
    expect(repos).toHaveLength(MAX_REPO_PAGES * 100)
  })
})

describe('githubClient.listSourceCandidates', () => {
  it('returns source files (handler-ish first), excluding tests/vendor/deps', async () => {
    const octokit = mockOctokit({
      git: {
        getTree: vi.fn().mockResolvedValue({
          data: {
            tree: [
              { type: 'blob', path: 'internal/handlers/users.go' },
              { type: 'blob', path: 'README.md' },
              { type: 'blob', path: 'db/users.go' },
              { type: 'blob', path: 'vendor/x/y.go' },
              { type: 'blob', path: 'handlers/users_test.go' },
              { type: 'blob', path: 'node_modules/a/index.js' },
              { type: 'blob', path: 'main.go' },
              { type: 'tree', path: 'internal' },
            ],
          },
        }),
      },
    })
    const { paths, truncated } = await githubClient(octokit).listSourceCandidates('o', 'r', 'main')
    expect(truncated).toBe(false)
    expect(paths).toContain('internal/handlers/users.go')
    expect(paths).toContain('db/users.go')
    expect(paths).toContain('main.go')
    expect(paths).not.toContain('vendor/x/y.go')
    expect(paths).not.toContain('handlers/users_test.go')
    expect(paths).not.toContain('node_modules/a/index.js')
    expect(paths).not.toContain('README.md')
    expect(paths.indexOf('internal/handlers/users.go')).toBeLessThan(paths.indexOf('db/users.go'))
  })

  it("reports GitHub's truncated tree so callers do not treat a partial listing as complete", async () => {
    const octokit = mockOctokit({
      git: {
        getTree: vi.fn().mockResolvedValue({
          data: { truncated: true, tree: [{ type: 'blob', path: 'main.go' }] },
        }),
      },
    })
    const listing = await githubClient(octokit).listSourceCandidates('o', 'r', 'main')
    expect(listing.truncated).toBe(true)
    expect(listing.paths).toEqual(['main.go'])
  })
})

describe('githubClient.readFiles', () => {
  it('reports how many reads failed instead of silently dropping them', async () => {
    const octokit = mockOctokit({
      repos: {
        getContent: vi.fn(async ({ path }: { path: string }) => {
          if (path === 'bad.go') throw new Error('403: forbidden')
          return { data: { type: 'file', content: Buffer.from(path).toString('base64') } }
        }),
      },
    })
    const result = await githubClient(octokit).readFiles(
      'o',
      'r',
      ['a.go', 'bad.go', 'b.go'],
      'main',
    )
    expect(result.files.map((f) => f.path)).toEqual(['a.go', 'b.go'])
    expect(result.failed).toBe(1)
  })

  it('never runs more than READ_CONCURRENCY reads at once', async () => {
    let inFlight = 0
    let peak = 0
    const octokit = mockOctokit({
      repos: {
        getContent: vi.fn(async ({ path }: { path: string }) => {
          inFlight++
          peak = Math.max(peak, inFlight)
          await new Promise((resolve) => setTimeout(resolve, 1))
          inFlight--
          return { data: { type: 'file', content: Buffer.from(path).toString('base64') } }
        }),
      },
    })
    const paths = Array.from({ length: 40 }, (_, i) => `f${i}.go`)
    const result = await githubClient(octokit).readFiles('o', 'r', paths, 'main')

    expect(result.files).toHaveLength(40)
    expect(peak).toBeLessThanOrEqual(READ_CONCURRENCY)
  })
})

describe('githubClient.listSpecCandidates', () => {
  it('returns only yaml/json blobs', async () => {
    const octokit = mockOctokit({
      git: {
        getTree: vi.fn().mockResolvedValue({
          data: {
            tree: [
              { type: 'blob', path: 'api/openapi.yaml' },
              { type: 'blob', path: 'README.md' },
              { type: 'blob', path: 'spec.json' },
              { type: 'tree', path: 'api' },
            ],
          },
        }),
      },
    })
    const specs = await githubClient(octokit).listSpecCandidates('o', 'r', 'main')
    expect(specs).toEqual({ paths: ['api/openapi.yaml', 'spec.json'], truncated: false })
  })
})

describe('githubClient.createFixPr', () => {
  it('creates a branch, commits the file, and opens a PR', async () => {
    const createRef = vi.fn().mockResolvedValue({ data: {} })
    const create = vi.fn().mockResolvedValue({ data: { html_url: 'https://pr/1', number: 1 } })
    const octokit = mockOctokit({
      git: {
        getRef: vi.fn().mockResolvedValue({ data: { object: { sha: 'base-sha' } } }),
        createRef,
      },
      repos: {
        getContent: vi.fn().mockRejectedValue(new Error('404')),
        createOrUpdateFileContents: vi.fn().mockResolvedValue({ data: {} }),
      },
      pulls: { create },
    })

    const result = await githubClient(octokit).createFixPr({
      owner: 'o',
      repo: 'r',
      baseBranch: 'main',
      headBranch: 'mcp-doctor/fix',
      path: 'api.yaml',
      content: 'openapi: 3.1.0',
      commitMessage: 'fix',
      title: 'Fix',
      body: 'body',
    })

    expect(createRef).toHaveBeenCalledWith(
      expect.objectContaining({ ref: 'refs/heads/mcp-doctor/fix', sha: 'base-sha' }),
    )
    expect(create).toHaveBeenCalled()
    expect(result).toEqual({ url: 'https://pr/1', number: 1 })
  })

  it('force-resets an existing branch when createRef fails with 422', async () => {
    const createRef = vi
      .fn()
      .mockRejectedValue(Object.assign(new Error('Reference already exists'), { status: 422 }))
    const updateRef = vi.fn().mockResolvedValue({ data: {} })
    const create = vi.fn().mockResolvedValue({ data: { html_url: 'https://pr/2', number: 2 } })
    const octokit = mockOctokit({
      git: {
        getRef: vi.fn().mockResolvedValue({ data: { object: { sha: 'base-sha' } } }),
        createRef,
        updateRef,
      },
      repos: {
        getContent: vi.fn().mockRejectedValue(new Error('404')),
        createOrUpdateFileContents: vi.fn().mockResolvedValue({ data: {} }),
      },
      pulls: { create },
    })

    const result = await githubClient(octokit).createFixPr({
      owner: 'o',
      repo: 'r',
      baseBranch: 'main',
      headBranch: 'mcp-doctor/fix',
      path: 'api.yaml',
      content: 'openapi: 3.1.0',
      commitMessage: 'fix',
      title: 'Fix',
      body: 'body',
    })

    expect(updateRef).toHaveBeenCalledWith(
      expect.objectContaining({ ref: 'heads/mcp-doctor/fix', sha: 'base-sha', force: true }),
    )
    expect(result).toEqual({ url: 'https://pr/2', number: 2 })
  })

  it('rethrows a permission failure on createRef instead of retrying as updateRef', async () => {
    const createRef = vi
      .fn()
      .mockRejectedValue(Object.assign(new Error('Resource not accessible by integration'), { status: 403 }))
    const updateRef = vi.fn().mockResolvedValue({ data: {} })
    const octokit = mockOctokit({
      git: {
        getRef: vi.fn().mockResolvedValue({ data: { object: { sha: 'base-sha' } } }),
        createRef,
        updateRef,
      },
      repos: {
        getContent: vi.fn().mockRejectedValue(new Error('404')),
        createOrUpdateFileContents: vi.fn().mockResolvedValue({ data: {} }),
      },
      pulls: { create: vi.fn() },
    })

    await expect(
      githubClient(octokit).createFixPr({
        owner: 'o',
        repo: 'r',
        baseBranch: 'main',
        headBranch: 'mcp-doctor/fix',
        path: 'api.yaml',
        content: 'openapi: 3.1.0',
        commitMessage: 'fix',
        title: 'Fix',
        body: 'body',
      }),
    ).rejects.toThrow(/not accessible by integration/)
    expect(updateRef).not.toHaveBeenCalled()
  })
})

describe('buildPrBody', () => {
  it('summarizes applied changes', () => {
    const report: AnalysisReport = {
      runId: 'r',
      timestamp: 't',
      spec: { file: 'api.yaml', version: '3.0.3', operationCount: 1 },
      mcpSpecVersion: '2025-11-25',
      mode: 'fix',
      mismatchMode: 'flag',
      durationMs: 1,
      summary: { total: 1, errors: 1, warnings: 0, info: 0, autoFixed: 1 },
      agents: [],
      findings: [
        {
          id: 'f1',
          agentId: 'structural-linter',
          operation: 'GET /users',
          rule: 'mcp-operationid-format',
          severity: 'error',
          confidence: 'HIGH',
          message: 'm',
          autoFixed: true,
          resolution: 'auto-fixed',
        },
      ],
    }
    const body = buildPrBody(report)
    expect(body).toContain('**1** change(s) applied')
    expect(body).toContain('mcp-operationid-format')
  })
})
