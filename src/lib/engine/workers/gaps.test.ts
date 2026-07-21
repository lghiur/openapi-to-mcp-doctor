import { describe, expect, it } from 'vitest'
import { extractOperations } from '@/lib/engine/operations'
import { structuralGapsFor } from '@/lib/engine/workers/gaps'
import type { Finding, SpecPath } from '@/types/domain'

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

const operations = extractOperations(SPEC)

function structural(rule: string, path?: SpecPath, after?: string): Finding {
  return {
    id: `${rule}:${path?.join('/') ?? 'doc'}`,
    agentId: 'structural-linter',
    rule,
    severity: 'warning',
    confidence: 'HIGH',
    message: `${rule} violated`,
    ...(path ? { path } : {}),
    ...(after !== undefined ? { after } : {}),
    autoFixable: false,
    autoFixed: false,
    resolution: 'pending',
  }
}

describe('structuralGapsFor', () => {
  it('keys operation-scoped content gaps by operation label with operation-relative paths', () => {
    const gaps = structuralGapsFor(operations, [
      structural('operation-description', ['paths', '/users', 'get']),
      structural('mcp-param-description-required', [
        'paths',
        '/items',
        'get',
        'parameters',
        0,
        'description',
      ]),
    ])
    expect(gaps['GET /users']).toEqual([
      { rule: 'operation-description', message: 'operation-description violated', path: [] },
    ])
    expect(gaps['GET /items']).toEqual([
      {
        rule: 'mcp-param-description-required',
        message: 'mcp-param-description-required violated',
        path: ['parameters', 0, 'description'],
      },
    ])
  })

  it('excludes document-level findings and findings on unknown operations', () => {
    const gaps = structuralGapsFor(operations, [
      structural('info-description', ['info']),
      structural('oas3-api-servers', []),
      structural('operation-description', ['paths', '/ghost', 'get']),
    ])
    expect(gaps).toEqual({})
  })

  it('excludes findings the fix applier already fixes deterministically', () => {
    const gaps = structuralGapsFor(operations, [
      structural('mcp-operationid-format', ['paths', '/users', 'get', 'operationId']),
      structural('mcp-nullable-deprecated', ['paths', '/users', 'get', 'x', 'nullable']),
    ])
    expect(gaps).toEqual({})
  })

  it('excludes findings that already carry a suggestion', () => {
    const gaps = structuralGapsFor(operations, [
      structural('some-rule', ['paths', '/users', 'get', 'description'], 'already suggested'),
    ])
    expect(gaps).toEqual({})
  })
})
