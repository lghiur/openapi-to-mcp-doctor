import { describe, expect, it } from 'vitest'
import { WORKER_RULES, type WorkerRule, normalizeRule } from '@/lib/engine/workers/rules'

/**
 * Worker rule ids must be STABLE across runs: the GitHub Action's delta gating
 * keys findings on rule+operation+path, so a model free-texting
 * "description-explains-when" one run and "mcp-description-missing-when" the
 * next makes every AI finding look new. normalizeRule is the deterministic
 * mapper from whatever the model emitted to the fixed taxonomy.
 */

describe('WORKER_RULES taxonomy', () => {
  it('is a fixed, mcp-prefixed, kebab-case set', () => {
    expect(WORKER_RULES.length).toBeGreaterThanOrEqual(10)
    for (const rule of WORKER_RULES) {
      expect(rule).toMatch(/^mcp-[a-z0-9]+(-[a-z0-9]+)*$/)
    }
    expect(new Set(WORKER_RULES).size).toBe(WORKER_RULES.length)
  })
})

describe('normalizeRule — canonical ids pass through unchanged', () => {
  it.each(WORKER_RULES.map((rule) => [rule]))('%s maps to itself', (rule) => {
    expect(normalizeRule(rule)).toBe(rule)
  })
})

describe('normalizeRule — observed production drift variants', () => {
  // Every variant actually observed in production runs must land on a sensible
  // canonical rule, deterministically.
  const observed: Array<[string, WorkerRule]> = [
    ['mcp-description-missing-when', 'mcp-description-missing-when'],
    ['description-explains-when', 'mcp-description-missing-when'],
    ['mcp-missing-when-to-call', 'mcp-description-missing-when'],
    ['mcp-parameter-description-misleading', 'mcp-parameter-description-misleading'],
    ['parameter-description-misleading', 'mcp-parameter-description-misleading'],
    ['mcp-parameter-description-unclear', 'mcp-parameter-description-unclear'],
    ['mcp-parameter-description-ambiguous', 'mcp-parameter-description-unclear'],
    ['mcp-returns-undescribed', 'mcp-returns-undescribed'],
    ['mcp-returns-unclear', 'mcp-returns-undescribed'],
    ['mcp-returns-underdescribed', 'mcp-returns-undescribed'],
    ['response-description-ambiguous', 'mcp-response-ambiguous'],
    ['mcp-description-too-short', 'mcp-description-unclear'],
    ['mcp-description-missing-context', 'mcp-description-unclear'],
  ]

  it.each(observed)('%s → %s', (raw, canonical) => {
    expect(normalizeRule(raw)).toBe(canonical)
  })

  it('is deterministic — repeated calls agree', () => {
    for (const [raw] of observed) {
      expect(normalizeRule(raw)).toBe(normalizeRule(raw))
    }
  })
})

describe('normalizeRule — structural gap rules echoed by workers', () => {
  it('maps the linter parameter-description gap rule to the parameter category', () => {
    expect(normalizeRule('mcp-param-description-required')).toBe(
      'mcp-parameter-description-missing',
    )
  })

  it('passes through gap rules that are themselves canonical', () => {
    expect(normalizeRule('mcp-enum-description-required')).toBe('mcp-enum-description-required')
    expect(normalizeRule('mcp-response-schema-required')).toBe('mcp-response-schema-required')
    expect(normalizeRule('mcp-nested-description-required')).toBe(
      'mcp-nested-description-required',
    )
  })
})

describe('normalizeRule — lenient input handling', () => {
  it('normalizes case, whitespace, and underscores before matching', () => {
    expect(normalizeRule('MCP_RETURNS_UNDESCRIBED')).toBe('mcp-returns-undescribed')
    expect(normalizeRule('  mcp-description-missing-when  ')).toBe('mcp-description-missing-when')
    expect(normalizeRule('Description Explains When')).toBe('mcp-description-missing-when')
  })

  it('adds the mcp- prefix when the model dropped it', () => {
    expect(normalizeRule('returns-undescribed')).toBe('mcp-returns-undescribed')
    expect(normalizeRule('enum-description-required')).toBe('mcp-enum-description-required')
  })

  it('maps unknown-but-keyworded names to the nearest category', () => {
    expect(normalizeRule('mcp-parameter-description-missing-units')).toBe(
      'mcp-parameter-description-missing',
    )
    expect(normalizeRule('mcp-enum-values-unexplained')).toBe('mcp-enum-description-required')
    expect(normalizeRule('mcp-response-schema-absent')).toBe('mcp-response-schema-required')
    expect(normalizeRule('mcp-description-repeats-operation-name')).toBe(
      'mcp-description-name-duplication',
    )
  })

  it('falls back to mcp-description-unclear for anything unrecognizable', () => {
    expect(normalizeRule('totally-made-up')).toBe('mcp-description-unclear')
    expect(normalizeRule('')).toBe('mcp-description-unclear')
  })
})
