import { createOpenAICompatible } from '@ai-sdk/openai-compatible'
import { streamText, type LanguageModel } from 'ai'
import { z, type ZodType } from 'zod'

/**
 * LLM client wrapper over the Vercel AI SDK. Provider-agnostic (any
 * OpenAI-compatible endpoint) and configured from env only. Credentials are read
 * at call time, never stored, never logged, and never included in thrown errors.
 */

const DEFAULT_MODEL = 'gpt-4o-mini'

/** Per-attempt ceiling on a single LLM call. Overridable via LLM_TIMEOUT_MS. */
const DEFAULT_TIMEOUT_MS = 120_000

export interface LlmConfig {
  baseURL: string
  apiToken: string
  model: string
}

export function readLlmTimeoutMs(
  env: Record<string, string | undefined> = process.env,
): number {
  const raw = env.LLM_TIMEOUT_MS
  const parsed = raw !== undefined ? Number(raw) : NaN
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_TIMEOUT_MS
}

export class LlmGenerationError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'LlmGenerationError'
  }
}

export function readLlmConfig(
  env: Record<string, string | undefined> = process.env,
): LlmConfig | null {
  const baseURL = env.LLM_BASE_URL
  const apiToken = env.LLM_API_TOKEN
  if (!baseURL || !apiToken) return null
  return { baseURL, apiToken, model: env.LLM_MODEL ?? DEFAULT_MODEL }
}

export function isLlmEnabled(env: Record<string, string | undefined> = process.env): boolean {
  return readLlmConfig(env) !== null
}

export function createModel(config: LlmConfig): LanguageModel {
  const provider = createOpenAICompatible({
    name: 'mcp-doctor',
    baseURL: config.baseURL,
    apiKey: config.apiToken,
  })
  return provider(config.model)
}

type GenerateObjectFn = <T>(args: {
  model: LanguageModel
  schema: ZodType<T>
  prompt: string
  system?: string
  abortSignal?: AbortSignal
}) => Promise<{ object: T }>

type GenerateTextFn = (args: {
  model: LanguageModel
  prompt: string
  system?: string
  abortSignal?: AbortSignal
}) => Promise<{ text: string }>

// Everything goes through streamText, for two reasons:
//   1. Some OpenAI-compatible gateways only accept streaming requests and reject
//      non-streaming generate* calls with `400 streaming is required` (e.g. the
//      Tyk AI gateway's `/llm/stream/...` endpoint).
//   2. `streamObject` hangs against such gateways — they never emit the finish
//      event its structured-output parser waits for — whereas streamText works.
// So structured output is "ask for JSON as text, then parse" (the same robust
// path the fallback already used). The caller still validates with Zod.
async function collectStream(result: ReturnType<typeof streamText>): Promise<string> {
  let text = ''
  for await (const delta of result.textStream) text += delta
  return text
}

const defaultGenerateObject: GenerateObjectFn = async ({
  model,
  schema,
  prompt,
  system,
  abortSignal,
}) => {
  // Without streamObject's provider-side schema enforcement, the model free-forms
  // its JSON field names (e.g. `issue`/`suggestion` instead of `message`/`suggested`),
  // so we hand it the exact JSON Schema to conform to. Zod v4 derives it directly.
  const jsonSchema = JSON.stringify(z.toJSONSchema(schema))
  const text = await collectStream(
    streamText({
      model,
      system,
      abortSignal,
      prompt: `${prompt}\n\nReturn ONLY a single JSON object that conforms to this JSON Schema. Use these exact field names and enum values. No prose, no markdown, no code fences.\n\nJSON Schema:\n${jsonSchema}`,
    }),
  )
  return { object: schema.parse(extractJsonObject(text)) }
}

const defaultGenerateText: GenerateTextFn = async ({ model, prompt, system, abortSignal }) => {
  return { text: await collectStream(streamText({ model, system, prompt, abortSignal })) }
}

