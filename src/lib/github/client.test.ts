import type { Octokit } from '@octokit/rest'
import { describe, expect, it, vi } from 'vitest'
import { githubClient } from '@/lib/github/client'
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
    const out = await githubClient(octokit).listSourceCandidates('o', 'r', 'main')
    expect(out).toContain('internal/handlers/users.go')
    expect(out).toContain('db/users.go')
    expect(out).toContain('main.go')
    expect(out).not.toContain('vendor/x/y.go')
    expect(out).not.toContain('handlers/users_test.go')
    expect(out).not.toContain('node_modules/a/index.js')
    expect(out).not.toContain('README.md')
    expect(out.indexOf('internal/handlers/users.go')).toBeLessThan(out.indexOf('db/users.go'))
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
    expect(specs).toEqual(['api/openapi.yaml', 'spec.json'])
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
