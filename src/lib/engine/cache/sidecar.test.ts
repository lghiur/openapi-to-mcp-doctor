import { mkdtemp, rm } from 'node:fs/promises'
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
