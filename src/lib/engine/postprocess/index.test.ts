import { describe, expect, it, vi } from 'vitest'
import type { OperationRef } from '@/lib/engine/operations'
import { runPostProcess } from '@/lib/engine/postprocess'
import type { PostProcessOutput } from '@/lib/llm/schemas'

const fakeModel = {} as never

function ops(...labels: string[]): OperationRef[] {
  return labels.map((label) => ({
    id: label,
    method: 'GET',
    path: label,
    label,
    definition: { description: `${label} description` },
  }))
}

function generatorReturning(output: PostProcessOutput) {
  return vi.fn(async () => output)
}

describe('runPostProcess', () => {
  it('emits a MCP_NEAR_DUPLICATE finding for each reported pair', async () => {
    const generate = generatorReturning({
      nearDuplicates: [
        {
          operations: ['GET /users', 'GET /users/search'],
          suggested: 'Use list_users for full listing; use search_users when filtering.',
        },
      ],
    })
    const findings = await runPostProcess({
      operations: ops('GET /users', 'GET /users/search'),
      model: fakeModel,
      generate,
    })
    expect(generate).toHaveBeenCalledTimes(1)
    expect(findings).toHaveLength(1)
    expect(findings[0]).toMatchObject({
      rule: 'MCP_NEAR_DUPLICATE',
      severity: 'warning',
      confidence: 'MEDIUM',
      operations: ['GET /users', 'GET /users/search'],
      after: 'Use list_users for full listing; use search_users when filtering.',
      agentId: 'orchestrator',
    })
  })

  it('does not call the LLM when there are fewer than two operations', async () => {
    const generate = generatorReturning({ nearDuplicates: [] })
    const findings = await runPostProcess({
      operations: ops('GET /only'),
      model: fakeModel,
      generate,
    })
    expect(generate).not.toHaveBeenCalled()
    expect(findings).toEqual([])
  })

  it('returns an empty array when no near-duplicates are found', async () => {
    const generate = generatorReturning({ nearDuplicates: [] })
    const findings = await runPostProcess({
      operations: ops('GET /a', 'POST /b'),
      model: fakeModel,
      generate,
    })
    expect(findings).toEqual([])
  })
})
