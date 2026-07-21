import { type AiCapability, runGrounding } from '@/lib/engine'
import { runPostProcess } from '@/lib/engine/postprocess'
import { createSuggester } from '@/lib/engine/workers/suggest'
import { createWorker } from '@/lib/engine/workers/worker'
import { createModel, readLlmConfig } from '@/lib/llm/client'

export interface AiCapabilityOptions {
  /** Cancels every in-flight LLM call (workers, post-process, grounding) on abort. */
  signal?: AbortSignal
}

/**
 * Build the engine's AI capability (worker + post-process + grounding) from
 * environment variables, or `undefined` when no LLM is configured. Shared by the
 * CLI and the web SSE route so both enable AI analysis the same way — `lib/engine`
 * stays LLM-agnostic (workers take a `model`); this module bridges env → model.
 */
export function aiCapabilityFromEnv(
  env: Record<string, string | undefined>,
  options: AiCapabilityOptions = {},
): AiCapability | undefined {
  const config = readLlmConfig(env)
  if (!config) return undefined
  const model = createModel(config)
  const signal = options.signal
  return {
    runWorker: createWorker({ model, ...(signal ? { signal } : {}) }),
    runPostProcess: (operations) =>
      runPostProcess({ operations, model, ...(signal ? { signal } : {}) }),
    runSuggest: createSuggester({ model, ...(signal ? { signal } : {}) }),
    runGrounding: (operations, routeFiles, version, serverPrefixes) =>
      runGrounding(
        {
          operations,
          routeFiles,
          version,
          ...(serverPrefixes !== undefined ? { serverPrefixes } : {}),
        },
        { model, ...(signal ? { signal } : {}) },
      ),
  }
}
