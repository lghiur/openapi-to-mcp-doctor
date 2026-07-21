import { describe, expect, it } from 'vitest'
import { errorFindingIds, partitionResolved } from '@/features/analyze/resolved'
import type { SSEFinding } from '@/types/domain'

const f = (id: string, severity: 'error' | 'warning' | 'info'): SSEFinding => ({
  id,
  agentId: 'a',
  rule: 'r',
  severity,
  confidence: 'HIGH',
  message: 'm',
  autoFixable: false,
})

describe('errorFindingIds', () => {
  it('returns only the ids of error-severity findings, in order', () => {
    const ids = errorFindingIds([f('a', 'error'), f('b', 'warning'), f('c', 'error'), f('d', 'info')])
    expect(ids).toEqual(['a', 'c'])
  })

  it('returns [] when there are no errors', () => {
    expect(errorFindingIds([f('a', 'warning'), f('b', 'info')])).toEqual([])
  })
})

describe('partitionResolved', () => {
  it('splits findings into active and resolved, preserving order', () => {
    const findings = [f('a', 'error'), f('b', 'warning'), f('c', 'info')]
    const { active, resolved } = partitionResolved(findings, new Set(['b']))
    expect(active.map((x) => x.id)).toEqual(['a', 'c'])
    expect(resolved.map((x) => x.id)).toEqual(['b'])
  })

  it('puts everything in active when nothing is resolved', () => {
    const findings = [f('a', 'error')]
    const out = partitionResolved(findings, new Set())
    expect(out.active).toHaveLength(1)
    expect(out.resolved).toHaveLength(0)
  })
})
