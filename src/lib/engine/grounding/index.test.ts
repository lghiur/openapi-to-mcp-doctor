import { describe, expect, it, vi } from 'vitest'
import { runGrounding } from '@/lib/engine/grounding'
import type { RouteFile } from '@/lib/engine/grounding/map'
import type { OperationRef } from '@/lib/engine/operations'
import type { Finding } from '@/types/domain'

const fakeModel = {} as never

function op(method: string, path: string): OperationRef {
  return { id: `${method}_${path}`, method, path, label: `${method} ${path}`, definition: {} }
}

const routeFiles: RouteFile[] = [
  { path: 'routes/gin.go', content: 'r.GET("/users/:id", handlers.GetUser)' },
]

describe('runGrounding', () => {
  it('reads mapped handlers and collects mismatch findings + file_read entries', async () => {
    const mismatch: Finding = {
      id: 'm1',
      agentId: 'worker',
      operation: 'GET /users/{id}',
      rule: 'SPEC_CODE_MISMATCH',
      severity: 'error',
      confidence: 'LOW',
      message: 'mismatch',
      actual: '204',
      warning: 'confirm',
      autoFixable: false,
      autoFixed: false,
      resolution: 'pending',
    }
    const detect = vi.fn(async () => [mismatch])

    const result = await runGrounding(
      { operations: [op('GET', '/users/{id}')], routeFiles, version: '3.0' },
      { model: fakeModel, detect },
    )

    expect(detect).toHaveBeenCalledTimes(1)
    expect(result.filesRead).toEqual([
      {
        agentId: 'worker',
        path: 'routes/gin.go',
        operation: 'GET /users/{id}',
        line: 1,
        linesRead: 1,
        role: 'registration',
        symbol: 'handlers.GetUser',
      },
    ])
    expect(result.findings.map((f) => f.rule)).toContain('SPEC_CODE_MISMATCH')
  })

  it('maps operations through spec server-URL base paths', async () => {
    const detect = vi.fn(async () => [])
    const v1Files: RouteFile[] = [
      { path: 'routes/app.js', content: "app.get('/v1/users/:id', getUser)" },
    ]
    const result = await runGrounding(
      {
        operations: [op('GET', '/users/{id}')],
        routeFiles: v1Files,
        version: '3.0',
        serverPrefixes: ['/v1'],
      },
      { model: fakeModel, detect },
    )
    expect(result.findings.filter((f) => f.rule === 'SPEC_CODE_HANDLER_NOT_FOUND')).toEqual([])
    expect(result.filesRead.map((f) => f.path)).toContain('routes/app.js')
  })

  it('reports registered routes missing from the spec (discovery)', async () => {
    const detect = vi.fn(async () => [])
    const files: RouteFile[] = [
      {
        path: 'routes/gin.go',
        content:
          'r.GET("/users/:id", handlers.GetUser)\nr.GET("/admin/cache", handlers.CacheAdmin)',
      },
    ]
    const result = await runGrounding(
      { operations: [op('GET', '/users/{id}')], routeFiles: files, version: '3.0' },
      { model: fakeModel, detect },
    )
    const undocumented = result.findings.filter(
      (f) => f.rule === 'SPEC_CODE_UNDOCUMENTED_ENDPOINT',
    )
    expect(undocumented).toHaveLength(1)
    expect(undocumented[0]?.operation).toBe('GET /admin/cache')
    expect(undocumented[0]?.after).toContain('operationId')
  })

  it('emits a handler-not-found finding for unmapped operations', async () => {
    const detect = vi.fn(async () => [])
    const result = await runGrounding(
      { operations: [op('DELETE', '/nope')], routeFiles, version: '3.0' },
      { model: fakeModel, detect },
    )
    expect(detect).not.toHaveBeenCalled()
    expect(result.findings.map((f) => f.rule)).toContain('SPEC_CODE_HANDLER_NOT_FOUND')
  })

  it('follows the handler symbol to its defining file (depth 2)', async () => {
    const files: RouteFile[] = [
      { path: 'routes/gin.go', content: 'r.GET("/users/:id", handlers.GetUser)' },
      {
        path: 'handlers/users.go',
        content: 'func GetUser(c *gin.Context) {\n  c.JSON(200, user)\n}',
      },
    ]
    const detect = vi.fn(async (input: { handlerCode: string }) => {
      expect(input.handlerCode).toContain('routes/gin.go')
      expect(input.handlerCode).toContain('handlers/users.go')
      expect(input.handlerCode).toContain('func GetUser')
      return []
    })

    const result = await runGrounding(
      { operations: [op('GET', '/users/{id}')], routeFiles: files, version: '3.0' },
      { model: fakeModel, detect },
    )

    expect(detect).toHaveBeenCalledTimes(1)
    expect(result.filesRead.map((f) => f.path)).toEqual(['routes/gin.go', 'handlers/users.go'])
    // The evidence trail records why each file was read and where the match sits.
    expect(result.filesRead[0]).toMatchObject({ role: 'registration', line: 1 })
    expect(result.filesRead[1]).toMatchObject({
      role: 'handler',
      symbol: 'handlers.GetUser',
      line: 1,
      linesRead: 3,
    })
  })

  it('isolates a failing detection — other operations still produce findings', async () => {
    const files: RouteFile[] = [
      {
        path: 'routes/gin.go',
        content: 'r.GET("/users/:id", handlers.GetUser)\nr.GET("/pets", handlers.ListPets)',
      },
    ]
    const petsFinding: Finding = {
      id: 'p1',
      agentId: 'worker',
      operation: 'GET /pets',
      rule: 'SPEC_CODE_MISMATCH',
      severity: 'error',
      confidence: 'LOW',
      message: 'mismatch',
      autoFixable: false,
      autoFixed: false,
      resolution: 'pending',
    }
    const detect = vi.fn(async (input: { operation: OperationRef }) => {
      if (input.operation.label === 'GET /users/{id}') throw new Error('gateway down')
      return [petsFinding]
    })

    const result = await runGrounding(
      {
        operations: [op('GET', '/users/{id}'), op('GET', '/pets')],
        routeFiles: files,
        version: '3.0',
      },
      { model: fakeModel, detect },
    )

    expect(detect).toHaveBeenCalledTimes(2)
    expect(result.findings.map((f) => f.id)).toEqual(['p1'])
    // The failure is recorded, not swallowed — "no findings" ≠ "code matches".
    expect(result.failures).toEqual([
      { operation: 'GET /users/{id}', error: 'gateway down' },
    ])
  })

  it('passes the abort signal through to detection', async () => {
    const controller = new AbortController()
    const detect = vi.fn(async (_input: unknown, deps: { signal?: AbortSignal }) => {
      expect(deps.signal).toBe(controller.signal)
      return []
    })
    await runGrounding(
      { operations: [op('GET', '/users/{id}')], routeFiles, version: '3.0' },
      { model: fakeModel, signal: controller.signal, detect },
    )
    expect(detect).toHaveBeenCalledTimes(1)
  })
})
