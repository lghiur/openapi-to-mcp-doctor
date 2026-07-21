import { describe, expect, it } from 'vitest'
import { resolveSpecLine } from '@/lib/engine/lines/resolve'

const YAML_SPEC = [
  'openapi: 3.0.3', // line 1
  'paths:', // line 2
  '  /users/{id}:', // line 3
  '    get:', // line 4
  '      operationId: get_user', // line 5
  '      description: Fetch one user', // line 6
].join('\n')

const YAML_SEQ_SPEC = [
  'servers:', // line 1
  '  - url: https://a.example.com', // line 2
  '  - url: https://b.example.com', // line 3
  '    description: Backup', // line 4
].join('\n')

const JSON_SPEC = [
  '{', // line 1
  '  "openapi": "3.0.3",', // line 2
  '  "paths": {', // line 3
  '    "/users/{id}": {', // line 4
  '      "get": {', // line 5
  '        "operationId": "get_user"', // line 6
  '      }', // line 7
  '    }', // line 8
  '  }', // line 9
  '}', // line 10
].join('\n')

describe('resolveSpecLine', () => {
  it('resolves a nested map path in YAML to the line of its key', () => {
    expect(resolveSpecLine(YAML_SPEC, ['paths', '/users/{id}', 'get', 'description'])).toBe(6)
    expect(resolveSpecLine(YAML_SPEC, ['paths', '/users/{id}', 'get'])).toBe(4)
    expect(resolveSpecLine(YAML_SPEC, ['openapi'])).toBe(1)
  })

  it('resolves a sequence index in YAML to the line of the item', () => {
    expect(resolveSpecLine(YAML_SEQ_SPEC, ['servers', 0])).toBe(2)
    expect(resolveSpecLine(YAML_SEQ_SPEC, ['servers', 1])).toBe(3)
    expect(resolveSpecLine(YAML_SEQ_SPEC, ['servers', 1, 'description'])).toBe(4)
  })

  it('resolves paths in JSON input through the same code path', () => {
    expect(resolveSpecLine(JSON_SPEC, ['paths', '/users/{id}', 'get', 'operationId'])).toBe(6)
    expect(resolveSpecLine(JSON_SPEC, ['paths', '/users/{id}'])).toBe(4)
  })

  it('handles keys with special characters like path templates', () => {
    expect(resolveSpecLine(YAML_SPEC, ['paths', '/users/{id}'])).toBe(3)
  })

  it('falls back to the deepest existing ancestor when the tail is missing', () => {
    // 'post' does not exist under the path item → land on the path item key
    expect(resolveSpecLine(YAML_SPEC, ['paths', '/users/{id}', 'post', 'description'])).toBe(3)
    // out-of-range sequence index → land on the sequence key
    expect(resolveSpecLine(YAML_SEQ_SPEC, ['servers', 5, 'url'])).toBe(1)
  })

  it('falls back to the document root when no segment matches', () => {
    expect(resolveSpecLine(YAML_SPEC, ['components', 'schemas'])).toBe(1)
  })

  it('returns undefined for an unparseable document', () => {
    expect(resolveSpecLine('a: [1, 2', ['a'])).toBeUndefined()
  })

  it('returns undefined for an empty document', () => {
    expect(resolveSpecLine('', ['paths'])).toBeUndefined()
    expect(resolveSpecLine('# just a comment\n', ['paths'])).toBeUndefined()
  })
})
