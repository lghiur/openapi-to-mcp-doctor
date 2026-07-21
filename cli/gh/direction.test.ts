import { describe, expect, it } from 'vitest'
import { DirectionError, changedFilesViaGit, detectDirection } from './direction'

describe('detectDirection', () => {
  const specPath = 'docs/openapi.yaml'

  it('returns full when both spec and route files changed', () => {
    const result = detectDirection({
      changedFiles: ['docs/openapi.yaml', 'internal/api/handler.go'],
      specPath,
    })
    expect(result.specChanged).toBe(true)
    expect(result.routesChanged).toBe(true)
    expect(result.strategy).toBe('full')
    expect(result.changedFiles).toEqual(['docs/openapi.yaml', 'internal/api/handler.go'])
  })

  it('returns spec-verify when only the spec changed', () => {
    const result = detectDirection({ changedFiles: ['docs/openapi.yaml'], specPath })
    expect(result.specChanged).toBe(true)
    expect(result.routesChanged).toBe(false)
    expect(result.strategy).toBe('spec-verify')
  })

  it('returns code-drift when only route files changed', () => {
    const result = detectDirection({ changedFiles: ['internal/api/handler.go'], specPath })
    expect(result.specChanged).toBe(false)
    expect(result.routesChanged).toBe(true)
    expect(result.strategy).toBe('code-drift')
  })

  it('returns lint-only when neither spec nor route files changed', () => {
    const result = detectDirection({ changedFiles: ['README.md', 'Makefile'], specPath })
    expect(result.specChanged).toBe(false)
    expect(result.routesChanged).toBe(false)
    expect(result.strategy).toBe('lint-only')
  })

  it('normalizes ./ prefixes on both specPath and changed files', () => {
    expect(
      detectDirection({ changedFiles: ['./docs/openapi.yaml'], specPath: 'docs/openapi.yaml' })
        .specChanged,
    ).toBe(true)
    expect(
      detectDirection({ changedFiles: ['docs/openapi.yaml'], specPath: './docs/openapi.yaml' })
        .specChanged,
    ).toBe(true)
  })

  it('detects spec-shaped files that are not the configured spec path', () => {
    const result = detectDirection({ changedFiles: ['api/swagger.json'], specPath })
    expect(result.specChanged).toBe(true)
    expect(result.strategy).toBe('spec-verify')
  })

  it('does not count excluded source files as route changes', () => {
    const result = detectDirection({
      changedFiles: ['internal/api/foo_test.go', 'node_modules/lib/index.js', 'src/app.spec.ts'],
      specPath,
    })
    expect(result.routesChanged).toBe(false)
    expect(result.strategy).toBe('lint-only')
  })
})

describe('changedFilesViaGit', () => {
  it('runs git diff --name-only base...head and returns non-empty lines', async () => {
    const calls: { cmd: string; args: string[] }[] = []
    const exec = async (cmd: string, args: string[]) => {
      calls.push({ cmd, args })
      return { stdout: 'docs/openapi.yaml\ninternal/api/handler.go\n\n', exitCode: 0 }
    }
    const files = await changedFilesViaGit('main', 'abc123', exec)
    expect(calls).toEqual([{ cmd: 'git', args: ['diff', '--name-only', 'main...abc123'] }])
    expect(files).toEqual(['docs/openapi.yaml', 'internal/api/handler.go'])
  })

  it('throws DirectionError on non-zero exit so the caller can fetch and retry', async () => {
    const exec = async () => ({ stdout: '', exitCode: 128 })
    await expect(changedFilesViaGit('main', 'abc123', exec)).rejects.toBeInstanceOf(DirectionError)
    await expect(changedFilesViaGit('main', 'abc123', exec)).rejects.toThrow(/git diff/)
  })
})
