import { describe, expect, it } from 'vitest'
import { countOperations, extractOperations, extractServerPathPrefixes } from '@/lib/engine/operations'

describe('countOperations', () => {
  it('counts operations across paths and HTTP methods', () => {
    const spec = `openapi: 3.0.3
paths:
  /a:
    get:
      responses:
        '200':
          description: ok
    post:
      responses:
        '200':
          description: ok
  /b:
    delete:
      responses:
        '200':
          description: ok`
    expect(countOperations(spec)).toBe(3)
  })

  it('ignores non-method keys like parameters', () => {
    const spec = `openapi: 3.0.3
paths:
  /a:
    parameters: []
    get:
      responses:
        '200':
          description: ok`
    expect(countOperations(spec)).toBe(1)
  })

  it('returns 0 for an unparseable spec', () => {
    expect(countOperations('not yaml : : [')).toBe(0)
  })

  it('returns 0 for a spec with no paths', () => {
    expect(countOperations('openapi: 3.0.3')).toBe(0)
  })
})

describe('extractOperations', () => {
  const spec = `openapi: 3.0.3
paths:
  /users/{id}:
    get:
      operationId: get_user
      description: d
    parameters: []
  /users:
    post:
      description: no id here`

  it('extracts one ref per path × method with labels', () => {
    const ops = extractOperations(spec)
    expect(ops.map((o) => o.label).sort()).toEqual(['GET /users/{id}', 'POST /users'])
  })

  it('uses operationId when present and synthesizes one when absent', () => {
    const ops = extractOperations(spec)
    expect(ops.find((o) => o.label === 'GET /users/{id}')?.id).toBe('get_user')
    expect(ops.find((o) => o.label === 'POST /users')?.id).toContain('post')
  })

  it('carries the operation definition for worker context', () => {
    const op = extractOperations(spec).find((o) => o.label === 'GET /users/{id}')
    expect(op?.definition.operationId).toBe('get_user')
  })

  it('returns [] for an unparseable or pathless spec', () => {
    expect(extractOperations('::: bad')).toEqual([])
    expect(extractOperations('openapi: 3.0.3')).toEqual([])
  })
})

describe('extractServerPathPrefixes', () => {
  it('extracts the path component of absolute server URLs', () => {
    const spec = `openapi: 3.0.3
servers:
  - url: https://api.example.com/api/v1
paths: {}
`
    expect(extractServerPathPrefixes(spec)).toEqual(['/api/v1'])
  })

  it('accepts relative server URLs that are plain paths', () => {
    const spec = `openapi: 3.0.3
servers:
  - url: /v2
paths: {}
`
    expect(extractServerPathPrefixes(spec)).toEqual(['/v2'])
  })

  it('ignores root-path and missing servers', () => {
    expect(
      extractServerPathPrefixes('openapi: 3.0.3\nservers:\n  - url: https://api.example.com/\n'),
    ).toEqual([])
    expect(extractServerPathPrefixes('openapi: 3.0.3\npaths: {}\n')).toEqual([])
    expect(extractServerPathPrefixes('::: bad')).toEqual([])
  })
})
