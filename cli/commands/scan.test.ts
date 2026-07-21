import { readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { parse as parseYaml } from 'yaml'
import type { AiCapability } from '@/lib/engine'
import { AnalysisReportSchema } from '@/types/api'
import type { Finding } from '@/types/domain'
import { runScan } from './scan'

const mockAi: AiCapability = {
  runWorker: async (batch, ctx) =>
    batch.map<Finding>((o) => ({
      id: `${ctx.agentId}-${o.label}`,
      agentId: ctx.agentId,
      operation: o.label,
      rule: 'MCP_NO_WHEN_TO_USE',
      severity: 'warning',
      confidence: 'MEDIUM',
      message: 'Explain when to use this tool.',
      autoFixable: false,
      autoFixed: false,
      resolution: 'pending',
    })),
  runPostProcess: async () => [],
}

const FIXTURES = join(process.cwd(), 'fixtures', 'specs')
const fixture = (name: string) => join(FIXTURES, name)

const tmpFiles: string[] = []
afterEach(async () => {
  await Promise.all(tmpFiles.splice(0).map((f) => rm(f, { force: true })))
})

describe('runScan — exit-code contract', () => {
  it('exits 0 when there are no error-severity findings', async () => {
    const result = await runScan({ specPath: fixture('clean-3.0.yaml') })
    expect(result.exitCode).toBe(0)
  })

  it('exits 1 when there are error-severity findings', async () => {
    const result = await runScan({ specPath: fixture('violations-3.0.yaml') })
    expect(result.exitCode).toBe(1)
  })

  it('exits 2 when the spec file cannot be read', async () => {
    const result = await runScan({ specPath: fixture('does-not-exist.yaml') })
    expect(result.exitCode).toBe(2)
    expect(result.stdout).toMatch(/could not read/i)
  })

  it('exits 2 when the spec version is unsupported (Swagger 2.0)', async () => {
    const result = await runScan({ specPath: fixture('swagger-2.0.yaml') })
    expect(result.exitCode).toBe(2)
    expect(result.stdout).toMatch(/2\.0|not supported/i)
  })

  it('exits 2 when the spec version is undetectable', async () => {
    const result = await runScan({ specPath: fixture('undetectable.yaml') })
    expect(result.exitCode).toBe(2)
  })

  it('reports the detected version and a finding summary on success', async () => {
    const result = await runScan({ specPath: fixture('violations-3.0.yaml') })
    expect(result.stdout).toMatch(/3\.0/)
    expect(result.stdout).toMatch(/error/i)
  })
})

describe('runScan — output rendering', () => {
  it('renders a human report with a health score by default', async () => {
    const result = await runScan({ specPath: fixture('clean-3.0.yaml'), color: false })
    expect(result.stdout).toMatch(/Health score:/)
    expect(result.stdout).not.toMatch(/\x1b\[/)
  })

  it('includes MCP tool loadability in the human report', async () => {
    const result = await runScan({ specPath: fixture('violations-3.0.yaml'), color: false })
    expect(result.stdout).toMatch(/MCP tools: \d+\/\d+ operations loadable/)
  })

  it('prints a valid JSON report with --json', async () => {
    const result = await runScan({ specPath: fixture('violations-3.0.yaml'), json: true })
    const parsed = JSON.parse(result.stdout)
    expect(() => AnalysisReportSchema.parse(parsed)).not.toThrow()
    expect(parsed.spec.version).toBe('3.0')
    expect(result.exitCode).toBe(1)
  })

  it('writes a valid JSON report to --report path', async () => {
    const out = join(tmpdir(), `mcp-doctor-report-${process.pid}.json`)
    tmpFiles.push(out)
    await runScan({ specPath: fixture('clean-3.0.yaml'), reportPath: out })
    const written = JSON.parse(await readFile(out, 'utf8'))
    expect(() => AnalysisReportSchema.parse(written)).not.toThrow()
    expect(written.summary.autoFixed).toBe(0)
  })
})

describe('runScan — fix mode', () => {
  it('writes a patched spec and reports applied/skipped counts (exit 0)', async () => {
    const out = join(tmpdir(), `mcp-doctor-fixed-${process.pid}.yaml`)
    tmpFiles.push(out)
    const result = await runScan({
      specPath: fixture('violations-3.0.yaml'),
      mode: 'fix',
      confidenceThreshold: 'high',
      outputPath: out,
    })
    expect(result.exitCode).toBe(0)
    expect(result.stdout).toMatch(/Applied \d+ fix/)
    const patched = await readFile(out, 'utf8')
    // the PascalCase GetUser operationId is snake_cased by the high-confidence fix
    expect(patched).toContain('get_user')
  })

  it('prints a prominent warning banner under the low (aggressive) threshold', async () => {
    const result = await runScan({
      specPath: fixture('violations-3.0.yaml'),
      mode: 'fix',
      confidenceThreshold: 'low',
    })
    expect(result.stdout).toMatch(/AGGRESSIVE MODE/)
  })

  it('verifies applied fixes by re-linting and reports MCP loadability before → after', async () => {
    const result = await runScan({
      specPath: fixture('violations-3.0.yaml'),
      mode: 'fix',
      confidenceThreshold: 'high',
    })
    expect(result.exitCode).toBe(0)
    expect(result.stdout).toMatch(/Verified: \d+ resolved, \d+ unresolved, \d+ new finding\(s\)/)
    expect(result.stdout).toMatch(/MCP tools: \d+\/\d+ → \d+\/\d+ loadable/)
  })

  it('exits 2 with a loud error when applied fixes break the spec', async () => {
    const evilAi: AiCapability = {
      runWorker: async (_batch, ctx) => [
        {
          id: `${ctx.agentId}-evil`,
          agentId: ctx.agentId,
          rule: 'EVIL_DOWNGRADE',
          severity: 'warning',
          confidence: 'HIGH',
          message: 'downgrade the document',
          path: ['openapi'],
          after: '2.0',
          autoFixable: false,
          autoFixed: false,
          resolution: 'pending',
        },
      ],
      runPostProcess: async () => [],
    }
    const result = await runScan({
      specPath: fixture('clean-3.0.yaml'),
      mode: 'fix',
      ai: evilAi,
    })
    expect(result.exitCode).toBe(2)
    expect(result.stdout).toMatch(/verification failed/i)
  })
})

describe('runScan — operation selection', () => {
  // Two operations, both with a HIGH-confidence fixable violation (PascalCase
  // operationId) — the discriminator for "only the selected one is patched".
  const TWO_OP_SPEC = `openapi: 3.0.3
info:
  title: T
  version: 1.0.0
paths:
  /users:
    get:
      operationId: ListUsers
      description: Returns the users of the account, newest first.
      responses:
        '200':
          description: ok
          content:
            application/json:
              schema:
                type: object
  /items:
    get:
      operationId: ListItems
      description: Returns the items of the account, newest first.
      responses:
        '200':
          description: ok
          content:
            application/json:
              schema:
                type: object
`

  async function twoOpSpecFile(): Promise<string> {
    const specPath = join(tmpdir(), `mcp-doctor-two-op-${process.pid}-${Math.random()}.yaml`)
    tmpFiles.push(specPath)
    await writeFile(specPath, TWO_OP_SPEC)
    return specPath
  }

  it('fix mode with a selection patches only the selected operation', async () => {
    const specPath = await twoOpSpecFile()
    const out = join(tmpdir(), `mcp-doctor-selected-fix-${process.pid}.yaml`)
    tmpFiles.push(out)
    const result = await runScan({
      specPath,
      mode: 'fix',
      confidenceThreshold: 'high',
      outputPath: out,
      selection: [{ path: '/users', methods: ['get'] }],
    })
    expect(result.exitCode).toBe(0)
    const patched = parseYaml(await readFile(out, 'utf8')) as {
      paths: Record<string, { get: { operationId: string } }>
    }
    // selected operation fixed…
    expect(patched.paths['/users']?.get.operationId).toBe('list_users')
    // …the unselected operation's violation remains untouched
    expect(patched.paths['/items']?.get.operationId).toBe('ListItems')
  })

  it('lint mode with a selection drops findings on unselected operations', async () => {
    const specPath = await twoOpSpecFile()
    const result = await runScan({
      specPath,
      json: true,
      selection: [{ path: '/users', methods: ['get'] }],
    })
    const report = JSON.parse(result.stdout) as {
      findings: Array<{ operation?: string; path?: Array<string | number> }>
    }
    const onUsers = report.findings.filter((f) => f.path?.includes('/users'))
    expect(onUsers.length).toBeGreaterThan(0)
    expect(report.findings.some((f) => f.path?.includes('/items'))).toBe(false)
    expect(report.findings.some((f) => f.operation === 'GET /items')).toBe(false)
  })
})

describe('runScan — v2 grounding', () => {
  it('surfaces SPEC_CODE_MISMATCH findings when a grounding runner is provided', async () => {
    const grounding = async () => ({
      findings: [
        {
          id: 'm1',
          agentId: 'worker',
          operation: 'GET /users',
          rule: 'SPEC_CODE_MISMATCH',
          severity: 'error' as const,
          confidence: 'LOW' as const,
          message: 'mismatch',
          actual: '204',
          warning: 'confirm',
          autoFixable: false,
          autoFixed: false,
          resolution: 'pending' as const,
        },
      ],
      filesRead: [{ agentId: 'worker', path: 'handlers/users.go' }],
    })
    const result = await runScan({ specPath: fixture('clean-3.0.yaml'), color: false, grounding })
    expect(result.stdout).toContain('SPEC_CODE_MISMATCH')
    expect(result.exitCode).toBe(1)
    // Evidence log: the CLI reports which code the grounding agent actually read.
    expect(result.stderr).toMatch(/grounding read handlers\/users\.go/)
  })

  const appliableMismatch = async () => ({
    findings: [
      {
        id: 'm1',
        agentId: 'worker',
        operation: 'GET /users',
        rule: 'SPEC_CODE_MISMATCH',
        severity: 'error' as const,
        confidence: 'LOW' as const,
        message: 'spec says newest first, code sorts oldest first',
        after: 'Returns the list of users in the account, oldest first.',
        path: ['paths', '/users', 'get', 'description'],
        warning: 'confirm',
        autoFixable: false,
        autoFixed: false,
        resolution: 'pending' as const,
      },
    ],
    filesRead: [{ agentId: 'worker', path: 'handlers/users.go' }],
  })

  it('flags but never applies mismatches in the default mismatch mode, with a hint', async () => {
    const result = await runScan({
      specPath: fixture('clean-3.0.yaml'),
      mode: 'fix',
      confidenceThreshold: 'low',
      grounding: appliableMismatch,
    })
    expect(result.stdout).toMatch(/spec\/code mismatch\(es\) flagged but not applied/)
    expect(result.stdout).toMatch(/--mismatch-mode=fix/)
  })

  it('applies mismatch fixes with --mismatch-mode=fix at the low threshold', async () => {
    const out = join(tmpdir(), `mcp-doctor-mismatch-${process.pid}.yaml`)
    tmpFiles.push(out)
    const result = await runScan({
      specPath: fixture('clean-3.0.yaml'),
      mode: 'fix',
      confidenceThreshold: 'low',
      mismatchMode: 'fix',
      outputPath: out,
      grounding: appliableMismatch,
    })
    expect(result.stdout).toMatch(/including spec\/code mismatches/)
    const patched = await readFile(out, 'utf8')
    expect(patched).toContain('oldest first')
  })

  it('records the mismatch mode in the JSON report', async () => {
    const result = await runScan({
      specPath: fixture('clean-3.0.yaml'),
      json: true,
      mismatchMode: 'fix',
    })
    const report = JSON.parse(result.stdout)
    expect(report.mismatchMode).toBe('fix')
  })
})

describe('runScan — AI mode', () => {
  it('prints the AI-disabled hint to stderr when no AI capability is supplied', async () => {
    const result = await runScan({ specPath: fixture('clean-3.0.yaml'), color: false })
    expect(result.stderr).toMatch(/AI analysis not enabled/)
  })

  it('runs workers and includes AI findings when an AI capability is supplied', async () => {
    const result = await runScan({ specPath: fixture('clean-3.0.yaml'), color: false, ai: mockAi })
    expect(result.stdout).toContain('MCP_NO_WHEN_TO_USE')
    expect(result.stderr).toMatch(/worker-1/)
  })

  it('includes worker agents in the JSON report under AI mode', async () => {
    const result = await runScan({ specPath: fixture('clean-3.0.yaml'), json: true, ai: mockAi })
    const report = JSON.parse(result.stdout)
    expect(report.agents.map((a: { type: string }) => a.type)).toContain('worker')
  })
})
