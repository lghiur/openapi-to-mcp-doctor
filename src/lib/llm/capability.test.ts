import { describe, expect, it } from 'vitest'
import { aiCapabilityFromEnv } from '@/lib/llm/capability'

describe('aiCapabilityFromEnv', () => {
  it('returns undefined when the LLM env is not (fully) configured', () => {
    expect(aiCapabilityFromEnv({})).toBeUndefined()
    expect(aiCapabilityFromEnv({ LLM_BASE_URL: 'https://x' })).toBeUndefined()
    expect(aiCapabilityFromEnv({ LLM_API_TOKEN: 't' })).toBeUndefined()
  })

  it('builds worker, post-process, and grounding runners when configured', () => {
    const cap = aiCapabilityFromEnv({ LLM_BASE_URL: 'https://x', LLM_API_TOKEN: 't' })
    expect(cap).toBeDefined()
    expect(typeof cap?.runWorker).toBe('function')
    expect(typeof cap?.runPostProcess).toBe('function')
    expect(typeof cap?.runGrounding).toBe('function')
  })
})
