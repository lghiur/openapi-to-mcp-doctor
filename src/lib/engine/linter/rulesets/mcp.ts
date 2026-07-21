import type { IFunctionResult, RulesetDefinition } from '@stoplight/spectral-core'
// Spectral packages are CJS; Node's native ESM loader can't see their named
// exports, so default-import + destructure (works under both vitest and tsx/node).
import spectralFormats from '@stoplight/spectral-formats'
import spectralFunctions from '@stoplight/spectral-functions'

const { oas3_0, oas3_1 } = spectralFormats
const { length, pattern, truthy } = spectralFunctions
import {
  MCP_TOOL_NAME_MAX_LENGTH,
  OPERATION_COUNT_ERROR,
  OPERATION_COUNT_WARN,
  OPERATIONID_MAX_LENGTH,
} from '@/lib/engine/constants'
import type { OpenApiVersion } from '@/types/domain'

/**
 * The MCP-specific Spectral ruleset — the novel part of this tool. Version-
 * parameterized so 3.0-only and 3.1-only rules (added in the conversion ruleset)
 * scope correctly. Publishable standalone as `@mcp-doctor/spectral-ruleset`.
 *
 * Provenance is stated honestly in every message: snake_case/64 is a vendor LLM
 * tool-API convention (not MCP), and the 40/80 operation counts are Cursor's
 * client limit / a heuristic — not benchmarked model cliffs.
 */