export interface GenerateStructuredOptions<T> {
  schema: ZodType<T>
  prompt: string
  system?: string
  model: LanguageModel
  /** Cancellation from the caller (e.g. the SSE route's abort controller). */
  abortSignal?: AbortSignal
  /** Per-attempt ceiling; defaults to LLM_TIMEOUT_MS or 120s. */
  timeoutMs?: number
  /** Injectable for tests; defaults to the real AI SDK functions. */
  generateObject?: GenerateObjectFn
  generateText?: GenerateTextFn
}

/** Timeout + caller cancellation, combined per attempt so a retry gets a fresh clock. */
function attemptSignal(caller: AbortSignal | undefined, timeoutMs: number): AbortSignal {
  const timeout = AbortSignal.timeout(timeoutMs)
  return caller ? AbortSignal.any([caller, timeout]) : timeout
}

/**
 * Request structured output, validated against a Zod schema. Tries the SDK's
 * native structured-output mode first; on failure falls back to free-text + a
 * manual JSON parse (for gateways that don't support JSON-schema mode). Throws a
 * credential-free LlmGenerationError if neither path yields valid output.
 *
 * Every attempt is bounded by a timeout and honours the caller's abort signal —
 * a hung gateway can never hold an agent (or its SSE stream) open indefinitely.
 * Caller-initiated cancellation short-circuits the fallback entirely.
 */
export async function generateStructured<T>(options: GenerateStructuredOptions<T>): Promise<T> {
  const genObject = options.generateObject ?? defaultGenerateObject
  const genText = options.generateText ?? defaultGenerateText
  const timeoutMs = options.timeoutMs ?? readLlmTimeoutMs()

  try {
    const { object } = await genObject({
      model: options.model,
      schema: options.schema,
      prompt: options.prompt,
      system: options.system,
      abortSignal: attemptSignal(options.abortSignal, timeoutMs),
    })
    return options.schema.parse(object)
  } catch {
    // Fall through to the text-mode fallback. The original error is deliberately
    // discarded — it may contain provider auth details.
  }

  // The run was cancelled — retrying in text mode would be wasted work.
  if (options.abortSignal?.aborted) {
    throw new LlmGenerationError('The LLM call was cancelled.')
  }

  try {
    const { text } = await genText({
      model: options.model,
      prompt: `${options.prompt}\n\nReturn ONLY a single JSON object, with no prose or code fences.`,
      system: options.system,
      abortSignal: attemptSignal(options.abortSignal, timeoutMs),
    })
    return options.schema.parse(extractJsonObject(text))
  } catch {
    if (options.abortSignal?.aborted) {
      throw new LlmGenerationError('The LLM call was cancelled.')
    }
    throw new LlmGenerationError('The LLM did not return valid structured output.')
  }
}

/** Probe timeout: a health check should answer fast, whatever LLM_TIMEOUT_MS is. */
const PROBE_TIMEOUT_MS = 15_000

/**
 * Issue a minimal real request against the configured endpoint to verify the
 * base URL, token, and model actually work. The result message never contains
 * the token; provider errors are discarded entirely (they may echo auth headers).
 */
export async function probeLlm(
  env: Record<string, string | undefined> = process.env,
  generate: GenerateTextFn = defaultGenerateText,
): Promise<{ ok: boolean; message: string }> {
  const config = readLlmConfig(env)
  if (!config) {
    return { ok: false, message: 'Not configured — set LLM_BASE_URL and LLM_API_TOKEN.' }
  }
  try {
    await generate({
      model: createModel(config),
      prompt: 'Reply with the single word: ok',
      abortSignal: AbortSignal.timeout(Math.min(readLlmTimeoutMs(env), PROBE_TIMEOUT_MS)),
    })
    return { ok: true, message: `Connected: ${config.model} @ ${config.baseURL}` }
  } catch {
    return {
      ok: false,
      message: `Could not reach ${config.model} @ ${config.baseURL} — check the endpoint, token, and model name.`,
    }
  }
}

function extractJsonObject(text: string): unknown {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(text)
  const candidate = fenced?.[1] ?? text
  const start = candidate.indexOf('{')
  const end = candidate.lastIndexOf('}')
  if (start === -1 || end < start) {
    throw new LlmGenerationError('No JSON object found in LLM text output.')
  }
  return JSON.parse(candidate.slice(start, end + 1))
}
