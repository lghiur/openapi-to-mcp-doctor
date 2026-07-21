'use server'

import { probeLlm } from '@/lib/llm/client'

/**
 * Validate the LLM configuration with a real round-trip to the endpoint. Never
 * returns the API token — only the (non-secret) base URL and model name.
 */
export async function testLlmConnection(): Promise<{ ok: boolean; message: string }> {
  return probeLlm(process.env)
}
