import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { checkSelfGrounding, routeFileFor } from '../scripts/self-grounding'
import type { Finding } from '@/types/domain'

const dirs: string[] = []
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })))
})

const SELF_SPEC = `openapi: 3.1.0
info:
  title: T
  version: 0.1.0
paths:
  /api/ping:
    post:
      operationId: ping
      description: Health check endpoint that echoes the request body back.
      responses:
        '200':
          description: ok
  /api/ghost:
    get:
      operationId: ghost
      description: Documented but has no handler on disk.
      responses:
        '200':
          description: ok
`

const HANDLER = `export async function POST(request: Request): Promise<Response> {
  return Response.json({ ok: true })
}
`

async function selfRepo(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'mcp-doctor-self-'))
  dirs.push(root)
  await writeFile(join(root, 'openapi.yaml'), SELF_SPEC)
  await mkdir(join(root, 'src', 'app', 'api', 'ping'), { recursive: true })
  await writeFile(join(root, 'src', 'app', 'api', 'ping', 'route.ts'), HANDLER)
  return root
}

function mismatch(op: string): Finding {
  return {
    id: `m-${op}`,
    agentId: 'dogfood-grounding',
    operation: op,
    rule: 'SPEC_CODE_MISMATCH',
    severity: 'warning',
    confidence: 'LOW',
    message: 'spec says 200, code returns 204',
    autoFixable: false,
    autoFixed: false,
    resolution: 'pending',
  }
}

describe('routeFileFor', () => {
  it('maps a documented path (with params) to its Next.js route file', () => {
    expect(routeFileFor('/repo', '/api/jobs/{id}/stream')).toBe(
      join('/repo', 'src', 'app', 'api', 'jobs', '[id]', 'stream', 'route.ts'),
    )
  })
})

describe('checkSelfGrounding', () => {
  it('grounds every documented operation with a handler file and surfaces mismatches', async () => {
    const root = await selfRepo()
    const detect = vi.fn(async (input: { operation: { label: string }; handlerCode: string }) => {
      // the real route handler source reaches the detector
      expect(input.handlerCode).toContain('Response.json({ ok: true })')
      return [mismatch(input.operation.label)]
    })
    const result = await checkSelfGrounding(root, { model: {} as never, detect: detect as never })

    expect(result.checked).toEqual(['POST /api/ping'])
    expect(result.findings).toHaveLength(1)
    expect(result.findings[0]?.rule).toBe('SPEC_CODE_MISMATCH')
    expect(result.findings[0]?.confidence).toBe('LOW')
  })

  it('isolates a failing detection: other operations still run and the failure is reported', async () => {
    const root = await selfRepo()
    await mkdir(join(root, 'src', 'app', 'api', 'ghost'), { recursive: true })
    await writeFile(join(root, 'src', 'app', 'api', 'ghost', 'route.ts'), HANDLER)
    let calls = 0
    const detect = vi.fn(async (input: { operation: { label: string } }) => {
      calls += 1
      if (input.operation.label === 'POST /api/ping') throw new Error('gateway hiccup')
      return [mismatch(input.operation.label)]
    })
    const result = await checkSelfGrounding(root, { model: {} as never, detect: detect as never })

    expect(calls).toBe(2) // the failure did not stop the sweep
    expect(result.failures).toEqual([{ operation: 'POST /api/ping', error: 'gateway hiccup' }])
    expect(result.checked).toEqual(['GET /api/ghost'])
    expect(result.findings).toHaveLength(1)
  })

  it('reports documented paths with no route file as missing, without calling the LLM for them', async () => {
    const root = await selfRepo()
    const detect = vi.fn(async () => [])
    const result = await checkSelfGrounding(root, { model: {} as never, detect: detect as never })

    expect(result.missing).toHaveLength(1)
    expect(result.missing[0]).toContain('/api/ghost')
    expect(detect).toHaveBeenCalledOnce() // only /api/ping
    expect(result.findings).toHaveLength(0)
  })
})
