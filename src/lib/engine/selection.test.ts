import { describe, expect, it } from 'vitest'
import { extractOperations } from '@/lib/engine/operations'
import { filterFindings, filterOperations } from '@/lib/engine/selection'
import type { Finding, OperationSelection, SpecPath } from '@/types/domain'

const SPEC = `openapi: 3.0.3
info:
  title: T
  version: 1.0.0
paths:
  /users:
    get:
      operationId: list_users
    post:
      operationId: create_user
  /items:
    get:
      operationId: list_items`

function finding(path?: SpecPath): Finding {
  return {
    id: 'f',
    agentId: 'structural-linter',
    rule: 'r',
    severity: 'warning',
    confidence: 'HIGH',
    message: 'm',
    ...(path ? { path } : {}),
    autoFixable: false,
    autoFixed: false,
    resolution: 'pending',
  }
}

describe('filterOperations', () => {
  const operations = extractOperations(SPEC)

  it('returns all operations when no selection is given', () => {
    expect(filterOperations(operations)).toHaveLength(3)
  })

  it('keeps only selected path+method combinations', () => {
    const selection: OperationSelection = [{ path: '/users', methods: ['get'] }]
    const filtered = filterOperations(operations, selection)
    expect(filtered.map((o) => o.label)).toEqual(['GET /users'])
  })

  it('a path with all its methods keeps every operation under it', () => {
    const selection: OperationSelection = [{ path: '/users', methods: ['get', 'post'] }]
    const filtered = filterOperations(operations, selection)
    expect(filtered.map((o) => o.label)).toEqual(['GET /users', 'POST /users'])
  })

  it('matches methods case-insensitively', () => {
    const selection: OperationSelection = [{ path: '/items', methods: ['GET'] }]
    expect(filterOperations(operations, selection)).toHaveLength(1)
  })
})

describe('filterFindings', () => {
  const selection: OperationSelection = [{ path: '/users', methods: ['get'] }]

  it('passes everything through when no selection is given', () => {
    const findings = [finding(['paths', '/items', 'get'])]
    expect(filterFindings(findings)).toHaveLength(1)
  })

  it('keeps document-level findings (no path, or not under paths)', () => {
    const findings = [finding(), finding(['info', 'title'])]
    expect(filterFindings(findings, selection)).toHaveLength(2)
  })

  it('drops findings on unselected paths', () => {
    const findings = [finding(['paths', '/items', 'get', 'description'])]
    expect(filterFindings(findings, selection)).toHaveLength(0)
  })

  it('drops findings on unselected methods of a selected path', () => {
    const findings = [finding(['paths', '/users', 'post', 'operationId'])]
    expect(filterFindings(findings, selection)).toHaveLength(0)
  })

  it('keeps findings on selected methods', () => {
    const findings = [finding(['paths', '/users', 'get', 'operationId'])]
    expect(filterFindings(findings, selection)).toHaveLength(1)
  })

  it('keeps path-level findings (e.g. parameters) on a selected path', () => {
    const findings = [finding(['paths', '/users', 'parameters', 0])]
    expect(filterFindings(findings, selection)).toHaveLength(1)
  })

  it('keeps path-item findings anchored directly on a selected path', () => {
    const findings = [finding(['paths', '/users'])]
    expect(filterFindings(findings, selection)).toHaveLength(1)
  })
})
