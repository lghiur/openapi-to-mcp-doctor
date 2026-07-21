import { parse as parseYaml } from 'yaml'
import type { OpenApiVersion, VersionDetectionError } from '@/types/domain'

/**
 * Result of OpenAPI version detection. A `false` result halts analysis — no
 * ruleset runs on an undetectable or unsupported document.
 */
export type VersionDetectionResult =
  | { ok: true; version: OpenApiVersion; rawVersion: string }
  | { ok: false; error: VersionDetectionError; message: string }

/**
 * Detect the OpenAPI version of a raw spec string. Runs before everything else.
 *
 * - 3.0.x -> `'3.0'`, 3.1.x -> `'3.1'`
 * - Swagger 2.0 (the `swagger` key) -> halt with `SWAGGER_20_NOT_SUPPORTED`
 * - missing / unparseable / unsupported version -> halt with `OAS_VERSION_UNDETECTABLE`
 *
 * YAML is a superset of JSON, so a single YAML parse handles both spec formats.
 */
export function detectVersion(spec: string): VersionDetectionResult {
  let doc: unknown
  try {
    doc = parseYaml(spec)
  } catch {
    return undetectable('The document could not be parsed as YAML or JSON.')
  }

  if (typeof doc !== 'object' || doc === null || Array.isArray(doc)) {
    return undetectable('The document root is not an object.')
  }

  const record = doc as Record<string, unknown>

  // Swagger 2.0 uses the `swagger` key and never `openapi`. Reject and halt.
  if ('swagger' in record) {
    return {
      ok: false,
      error: 'SWAGGER_20_NOT_SUPPORTED',
      message:
        'Swagger/OpenAPI 2.0 is not supported. Convert the spec to OpenAPI 3.0 or 3.1 first.',
    }
  }

  const raw = record.openapi
  if (raw === undefined || raw === null) {
    return undetectable('No `openapi` version field was found.')
  }

  const rawVersion = String(raw)
  const match = /^(\d+)\.(\d+)(?:\.\d+)?$/.exec(rawVersion)
  if (!match) {
    return undetectable(`The \`openapi\` value "${rawVersion}" is not a recognized version.`)
  }

  const [, major, minor] = match
  if (major === '3' && minor === '0') return { ok: true, version: '3.0', rawVersion }
  if (major === '3' && minor === '1') return { ok: true, version: '3.1', rawVersion }

  return undetectable(
    `OpenAPI ${rawVersion} is not supported. This tool supports OpenAPI 3.0 and 3.1.`,
  )
}

function undetectable(message: string): {
  ok: false
  error: VersionDetectionError
  message: string
} {
  return { ok: false, error: 'OAS_VERSION_UNDETECTABLE', message }
}
