import { describe, expect, it } from 'vitest'
import { computeHealthScore, healthBadge } from '@/lib/engine/health'

describe('computeHealthScore', () => {
  it('is 100 for a spec with no findings', () => {
    expect(computeHealthScore({ errors: 0, warnings: 0, info: 0 })).toBe(100)
  })

  it('weights errors most heavily, then warnings, then info', () => {
    expect(computeHealthScore({ errors: 1, warnings: 0, info: 0 })).toBe(90)
    expect(computeHealthScore({ errors: 0, warnings: 1, info: 0 })).toBe(97)
    expect(computeHealthScore({ errors: 0, warnings: 0, info: 1 })).toBe(99)
  })

  it('sums penalties across severities', () => {
    expect(computeHealthScore({ errors: 1, warnings: 2, info: 3 })).toBe(100 - 10 - 6 - 3)
  })

  it('never drops below 0', () => {
    expect(computeHealthScore({ errors: 50, warnings: 0, info: 0 })).toBe(0)
  })

  it('returns an integer', () => {
    expect(Number.isInteger(computeHealthScore({ errors: 2, warnings: 1, info: 1 }))).toBe(true)
  })
})

describe('healthBadge', () => {
  it('emits the shields.io endpoint schema with the score as the message', () => {
    expect(healthBadge(100)).toEqual({
      schemaVersion: 1,
      label: 'MCP health',
      message: '100/100',
      color: 'brightgreen',
    })
  })

  it('colours by score band: ≥90 green, ≥70 yellow, below red', () => {
    expect(healthBadge(90).color).toBe('brightgreen')
    expect(healthBadge(89).color).toBe('yellow')
    expect(healthBadge(70).color).toBe('yellow')
    expect(healthBadge(69).color).toBe('red')
    expect(healthBadge(0).color).toBe('red')
  })
})
