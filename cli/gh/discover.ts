import { readdir, stat } from 'node:fs/promises'
import path from 'node:path'
import {
  HANDLER_HINT,
  MAX_SOURCE_CANDIDATES,
  SOURCE_EXCLUDE,
  SOURCE_PATTERN,
  SPEC_FILE_PATTERN,
} from '@/lib/github/source-patterns'

/**
 * Local workspace auto-discovery for the GitHub Action: the checked-out repo
 * is on disk, so walk it directly instead of the git tree API (`client.ts`).
 * All returned paths are repo-relative with `/` separators.
 */

/** How many directory levels deep `detectSpecPath` searches (root = 0). */
const SPEC_SEARCH_DEPTH = 3

async function walk(
  rootDir: string,
  relDir: string,
  maxDepth: number | undefined,
  out: string[],
): Promise<void> {
  const entries = await readdir(path.join(rootDir, relDir), { withFileTypes: true })
  for (const entry of entries) {
    const relPath = relDir ? `${relDir}/${entry.name}` : entry.name
    if (SOURCE_EXCLUDE.test(relPath)) continue
    if (entry.isDirectory()) {
      const depth = relPath.split('/').length
      if (maxDepth === undefined || depth <= maxDepth) {
        await walk(rootDir, relPath, maxDepth, out)
      }
    } else if (entry.isFile()) {
      out.push(relPath)
    }
  }
}

/**
 * Recursively collect candidate route/handler files under `rootDir`,
 * handler-ish paths first, capped at `opts.max ?? MAX_SOURCE_CANDIDATES`.
 */
export async function discoverRouteFiles(
  rootDir: string,
  opts?: { max?: number },
): Promise<string[]> {
  const files: string[] = []
  await walk(rootDir, '', undefined, files)
  const paths = files.filter((file) => SOURCE_PATTERN.test(file))

  // Same ordering as client.ts listSourceCandidates: handler-ish files first,
  // then shallower paths, then alphabetical — so the capped slice keeps the
  // files most likely to register routes.
  paths.sort((a, b) => {
    const hintA = HANDLER_HINT.test(a) ? 0 : 1
    const hintB = HANDLER_HINT.test(b) ? 0 : 1
    if (hintA !== hintB) return hintA - hintB
    const depthA = a.split('/').length
    const depthB = b.split('/').length
    if (depthA !== depthB) return depthA - depthB
    return a.localeCompare(b)
  })
  return paths.slice(0, opts?.max ?? MAX_SOURCE_CANDIDATES)
}

/**
 * Expand user-supplied `route-paths` entries: directory entries become their
 * contained route files (the scan readFile()s every entry, so a bare directory
 * would fail); file entries pass through untouched. Missing entries are kept
 * so the scan can report the unreadable path instead of silently dropping it.
 * All entries and results are repo-relative to `rootDir`.
 */
export async function expandRoutePaths(rootDir: string, entries: string[]): Promise<string[]> {
  const out: string[] = []
  for (const entry of entries) {
    const rel = entry.replace(/^\.\//, '').replace(/\/+$/, '')
    const stats = await stat(path.join(rootDir, rel)).catch(() => null)
    if (stats?.isDirectory()) {
      const files = await discoverRouteFiles(path.join(rootDir, rel))
      out.push(...files.map((file) => `${rel}/${file}`))
    } else {
      out.push(rel)
    }
  }
  return out
}

/**
 * Shallow search (≤ 3 directories deep) for an OpenAPI spec file.
 * Prefers shallower paths, then `openapi.*` over `swagger.*`.
 */
export async function detectSpecPath(rootDir: string): Promise<string | undefined> {
  const files: string[] = []
  await walk(rootDir, '', SPEC_SEARCH_DEPTH, files)
  const specs = files.filter((file) => SPEC_FILE_PATTERN.test(file))

  specs.sort((a, b) => {
    const depthA = a.split('/').length
    const depthB = b.split('/').length
    if (depthA !== depthB) return depthA - depthB
    const openapiA = /(^|\/)openapi/i.test(a) ? 0 : 1
    const openapiB = /(^|\/)openapi/i.test(b) ? 0 : 1
    if (openapiA !== openapiB) return openapiA - openapiB
    return a.localeCompare(b)
  })
  return specs[0]
}
