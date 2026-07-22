import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { withAnalysisCache, type CachedComputation } from '@/lib/engine/cache/sidecar'
import { hashOperationHandlers } from '@/lib/engine/grounding'
import { extractOperations } from '@/lib/engine/operations'
import type { Finding } from '@/types/domain'

const dirs: string[] = []
async function sidecarIn(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'mcp-cache-grounding-'))
  dirs.push(dir)
  return join(dir, '.mcp-doctor.yaml')
}
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })))
})

function specFinding(id: string): Finding {
  return {
    id,
    agentId: 'structural-linter',
    rule: 'mcp-operationid-required',
    severity: 'warning',
    confidence: 'HIGH',
    message: 'spec finding',
    autoFixable: false,
    autoFixed: false,
    resolution: 'pending',
  }
}

function mismatch(op: string): Finding {
  return {
    id: `mismatch-${op}`,
    agentId: 'worker',
    operation: op,
    rule: 'SPEC_CODE_MISMATCH',
    severity: 'warning',
    confidence: 'LOW',
    message: 'spec says X, code does Y',
    autoFixable: false,
    autoFixed: false,
    resolution: 'pending',
  }
}

const SPEC_RESULT: CachedComputation = {
  findings: [specFinding('s1')],
  summary: { total: 1, errors: 0, warnings: 1, info: 0 },
  operations: ['GET /users', 'GET /items'],
}

const HASHES_V1 = { 'GET /users': 'hash-u1', 'GET /items': 'hash-i1' }

function makeComputes() {
  const computeSpec = vi.fn(async () => SPEC_RESULT)
  const computeGrounding = vi.fn(async (stale: string[]) =>
    Object.fromEntries(stale.map((op) => [op, [mismatch(op)]])),
  )
  return { computeSpec, computeGrounding }
}

describe('withAnalysisCache — the four cache scenarios', () => {
  it('scenario 1 (cold start): computes spec quality and grounding for every operation', async () => {
    const sidecarPath = await sidecarIn()
    const { computeSpec, computeGrounding } = makeComputes()
    const result = await withAnalysisCache({
      sidecarPath,
      specHash: 'spec-a',
      computeSpec,
      handlerHashes: HASHES_V1,
      computeGrounding,
    })
    expect(computeSpec).toHaveBeenCalledOnce()
    expect(computeGrounding).toHaveBeenCalledWith(['GET /users', 'GET /items'])
    expect(result.specFromCache).toBe(false)
    expect(result.groundingReused).toEqual([])
    expect(result.findings.map((f) => f.id)).toContain('s1')
    expect(result.groundingFindings['GET /users']?.[0]?.rule).toBe('SPEC_CODE_MISMATCH')
  })

  it('scenario 2 (nothing changed): zero compute, everything reused', async () => {
    const sidecarPath = await sidecarIn()
    const first = makeComputes()
    await withAnalysisCache({
      sidecarPath,
      specHash: 'spec-a',
      computeSpec: first.computeSpec,
      handlerHashes: HASHES_V1,
      computeGrounding: first.computeGrounding,
    })

    const second = makeComputes()
    const result = await withAnalysisCache({
      sidecarPath,
      specHash: 'spec-a',
      computeSpec: second.computeSpec,
      handlerHashes: HASHES_V1,
      computeGrounding: second.computeGrounding,
    })
    expect(second.computeSpec).not.toHaveBeenCalled()
    expect(second.computeGrounding).not.toHaveBeenCalled()
    expect(result.specFromCache).toBe(true)
    expect(result.groundingReused.sort()).toEqual(['GET /items', 'GET /users'])
    expect(result.groundingFindings['GET /items']?.[0]?.rule).toBe('SPEC_CODE_MISMATCH')
  })

  it('scenario 3 (spec changed, code unchanged): re-runs spec quality only, reuses grounding', async () => {
    const sidecarPath = await sidecarIn()
    const first = makeComputes()
    await withAnalysisCache({
      sidecarPath,
      specHash: 'spec-a',
      computeSpec: first.computeSpec,
      handlerHashes: HASHES_V1,
      computeGrounding: first.computeGrounding,
    })

    const second = makeComputes()
    const result = await withAnalysisCache({
      sidecarPath,
      specHash: 'spec-b', // spec changed
      computeSpec: second.computeSpec,
      handlerHashes: HASHES_V1, // code unchanged
      computeGrounding: second.computeGrounding,
    })
    expect(second.computeSpec).toHaveBeenCalledOnce()
    expect(second.computeGrounding).not.toHaveBeenCalled()
    expect(result.specFromCache).toBe(false)
    expect(result.groundingReused.sort()).toEqual(['GET /items', 'GET /users'])
  })

  it('scenario 4 (code changed, spec unchanged): re-runs only the changed handlers', async () => {
    const sidecarPath = await sidecarIn()
    const first = makeComputes()
    await withAnalysisCache({
      sidecarPath,
      specHash: 'spec-a',
      computeSpec: first.computeSpec,
      handlerHashes: HASHES_V1,
      computeGrounding: first.computeGrounding,
    })

    const second = makeComputes()
    const result = await withAnalysisCache({
      sidecarPath,
      specHash: 'spec-a', // spec unchanged
      computeSpec: second.computeSpec,
      handlerHashes: { ...HASHES_V1, 'GET /items': 'hash-i2' }, // one handler changed
      computeGrounding: second.computeGrounding,
    })
    expect(second.computeSpec).not.toHaveBeenCalled()
    expect(second.computeGrounding).toHaveBeenCalledWith(['GET /items'])
    expect(result.specFromCache).toBe(true)
    expect(result.groundingReused).toEqual(['GET /users'])
    expect(result.groundingRecomputed).toEqual(['GET /items'])
  })

  it('both changed: independent hash checks recompute spec and only the stale handlers', async () => {
    const sidecarPath = await sidecarIn()
    const first = makeComputes()
    await withAnalysisCache({
      sidecarPath,
      specHash: 'spec-a',
      computeSpec: first.computeSpec,
      handlerHashes: HASHES_V1,
      computeGrounding: first.computeGrounding,
    })

    const second = makeComputes()
    await withAnalysisCache({
      sidecarPath,
      specHash: 'spec-b',
      computeSpec: second.computeSpec,
      handlerHashes: { ...HASHES_V1, 'GET /users': 'hash-u2' },
      computeGrounding: second.computeGrounding,
    })
    expect(second.computeSpec).toHaveBeenCalledOnce()
    expect(second.computeGrounding).toHaveBeenCalledWith(['GET /users'])
  })

  it('an operation whose grounding was not returned (failure) is recomputed next run', async () => {
    const sidecarPath = await sidecarIn()
    const computeSpec = vi.fn(async () => SPEC_RESULT)
    // first run: /items detection failed, so it reports nothing for that op
    const failingGrounding = vi.fn(async (stale: string[]) =>
      Object.fromEntries(
        stale.filter((op) => op !== 'GET /items').map((op) => [op, [mismatch(op)]]),
      ),
    )
    await withAnalysisCache({
      sidecarPath,
      specHash: 'spec-a',
      computeSpec,
      handlerHashes: HASHES_V1,
      computeGrounding: failingGrounding,
    })

    const second = makeComputes()
    await withAnalysisCache({
      sidecarPath,
      specHash: 'spec-a',
      computeSpec: second.computeSpec,
      handlerHashes: HASHES_V1,
      computeGrounding: second.computeGrounding,
    })
    expect(second.computeGrounding).toHaveBeenCalledWith(['GET /items'])
  })
})

