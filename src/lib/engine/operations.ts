import { parse as parseYaml } from 'yaml'

const HTTP_METHODS = ['get', 'put', 'post', 'delete', 'options', 'head', 'patch', 'trace'] as const

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** A single operation extracted from a spec, with the context a worker needs. */
export interface OperationRef {
  /** operationId, or a synthesized id when absent. */
  id: string
  method: string
  path: string
  /** Human label, e.g. "GET /users/{id}". */
  label: string
  /** The raw operation object — the only spec context a worker receives. */
  definition: Record<string, unknown>
}

/**
 * Absolute document location of an operation object, e.g. ['paths', '/users', 'get'].
 * Prefix for agent-emitted paths, which are relative to the operation they saw.
 */
export function operationBasePath(operation: OperationRef): Array<string | number> {
  return ['paths', operation.path, operation.method.toLowerCase()]
}

/** Extract every operation (path × method) from a spec. Returns [] if unparseable. */
export function extractOperations(spec: string): OperationRef[] {
  let doc: unknown
  try {
    doc = parseYaml(spec)
  } catch {
    return []
  }
  if (!isRecord(doc) || !isRecord(doc.paths)) return []

  const operations: OperationRef[] = []
  for (const [path, item] of Object.entries(doc.paths)) {
    if (!isRecord(item)) continue
    for (const method of HTTP_METHODS) {
      const definition = item[method]
      if (!isRecord(definition)) continue
      const id =
        typeof definition.operationId === 'string' ? definition.operationId : `${method}_${path}`
      operations.push({
        id,
        method: method.toUpperCase(),
        path,
        label: `${method.toUpperCase()} ${path}`,
        definition,
      })
    }
  }
  return operations
}

/**
 * Path components of `servers[].url` — external base paths that `paths` keys
 * omit but source code often registers in full (`/v1/users` for spec `/users`).
 * Returns [] when servers are absent, root-path, or the spec is unparseable.
 */
export function extractServerPathPrefixes(spec: string): string[] {
  let doc: unknown
  try {
    doc = parseYaml(spec)
  } catch {
    return []
  }
  if (!isRecord(doc) || !Array.isArray(doc.servers)) return []

  const prefixes = new Set<string>()
  for (const server of doc.servers) {
    if (!isRecord(server) || typeof server.url !== 'string') continue
    let pathname: string
    try {
      pathname = new URL(server.url).pathname
    } catch {
      if (!server.url.startsWith('/')) continue
      pathname = server.url
    }
    const normalized = pathname.replace(/\/+$/, '')
    if (normalized !== '' && normalized !== '/') prefixes.add(normalized)
  }
  return [...prefixes]
}

/** Count the operations (path × method) in a spec. Returns 0 if unparseable. */
export function countOperations(spec: string): number {
  let doc: unknown
  try {
    doc = parseYaml(spec)
  } catch {
    return 0
  }
  if (!isRecord(doc) || !isRecord(doc.paths)) return 0

  let count = 0
  for (const item of Object.values(doc.paths)) {
    if (!isRecord(item)) continue
    for (const method of HTTP_METHODS) {
      if (isRecord(item[method])) count += 1
    }
  }
  return count
}
