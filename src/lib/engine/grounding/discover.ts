import { detectMountPrefixes, type RouteFile } from '@/lib/engine/grounding/map'
import type { OperationRef } from '@/lib/engine/operations'
import type { Finding } from '@/types/domain'

const GROUNDING_AGENT_ID = 'worker'

/** One route registration found in source. `method: '*'` = method-less (catch-all/default). */
export interface RegisteredRoute {
  method: string
  path: string
  file: string
  line: number
  /** The router variable the route was registered on (`r`, `muxer`, `app`). */
  receiver: string
}

/** Registration verbs whose first string argument is a route path. */
const METHOD_VERBS = new Set(['get', 'post', 'put', 'delete', 'patch', 'options', 'head', 'trace'])
const GENERIC_VERBS = new Set(['handlefunc', 'handle', 'route', 'all'])

const REGISTRATION = /(?:^|[^\w.])(\w+)\.(\w+)\(\s*["'`]([^"'`]+)["'`]/g
const METHOD_TOKEN = /\b(GET|PUT|POST|DELETE|OPTIONS|HEAD|PATCH|TRACE)\b|\bMethod(Get|Put|Post|Delete|Options|Head|Patch|Trace)\b/g

/**
 * Extract every route registration from the provided files — the inverse of
 * `mapOperationsToHandlers`. Deterministic text matching: method-named calls
 * (`.get(`, `.GET(`, `.Post(`), generic registrations with methods nearby
 * (`HandleFunc(...).Methods("GET")`, `@app.route(..., methods=[...])`), and
 * net/http 1.22 `"GET /path"` patterns. Method-less registrations return `'*'`.
 */
export function extractRegisteredRoutes(routeFiles: RouteFile[]): RegisteredRoute[] {
  const routes: RegisteredRoute[] = []
  for (const file of routeFiles) {
    const lines = file.content.split('\n')
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i] ?? ''
      REGISTRATION.lastIndex = 0
      for (const match of line.matchAll(REGISTRATION)) {
        const receiver = match[1] ?? ''
        const verb = (match[2] ?? '').toLowerCase()
        let path = match[3] ?? ''
        const isMethodVerb = METHOD_VERBS.has(verb)
        if (!isMethodVerb && !GENERIC_VERBS.has(verb)) continue

        // A `+` after the closing quote means the path is built dynamically
        // (`"/"+cfg.HealthCheckEndpointName`) — no static path exists to report.
        const rest = line.slice((match.index ?? 0) + match[0].length)
        if (/^\s*\+/.test(rest)) continue

        // net/http 1.22: the method lives inside the pattern string.
        let embeddedMethod: string | undefined
        const embedded = /^([A-Z]+)\s+(\/.*)$/.exec(path)
        if (embedded && embedded[1] !== undefined && embedded[2] !== undefined) {
          embeddedMethod = embedded[1]
          path = embedded[2]
        }
        if (!path.startsWith('/') || path === '/') continue

        const methods = isMethodVerb
          ? [verb.toUpperCase()]
          : embeddedMethod !== undefined
            ? [embeddedMethod]
            : methodsNear(lines, i)
        for (const method of methods.length > 0 ? methods : ['*']) {
          routes.push({ method, path, file: file.path, line: i + 1, receiver })
        }
      }
    }
  }
  return routes
}

/** Method tokens on the registration line or its continuation lines. */
function methodsNear(lines: string[], start: number): string[] {
  const window: string[] = [lines[start] ?? '']
  for (let k = 1; k <= 2; k++) {
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
  const methods: string[] = []
  METHOD_TOKEN.lastIndex = 0
  for (const match of window.join('\n').matchAll(METHOD_TOKEN)) {
    const method = (match[1] ?? match[2] ?? '').toUpperCase()
    if (method !== '' && !methods.includes(method)) methods.push(method)
  }
  return methods
}

/** `/users/:id`, `/users/{id:regex}`, `/users/<int:id>` → `/users/*` for comparison. */
function comparablePath(path: string): string {
  return `/${normalizeSegments(path)
    .map((segment) => (isParam(segment) ? '*' : segment))
    .join('/')}`
}

function isParam(segment: string): boolean {
  return segment.startsWith(':') || segment.startsWith('{') || segment.startsWith('<')
}

/**
 * Split a route path into segments, brace/angle-aware: a gorilla regex param
 * like `{keyName:[^/]*}` contains `/` inside its character class and must stay
 * one segment.
 */
function normalizeSegments(path: string): string[] {
  const segments: string[] = []
  let current = ''
  let depth = 0
  for (const char of path) {
    if (char === '{' || char === '<') depth++
    else if (char === '}' || char === '>') depth = Math.max(0, depth - 1)
    if (char === '/' && depth === 0) {
      if (current !== '') segments.push(current)
      current = ''
    } else {
      current += char
    }
  }
  if (current !== '') segments.push(current)
  return segments
}

/** Convert any source param syntax to OpenAPI `{name}` for a suggested spec path. */
function toOpenApiPath(path: string): string {
  const segments = normalizeSegments(path).map((segment) => {
    if (!isParam(segment)) return segment
    // gorilla `{name:regex}` puts the name BEFORE the colon; Flask `<type:name>` after.
    const inner = segment.replace(/^[:{<]+/, '').replace(/[}>]+$/, '')
    const name = segment.startsWith('<') ? (inner.split(':').pop() ?? inner) : inner.split(':')[0]
    const bare = (name ?? '').replace(/[^A-Za-z0-9_]/g, '')
    return `{${bare === '' ? 'param' : bare}}`
  })
  return `/${segments.join('/')}`
}

export interface DiscoverOptions {
  serverPrefixes?: string[]
}

/**
 * The inverse check of handler mapping: every route registered in code that no
 * spec operation documents becomes a finding carrying a ready-to-insert spec
 * stub. MEDIUM confidence — the endpoint's existence is deterministic, but
 * whether it *belongs* in the public spec is a human call (debug/internal
 * endpoints are often undocumented on purpose).
 */
export function discoverUndocumentedEndpoints(
  operations: OperationRef[],
  routeFiles: RouteFile[],
  options: DiscoverOptions = {},
): Finding[] {
  const mounts = detectMountPrefixes(routeFiles)
  const serverPrefixes = options.serverPrefixes ?? []

  // Spec index: comparable path → documented methods (plus server-prefixed
  // aliases, since code may register the full external path).
  const spec = new Map<string, Set<string>>()
  const specPathFor = new Map<string, string>()
  for (const operation of operations) {
    for (const alias of [operation.path, ...serverPrefixes.map((p) => `${p}${operation.path}`)]) {
      const key = comparablePath(alias)
      const methods = spec.get(key) ?? new Set<string>()
      methods.add(operation.method.toUpperCase())
      spec.set(key, methods)
      if (!specPathFor.has(key)) specPathFor.set(key, operation.path)
    }
  }

  const pathDocumented = (path: string, method: string): boolean => {
    const methods = spec.get(comparablePath(path))
    if (!methods) return false
    return method === '*' || methods.has(method)
  }
  const documented = (route: RegisteredRoute): boolean =>
    [route.path, ...mounts.map((m) => `${m}${route.path}`)].some((candidate) =>
      pathDocumented(candidate, route.method),
    )

  // Text matching cannot tell which router a mount prefix applies to, so learn
  // it per receiver variable: `r`'s routes are documented under `/tyk/…` in the
  // Tyk repo (StripPrefix mount), while `muxer`'s pprof routes live at the root.
  const routes = extractRegisteredRoutes(routeFiles)
  const receiverMount = new Map<string, string | null>()
  for (const route of routes) {
    if (pathDocumented(route.path, route.method)) {
      if (!receiverMount.has(route.receiver)) receiverMount.set(route.receiver, null)
      continue
    }
    const mount = mounts.find((m) => pathDocumented(`${m}${route.path}`, route.method))
    if (mount !== undefined && receiverMount.get(route.receiver) == null) {
      receiverMount.set(route.receiver, mount)
    }
  }

  // Group undocumented routes by their suggested external spec path, deduping
  // identical registrations across files.
  const groups = new Map<string, { methods: Map<string, RegisteredRoute> }>()
  for (const route of routes) {
    if (documented(route)) continue
    const externalPath = suggestedSpecPath(
      route,
      serverPrefixes,
      receiverMount.get(route.receiver) ?? undefined,
    )
    const group = groups.get(externalPath) ?? { methods: new Map<string, RegisteredRoute>() }
    const method = route.method === '*' ? 'GET' : route.method
    if (!group.methods.has(method)) group.methods.set(method, route)
    groups.set(externalPath, group)
  }

  const findings: Finding[] = []
  for (const [externalPath, group] of groups) {
    const existingSpecPath = specPathFor.get(comparablePath(externalPath))
    if (existingSpecPath !== undefined) {
      // Path documented, method missing — target the method key directly.
      for (const [method, route] of group.methods) {
        findings.push(undocumentedFinding([externalPath], method, route, {
          path: ['paths', existingSpecPath, method.toLowerCase()],
          stub: operationStub(method, externalPath, route),
        }))
      }
      continue
    }
    // New path — one finding inserting the whole path item (all its methods),
    // so sequential fix application never overwrites a sibling method.
    const stub: Record<string, unknown> = {}
    for (const [method, route] of group.methods) {
      stub[method.toLowerCase()] = operationStub(method, externalPath, route)
    }
    const [firstMethod, firstRoute] = [...group.methods.entries()][0] ?? ['GET', undefined]
    if (firstRoute === undefined) continue
    findings.push(
      undocumentedFinding([...group.methods.keys()], firstMethod, firstRoute, {
        path: ['paths', externalPath],
        stub,
      }),
    )
  }
  return findings
}

/**
 * The spec-style external path for a registered route: server base paths are
 * stripped (spec paths omit them), and a detected mount prefix is prepended
 * only when this route's receiver demonstrably registers under it.
 */
function suggestedSpecPath(
  route: RegisteredRoute,
  serverPrefixes: string[],
  mount: string | undefined,
): string {
  let path = route.path
  for (const prefix of serverPrefixes) {
    if (path.startsWith(`${prefix}/`)) {
      path = path.slice(prefix.length)
      break
    }
  }
  if (mount !== undefined) path = `${mount}${path}`
  return toOpenApiPath(path)
}

function operationStub(
  method: string,
  externalPath: string,
  route: RegisteredRoute,
): Record<string, unknown> {
  return {
    operationId: operationIdFor(method, externalPath),
    summary: `TODO: document ${method} ${externalPath}`,
    description:
      `Endpoint discovered in ${route.file}:${route.line} but not documented in the ` +
      'OpenAPI spec. Describe what it does, when an agent should use it, and its responses.',
    responses: { '200': { description: 'TODO: document the successful response.' } },
  }
}

function operationIdFor(method: string, path: string): string {
  const segments = normalizeSegments(path).map((segment) =>
    isParam(segment) ? segment.replace(/[^A-Za-z0-9_]/g, '') : segment,
  )
  return [method.toLowerCase(), ...segments]
    .join('_')
    .toLowerCase()
    .replace(/[^a-z0-9_]/g, '')
}

function undocumentedFinding(
  methods: string[],
  method: string,
  route: RegisteredRoute,
  fix: { path: Array<string | number>; stub: Record<string, unknown> },
): Finding {
  const externalPath = String(fix.path[1])
  return {
    id: `grounding-undocumented-${methods.join('-').toLowerCase()}-${externalPath}`,
    agentId: GROUNDING_AGENT_ID,
    operation: `${method} ${externalPath}`,
    rule: 'SPEC_CODE_UNDOCUMENTED_ENDPOINT',
    severity: 'info',
    confidence: 'MEDIUM',
    message:
      `${methods.join(', ')} ${externalPath} is registered in ${route.file}:${route.line} ` +
      'but not documented in the spec. Accept the suggested stub to document it, or leave it ' +
      'undocumented if it is internal.',
    path: fix.path,
    after: JSON.stringify(fix.stub, null, 2),
    autoFixable: false,
    autoFixed: false,
    resolution: 'pending',
  }
}
