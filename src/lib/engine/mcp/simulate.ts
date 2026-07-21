import { parse as parseYaml } from 'yaml'
import {
  MCP_TOOL_NAME_MAX_LENGTH,
  OPERATION_COUNT_ERROR,
  OPERATION_COUNT_WARN,
  OPERATIONID_MAX_LENGTH,
} from '@/lib/engine/constants'

const HTTP_METHODS = ['get', 'put', 'post', 'delete', 'options', 'head', 'patch', 'trace'] as const

/** Vendor LLM tool-API character set (Anthropic/OpenAI); length is checked separately. */
const VENDOR_NAME_CHARS = /^[a-zA-Z0-9_-]+$/

export type ToolIssueCode =
  | 'missing-name'
  | 'invalid-name'
  | 'name-too-long'
  | 'duplicate-name'
  | 'missing-description'

export interface ToolIssue {
  code: ToolIssueCode
  message: string
}

/** One operation rendered the way an OpenAPI→MCP converter would expose it. */
export interface McpToolPreview {
  /** Tool name (the operationId); absent when the operation has none. */
  name?: string
  /** Operation label, e.g. "GET /pets/{petId}". */
  operation: string
  /** Tool description an LLM would see (description, falling back to summary). */
  description: string
  inputSchema: {
    type: 'object'
    properties: Record<string, unknown>
    required?: string[]
  }
  /** Why this tool would fail to load (or fail to be usable) in an MCP client. */
  issues: ToolIssue[]
}

export interface McpSimulation {
  tools: McpToolPreview[]
  /** Operation count — the denominator for "X of N loadable". */
  total: number
  /** Tools with zero issues — what would actually work in a client today. */
  loadable: number
  /** Aggregate warnings (tool-count client limits), independent of any one tool. */
  clientWarnings: string[]
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Simulate converting the spec into MCP tool definitions — the "would this
 * actually load in Claude/Cursor" check. Deterministic, zero LLM calls. This is
 * the product's own currency for "did the fixes work": run it before and after
 * applying fixes and the loadable count should go up.
 */
export function simulateMcpTools(spec: string): McpSimulation {
  let doc: unknown
  try {
    doc = parseYaml(spec)
  } catch {
    return { tools: [], total: 0, loadable: 0, clientWarnings: [] }
  }
  if (!isRecord(doc) || !isRecord(doc.paths)) {
    return { tools: [], total: 0, loadable: 0, clientWarnings: [] }
  }

  const tools: McpToolPreview[] = []
  for (const [path, item] of Object.entries(doc.paths)) {
    if (!isRecord(item)) continue
    const pathParams = Array.isArray(item.parameters) ? item.parameters : []
    for (const method of HTTP_METHODS) {
      const definition = item[method]
      if (!isRecord(definition)) continue
      tools.push(buildTool(`${method.toUpperCase()} ${path}`, definition, pathParams))
    }
  }

  // Duplicates are only visible across the whole tool list.
  const nameCounts = new Map<string, number>()
  for (const tool of tools) {
    if (tool.name !== undefined) nameCounts.set(tool.name, (nameCounts.get(tool.name) ?? 0) + 1)
  }
  for (const tool of tools) {
    if (tool.name !== undefined && (nameCounts.get(tool.name) ?? 0) > 1) {
      tool.issues.push({
        code: 'duplicate-name',
        message: `Tool name "${tool.name}" is used by more than one operation — MCP tool names must be unique.`,
      })
    }
  }

  const clientWarnings: string[] = []
  if (tools.length > OPERATION_COUNT_WARN) {
    clientWarnings.push(
      `${tools.length} tools exceeds Cursor's hard ${OPERATION_COUNT_WARN}-tool client limit — some clients will truncate or refuse the tool list.`,
    )
  }
  if (tools.length > OPERATION_COUNT_ERROR) {
    clientWarnings.push(
      `${tools.length} tools is beyond ${OPERATION_COUNT_ERROR} — expect degraded tool selection accuracy in most LLM clients.`,
    )
  }

  return {
    tools,
    total: tools.length,
    loadable: tools.filter((t) => t.issues.length === 0).length,
    clientWarnings,
  }
}

function buildTool(
  operation: string,
  definition: Record<string, unknown>,
  pathParams: unknown[],
): McpToolPreview {
  const issues: ToolIssue[] = []

  const name = typeof definition.operationId === 'string' ? definition.operationId : undefined
  if (name === undefined) {
    issues.push({
      code: 'missing-name',
      message:
        'Operation has no operationId — converters cannot derive a stable MCP tool name.',
    })
  } else {
    if (!VENDOR_NAME_CHARS.test(name)) {
      issues.push({
        code: 'invalid-name',
        message: `"${name}" contains characters outside [a-zA-Z0-9_-] — rejected by LLM tool APIs.`,
      })
    }
    if (name.length > OPERATIONID_MAX_LENGTH) {
      issues.push({
        code: 'name-too-long',
        message:
          `"${name}" is ${name.length} chars — over the ${OPERATIONID_MAX_LENGTH}-char LLM tool API limit ` +
          `(MCP itself allows ${MCP_TOOL_NAME_MAX_LENGTH}).`,
      })
    }
  }

  const description = firstNonEmptyString(definition.description, definition.summary) ?? ''
  if (description === '') {
    issues.push({
      code: 'missing-description',
      message: 'Operation has neither description nor summary — the tool is unusable to an LLM.',
    })
  }

  return {
    ...(name !== undefined ? { name } : {}),
    operation,
    description,
    inputSchema: buildInputSchema(definition, pathParams),
    issues,
  }
}

function firstNonEmptyString(...values: unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value === 'string' && value.trim() !== '') return value
  }
  return undefined
}

function buildInputSchema(
  definition: Record<string, unknown>,
  pathParams: unknown[],
): McpToolPreview['inputSchema'] {
  const properties: Record<string, unknown> = {}
  const required: string[] = []

  // Path-level parameters first so operation-level ones of the same name win.
  const params = [...pathParams, ...(Array.isArray(definition.parameters) ? definition.parameters : [])]
  for (const param of params) {
    if (!isRecord(param) || typeof param.name !== 'string') continue
    const schema = isRecord(param.schema) ? param.schema : {}
    properties[param.name] = {
      ...schema,
      ...(typeof param.description === 'string' ? { description: param.description } : {}),
    }
    if (param.required === true && !required.includes(param.name)) required.push(param.name)
  }

  const body = jsonBodySchema(definition.requestBody)
  if (body !== undefined) properties.body = body

  return {
    type: 'object',
    properties,
    ...(required.length > 0 ? { required } : {}),
  }
}

function jsonBodySchema(requestBody: unknown): unknown {
  if (!isRecord(requestBody) || !isRecord(requestBody.content)) return undefined
  const json = requestBody.content['application/json']
  if (!isRecord(json) || !isRecord(json.schema)) return undefined
  return json.schema
}
