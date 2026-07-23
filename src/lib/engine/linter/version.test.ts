import { describe, expect, it } from 'vitest'
import { detectVersion } from '@/lib/engine/linter/version'

describe('detectVersion', () => {
  it('detects 3.0.x from a YAML spec', () => {
    const result = detectVersion('openapi: 3.0.3\ninfo:\n  title: X\n')
    expect(result).toEqual({ ok: true, version: '3.0', rawVersion: '3.0.3' })
  })

  it('detects 3.0.0', () => {
    expect(detectVersion('openapi: 3.0.0')).toMatchObject({ ok: true, version: '3.0' })
  })

  it('detects 3.1.x from a YAML spec', () => {
    const result = detectVersion('openapi: 3.1.0\ninfo:\n  title: X\n')
    expect(result).toEqual({ ok: true, version: '3.1', rawVersion: '3.1.0' })
  })

  it('detects 3.1.1', () => {
    expect(detectVersion('openapi: 3.1.1')).toMatchObject({ ok: true, version: '3.1' })
  })

  // YAML parses an unquoted `3.0` as the float 3, whose String() is "3" — the
  // trailing zero is gone. Recovering the literal source keeps a legal-looking
  // (if unquoted) spec analysable instead of halting it as undetectable.
  it('detects 3.0 written unquoted (YAML would otherwise collapse it to the number 3)', () => {
    expect(detectVersion('openapi: 3.0\ninfo:\n  title: X\n')).toMatchObject({
      ok: true,
      version: '3.0',
      rawVersion: '3.0',
    })
  })

  it('detects 3.1 written unquoted', () => {
    expect(detectVersion('openapi: 3.1\ninfo:\n  title: X\n')).toMatchObject({
      ok: true,
      version: '3.1',
    })
  })

  it('still rejects a bare `openapi: 3` (no minor version to detect)', () => {
    expect(detectVersion('openapi: 3\ninfo:\n  title: X\n')).toMatchObject({
      ok: false,
      error: 'OAS_VERSION_UNDETECTABLE',
    })
  })

  it('detects the version from a JSON spec (JSON is valid YAML)', () => {
    const result = detectVersion('{"openapi":"3.1.0","info":{"title":"X"}}')
    expect(result).toEqual({ ok: true, version: '3.1', rawVersion: '3.1.0' })
  })

  it('rejects Swagger 2.0 with SWAGGER_20_NOT_SUPPORTED (YAML)', () => {
    const result = detectVersion('swagger: "2.0"\ninfo:\n  title: X\n')
    expect(result).toMatchObject({ ok: false, error: 'SWAGGER_20_NOT_SUPPORTED' })
  })

  it('rejects Swagger 2.0 with SWAGGER_20_NOT_SUPPORTED (JSON)', () => {
    const result = detectVersion('{"swagger":"2.0","info":{"title":"X"}}')
    expect(result).toMatchObject({ ok: false, error: 'SWAGGER_20_NOT_SUPPORTED' })
  })

  it('returns OAS_VERSION_UNDETECTABLE when the openapi field is missing', () => {
    const result = detectVersion('info:\n  title: X\npaths: {}\n')
    expect(result).toMatchObject({ ok: false, error: 'OAS_VERSION_UNDETECTABLE' })
  })

  it('returns OAS_VERSION_UNDETECTABLE for unparseable input', () => {
    const result = detectVersion(':\n  - }{ this is not valid : : yaml\n[')
    expect(result).toMatchObject({ ok: false, error: 'OAS_VERSION_UNDETECTABLE' })
  })

  it('returns OAS_VERSION_UNDETECTABLE for an empty string', () => {
    expect(detectVersion('')).toMatchObject({ ok: false, error: 'OAS_VERSION_UNDETECTABLE' })
  })

  it('returns OAS_VERSION_UNDETECTABLE for a non-object document', () => {
    expect(detectVersion('just a bare string')).toMatchObject({
      ok: false,
      error: 'OAS_VERSION_UNDETECTABLE',
    })
  })

  it('returns OAS_VERSION_UNDETECTABLE for an unsupported future 3.x version', () => {
    const result = detectVersion('openapi: 3.2.0')
    expect(result).toMatchObject({ ok: false, error: 'OAS_VERSION_UNDETECTABLE' })
  })

  it('does not misclassify 3.10 as 3.1 (precise minor matching)', () => {
    const result = detectVersion('openapi: "3.10.0"')
    expect(result).toMatchObject({ ok: false, error: 'OAS_VERSION_UNDETECTABLE' })
  })

  it('carries a human-readable message on failure', () => {
    const result = detectVersion('swagger: "2.0"')
    if (result.ok) throw new Error('expected failure')
    expect(result.message.length).toBeGreaterThan(0)
  })
})
