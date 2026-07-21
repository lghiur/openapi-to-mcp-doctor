import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { detectSpecPath, discoverRouteFiles, expandRoutePaths } from './discover'

const tempDirs: string[] = []

async function makeRepo(files: string[]): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), 'mcp-doctor-discover-'))
  tempDirs.push(root)
  for (const file of files) {
    const abs = path.join(root, file)
    await mkdir(path.dirname(abs), { recursive: true })
    await writeFile(abs, '// stub\n', 'utf8')
  }
  return root
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

describe('discoverRouteFiles', () => {
  it('collects source files with handler-ish paths first, as repo-relative paths', async () => {
    const root = await makeRepo(['db/models.go', 'internal/handlers/users.go', 'main.go'])
    const out = await discoverRouteFiles(root)
    expect(out).toContain('internal/handlers/users.go')
    expect(out).toContain('db/models.go')
    expect(out).toContain('main.go')
    expect(out.indexOf('internal/handlers/users.go')).toBeLessThan(out.indexOf('db/models.go'))
    expect(out.indexOf('internal/handlers/users.go')).toBeLessThan(out.indexOf('main.go'))
  })

  it('skips excluded dirs, test/spec/declaration files, and non-source files', async () => {
    const root = await makeRepo([
      'node_modules/pkg/index.js',
      'vendor/x/y.go',
      'dist/server.js',
      'handlers/users_test.go',
      'handlers/users.test.ts',
      'types/api.d.ts',
      'README.md',
      'handlers/users.go',
    ])
    const out = await discoverRouteFiles(root)
    expect(out).toEqual(['handlers/users.go'])
  })

  it('caps results at opts.max, keeping hint matches over plain files', async () => {
    const root = await makeRepo(['aaa.go', 'bbb.go', 'router/mux.go', 'zzz/handler.go'])
    const out = await discoverRouteFiles(root, { max: 2 })
    expect(out).toHaveLength(2)
    expect(out).toContain('router/mux.go')
    expect(out).toContain('zzz/handler.go')
  })

  it('caps at MAX_SOURCE_CANDIDATES by default', async () => {
    const files = Array.from({ length: 45 }, (_, i) => `pkg/file${String(i).padStart(2, '0')}.go`)
    const root = await makeRepo(files)
    const out = await discoverRouteFiles(root)
    expect(out).toHaveLength(40)
  })

  it('returns an empty list for a repo with no source files', async () => {
    const root = await makeRepo(['README.md', 'docs/guide.md'])
    await expect(discoverRouteFiles(root)).resolves.toEqual([])
  })
})

describe('expandRoutePaths', () => {
  it('expands directory entries into their contained route files', async () => {
    const root = await makeRepo([
      'internal/api/users.go',
      'internal/api/orders.go',
      'internal/api/users_test.go',
      'main.go',
    ])
    const out = await expandRoutePaths(root, ['internal/api/', 'main.go'])
    expect(out).toContain('internal/api/users.go')
    expect(out).toContain('internal/api/orders.go')
    expect(out).toContain('main.go')
    expect(out).not.toContain('internal/api/users_test.go')
  })

  it('passes plain file entries through untouched (even non-source ones)', async () => {
    const root = await makeRepo(['routes.txt'])
    await expect(expandRoutePaths(root, ['routes.txt'])).resolves.toEqual(['routes.txt'])
  })

  it('keeps missing entries as-is so the scan reports the unreadable file', async () => {
    const root = await makeRepo(['main.go'])
    await expect(expandRoutePaths(root, ['does/not/exist.go'])).resolves.toEqual([
      'does/not/exist.go',
    ])
  })
})

describe('detectSpecPath', () => {
  it('prefers a shallower spec file (root openapi.yaml beats docs/swagger.json)', async () => {
    const root = await makeRepo(['docs/swagger.json', 'openapi.yaml', 'main.go'])
    await expect(detectSpecPath(root)).resolves.toBe('openapi.yaml')
  })

  it('prefers openapi over swagger at the same depth', async () => {
    const root = await makeRepo(['api/swagger.yaml', 'api/openapi.yaml'])
    await expect(detectSpecPath(root)).resolves.toBe('api/openapi.yaml')
  })

  it('finds specs nested up to three directories deep', async () => {
    const root = await makeRepo(['docs/api/v1/openapi.yaml'])
    await expect(detectSpecPath(root)).resolves.toBe('docs/api/v1/openapi.yaml')
  })

  it('ignores specs deeper than three directories and inside excluded dirs', async () => {
    const root = await makeRepo(['a/b/c/d/openapi.yaml', 'node_modules/pkg/openapi.yaml'])
    await expect(detectSpecPath(root)).resolves.toBeUndefined()
  })

  it('returns undefined when nothing matches', async () => {
    const root = await makeRepo(['main.go', 'config.yaml'])
    await expect(detectSpecPath(root)).resolves.toBeUndefined()
  })
})
