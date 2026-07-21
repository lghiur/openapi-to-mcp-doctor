import { spawnSync } from 'node:child_process'
import { copyFileSync, existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

const CLI = join(process.cwd(), 'cli', 'index.ts')
const FIXTURES = join(process.cwd(), 'fixtures', 'specs')

// Scans run against temp copies: the CLI writes its .mcp-doctor.yaml sidecar
// next to the spec by default, and the fixture corpus must stay pristine.
let dir: string
const fixture = (name: string) => join(dir, name)

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'mcp-doctor-cli-'))
  for (const name of ['clean-3.0.yaml', 'violations-3.0.yaml', 'swagger-2.0.yaml']) {
    copyFileSync(join(FIXTURES, name), join(dir, name))
  }
})
afterAll(() => {
  rmSync(dir, { recursive: true, force: true })
})

function runCli(args: string[]) {
  // Clear LLM env so spawned runs are deterministically structural-only.
  return spawnSync(process.execPath, ['--import', 'tsx', CLI, ...args], {
    encoding: 'utf8',
    env: { ...process.env, LLM_BASE_URL: '', LLM_API_TOKEN: '' },
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
    'prints the AI-disabled hint to stderr when no LLM creds are set',
    () => {
      const result = runCli(['scan', fixture('clean-3.0.yaml')])
      expect(result.stderr).toMatch(/AI analysis not enabled/)
    },
    TIMEOUT,
  )
})
