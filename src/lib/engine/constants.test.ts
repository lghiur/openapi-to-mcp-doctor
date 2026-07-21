import { describe, expect, it } from 'vitest'
import {
  DEFAULT_CONFIDENCE_THRESHOLD,
  DEFAULT_HISTORY_LIMIT,
  DEFAULT_WORKER_BATCH_SIZE,
  EXIT_CODES,
  MCP_VERSION,
  OPERATION_COUNT_ERROR,
  OPERATION_COUNT_WARN,
  OPERATIONID_MAX_LENGTH,
  SUPPORTED_OPENAPI_VERSIONS,
} from '@/lib/engine/constants'

describe('engine constants', () => {
  it('pins the MCP spec version to the current stable release', () => {
    // This is a deliberate, reviewed value — see CLAUDE.md and the research docs.
    expect(MCP_VERSION).toBe('2025-11-25')
  })

  it('supports exactly OpenAPI 3.0 and 3.1', () => {
    expect(SUPPORTED_OPENAPI_VERSIONS).toEqual(['3.0', '3.1'])
  })

  it('maps exit codes to the documented CLI contract', () => {
    expect(EXIT_CODES).toEqual({
      OK: 0,
      FINDINGS_ERROR: 1,
      ANALYSIS_FAILED: 2,
      INVALID_ARGS: 3,
    })
  })

  it('uses operation-count thresholds grounded in the research (Cursor 40 / heuristic 80)', () => {
    expect(OPERATION_COUNT_WARN).toBe(40)
    expect(OPERATION_COUNT_ERROR).toBe(80)
  })

  it('caps operationId length at the vendor LLM tool-API limit (64)', () => {
    expect(OPERATIONID_MAX_LENGTH).toBe(64)
  })

  it('keeps the worker batch size within the 3-5 heuristic', () => {
    expect(DEFAULT_WORKER_BATCH_SIZE).toBeGreaterThanOrEqual(3)
    expect(DEFAULT_WORKER_BATCH_SIZE).toBeLessThanOrEqual(5)
  })

  it('defaults to conservative fix confidence and a 100-run history cap', () => {
    expect(DEFAULT_CONFIDENCE_THRESHOLD).toBe('high')
    expect(DEFAULT_HISTORY_LIMIT).toBe(100)
  })
})
