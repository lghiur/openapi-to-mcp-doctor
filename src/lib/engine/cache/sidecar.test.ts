import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  hashSpec,
  readSidecar,
  sidecarPathFor,
  withSpecCache,
  writeSidecar,
} from '@/lib/engine/cache/sidecar'
import type { Finding } from '@/types/domain'

const dirs: string[] = []
async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'mcp-cache-'))
  dirs.push(dir)
  return dir
}
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })))
})

const finding: Finding = {
  id: 'f1',
  agentId: 'structural-linter',
  rule: 'mcp-operationid-required',
  severity: 'error',
  confidence: 'HIGH',
  message: 'missing',
  autoFixable: false,
  autoFixed: false,
  resolution: 'pending',
}

describe('hashSpec', () => {
  it('is deterministic and content-sensitive', () => {
    expect(hashSpec('a')).toBe(hashSpec('a'))
    expect(hashSpec('a')).not.toBe(hashSpec('b'))
  })
})

describe('sidecarPathFor', () => {
  it('places .mcp-doctor.yaml next to the spec', () => {
    expect(sidecarPathFor('/repo/api/openapi.yaml')).toBe('/repo/api/.mcp-doctor.yaml')
  })
})

describe('readSidecar / writeSidecar', () => {
  it('round-trips a cache record including the v2 handlerHash stub', async () => {
    const dir = await tempDir()
    const path = join(dir, '.mcp-doctor.yaml')
    await writeSidecar(path, {
      schemaVersion: 1,
      specHash: 'abc',
      generatedAt: '2026-06-24T00:00:00Z',
      findings: [finding],
      summary: { total: 1, errors: 1, warnings: 0, info: 0 },
      operations: [{ label: 'GET /users', handlerHash: 'deadbeef' }],
    })
    const cache = await readSidecar(path)
    expect(cache?.specHash).toBe('abc')
    expect(cache?.operations[0]).toEqual({ label: 'GET /users', handlerHash: 'deadbeef' })
    expect(cache?.findings[0]?.rule).toBe('mcp-operationid-required')
  })

  it('returns null for a missing sidecar', async () => {
    const dir = await tempDir()
    expect(await readSidecar(join(dir, 'nope.yaml'))).toBeNull()
  })
})

/**
 * The sidecar is a committed/committable file an attacker (or a merge accident)
 * can poison. A malformed record must read as a cache miss — never crash the
 * run or spoof findings into the report.
 */
describe('readSidecar — shape validation', () => {
  async function poisoned(content: string): Promise<string> {
    const dir = await tempDir()
    const path = join(dir, '.mcp-doctor.yaml')
    await writeFile(path, content)
    return path
  }

  it('treats findings that are not an array as a cache miss', async () => {
    const path = await poisoned(
      `schemaVersion: 2\nspecHash: abc\ngeneratedAt: '2026-01-01'\nfindings: not-an-array\nsummary:\n  total: 0\n  errors: 0\n  warnings: 0\n  info: 0\noperations: []\n`,
    )
    expect(await readSidecar(path)).toBeNull()
  })

  it('treats spoofed finding entries (wrong field types) as a cache miss', async () => {
    const path = await poisoned(
      `schemaVersion: 2\nspecHash: abc\ngeneratedAt: '2026-01-01'\nfindings:\n  - id: f1\n    severity:\n      evil: true\nsummary:\n  total: 1\n  errors: 1\n  warnings: 0\n  info: 0\noperations: []\n`,
    )
    expect(await readSidecar(path)).toBeNull()
  })

  it('treats a missing summary as a cache miss', async () => {
    const path = await poisoned(
      `schemaVersion: 2\nspecHash: abc\ngeneratedAt: '2026-01-01'\nfindings: []\noperations: []\n`,
    )
    expect(await readSidecar(path)).toBeNull()
  })

  it('treats malformed operations entries as a cache miss', async () => {
    const path = await poisoned(
      `schemaVersion: 2\nspecHash: abc\ngeneratedAt: '2026-01-01'\nfindings: []\nsummary:\n  total: 0\n  errors: 0\n  warnings: 0\n  info: 0\noperations:\n  - 42\n`,
    )
    expect(await readSidecar(path)).toBeNull()
  })

  it('never throws on scalar or garbage YAML content', async () => {
    expect(await readSidecar(await poisoned('just a string'))).toBeNull()
    expect(await readSidecar(await poisoned('42'))).toBeNull()
  })
})

describe('withSpecCache', () => {
  it('computes and writes the cache on a cold start', async () => {
    const dir = await tempDir()
    const path = join(dir, '.mcp-doctor.yaml')
    const compute = vi.fn(async () => ({
      findings: [finding],
      summary: { total: 1, errors: 1, warnings: 0, info: 0 },
      operations: ['GET /users'],
    }))
    const result = await withSpecCache({ sidecarPath: path, specHash: 'h1', compute })
    expect(compute).toHaveBeenCalledTimes(1)
    expect(result.fromCache).toBe(false)
    // sidecar written
    expect(JSON.parse(JSON.stringify(await readSidecar(path)))?.specHash).toBe('h1')
  })

  it('returns cached findings with zero compute on a warm cache', async () => {
    const dir = await tempDir()
    const path = join(dir, '.mcp-doctor.yaml')
    const compute = vi.fn(async () => ({
      findings: [finding],
      summary: { total: 1, errors: 1, warnings: 0, info: 0 },
      operations: ['GET /users'],
    }))
    await withSpecCache({ sidecarPath: path, specHash: 'h1', compute }) // cold
    compute.mockClear()

    const warm = await withSpecCache({ sidecarPath: path, specHash: 'h1', compute })
    expect(compute).not.toHaveBeenCalled()
    expect(warm.fromCache).toBe(true)
    expect(warm.findings[0]?.rule).toBe('mcp-operationid-required')
  })

  it('recomputes when the spec hash changes', async () => {
    const dir = await tempDir()
    const path = join(dir, '.mcp-doctor.yaml')
    const compute = vi.fn(async () => ({
      findings: [finding],
      summary: { total: 1, errors: 1, warnings: 0, info: 0 },
      operations: ['GET /users'],
    }))
    await withSpecCache({ sidecarPath: path, specHash: 'h1', compute })
    compute.mockClear()
    const result = await withSpecCache({ sidecarPath: path, specHash: 'h2', compute })
    expect(compute).toHaveBeenCalledTimes(1)
    expect(result.fromCache).toBe(false)
  })
})
