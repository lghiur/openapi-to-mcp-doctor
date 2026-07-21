import { describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import {
  LlmGenerationError,
  generateStructured,
  isLlmEnabled,
  probeLlm,
  readLlmConfig,
} from '@/lib/llm/client'

// The gateway only accepts streaming requests, so the default path must use the
// AI SDK's streamText (streamObject hangs against it). Mock streamText with a
// real async-iterable textStream to assert the default path consumes it.
vi.mock('ai', () => ({
  streamText: vi.fn(() => ({
    textStream: (async function* () {
      yield '{"findings":[{"rule":'
      yield '"streamed"}]}'
    })(),
  })),
}))

const schema = z.object({ findings: z.array(z.object({ rule: z.string() })) })
const fakeModel = {} as never

describe('readLlmConfig / isLlmEnabled', () => {
  it('returns null when env vars are absent', () => {
    expect(readLlmConfig({})).toBeNull()
    expect(isLlmEnabled({})).toBe(false)
  })

  it('reads config from env and applies a default model', () => {
    expect(readLlmConfig({ LLM_BASE_URL: 'https://x', LLM_API_TOKEN: 'secret' })).toMatchObject({
      baseURL: 'https://x',
      apiToken: 'secret',
    })
    expect(isLlmEnabled({ LLM_BASE_URL: 'https://x', LLM_API_TOKEN: 'secret' })).toBe(true)
  })

  it('requires both base URL and token', () => {
    expect(readLlmConfig({ LLM_BASE_URL: 'https://x' })).toBeNull()
    expect(readLlmConfig({ LLM_API_TOKEN: 'secret' })).toBeNull()
  })
})

describe('probeLlm', () => {
  const env = { LLM_BASE_URL: 'https://gw.example', LLM_API_TOKEN: 'super-secret', LLM_MODEL: 'm1' }

  it('reports unconfigured without issuing a request', async () => {
    const generate = vi.fn()
    const result = await probeLlm({}, generate)
    expect(result.ok).toBe(false)
    expect(result.message).toMatch(/not configured/i)
    expect(generate).not.toHaveBeenCalled()
  })

  it('issues a real round-trip and reports success with model and endpoint', async () => {
    const generate = vi.fn(async () => ({ text: 'ok' }))
    const result = await probeLlm(env, generate)
    expect(result.ok).toBe(true)
    expect(result.message).toContain('m1')
    expect(result.message).toContain('https://gw.example')
    expect(generate).toHaveBeenCalledOnce()
  })

  it('reports failure without leaking the token when the endpoint rejects', async () => {
    const generate = vi.fn(async () => {
      throw new Error('401 unauthorized: bad token super-secret')
    })
    const result = await probeLlm(env, generate)
    expect(result.ok).toBe(false)
    expect(result.message).not.toContain('super-secret')
    expect(result.message).toMatch(/could not reach|failed/i)
  })
})

describe('generateStructured', () => {
  it('returns the Zod-validated object from generateObject', async () => {
    const generateObject = vi.fn().mockResolvedValue({ object: { findings: [{ rule: 'r' }] } })
    const out = await generateStructured({ schema, prompt: 'p', model: fakeModel, generateObject })
    expect(out.findings[0]?.rule).toBe('r')
  })

  it('uses streamText on the default path (gateway requires streaming; streamObject hangs)', async () => {
    const ai = await import('ai')
    // No injected generateObject — exercise the real default implementation.
    const out = await generateStructured({ schema, prompt: 'p', model: fakeModel })
    expect(out.findings[0]?.rule).toBe('streamed')
    expect(ai.streamText).toHaveBeenCalled()
  })

  it('falls back to generateText + JSON parse when generateObject fails', async () => {
    const generateObject = vi.fn().mockRejectedValue(new Error('no object generated'))
    const generateText = vi
      .fn()
      .mockResolvedValue({ text: 'Here:\n```json\n{"findings":[{"rule":"x"}]}\n```' })
    const out = await generateStructured({
      schema,
      prompt: 'p',
      model: fakeModel,
      generateObject,
      generateText,
    })
    expect(out.findings[0]?.rule).toBe('x')
  })

  it('throws LlmGenerationError when both paths fail', async () => {
    const generateObject = vi.fn().mockRejectedValue(new Error('bad'))
    const generateText = vi.fn().mockResolvedValue({ text: 'not json at all' })
    await expect(
      generateStructured({ schema, prompt: 'p', model: fakeModel, generateObject, generateText }),
    ).rejects.toBeInstanceOf(LlmGenerationError)
  })

  it('bounds every attempt with a combined timeout + caller abort signal', async () => {
    const generateObject = vi.fn().mockResolvedValue({ object: { findings: [{ rule: 'ok' }] } })
    const controller = new AbortController()
    const out = await generateStructured({
      schema,
      prompt: 'p',
      model: fakeModel,
      abortSignal: controller.signal,
      timeoutMs: 5_000,
      generateObject,
    })
    expect(out.findings[0]?.rule).toBe('ok')
    const args = generateObject.mock.calls[0]?.[0] as { abortSignal?: AbortSignal }
    expect(args.abortSignal).toBeInstanceOf(AbortSignal)
  })

  it('does not fall back to text mode when the caller cancelled the run', async () => {
    const controller = new AbortController()
    const generateObject = vi.fn(async () => {
      controller.abort()
      throw new Error('aborted mid-flight')
    })
    const generateText = vi.fn()
    await expect(
      generateStructured({
        schema,
        prompt: 'p',
        model: fakeModel,
        abortSignal: controller.signal,
        generateObject,
        generateText,
      }),
    ).rejects.toThrow(/cancelled/)
    expect(generateText).not.toHaveBeenCalled()
  })

  it('never leaks credentials into thrown errors or console output', async () => {
    const SECRET = 'sk-supersecret-abc123'
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})

    const leak = new Error(`401 unauthorized for token ${SECRET}`)
    const generateObject = vi.fn().mockRejectedValue(leak)
    const generateText = vi.fn().mockRejectedValue(leak)

    let thrown: unknown
    try {
      await generateStructured({
        schema,
        prompt: 'p',
        model: fakeModel,
        generateObject,
        generateText,
      })
    } catch (error) {
      thrown = error
    }

    const serialized = `${String(thrown)}${thrown instanceof Error ? (thrown.stack ?? '') : ''}`
    expect(serialized).not.toContain(SECRET)
    const allCalls = [...errorSpy.mock.calls, ...logSpy.mock.calls, ...warnSpy.mock.calls].flat()
    for (const call of allCalls) {
      expect(String(call)).not.toContain(SECRET)
    }

    errorSpy.mockRestore()
    logSpy.mockRestore()
    warnSpy.mockRestore()
  })
})
