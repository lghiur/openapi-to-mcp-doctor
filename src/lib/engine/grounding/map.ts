import type { OperationRef } from '@/lib/engine/operations'

export interface RouteFile {
  path: string
  content: string
}

export interface HandlerCandidate {
  operation: string
  file: string | null
  line: number | null
  symbol: string | null
  matched: boolean
}

const HTTP_METHODS = ['GET', 'PUT', 'POST', 'DELETE', 'OPTIONS', 'HEAD', 'PATCH', 'TRACE']

/**
 * A path parameter as it appears in source registrations: `:id` (Express/Rails),
 * `{id}` / `{keyName:[^/]*}` (net/http, gorilla — the braces may contain a regex,
 * which may itself contain `/` inside a character class), `<int:id>` (Flask).
 */
const PARAM_SEGMENT = '(?::[A-Za-z0-9_]+|\\{[^}]*\\}|<[^>]*>)'

/** Lines after a path match in which the HTTP method may still appear (chained calls). */
const METHOD_WINDOW_LINES = 2

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/** `GET` as a route-registration token: bare (`.Methods("GET")`, `.get(`) or a Go constant (`http.MethodGet`). */
function methodPattern(method: string): RegExp {
  const title = method.charAt(0) + method.slice(1).toLowerCase()
  return new RegExp(`\\b${method}\\b|\\bMethod${title}\\b`, 'i')
}

const ANY_METHOD = new RegExp(
  `\\b(?:${HTTP_METHODS.join('|')})\\b|\\bMethod(?:${HTTP_METHODS.map(
    (m) => m.charAt(0) + m.slice(1).toLowerCase(),
  ).join('|')})\\b`,
  'i',
)

/**
 * Build a regex matching the spec path as a quoted string literal in source code,
 * tolerating parameter syntax variants, a trailing slash, and an optional leading
 * `METHOD ` (net/http 1.22). Anchored on the closing quote so `/users` never
 * matches `/users/{id}`.
 */
function pathPattern(specPath: string): RegExp {
  const parts = specPath
    .split('/')
    .filter((segment) => segment.length > 0)
    .map((segment) => (/^\{.+\}$/.test(segment) ? PARAM_SEGMENT : escapeRegex(segment)))
  const body = `/${parts.join('/')}`
  return new RegExp(`["'\`](?:[A-Z]+\\s+)?${body}/?["'\`]`)
}

/**
 * Prefixes that routers strip (or prepend) before registrations see the path —
 * why `GET /tyk/reload/group` is registered in source as `"/reload/group"`.
 * Detected per framework mount idiom; no variable tracking, so every detected
 * prefix is a *candidate* tried during matching, never an assertion.
 */
