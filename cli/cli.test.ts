import { spawnSync } from 'node:child_process'
import { copyFileSync, existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

const CLI = join(process.cwd(), 'cli', 'index.ts')
const FIXTURES = join(process.cwd(), 'fixtures', 'specs')
// Absolute path: the spawned process runs with a temp-dir cwd, where a bare
// `--import tsx` would no longer resolve.
const TSX = join(process.cwd(), 'node_modules', 'tsx', 'dist', 'loader.mjs')

// Scans run against temp copies: the CLI writes its .mcp-doctor.yaml sidecar
// next to the spec by default, and the fixture corpus must stay pristine.
let dir: string
const fixture = (name: string) => join(dir, name)

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'mcp-doctor-cli-'))
  for (const name of [
    'clean-3.0.yaml',
    'violations-3.0.yaml',
    'swagger-2.0.yaml',
    'many-operations-3.0.yaml',
  ]) {
    copyFileSync(join(FIXTURES, name), join(dir, name))
  }
})
afterAll(() => {
  rmSync(dir, { recursive: true, force: true })
})

function runCli(args: string[], cwd?: string) {
  // Clear LLM env so spawned runs are deterministically structural-only. cwd
  // defaults to the temp fixture dir: the CLI records run history under its
  // working directory, which must never be the repo checkout during tests.
  return spawnSync(process.execPath, ['--import', TSX, CLI, ...args], {
    encoding: 'utf8',
    cwd: cwd ?? dir,
    env: {
      ...process.env,
      LLM_BASE_URL: '',
      LLM_API_TOKEN: '',
      // tsx resolves the `@/` path aliases from tsconfig relative to cwd —
      // pin it to the repo's tsconfig since cwd is a temp dir here.
      TSX_TSCONFIG_PATH: join(process.cwd(), 'tsconfig.json'),
    },
    timeout: 60_000,
  })
}

// Spawning tsx + loading Spectral takes ~1s per invocation.
const TIMEOUT = 30_000

describe('mcp-doctor CLI (spawned, native ESM)', () => {
  it(
    'scan on a clean spec exits 0, reports the version, and writes the sidecar cache',
    () => {
      const result = runCli(['scan', fixture('clean-3.0.yaml')])
      expect(result.status).toBe(0)
      expect(result.stdout).toMatch(/OpenAPI 3\.0/)
      // cache is on by default; the sidecar lands next to the spec
      expect(existsSync(join(dir, '.mcp-doctor.yaml'))).toBe(true)
    },
    TIMEOUT,
  )

  it(
    'scan --no-cache is accepted and skips the sidecar',
    () => {
      const noCacheDir = mkdtempSync(join(tmpdir(), 'mcp-doctor-nocache-'))
      copyFileSync(join(FIXTURES, 'clean-3.0.yaml'), join(noCacheDir, 'clean-3.0.yaml'))
      const result = runCli(['scan', join(noCacheDir, 'clean-3.0.yaml'), '--no-cache'])
      expect(result.status).toBe(0)
      expect(existsSync(join(noCacheDir, '.mcp-doctor.yaml'))).toBe(false)
      rmSync(noCacheDir, { recursive: true, force: true })
    },
    TIMEOUT,
  )

  it(
    'scan on a spec with errors exits 1',
    () => {
      expect(runCli(['scan', fixture('violations-3.0.yaml')]).status).toBe(1)
    },
    TIMEOUT,
  )

  it(
    'scan on Swagger 2.0 exits 2 (analysis failed)',
    () => {
      expect(runCli(['scan', fixture('swagger-2.0.yaml')]).status).toBe(2)
    },
    TIMEOUT,
  )

  it(
    'scan with no spec argument exits 3 (invalid args)',
    () => {
      expect(runCli(['scan']).status).toBe(3)
    },
    TIMEOUT,
  )

  it(
    '--version exits 0 and prints the version',
    () => {
      const result = runCli(['--version'])
      expect(result.status).toBe(0)
      expect(result.stdout).toMatch(/0\.1\.0/)
    },
    TIMEOUT,
  )

  it(
    '--help exits 0',
    () => {
      expect(runCli(['--help']).status).toBe(0)
    },
    TIMEOUT,
  )

  it(
    'scan records a run under .mcp-doctor/runs by default, and history lists it',
    () => {
      const histDir = mkdtempSync(join(tmpdir(), 'mcp-doctor-hist-'))
      copyFileSync(join(FIXTURES, 'clean-3.0.yaml'), join(histDir, 'clean-3.0.yaml'))
      const scan = runCli(['scan', join(histDir, 'clean-3.0.yaml')], histDir)
      expect(scan.status).toBe(0)
      const runsDir = join(histDir, '.mcp-doctor', 'runs')
      expect(existsSync(runsDir)).toBe(true)
      expect(readdirSync(runsDir).filter((f) => f.endsWith('.json'))).toHaveLength(1)
      const history = runCli(['history'], histDir)
      expect(history.status).toBe(0)
      expect(history.stdout).toContain('clean-3.0.yaml')
      rmSync(histDir, { recursive: true, force: true })
    },
    TIMEOUT,
  )

  it(
    'scan --no-history skips run recording',
    () => {
      const histDir = mkdtempSync(join(tmpdir(), 'mcp-doctor-nohist-'))
      copyFileSync(join(FIXTURES, 'clean-3.0.yaml'), join(histDir, 'clean-3.0.yaml'))
      const scan = runCli(['scan', join(histDir, 'clean-3.0.yaml'), '--no-history'], histDir)
      expect(scan.status).toBe(0)
      expect(existsSync(join(histDir, '.mcp-doctor'))).toBe(false)
      rmSync(histDir, { recursive: true, force: true })
    },
    TIMEOUT,
  )

  it(
    'rejects an invalid --confidence-threshold value with exit 3 (never silently coerced)',
    () => {
      const result = runCli(['scan', fixture('clean-3.0.yaml'), '--confidence-threshold', 'meduim'])
      expect(result.status).toBe(3)
      expect(result.stderr).toMatch(/meduim/)
      expect(result.stderr).toMatch(/high, medium, low/)
    },
    TIMEOUT,
  )

  it(
    'rejects an invalid --mode value with exit 3',
    () => {
      const result = runCli(['scan', fixture('clean-3.0.yaml'), '--mode', 'lnit'])
      expect(result.status).toBe(3)
      expect(result.stderr).toMatch(/lint, fix/)
    },
    TIMEOUT,
  )

  it(
    'rejects an invalid --mismatch-mode value with exit 3',
    () => {
      const result = runCli(['scan', fixture('clean-3.0.yaml'), '--mismatch-mode', 'flug'])
      expect(result.status).toBe(3)
      expect(result.stderr).toMatch(/flag, fix/)
    },
    TIMEOUT,
  )

  it(
    'scan --json emits complete, parseable JSON on stdout (no exit-time truncation)',
    () => {
      const result = runCli(['scan', fixture('many-operations-3.0.yaml'), '--json', '--no-cache'])
      expect(() => JSON.parse(result.stdout) as unknown).not.toThrow()
    },
    TIMEOUT,
  )

  it(
    'prints the AI-disabled hint to stderr when no LLM creds are set',
    () => {
      const result = runCli(['scan', fixture('clean-3.0.yaml')])
      expect(result.stderr).toMatch(/AI analysis not enabled/)
    },
    TIMEOUT,
  )
})