describe('hashOperationHandlers', () => {
  const SPEC = `openapi: 3.0.3
info:
  title: T
  version: 1.0.0
paths:
  /users:
    get:
      operationId: list_users
  /items:
    get:
      operationId: list_items`

  const ROUTES = [
    {
      path: 'routes.go',
      content: `package main
func routes() {
	mux.HandleFunc("GET /users", listUsers)
	mux.HandleFunc("GET /items", listItems)
}
func listUsers(w http.ResponseWriter, r *http.Request) {}
func listItems(w http.ResponseWriter, r *http.Request) {}
`,
    },
  ]

  it('gives every operation a hash, stable across identical inputs', () => {
    const operations = extractOperations(SPEC)
    const a = hashOperationHandlers(operations, ROUTES)
    const b = hashOperationHandlers(operations, ROUTES)
    expect(Object.keys(a).sort()).toEqual(['GET /items', 'GET /users'])
    expect(a).toEqual(b)
  })

  it('changes the hash when a mapped handler file changes', () => {
    const operations = extractOperations(SPEC)
    const before = hashOperationHandlers(operations, ROUTES)
    const changed = [
      { path: 'routes.go', content: ROUTES[0]!.content.replace('listItems)', 'listItemsV2)') },
    ]
    const after = hashOperationHandlers(operations, changed)
    expect(after['GET /items']).not.toBe(before['GET /items'])
  })

  it("changes the hash when the operation's spec fragment changes (spec edits invalidate grounding too)", () => {
    const before = hashOperationHandlers(extractOperations(SPEC), ROUTES)
    const specChanged = SPEC.replace(
      'operationId: list_items',
      'operationId: list_items\n      description: Now returns 204 No Content.',
    )
    const after = hashOperationHandlers(extractOperations(specChanged), ROUTES)
    // The edited operation's grounding key changes — a cached spec⇄code mismatch
    // finding about the old description must not be replayed.
    expect(after['GET /items']).not.toBe(before['GET /items'])
    // Untouched operations keep their key and reuse their grounding.
    expect(after['GET /users']).toBe(before['GET /users'])
  })
})