export function detectMountPrefixes(routeFiles: RouteFile[]): string[] {
  const patterns = [
    /StripPrefix\(\s*["'`]([^"'`]+)["'`]/g, // Go http.StripPrefix
    /PathPrefix\(\s*["'`]([^"'`]+)["'`]\s*\)\s*\.Subrouter\(/g, // gorilla subrouter
    /\.(?:Mount|Route)\(\s*["'`]([^"'`]+)["'`]/g, // chi
    /\.use\(\s*["'`]([^"'`]+)["'`]\s*,/g, // Express/Koa app.use('/x', router)
    /\bprefix\s*[:=]\s*["'`]([^"'`]+)["'`]/g, // Fastify register / FastAPI APIRouter
    /\burl_prefix\s*=\s*["'`]([^"'`]+)["'`]/g, // Flask blueprint
    /@Controller\(\s*["'`]([^"'`]+)["'`]/g, // NestJS
    /@RequestMapping\(\s*(?:value\s*=\s*)?["'`]([^"'`]+)["'`]/g, // Spring class level
  ]
  const prefixes = new Set<string>()
  for (const file of routeFiles) {
    for (const pattern of patterns) {
      pattern.lastIndex = 0
      for (const match of file.content.matchAll(pattern)) {
        const raw = match[1]
        if (raw === undefined) continue
        const normalized = normalizePath(raw)
        if (normalized !== '/') prefixes.add(normalized)
      }
    }
  }
  return [...prefixes]
}

/** Leading slash, no trailing slash: `'tyk/'` and `'/tyk'` both mean `/tyk`. */
function normalizePath(path: string): string {
  const withLead = path.startsWith('/') ? path : `/${path}`
  const trimmed = withLead.replace(/\/+$/, '')
  return trimmed === '' ? '/' : trimmed
}

/**
 * The paths under which an operation's registration may appear in source, in
 * priority order: the spec path itself first, then server-base-path variants
 * (spec paths written relative to `servers[].url`), then each with detected
 * mount prefixes stripped (depth 2 for nested mounts).
 */
function candidatePaths(
  specPath: string,
  mounts: string[],
  serverPrefixes: string[],
): string[] {
  const seen = new Set<string>([normalizePath(specPath)])
  for (const prefix of serverPrefixes) {
    seen.add(normalizePath(`${normalizePath(prefix)}${normalizePath(specPath)}`))
  }
  let frontier = [...seen]
  for (let depth = 0; depth < 2; depth++) {
    const next: string[] = []
    for (const candidate of frontier) {
      for (const mount of mounts) {
        if (!candidate.startsWith(`${mount}/`)) continue
        const stripped = candidate.slice(mount.length)
        if (!seen.has(stripped)) {
          seen.add(stripped)
          next.push(stripped)
        }
      }
    }
    frontier = next
  }
  return [...seen]
}

export interface MapOptions {
  /** Path components of the spec's `servers[].url` — external base paths not in `paths` keys. */
  serverPrefixes?: string[]
}

/**
 * Map each operation to a candidate handler in the user-pointed route files using
 * deterministic text matching (no per-language parser). Unmatched operations are
 * returned with `matched: false` (surfaced as a finding, never a crash).
 *
 * Matching runs in two passes over all candidate paths: first registrations with
 * an explicit method token near the path (same line or the next couple of lines,
 * for chained `.route('/x').get(h)` styles), then method-less registrations
 * (mux catch-all `HandleFunc`, Flask's default-GET `@app.route`).
 */
export function mapOperationsToHandlers(
  operations: OperationRef[],
  routeFiles: RouteFile[],
  options: MapOptions = {},
): HandlerCandidate[] {
  const mounts = detectMountPrefixes(routeFiles)
  const serverPrefixes = options.serverPrefixes ?? []

  return operations.map((operation) => {
    const candidates = candidatePaths(operation.path, mounts, serverPrefixes)
    for (const requireMethod of [true, false]) {
      for (const candidate of candidates) {
        const found = findRegistration(candidate, operation.method, routeFiles, requireMethod)
        if (found) return { operation: operation.label, ...found, matched: true }
      }
    }
    return { operation: operation.label, file: null, line: null, symbol: null, matched: false }
  })
}

function findRegistration(
  candidatePath: string,
  method: string,
  routeFiles: RouteFile[],
  requireMethod: boolean,
): Omit<HandlerCandidate, 'operation' | 'matched'> | null {
  const pathRe = pathPattern(candidatePath)
  const methodRe = methodPattern(method)

  for (const file of routeFiles) {
    const lines = file.content.split('\n')
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i] ?? ''
      const match = pathRe.exec(line)
      if (!match) continue
      const window = statementWindow(lines, i)
      // Explicit pass: the operation's method appears near the path. Relaxed
      // pass: NO method token at all — a catch-all/default registration; a
      // registration pinned to a different method is never a match.
      const hit = requireMethod ? methodRe.test(window) : !ANY_METHOD.test(window)
      if (!hit) continue
      return {
        file: file.path,
        line: i + 1,
        symbol: extractSymbol(line, match.index + match[0].length),
      }
    }
  }
  return null
}

/**
 * The registration line plus its continuation lines — chained calls
 * (`.get(handler)`), closing calls (`).Methods("GET")`), or lines following an
 * unterminated argument list. A neighbouring statement's method token must never
 * bleed into this window, so extension stops at the first non-continuation line.
 */
function statementWindow(lines: string[], start: number): string {
  const window = [lines[start] ?? '']
  for (let k = 1; k <= METHOD_WINDOW_LINES; k++) {
    const previous = (lines[start + k - 1] ?? '').trimEnd()
    const next = lines[start + k]
    if (next === undefined) break
    const continues =
      next.trimStart().startsWith('.') ||
      next.trimStart().startsWith(')') ||
      previous.endsWith(',') ||
      previous.endsWith('(')
    if (!continues) break
    window.push(next)
  }
  return window.join('\n')
}

function extractSymbol(line: string, afterIndex: number): string | null {
  const rest = line.slice(afterIndex)
  const match = /^\s*,\s*&?([A-Za-z_][\w.]*)/.exec(rest)
  return match?.[1] ?? null
}

export interface SymbolDefinition {
  file: string
  line: number
}

/**
 * Locate the definition of a handler symbol across the provided files — the
 * deterministic "follow the reference" step (depth 2). Text-pattern based, no
 * per-language parser: covers Go funcs/methods, JS/TS functions and function-
 * valued bindings, and Python defs. Dotted symbols (`handlers.GetUser`) search
 * by their final segment. Returns null when no definition is found.
 */
export function findSymbolDefinition(
  symbol: string,
  routeFiles: RouteFile[],
): SymbolDefinition | null {
  const name = symbol.split('.').pop()
  if (!name) return null
  const escaped = escapeRegex(name)
  const patterns = [
    new RegExp(`\\bfunc\\s+(\\([^)]*\\)\\s*)?${escaped}\\s*\\(`), // Go func / method
    new RegExp(`\\bfunction\\s+${escaped}\\s*\\(`), // JS/TS function declaration
    new RegExp(`\\b(?:const|let|var)\\s+${escaped}\\s*=`), // JS/TS binding
    new RegExp(`(?:^|[{,]\\s*)${escaped}\\s*:\\s*(?:async\\s+)?(?:function\\b|\\()`), // object method
    new RegExp(`\\bdef\\s+${escaped}\\s*\\(`), // Python
  ]

  for (const file of routeFiles) {
    const lines = file.content.split('\n')
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i] ?? ''
      if (patterns.some((pattern) => pattern.test(line))) {
        return { file: file.path, line: i + 1 }
      }
    }
  }
  return null
}

export { HTTP_METHODS }