export function mcpRuleset(version: OpenApiVersion) {
  const format = version === '3.1' ? oas3_1 : oas3_0
  const operations = `$.paths[*][get,put,post,delete,options,head,patch,trace]`

  return {
    documentationUrl: 'https://github.com/TykTechnologies/openapi-to-mcp-doctor',
    formats: [format],
    rules: {
      'mcp-operationid-required': {
        description: 'Every operation needs an operationId — it becomes the MCP tool name.',
        message:
          'operationId is missing — converters auto-generate an unreadable MCP tool name from the path and method.',
        severity: 'error',
        given: operations,
        then: { field: 'operationId', function: truthy },
      },

      'mcp-operationid-format': {
        description: `operationId should be snake_case and within the vendor tool-name length limit.`,
        message: `operationId should be snake_case and ≤ ${OPERATIONID_MAX_LENGTH} characters for LLM tool-API compatibility (Anthropic/OpenAI vendor limit; the MCP spec itself allows ≤ ${MCP_TOOL_NAME_MAX_LENGTH} per SEP-986).`,
        severity: 'error',
        given: operations,
        then: {
          field: 'operationId',
          function: pattern,
          functionOptions: { match: `^[a-z][a-z0-9_]{0,${OPERATIONID_MAX_LENGTH - 1}}$` },
        },
      },

      'mcp-operationid-unique': {
        description: 'operationIds must be unique — duplicates silently shadow each other.',
        severity: 'error',
        given: '$.paths',
        then: { function: operationIdUnique },
      },

      'mcp-param-description-required': {
        description:
          'Every parameter needs a description — LLMs build arguments from descriptions.',
        message: 'Parameter has no description — LLMs use descriptions to construct arguments.',
        severity: 'error',
        given: [`${operations}.parameters[*]`, '$.paths[*].parameters[*]'],
        then: { field: 'description', function: truthy },
      },

      'mcp-enum-description-required': {
        description: 'A schema with an enum should describe what the allowed values mean.',
        severity: 'warn',
        // A custom walk rather than `$..[?(@.enum)]`: that JSONPath makes nimma
        // evaluate `null.enum` and throw on specs that contain literal `null`
        // values (common in real-world specs), aborting the entire run.
        resolved: false,
        given: '$',
        then: { function: enumDescriptionRequired },
      },

      'mcp-nested-description-required': {
        description: 'Every object property should have a description at every level.',
        severity: 'warn',
        // Same reason as enum above — `$..properties[*]` is not null-safe in nimma.
        resolved: false,
        given: '$',
        then: { function: nestedDescriptionRequired },
      },

      'mcp-response-schema-required': {
        description: 'Every 2xx response (except bodyless ones) must define a schema.',
        severity: 'warn',
        given: `${operations}.responses`,
        then: { function: responseSchemaRequired },
      },

      'mcp-operation-count-warn': {
        description: `More than ${OPERATION_COUNT_WARN} tools degrades selection and exceeds some clients.`,
        severity: 'warn',
        given: '$.paths',
        then: {
          function: operationCount,
          functionOptions: {
            gt: OPERATION_COUNT_WARN,
            lte: OPERATION_COUNT_ERROR,
            label: `Cursor silently sends only the first ${OPERATION_COUNT_WARN} tools; curate the exposed set rather than exposing every endpoint.`,
          },
        },
      },

      'mcp-operation-count-error': {
        description: `More than ${OPERATION_COUNT_ERROR} tools is well past reliable selection for most clients.`,
        severity: 'error',
        given: '$.paths',
        then: {
          function: operationCount,
          functionOptions: {
            gt: OPERATION_COUNT_ERROR,
            label: `This is a heuristic upper bound, not a benchmarked client cliff — but it is well past reliable tool selection for most clients. Split or curate the API.`,
          },
        },
      },

      'mcp-description-too-short': {
        description: 'Very short operation descriptions are rarely enough for tool selection.',
        message:
          'Operation description is very short — one sentence is usually too little for an LLM to choose this tool correctly.',
        severity: 'warn',
        given: operations,
        then: { field: 'description', function: length, functionOptions: { min: 50 } },
      },

      'mcp-description-is-just-path': {
        description: 'A description that just restates the HTTP method and path is not useful.',
        severity: 'warn',
        given: operations,
        then: { function: descriptionIsJustPath },
      },

      // --- Conversion hazards (both versions) ---------------------------------

      'mcp-xnullable-not-standard': {
        description:
          '`x-nullable` is a non-standard vendor extension; use the version-correct form.',
        severity: 'warn',
        resolved: false,
        given: '$',
        then: { function: xNullable },
      },

      'mcp-external-ref': {
        description:
          'MCP tool schemas cannot use external $refs — converters must inline/bundle them.',
        severity: 'error',
        resolved: false,
        given: '$',
        then: { function: externalRef },
      },

      'mcp-recursive-ref': {
        description: 'Recursive schemas cannot be expressed as a finite MCP tool input schema.',
        severity: 'warn',
        resolved: false,
        given: '$',
        then: { function: recursiveRef },
      },

      'mcp-binary-no-mcp-equivalent': {
        description:
          'Binary upload/download (type: string, format: binary) has no MCP tool equivalent.',
        severity: 'error',
        resolved: false,
        given: '$',
        then: { function: binaryUpload },
      },

      'mcp-multipart-partial-support': {
        description: 'multipart/form-data is only partially supported by OpenAPI→MCP converters.',
        severity: 'warn',
        resolved: false,
        given: '$',
        then: { function: requestMediaType, functionOptions: { mediaType: 'multipart/form-data' } },
      },

      'mcp-form-urlencoded': {
        description: 'application/x-www-form-urlencoded bodies need special converter handling.',
        severity: 'warn',
        resolved: false,
        given: '$',
        then: {
          function: requestMediaType,
          functionOptions: { mediaType: 'application/x-www-form-urlencoded' },
        },
      },

      'mcp-param-conflict': {
        description:
          'Parameters and body fields that share a name collide in the flattened MCP schema.',
        severity: 'warn',
        given: operations,
        then: { function: paramConflict },
      },

      'mcp-auth-not-in-description': {
        description: 'A secured operation should tell the agent what credential it needs.',
        severity: 'info',
        given: operations,
        then: { function: authNotInDescription },
      },

      // --- Version-specific rules ---------------------------------------------

      ...(version === '3.1'
        ? {
            'mcp-nullable-deprecated': {
              description: '`nullable` was removed in OpenAPI 3.1 — use a "null" entry in `type`.',
              severity: 'warn' as const,
              resolved: false,
              given: '$',
              then: { function: nullableDeprecated },
            },
          }
        : {}),

      ...(version === '3.0'
        ? {
            'mcp-schema-examples-array': {
              description:
                'Schema-level array `examples` is 3.1 syntax; 3.0 schemas use singular `example`.',
              severity: 'warn' as const,
              resolved: false,
              given: '$',
              then: { function: schemaExamplesArray },
            },
          }
        : {}),
    },
  } satisfies RulesetDefinition
}

