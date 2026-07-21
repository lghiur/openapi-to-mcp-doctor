import { describe, expect, it } from 'vitest'
import { verifyFixes } from '@/lib/engine/fix/verify'
import { runStructuralAnalysis } from '@/lib/engine/structural'
import type { Finding } from '@/types/domain'

const SPEC_MISSING_PARAM_DESCRIPTION = `openapi: 3.0.3
info:
  title: Pets
  version: 1.0.0
  description: Pet store API.
  contact:
    name: Team
paths:
  /pets/{petId}:
    get:
      operationId: get_pet
      summary: Get pet
      description: Fetch one pet by id.
      parameters:
        - name: petId
          in: path
          required: true
          schema:
            type: string
      responses:
        '200':
          description: A pet.
          content:
            application/json:
              schema:
                type: object
                properties:
                  id:
                    type: string
`

const SPEC_PARAM_DESCRIPTION_FIXED = SPEC_MISSING_PARAM_DESCRIPTION.replace(
  '          required: true',
  '          required: true\n          description: Unique pet identifier.',
)

const SPEC_OPERATIONID_REMOVED = SPEC_MISSING_PARAM_DESCRIPTION.replace(
  '      operationId: get_pet\n',
  '',
)

async function paramFinding(): Promise<{ finding: Finding; originalFindings: Finding[] }> {
  const analysis = await runStructuralAnalysis(SPEC_MISSING_PARAM_DESCRIPTION)
  const finding = analysis.findings.find((f) => f.rule === 'mcp-param-description-required')
  if (!finding) throw new Error('fixture no longer triggers mcp-param-description-required')
  return { finding, originalFindings: analysis.findings }
}

describe('verifyFixes', () => {
  it('confirms an applied fix as resolved when the finding no longer lints', async () => {
    const { finding, originalFindings } = await paramFinding()
    const result = await verifyFixes({
      patched: SPEC_PARAM_DESCRIPTION_FIXED,
      applied: [finding],
      originalFindings,
    })
    expect(result.valid).toBe(true)
    expect(result.resolved.map((f) => f.id)).toContain(finding.id)
    expect(result.unresolved).toEqual([])
    expect(result.regressions).toEqual([])
  })

  it('reports an applied fix as unresolved when the patched spec still lints it', async () => {
    const { finding, originalFindings } = await paramFinding()
    const result = await verifyFixes({
      // "patched" spec is unchanged — the fix did not take
      patched: SPEC_MISSING_PARAM_DESCRIPTION,
      applied: [finding],
      originalFindings,
    })
    expect(result.valid).toBe(true)
    expect(result.unresolved.map((f) => f.id)).toContain(finding.id)
    expect(result.resolved).toEqual([])
  })

  it('reports findings introduced by the patch as regressions', async () => {
    const { finding, originalFindings } = await paramFinding()
    const result = await verifyFixes({
      patched: SPEC_OPERATIONID_REMOVED,
      applied: [finding],
      originalFindings,
    })
    expect(result.valid).toBe(true)
    expect(result.regressions.map((f) => f.rule)).toContain('mcp-operationid-required')
  })

  it('flags an unparseable/unsupported patched spec as invalid, all fixes unresolved', async () => {
    const { finding, originalFindings } = await paramFinding()
    const result = await verifyFixes({
      patched: 'swagger: "2.0"\ninfo:\n  title: Broken\n',
      applied: [finding],
      originalFindings,
    })
    expect(result.valid).toBe(false)
    expect(result.unresolved).toEqual([finding])
    expect(result.resolved).toEqual([])
  })

  it('counts non-linter (AI worker) findings as resolved — the linter cannot contradict them', async () => {
    const { originalFindings } = await paramFinding()
    const workerFinding: Finding = {
      id: 'description-quality:custom',
      agentId: 'worker-1',
      rule: 'description-quality',
      severity: 'warning',
      confidence: 'MEDIUM',
      message: 'vague description',
      path: [],
      autoFixable: false,
      autoFixed: false,
      resolution: 'pending',
    }
    const result = await verifyFixes({
      patched: SPEC_PARAM_DESCRIPTION_FIXED,
      applied: [workerFinding],
      originalFindings,
    })
    expect(result.resolved).toEqual([workerFinding])
    expect(result.unresolved).toEqual([])
  })
})
