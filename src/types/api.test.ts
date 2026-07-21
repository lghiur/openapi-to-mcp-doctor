import { describe, expect, expectTypeOf, it } from 'vitest'
import { AnalysisReportSchema, AnalyzeRequestSchema } from '@/types/api'
import type { AnalysisReport, AnalyzeRequest } from '@/types/api'
import type { AnalysisMode, ConfidenceThreshold, MismatchMode, Severity } from '@/types/domain'

// The exact JSON report sample from docs/research/ux-design.md — the stable v1 contract.
const SAMPLE_REPORT: AnalysisReport = {
  runId: 'run-12',
  timestamp: '2026-06-24T14:23:00Z',
  spec: {
    file: 'api/openapi.yaml',
    version: '3.0.3',
    operationCount: 24,
  },
  mcpSpecVersion: '2025-11-25',
  mode: 'lint',
  mismatchMode: 'flag',
  durationMs: 12400,
  summary: {
    total: 14,
    errors: 3,
    warnings: 8,
    info: 3,
    autoFixed: 3,
  },
  agents: [
    {
      id: 'structural-linter',
      type: 'structural-linter',
      operations: [],
      filesRead: [],
      findingsCount: 3,
      durationMs: 100,
    },
  ],
  findings: [
    {
      id: 'f-001',
      agentId: 'structural-linter',
      operation: 'GET /users/{id}',
      operationId: 'getUser',
      rule: 'MCP_OPERATIONID_FORMAT',
      severity: 'error',
      confidence: 'HIGH',
      message: 'operationId must be snake_case',
      before: 'getUser',
      after: 'get_user',
      autoFixed: false,
      resolution: 'pending',
      path: ['paths', '/users/{id}', 'get', 'operationId'],
    },
  ],
}

describe('AnalyzeRequestSchema', () => {
  it('parses a fully-specified request', () => {
    const parsed = AnalyzeRequestSchema.parse({
      spec: 'openapi: 3.0.3',
      mode: 'fix',
      mismatchMode: 'fix',
      confidenceThreshold: 'medium',
    })
    expect(parsed).toMatchObject({
      spec: 'openapi: 3.0.3',
      mode: 'fix',
      mismatchMode: 'fix',
      confidenceThreshold: 'medium',
    })
  })

  it('applies documented defaults when optional fields are omitted', () => {
    const parsed = AnalyzeRequestSchema.parse({ spec: 'openapi: 3.1.0' })
    expect(parsed.mode).toBe('lint')
    expect(parsed.mismatchMode).toBe('flag')
    expect(parsed.confidenceThreshold).toBe('high')
  })

  it('parses an operation selection and rejects empty ones', () => {
    const parsed = AnalyzeRequestSchema.parse({
      spec: 'openapi: 3.0.3',
      selection: [{ path: '/users', methods: ['get', 'post'] }],
    })
    expect(parsed.selection).toEqual([{ path: '/users', methods: ['get', 'post'] }])
    // an empty selection (or a path with no methods) is a client bug, not "whole spec"
    expect(AnalyzeRequestSchema.safeParse({ spec: 's', selection: [] }).success).toBe(false)
    expect(
      AnalyzeRequestSchema.safeParse({ spec: 's', selection: [{ path: '/u', methods: [] }] })
        .success,
    ).toBe(false)
  })

  it('rejects an empty spec', () => {
    expect(AnalyzeRequestSchema.safeParse({ spec: '' }).success).toBe(false)
  })

  it('rejects an unknown mode', () => {
    expect(AnalyzeRequestSchema.safeParse({ spec: 'x', mode: 'destroy' }).success).toBe(false)
  })

  it('infers field types that match the domain unions', () => {
    expectTypeOf<AnalyzeRequest['mode']>().toEqualTypeOf<AnalysisMode>()
    expectTypeOf<AnalyzeRequest['mismatchMode']>().toEqualTypeOf<MismatchMode>()
    expectTypeOf<AnalyzeRequest['confidenceThreshold']>().toEqualTypeOf<ConfidenceThreshold>()
  })
})

describe('AnalysisReportSchema', () => {
  it('round-trips the documented sample report unchanged', () => {
    const parsed = AnalysisReportSchema.parse(SAMPLE_REPORT)
    expect(parsed).toEqual(SAMPLE_REPORT)
  })

  it('accepts a report with no findings and no agents', () => {
    const empty = { ...SAMPLE_REPORT, agents: [], findings: [] }
    expect(AnalysisReportSchema.safeParse(empty).success).toBe(true)
  })

  it('rejects a report missing the summary block', () => {
    const { summary: _omit, ...broken } = SAMPLE_REPORT
    expect(AnalysisReportSchema.safeParse(broken).success).toBe(false)
  })

  it('rejects a finding with an invalid severity', () => {
    const broken = {
      ...SAMPLE_REPORT,
      findings: [{ ...SAMPLE_REPORT.findings[0], severity: 'fatal' }],
    }
    expect(AnalysisReportSchema.safeParse(broken).success).toBe(false)
  })

  it('infers a severity type matching the domain union', () => {
    expectTypeOf<AnalysisReport['findings'][number]['severity']>().toEqualTypeOf<Severity>()
  })
})