// ----------------------------------------------------------------------------
// Custom rule functions
// ----------------------------------------------------------------------------

const HTTP_METHODS = ['get', 'put', 'post', 'delete', 'options', 'head', 'patch', 'trace'] as const

/** 2xx response codes that legitimately carry no body. */
const BODYLESS_2XX = new Set(['204', '205', '304'])

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

interface FunctionContext {
  path: ReadonlyArray<string | number>
}

function operationIdUnique(paths: unknown): IFunctionResult[] {
  if (!isRecord(paths)) return []
  const seen = new Set<string>()
  const results: IFunctionResult[] = []

  for (const [route, item] of Object.entries(paths)) {
    if (!isRecord(item)) continue
    for (const method of HTTP_METHODS) {
      const operation = item[method]
      if (!isRecord(operation)) continue
      const id = operation.operationId
      if (typeof id !== 'string') continue
      if (seen.has(id)) {
        results.push({
          message: `operationId "${id}" is not unique — duplicate operationIds silently shadow each other as MCP tools.`,
          path: ['paths', route, method, 'operationId'],
        })
      } else {
        seen.add(id)
      }
    }
  }
  return results
}

function operationCount(
  paths: unknown,
  options: { gt: number; lte?: number; label: string },
): IFunctionResult[] {
  if (!isRecord(paths)) return []
  let count = 0
  for (const item of Object.values(paths)) {
    if (!isRecord(item)) continue
    for (const method of HTTP_METHODS) {
      if (isRecord(item[method])) count++
    }
  }

  if (count <= options.gt) return []
  if (options.lte !== undefined && count > options.lte) return []

  return [
    {
      message: `This API exposes ${count} operations as MCP tools. ${options.label}`,
      path: ['paths'],
    },
  ]
}

function responseSchemaRequired(
  responses: unknown,
  _options: unknown,
  context: FunctionContext,
): IFunctionResult[] {
  if (!isRecord(responses)) return []
  const results: IFunctionResult[] = []
  const base = context.path

  for (const [code, response] of Object.entries(responses)) {
    // Anchored 2xx matcher — deliberately excludes `default`.
    if (!/^2(\d{2}|XX)$/.test(code)) continue
    if (!isRecord(response)) continue

    const content = response.content
    if (!isRecord(content) || Object.keys(content).length === 0) {
      if (BODYLESS_2XX.has(code)) continue
      results.push({
        message: `Response ${code} defines no content schema — the LLM cannot tell what this tool returns.`,
        path: [...base, code],
      })
      continue
    }

    for (const [mediaType, media] of Object.entries(content)) {
      if (!isRecord(media) || !('schema' in media)) {
        results.push({
          message: `Response ${code} (${mediaType}) has no schema — describe the shape the tool returns.`,
          path: [...base, code, 'content', mediaType],
        })
      }
    }
  }
  return results
}

function descriptionIsJustPath(
  operation: unknown,
  _options: unknown,
  context: FunctionContext,
): IFunctionResult[] {
  if (!isRecord(operation)) return []
  const description = operation.description
  if (typeof description !== 'string') return []
  const trimmed = description.trim()
  if (trimmed === '') return []

  const route = context.path[1]
  const looksLikeMethodPath = /^(get|put|post|delete|options|head|patch|trace)\s+\/\S*$/i.test(
    trimmed,
  )
  const equalsRoute = typeof route === 'string' && trimmed === route
  if (!looksLikeMethodPath && !equalsRoute) return []

  return [
    {
      message:
        'Description just restates the HTTP method and path — explain when to call this tool and what it returns.',
      path: [...context.path, 'description'],
    },
  ]
}

/** Truthy in the Spectral `truthy` sense: present and, for strings, non-empty. */
function hasText(value: unknown): boolean {
  return typeof value === 'string' ? value.trim() !== '' : Boolean(value)
}

/**
 * Flag every schema that defines an `enum` but no `description`. Implemented as a
 * document walk instead of `$..[?(@.enum)]` because that JSONPath crashes nimma on
 * any literal `null` node in the spec (see the null-safety test).
 */
