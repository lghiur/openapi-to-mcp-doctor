import { copyFile, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { AiCapability } from '@/lib/engine'
import type { Finding } from '@/types/domain'
import { runScan } from './scan'

const FIXTURES = join(process.cwd(), 'fixtures', 'specs')

const tmpDirs: string[] = []
afterEach(async () => {
  await Promise.all(tmpDirs.splice(0).map((d) => rm(d, { recursive: true, force: true })))
})

async function specInTempDir(): Promise<{ dir: string; specPath: string }> {
  const dir = await mkdtemp(join(tmpdir(), 'mcp-doctor-cache-'))
  tmpDirs.push(dir)
  const specPath = join(dir, 'openapi.yaml')
  await copyFile(join(FIXTURES, 'clean-3.0.yaml'), specPath)
  return { dir, specPath }
}

function countingAi(): { ai: AiCapability; calls: () => number } {
  let calls = 0
  const ai: AiCapability = {
    runWorker: async (batch, ctx) => {
      calls += 1
      return batch.map<Finding>((o) => ({
        id: `${ctx.agentId}-${o.label}`,
        agentId: ctx.agentId,
        operation: o.label,
        rule: 'MCP_NO_WHEN_TO_USE',
        severity: 'warning',
        confidence: 'MEDIUM',
        message: 'Explain when to use this tool.',
        autoFixable: false,
        autoFixed: false,
        resolution: 'pending',
      }))
    },
    runPostProcess: async () => [],
  }
  return { ai, calls: () => calls }
}

describe('runScan — sidecar cache wiring', () => {
  it('writes the sidecar on a cold run and reuses it with zero LLM calls when the spec is unchanged', async () => {
    const { dir, specPath } = await specInTempDir()
    const { ai, calls } = countingAi()

    const first = await runScan({ specPath, ai, cache: true })
    expect(first.exitCode).toBe(0)
    const coldCalls = calls()
    expect(coldCalls).toBeGreaterThan(0)
    const sidecar = await readFile(join(dir, '.mcp-doctor.yaml'), 'utf8')
    expect(sidecar).toContain('specHash')

    const second = await runScan({ specPath, ai, cache: true })
    expect(second.exitCode).toBe(0)
    expect(calls()).toBe(coldCalls) // warm run: zero additional LLM calls
    expect(second.stderr).toMatch(/cache/i)
    // cached findings still render — same finding counts as the cold run
    expect(second.stdout).toContain('3.0')
  })

  it('recomputes when the spec content changes', async () => {
    const { specPath } = await specInTempDir()
    const { ai, calls } = countingAi()
    await runScan({ specPath, ai, cache: true })
    const coldCalls = calls()

    const spec = await readFile(specPath, 'utf8')
    await writeFile(specPath, spec.replace('title:', 'title: changed —'))
    await runScan({ specPath, ai, cache: true })
    expect(calls()).toBeGreaterThan(coldCalls)
  })

  it('leaves no sidecar when caching is not enabled', async () => {
    const { dir, specPath } = await specInTempDir()
    await runScan({ specPath })
    await expect(stat(join(dir, '.mcp-doctor.yaml'))).rejects.toThrow()
  })
})

describe('runScan — sidecar cache with an operation selection', () => {
  const TWO_OP_SPEC = `openapi: 3.0.3
info:
  title: T
  version: 1.0.0
paths:
  /users:
    get:
      operationId: list_users
      description: Returns the users of the account, newest first, with pagination.
      responses:
        '200':
          description: ok
          content:
            application/json:
              schema:
                type: object
  /items:
    get:
      operationId: list_items
      description: Returns the items of the account, newest first, with pagination.
      responses:
        '200':
          description: ok
          content:
            application/json:
              schema:
                type: object
`

  async function twoOpTempDir(): Promise<{ dir: string; specPath: string }> {
    const dir = await mkdtemp(join(tmpdir(), 'mcp-doctor-selection-cache-'))
    tmpDirs.push(dir)
    const specPath = join(dir, 'openapi.yaml')
    await writeFile(specPath, TWO_OP_SPEC)
    return { dir, specPath }
  }

  it('reuses a fresh full-spec cache, filtered down to the selection (zero LLM calls)', async () => {
    const { specPath } = await twoOpTempDir()
    const { ai, calls } = countingAi()

    const full = await runScan({ specPath, ai, cache: true })
    expect(full.exitCode).toBe(0)
    const coldCalls = calls()
    expect(coldCalls).toBeGreaterThan(0)

    const scoped = await runScan({
      specPath,
      ai,
      cache: true,
      selection: [{ path: '/users', methods: ['get'] }],
    })
    expect(scoped.exitCode).toBe(0)
    expect(calls()).toBe(coldCalls) // cache hit — no new LLM work
    expect(scoped.stderr).toMatch(/cache/i)
    // cached full-spec findings are narrowed to the selection
    expect(scoped.stdout).toContain('GET /users')
    expect(scoped.stdout).not.toContain('GET /items')
  })

  it('never writes selection-scoped findings into the sidecar (no cache poisoning)', async () => {
    const { dir, specPath } = await twoOpTempDir()
    const { ai, calls } = countingAi()

    // Cold scoped run: must not populate the sidecar with partial findings.
    await runScan({
      specPath,
      ai,
      cache: true,
      selection: [{ path: '/users', methods: ['get'] }],
    })
    await expect(stat(join(dir, '.mcp-doctor.yaml'))).rejects.toThrow()

    // A later full run therefore computes the full spec, not the scoped subset.
    const scopedCalls = calls()
    const full = await runScan({ specPath, ai, cache: true })
    expect(calls()).toBeGreaterThan(scopedCalls)
    expect(full.stdout).toContain('GET /items')
  })
})

describe('runScan — grounded cache (handler-hash dimension)', () => {
  const GROUNDED_SPEC = `openapi: 3.0.3
info:
  title: T
  version: 1.0.0
paths:
  /users:
    get:
      operationId: list_users
      description: Returns the users of the account, newest first, with pagination.
      responses:
        '200':
          description: ok
          content:
            application/json:
              schema:
                type: object
  /items:
    get:
      operationId: list_items
      description: Returns the items of the account, newest first, with pagination.
      responses:
        '200':
          description: ok
          content:
            application/json:
              schema:
                type: object
`

  async function groundedTempDir(): Promise<{ dir: string; specPath: string; routePaths: string[] }> {
    const dir = await mkdtemp(join(tmpdir(), 'mcp-doctor-grounded-'))
    tmpDirs.push(dir)
    const specPath = join(dir, 'openapi.yaml')
    await writeFile(specPath, GROUNDED_SPEC)
    await writeFile(
      join(dir, 'routes.go'),
      `package main
func routes() {
	mux.HandleFunc("GET /users", listUsers)
	mux.HandleFunc("GET /items", listItems)
}
`,
    )
    await writeFile(
      join(dir, 'users.go'),
      `package main
func listUsers(w http.ResponseWriter, r *http.Request) {
	w.WriteHeader(200)
}
`,
    )
    await writeFile(
      join(dir, 'items.go'),
      `package main
func listItems(w http.ResponseWriter, r *http.Request) {
	w.WriteHeader(200)
}
`,
    )
    return {
      dir,
      specPath,
      routePaths: [join(dir, 'routes.go'), join(dir, 'users.go'), join(dir, 'items.go')],
    }
  }

  function groundingAi(): { ai: AiCapability; groundedOps: () => string[][] } {
    const calls: string[][] = []
    const base = countingAi().ai
    const ai: AiCapability = {
      ...base,
      runGrounding: async (operations) => {
        calls.push(operations.map((o) => o.label))
        return {
          findings: operations.map<Finding>((o) => ({
            id: `mismatch-${o.id}`,
            agentId: 'worker',
            operation: o.label,
            rule: 'SPEC_CODE_MISMATCH',
            severity: 'warning',
            confidence: 'LOW',
            message: 'spec drift',
            autoFixable: false,
            autoFixed: false,
            resolution: 'pending',
          })),
          filesRead: [],
        }
      },
    }
    return { ai, groundedOps: () => calls }
  }

  it('reuses grounding when nothing changed and re-runs only the changed handler (scenarios 2 & 4)', async () => {
    const { dir, specPath, routePaths } = await groundedTempDir()
    const { ai, groundedOps } = groundingAi()

    const first = await runScan({ specPath, ai, routePaths, cache: true })
    expect(first.exitCode).toBe(0)
    expect(groundedOps()).toHaveLength(1)
    expect(groundedOps()[0]?.sort()).toEqual(['GET /items', 'GET /users'])
    // mismatch findings surface in the report
    expect(first.stdout).toContain('SPEC_CODE_MISMATCH')

    // scenario 2: nothing changed — no new grounding call
    const second = await runScan({ specPath, ai, routePaths, cache: true })
    expect(groundedOps()).toHaveLength(1)
    expect(second.stderr).toMatch(/cache/i)
    expect(second.stdout).toContain('SPEC_CODE_MISMATCH')

    // scenario 4: one handler changes — only its operation is re-grounded
    await writeFile(
      join(dir, 'items.go'),
      `package main
func listItems(w http.ResponseWriter, r *http.Request) {
	w.WriteHeader(204)
}
`,
    )
    await runScan({ specPath, ai, routePaths, cache: true })
    expect(groundedOps()).toHaveLength(2)
    expect(groundedOps()[1]).toEqual(['GET /items'])
  })
})