function enumDescriptionRequired(root: unknown): IFunctionResult[] {
  const results: IFunctionResult[] = []
  walkObjects(root, [], (node, path) => {
    if (!('enum' in node) || hasText(node.description)) return
    results.push({
      message:
        'Enum has no description — the value labels alone rarely tell an LLM when to pick each one.',
      path: [...path, 'description'],
    })
  })
  return results
}

/**
 * Flag every object property that has no `description`, at any nesting depth.
 * Replaces `$..properties[*]` for the same null-safety reason. A property that is a
 * pure `$ref` is skipped — its description lives in the referenced schema.
 */
function nestedDescriptionRequired(root: unknown): IFunctionResult[] {
  const results: IFunctionResult[] = []
  walkObjects(root, [], (node, path) => {
    if (!isRecord(node.properties)) return
    for (const [name, schema] of Object.entries(node.properties)) {
      if (!isRecord(schema) || '$ref' in schema || hasText(schema.description)) continue
      results.push({
        message:
          'Property has no description — LLMs construct arguments from descriptions, not names.',
        path: [...path, 'properties', name, 'description'],
      })
    }
  })
  return results
}

// ----------------------------------------------------------------------------
// Conversion-hazard functions (operate on the raw document via `resolved: false`)
// ----------------------------------------------------------------------------

type WalkVisitor = (node: Record<string, unknown>, path: Array<string | number>) => void

/** Depth-first walk over every object node in a document, tracking its path. */
function walkObjects(node: unknown, path: Array<string | number>, visit: WalkVisitor): void {
  if (Array.isArray(node)) {
    node.forEach((child, index) => walkObjects(child, [...path, index], visit))
    return
  }
  if (!isRecord(node)) return
  visit(node, path)
  for (const [key, value] of Object.entries(node)) {
    walkObjects(value, [...path, key], visit)
  }
}

function nullableDeprecated(root: unknown): IFunctionResult[] {
  const results: IFunctionResult[] = []
  walkObjects(root, [], (node, path) => {
    if ('nullable' in node) {
      results.push({
        message:
          '`nullable` was removed in OpenAPI 3.1 — use a "null" entry in `type`, e.g. `type: ["string", "null"]`.',
        path: [...path, 'nullable'],
      })
    }
  })
  return results
}

function xNullable(root: unknown): IFunctionResult[] {
  const results: IFunctionResult[] = []
  walkObjects(root, [], (node, path) => {
    if ('x-nullable' in node) {
      results.push({
        message:
          '`x-nullable` is a non-standard extension. Use `nullable: true` (3.0) or a "null" type entry (3.1).',
        path: [...path, 'x-nullable'],
      })
    }
  })
  return results
}

function schemaExamplesArray(root: unknown): IFunctionResult[] {
  const results: IFunctionResult[] = []
  walkObjects(root, [], (node, path) => {
    // An array-valued `examples` is JSON Schema 2020-12 (3.1) syntax. A map-valued
    // `examples` is a parameter/media Example Object map, valid in both versions.
    if (Array.isArray(node.examples)) {
      results.push({
        message:
          'Schema-level array `examples` is OpenAPI 3.1 syntax. In 3.0, use singular `example` on the schema instead.',
        path: [...path, 'examples'],
      })
    }
  })
  return results
}

function externalRef(root: unknown): IFunctionResult[] {
  const results: IFunctionResult[] = []
  walkObjects(root, [], (node, path) => {
    const ref = node.$ref
    if (typeof ref === 'string' && !ref.startsWith('#')) {
      results.push({
        message: `External $ref "${ref}" cannot be represented in an MCP tool schema — inline or bundle it into the document.`,
        path: [...path, '$ref'],
      })
    }
  })
  return results
}

function binaryUpload(root: unknown): IFunctionResult[] {
  const results: IFunctionResult[] = []
  walkObjects(root, [], (node, path) => {
    if (node.type === 'string' && node.format === 'binary') {
      results.push({
        message:
          'Binary upload/download (type: string, format: binary) has no MCP tool equivalent — agents cannot send raw file bytes through a tool call.',
        path,
      })
    }
  })
  return results
}

function requestMediaType(root: unknown, options: { mediaType: string }): IFunctionResult[] {
  const results: IFunctionResult[] = []
  walkObjects(root, [], (node, path) => {
    const content = node.content
    if (isRecord(content) && options.mediaType in content) {
      results.push({
        message: `${options.mediaType} request bodies need special OpenAPI→MCP converter handling and may not round-trip cleanly.`,
        path: [...path, 'content', options.mediaType],
      })
    }
  })
  return results
}

function recursiveRef(root: unknown): IFunctionResult[] {
  if (!isRecord(root)) return []
  const components = isRecord(root.components) ? root.components : undefined
  const schemas = components && isRecord(components.schemas) ? components.schemas : undefined
  if (!isRecord(schemas)) return []

  const names = Object.keys(schemas)
  const graph = new Map<string, Set<string>>()
  for (const name of names) {
    const refs = new Set<string>()
    walkObjects(schemas[name], [], (node) => {
      const ref = node.$ref
      if (typeof ref === 'string') {
        const match = /^#\/components\/schemas\/([^/]+)$/.exec(ref)
        const target = match?.[1]
        if (target !== undefined) refs.add(decodeURIComponent(target))
      }
    })
    graph.set(name, refs)
  }

  const WHITE = 0
  const GRAY = 1
  const BLACK = 2
  const color = new Map<string, number>(names.map((n) => [n, WHITE]))
  const inCycle = new Set<string>()
  const stack: string[] = []

  const visit = (name: string): void => {
    color.set(name, GRAY)
    stack.push(name)
    for (const next of graph.get(name) ?? []) {
      if (!graph.has(next)) continue
      if (color.get(next) === GRAY) {
        const start = stack.indexOf(next)
        for (let i = start; i < stack.length; i++) {
          const member = stack[i]
          if (member !== undefined) inCycle.add(member)
        }
      } else if (color.get(next) === WHITE) {
        visit(next)
      }
    }
    stack.pop()
    color.set(name, BLACK)
  }

  for (const name of names) {
    if (color.get(name) === WHITE) visit(name)
  }

  return [...inCycle].map((name) => ({
    message: `Schema "${name}" is recursive (references itself directly or transitively). MCP tool input schemas must be finite — flatten it or cap the nesting depth.`,
    path: ['components', 'schemas', name],
  }))
}

function paramConflict(
  operation: unknown,
  _options: unknown,
  context: FunctionContext,
): IFunctionResult[] {
  if (!isRecord(operation)) return []
  const locations = new Map<string, Set<string>>()
  const record = (name: string, location: string): void => {
    const set = locations.get(name) ?? new Set<string>()
    set.add(location)
    locations.set(name, set)
  }

  const params = operation.parameters
  if (Array.isArray(params)) {
    for (const param of params) {
      if (isRecord(param) && typeof param.name === 'string' && typeof param.in === 'string') {
        record(param.name, param.in)
      }
    }
  }

  const requestBody = operation.requestBody
  if (isRecord(requestBody) && isRecord(requestBody.content)) {
    for (const media of Object.values(requestBody.content)) {
      if (isRecord(media) && isRecord(media.schema) && isRecord(media.schema.properties)) {
        for (const propertyName of Object.keys(media.schema.properties)) {
          record(propertyName, 'body')
        }
      }
    }
  }

  const results: IFunctionResult[] = []
  for (const [name, where] of locations) {
    if (where.size > 1) {
      results.push({
        message: `"${name}" appears in multiple input locations (${[...where].join(', ')}). MCP flattens path, query, header, and body into one schema, so these names collide — disambiguate them.`,
        path: [...context.path],
      })
    }
  }
  return results
}

const AUTH_KEYWORDS = [
  'auth',
  'token',
  'api key',
  'apikey',
  'bearer',
  'oauth',
  'credential',
  'permission',
  'scope',
  'authorization',
  'login',
]

function authNotInDescription(
  operation: unknown,
  _options: unknown,
  context: FunctionContext,
): IFunctionResult[] {
  if (!isRecord(operation)) return []
  const security = operation.security
  if (!Array.isArray(security) || security.length === 0) return []

  const description =
    typeof operation.description === 'string' ? operation.description.toLowerCase() : ''
  if (AUTH_KEYWORDS.some((keyword) => description.includes(keyword))) return []

  return [
    {
      message:
        'This operation requires authentication (it declares `security`) but the description never mentions it — tell the agent what credential is needed.',
      path: [...context.path],
    },
  ]
}
