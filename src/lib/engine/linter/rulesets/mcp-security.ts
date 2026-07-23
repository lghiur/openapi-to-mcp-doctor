import type { IFunctionResult, RulesetDefinition } from '@stoplight/spectral-core'
// Spectral packages are CJS; default-import + destructure (works under vitest and tsx/node).
import spectralFormats from '@stoplight/spectral-formats'
import type { OpenApiVersion } from '@/types/domain'

const { oas3_0, oas3_1 } = spectralFormats

// Rule→OWASP-id and risk-name maps live in a dependency-free module so client
// components can import them without dragging Spectral into the browser bundle.
export { OWASP_RULE_MAP, OWASP_RISK_NAMES } from '@/lib/engine/linter/rulesets/owasp-meta'

/**
 * The OWASP MCP Top 10 security ruleset — the spec-detectable slice.
 *
 * The OWASP MCP Top 10 (v0.1, 2025) is mostly about a *running* MCP server. This
 * tool reads a *static* OpenAPI spec, so we cover only the risks a spec can honestly
 * reveal and are explicit about the ones we can't. Coverage:
 *
 *   MCP01 Token & Secret Exposure ............. owasp-secret-in-content,
 *                                               owasp-credentials-in-server-url,
 *                                               owasp-insecure-transport
 *   MCP02 Privilege Escalation / Scope Creep .. owasp-broad-oauth-scope,
 *                                               owasp-shared-scope-across-verbs
 *   MCP03 Tool Poisoning ...................... owasp-prompt-injection,
 *                                               owasp-hidden-unicode
 *   MCP04 Supply Chain ........................ NOT spec-detectable (runtime)
 *   MCP05 Command Injection ................... owasp-unconstrained-command-param
 *   MCP06 Intent Flow Subversion .............. owasp-suspicious-markup
 *   MCP07 Insufficient Auth & Authz ........... owasp-no-security-schemes,
 *                                               owasp-mutating-operation-no-auth,
 *                                               owasp-apikey-in-query
 *   MCP08 Audit & Telemetry ................... NOT spec-detectable (runtime)
 *   MCP09 Shadow MCP Servers .................. owasp-local-or-private-server (partial)
 *   MCP10 Context Injection & Over-Sharing .... owasp-response-oversharing
 *
 * Publishable standalone as `@mcp-doctor/spectral-ruleset-security`. Every rule is
 * deterministic and null-safe (document walks, not `$..` JSONPath — see mcp.ts for
 * why nimma crashes on literal nulls). Ambiguous poisoning cases are meant to be
 * adjudicated downstream by a worker agent; these rules flag, never rewrite.
 *
 * The single source of truth mapping rule → OWASP id is OWASP_RULE_MAP below; the
 * finding normalizer reads it to tag every finding with e.g. `owasp: 'MCP03'`.
 */
export function mcpSecurityRuleset(version: OpenApiVersion) {
  const format = version === '3.1' ? oas3_1 : oas3_0

  return {
    documentationUrl: 'https://github.com/TykTechnologies/openapi-to-mcp-doctor#owasp-mcp-top-10',
    formats: [format],
    rules: {
      // --- MCP03 Tool Poisoning ------------------------------------------
      'owasp-prompt-injection': {
        description:
          'Descriptions/enums/examples must not carry instructions aimed at the agent (prompt injection).',
        severity: 'error',
        resolved: false,
        given: '$',
        then: { function: promptInjection },
      },
      'owasp-hidden-unicode': {
        description: 'Text fields must not hide zero-width, bidi, or tag Unicode used to smuggle instructions.',
        severity: 'error',
        resolved: false,
        given: '$',
        then: { function: hiddenUnicode },
      },

      // --- MCP06 Intent Flow Subversion ----------------------------------
      'owasp-suspicious-markup': {
        description: 'HTML/script/chat-role markup in text is a secondary instruction channel for agents.',
        severity: 'warn',
        resolved: false,
        given: '$',
        then: { function: suspiciousMarkup },
      },

      // --- MCP01 Token & Secret Exposure ---------------------------------
      'owasp-secret-in-content': {
        description: 'Examples, defaults, and descriptions must not contain real-looking secrets or keys.',
        severity: 'error',
        resolved: false,
        given: '$',
        then: { function: secretInContent },
      },
      'owasp-credentials-in-server-url': {
        description: 'Server URLs must not embed credentials or tokens (userinfo or query secrets).',
        severity: 'error',
        resolved: false,
        given: '$',
        then: { function: credentialsInServerUrl },
      },
      'owasp-insecure-transport': {
        description: 'Non-localhost servers should use https — http sends tokens in cleartext.',
        severity: 'warn',
        resolved: false,
        given: '$',
        then: { function: insecureTransport },
      },

      // --- MCP07 Insufficient Auth & Authz -------------------------------
      'owasp-no-security-schemes': {
        description: 'A spec with operations but no security schemes exposes every tool unauthenticated.',
        severity: 'warn',
        resolved: false,
        given: '$',
        then: { function: noSecuritySchemes },
      },
      'owasp-mutating-operation-no-auth': {
        description: 'State-changing operations should require authentication.',
        severity: 'warn',
        resolved: false,
        given: '$',
        then: { function: mutatingOperationNoAuth },
      },
      'owasp-apikey-in-query': {
        description: 'API keys in the query string leak through logs, history, and referrers.',
        severity: 'warn',
        resolved: false,
        given: '$',
        then: { function: apiKeyInQuery },
      },

      // --- MCP02 Privilege Escalation / Scope Creep ----------------------
      'owasp-broad-oauth-scope': {
        description: 'Wildcard or catch-all OAuth scopes grant far more than any single tool needs.',
        severity: 'warn',
        resolved: false,
        given: '$',
        then: { function: broadOauthScope },
      },
      'owasp-shared-scope-across-verbs': {
        description: 'A scope that gates both reads and writes cannot express least privilege.',
        severity: 'warn',
        resolved: false,
        given: '$',
        then: { function: sharedScopeAcrossVerbs },
      },

      // --- MCP05 Command Injection ---------------------------------------
      'owasp-unconstrained-command-param': {
        description: 'Free-form command/query/path string params with no constraint invite injection.',
        severity: 'warn',
        resolved: false,
        given: '$',
        then: { function: unconstrainedCommandParam },
      },

      // --- MCP10 Context Injection & Over-Sharing ------------------------
      'owasp-response-oversharing': {
        description: 'Responses should not expose secret/PII-looking fields to the model.',
        severity: 'warn',
        resolved: false,
        given: '$',
        then: { function: responseOversharing },
      },

      // --- MCP09 Shadow MCP Servers (partial) ----------------------------
      'owasp-local-or-private-server': {
        description: 'A localhost/private-network server left in a published spec hints at a shadow endpoint.',
        severity: 'info',
        resolved: false,
        given: '$',
        then: { function: localOrPrivateServer },
      },
    },
  } satisfies RulesetDefinition
}

// ----------------------------------------------------------------------------
// Shared helpers
// ----------------------------------------------------------------------------

const HTTP_METHODS = ['get', 'put', 'post', 'delete', 'options', 'head', 'patch', 'trace'] as const
const SAFE_METHODS = new Set(['get', 'head', 'options', 'trace'])
const MUTATING_METHODS = new Set(['post', 'put', 'patch', 'delete'])

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

type ObjectVisitor = (node: Record<string, unknown>, path: Array<string | number>) => void

/** Depth-first walk over every object node, tracking its path. */
function walkObjects(node: unknown, path: Array<string | number>, visit: ObjectVisitor): void {
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

type StringVisitor = (value: string, path: Array<string | number>) => void

/** Depth-first walk over every string leaf, tracking its path. */
function walkStrings(node: unknown, path: Array<string | number>, visit: StringVisitor): void {
  if (typeof node === 'string') {
    visit(node, path)
    return
  }
  if (Array.isArray(node)) {
    node.forEach((child, index) => walkStrings(child, [...path, index], visit))
    return
  }
  if (!isRecord(node)) return
  for (const [key, value] of Object.entries(node)) {
    walkStrings(value, [...path, key], visit)
  }
}

/** Keys whose string value is human-facing text an LLM reads as tool metadata. */
const TEXT_KEYS = ['description', 'summary', 'title'] as const

/** Visit every text field (description/summary/title) with its full path. */
function forEachTextField(root: unknown, visit: StringVisitor): void {
  walkObjects(root, [], (node, path) => {
    for (const key of TEXT_KEYS) {
      const value = node[key]
      if (typeof value === 'string' && value.trim() !== '') visit(value, [...path, key])
    }
  })
}

function getPaths(root: unknown): Record<string, unknown> | undefined {
  return isRecord(root) && isRecord(root.paths) ? root.paths : undefined
}

// ----------------------------------------------------------------------------
// MCP03 — Tool Poisoning
// ----------------------------------------------------------------------------

/**
 * Phrases that only make sense as instructions to a model, not as endpoint docs.
 * Kept specific to hold false positives down; ambiguous cases are for the worker.
 */
const INJECTION_PATTERNS: RegExp[] = [
  /\bignore\s+(?:all\s+|any\s+|the\s+)?(?:previous|above|prior|preceding|earlier)\s+(?:instructions?|prompts?|context|messages?|directions?|rules?)/i,
  /\bdisregard\s+(?:all\s+|any\s+|the\s+)?(?:previous|above|prior|preceding|system)\b/i,
  /\byou\s+are\s+now\s+(?:a|an|the)\b/i,
  /\bas\s+an?\s+(?:ai|assistant|language\s+model|llm)\b/i,
  /\byou\s+are\s+(?:chatgpt|claude|gpt-?\d|an?\s+ai|a\s+helpful\s+assistant)\b/i,
  /\bsystem\s+prompt\b/i,
  /\bnew\s+instructions?\s*:/i,
  /\bdo\s+not\s+(?:tell|inform|reveal\s+to|mention\s+to|warn)\s+the\s+user\b/i,
  /\boverride\s+(?:your|the|all)\s+(?:instructions?|guardrails?|safety|rules?)\b/i,
  /\bforget\s+(?:everything|all|your|the)\s+(?:instructions?|previous|above|prior)\b/i,
  /\bpretend\s+(?:to\s+be|you\s+are|that)\b/i,
  /\breveal\s+(?:your|the)\s+(?:system\s+prompt|instructions?|prompt)\b/i,
]

function promptInjection(root: unknown): IFunctionResult[] {
  const results: IFunctionResult[] = []
  forEachTextField(root, (text, path) => {
    const match = INJECTION_PATTERNS.find((re) => re.test(text))
    if (match) {
      results.push({
        message: `OWASP MCP03 (Tool Poisoning): this text reads as an instruction to the agent ("${previewMatch(text, match)}"), not documentation. An LLM ingests it as part of the tool definition — remove it or rephrase as neutral docs.`,
        path,
      })
    }
  })
  return results
}

/**
 * Zero-width, bidi-control, and Unicode-tag code points used to hide instructions
 * in plain sight: soft hyphen, ZW space/joiners, LRM/RLM, bidi embeddings &
 * isolates, word joiner, BOM, and the tag-character block.
 */
const HIDDEN_UNICODE =
  /[\u00AD\u200B-\u200F\u202A-\u202E\u2060-\u2064\u2066-\u206F\uFEFF]|[\u{E0000}-\u{E007F}]/u

/** Same class, global, to enumerate offending code points for the message. */
const HIDDEN_UNICODE_G = new RegExp(HIDDEN_UNICODE.source, 'gu')

function hiddenUnicode(root: unknown): IFunctionResult[] {
  const results: IFunctionResult[] = []
  // Text fields plus example/default values — anywhere the model reads.
  walkObjects(root, [], (node, path) => {
    for (const key of [...TEXT_KEYS, 'example', 'default'] as const) {
      const value = node[key]
      if (typeof value !== 'string' || !HIDDEN_UNICODE.test(value)) continue
      const points = [...value.matchAll(HIDDEN_UNICODE_G)]
        .map((m) => 'U+' + (m[0].codePointAt(0) ?? 0).toString(16).toUpperCase().padStart(4, '0'))
        .slice(0, 5)
      results.push({
        message: `OWASP MCP03 (Tool Poisoning): text contains hidden/invisible Unicode (${points.join(', ')}). These are invisible to reviewers but read by the model — a classic instruction-smuggling vector. Strip them.`,
        path: [...path, key],
      })
    }
  })
  return results
}

// ----------------------------------------------------------------------------
// MCP06 — Intent Flow Subversion
// ----------------------------------------------------------------------------

const MARKUP_PATTERNS: RegExp[] = [
  /<\s*script\b/i,
  /<\s*iframe\b/i,
  /<\s*img\b/i,
  /javascript:/i,
  /<!--/,
  /<\|(?:im_start|im_end|system|user|assistant)\|>/i,
  /\[\/?INST\]/i,
  /<\/?(?:system|assistant)>/i,
]

function suspiciousMarkup(root: unknown): IFunctionResult[] {
  const results: IFunctionResult[] = []
  forEachTextField(root, (text, path) => {
    if (MARKUP_PATTERNS.some((re) => re.test(text))) {
      results.push({
        message: `OWASP MCP06 (Intent Flow Subversion): text embeds markup or chat-role tokens that some MCP clients render or interpret — a secondary instruction channel. Use plain text.`,
        path,
      })
    }
  })
  return results
}

// ----------------------------------------------------------------------------
// MCP01 — Token & Secret Exposure
// ----------------------------------------------------------------------------

const SECRET_PATTERNS: { name: string; re: RegExp }[] = [
  { name: 'AWS access key id', re: /\bAKIA[0-9A-Z]{16}\b/ },
  { name: 'GitHub token', re: /\bgh[pousr]_[A-Za-z0-9]{36,}\b/ },
  { name: 'GitHub fine-grained PAT', re: /\bgithub_pat_[A-Za-z0-9_]{22,}\b/ },
  { name: 'OpenAI-style API key', re: /\bsk-[A-Za-z0-9]{20,}\b/ },
  { name: 'Slack token', re: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/ },
  { name: 'Google API key', re: /\bAIza[0-9A-Za-z_-]{35}\b/ },
  { name: 'Stripe key', re: /\b[sr]k_(?:live|test)_[A-Za-z0-9]{16,}\b/ },
  { name: 'JWT', re: /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/ },
  { name: 'private key block', re: /-----BEGIN (?:RSA |EC |OPENSSH |DSA |PGP )?PRIVATE KEY-----/ },
  { name: 'bearer token literal', re: /\bBearer\s+[A-Za-z0-9._~+/-]{20,}={0,2}\b/ },
]

function secretInContent(root: unknown): IFunctionResult[] {
  const results: IFunctionResult[] = []
  walkStrings(root, [], (value, path) => {
    const hit = SECRET_PATTERNS.find(({ re }) => re.test(value))
    if (hit) {
      results.push({
        message: `OWASP MCP01 (Secret Exposure): value looks like a real secret (${hit.name}). Specs are committed, logged, and fed to LLMs — never ship live credentials in examples or defaults. Use an obvious placeholder.`,
        path,
      })
    }
  })
  return results
}

function eachServerUrl(root: unknown, visit: (url: string, index: number) => void): void {
  if (!isRecord(root) || !Array.isArray(root.servers)) return
  root.servers.forEach((server, index) => {
    if (isRecord(server) && typeof server.url === 'string') visit(server.url, index)
  })
}

function credentialsInServerUrl(root: unknown): IFunctionResult[] {
  const results: IFunctionResult[] = []
  eachServerUrl(root, (url, index) => {
    const hasUserInfoSecret = /\/\/[^/@\s]*:[^/@\s]+@/.test(url)
    const hasQuerySecret = /[?&](?:api[_-]?key|access[_-]?token|token|secret|password|apikey)=/i.test(url)
    if (hasUserInfoSecret || hasQuerySecret) {
      results.push({
        message: `OWASP MCP01 (Secret Exposure): server URL embeds a credential (${hasUserInfoSecret ? 'userinfo' : 'query parameter'}). Move authentication to a security scheme; URLs leak through logs and referrers.`,
        path: ['servers', index, 'url'],
      })
    }
  })
  return results
}

/**
 * The host of a server URL, lowercased, with an IPv6 literal's brackets removed
 * (`http://[::1]:8080` → `::1`). Without the bracket case the authority parse
 * stops at the first `:` and every IPv6 host reads as `[`, so loopback and
 * private-range checks silently never match.
 */
function serverHost(url: string, scheme = '[a-z]+'): string | undefined {
  const bracketed = new RegExp(`^${scheme}://\\[([^\\]\\s]+)\\]`, 'i').exec(url)
  if (bracketed?.[1]) return bracketed[1].toLowerCase()
  return new RegExp(`^${scheme}://([^/:\\s]+)`, 'i').exec(url)?.[1]?.toLowerCase()
}

function insecureTransport(root: unknown): IFunctionResult[] {
  const results: IFunctionResult[] = []
  eachServerUrl(root, (url, index) => {
    const host = serverHost(url, 'http')
    if (host && host !== 'localhost' && !host.startsWith('127.') && host !== '::1') {
      results.push({
        message: `OWASP MCP01 (Secret Exposure): server "${url}" uses plain http — bearer tokens and API keys travel in cleartext. Use https.`,
        path: ['servers', index, 'url'],
      })
    }
  })
  return results
}

// ----------------------------------------------------------------------------
// MCP07 — Insufficient Auth & Authz
// ----------------------------------------------------------------------------

function securitySchemes(root: unknown): Record<string, unknown> {
  if (!isRecord(root) || !isRecord(root.components) || !isRecord(root.components.securitySchemes)) {
    return {}
  }
  return root.components.securitySchemes
}

/** True when a `security` requirement array is present and non-empty. */
function requiresAuth(security: unknown): boolean {
  return Array.isArray(security) && security.some((req) => isRecord(req) && Object.keys(req).length > 0)
}

function countOperations(paths: Record<string, unknown>): number {
  let count = 0
  for (const item of Object.values(paths)) {
    if (!isRecord(item)) continue
    for (const method of HTTP_METHODS) if (isRecord(item[method])) count++
  }
  return count
}

function noSecuritySchemes(root: unknown): IFunctionResult[] {
  const paths = getPaths(root)
  if (!paths || countOperations(paths) === 0) return []
  if (Object.keys(securitySchemes(root)).length > 0) return []
  // No schemes AND no global security applied → nothing can be authenticated.
  return [
    {
      message: `OWASP MCP07 (Insufficient Auth): the spec defines no security schemes, so every operation becomes an unauthenticated MCP tool. Add authentication (and reference it via \`security\`) before exposing this as tools.`,
      path: ['components'],
    },
  ]
}

function mutatingOperationNoAuth(root: unknown): IFunctionResult[] {
  const paths = getPaths(root)
  if (!paths) return []
  // Only meaningful once schemes exist — otherwise `owasp-no-security-schemes`
  // already reports the systemic gap and per-op findings would be redundant noise.
  if (Object.keys(securitySchemes(root)).length === 0) return []

  const globalSecurity = isRecord(root) ? (root as Record<string, unknown>).security : undefined
  const results: IFunctionResult[] = []

  for (const [route, item] of Object.entries(paths)) {
    if (!isRecord(item)) continue
    for (const method of HTTP_METHODS) {
      if (!MUTATING_METHODS.has(method)) continue
      const operation = item[method]
      if (!isRecord(operation)) continue

      // Effective security: an explicit `security: []` opts OUT of the global one.
      const effective = 'security' in operation ? operation.security : globalSecurity
      if (!requiresAuth(effective)) {
        results.push({
          message: `OWASP MCP07 (Insufficient Auth): ${method.toUpperCase()} ${route} changes state but requires no authentication. As an MCP tool, any agent could invoke it unauthenticated.`,
          path: ['paths', route, method],
        })
      }
    }
  }
  return results
}

function apiKeyInQuery(root: unknown): IFunctionResult[] {
  const results: IFunctionResult[] = []
  for (const [name, scheme] of Object.entries(securitySchemes(root))) {
    if (isRecord(scheme) && scheme.type === 'apiKey' && scheme.in === 'query') {
      results.push({
        message: `OWASP MCP07 (Insufficient Auth): security scheme "${name}" passes an API key in the query string, which leaks through server logs, browser history, and referrer headers. Use a header instead.`,
        path: ['components', 'securitySchemes', name, 'in'],
      })
    }
  }
  return results
}

// ----------------------------------------------------------------------------
// MCP02 — Privilege Escalation / Scope Creep
// ----------------------------------------------------------------------------

const BROAD_SCOPE = /^(?:\*|all|admin|root|superuser|super|write|full|full[_-]?access|everything|.*:\*|\*:.*)$/i

function eachOauthScope(
  root: unknown,
  visit: (scope: string, schemeName: string, path: Array<string | number>) => void,
): void {
  for (const [schemeName, scheme] of Object.entries(securitySchemes(root))) {
    if (!isRecord(scheme)) continue
    if (scheme.type === 'oauth2' && isRecord(scheme.flows)) {
      for (const [flowName, flow] of Object.entries(scheme.flows)) {
        if (isRecord(flow) && isRecord(flow.scopes)) {
          for (const scope of Object.keys(flow.scopes)) {
            visit(scope, schemeName, [
              'components',
              'securitySchemes',
              schemeName,
              'flows',
              flowName,
              'scopes',
              scope,
            ])
          }
        }
      }
    }
  }
}

function broadOauthScope(root: unknown): IFunctionResult[] {
  const results: IFunctionResult[] = []
  eachOauthScope(root, (scope, schemeName, path) => {
    if (BROAD_SCOPE.test(scope.trim())) {
      results.push({
        message: `OWASP MCP02 (Scope Creep): scope "${scope}" in "${schemeName}" is a catch-all — a token holding it can do far more than any single tool needs. Define narrow, per-capability scopes.`,
        path,
      })
    }
  })
  return results
}

/** Map each scope to the set of HTTP methods that require it, across all operations. */
function sharedScopeAcrossVerbs(root: unknown): IFunctionResult[] {
  const paths = getPaths(root)
  if (!paths) return []

  const scopeMethods = new Map<string, Set<string>>()
  for (const item of Object.values(paths)) {
    if (!isRecord(item)) continue
    for (const method of HTTP_METHODS) {
      const operation = item[method]
      if (!isRecord(operation) || !Array.isArray(operation.security)) continue
      for (const requirement of operation.security) {
        if (!isRecord(requirement)) continue
        for (const scopes of Object.values(requirement)) {
          if (!Array.isArray(scopes)) continue
          for (const scope of scopes) {
            if (typeof scope !== 'string') continue
            const set = scopeMethods.get(scope) ?? new Set<string>()
            set.add(method)
            scopeMethods.set(scope, set)
          }
        }
      }
    }
  }

  const results: IFunctionResult[] = []
  for (const [scope, methods] of scopeMethods) {
    const gatesReads = [...methods].some((m) => SAFE_METHODS.has(m))
    const gatesWrites = [...methods].some((m) => MUTATING_METHODS.has(m))
    if (gatesReads && gatesWrites) {
      results.push({
        message: `OWASP MCP02 (Scope Creep): scope "${scope}" gates both reads and state-changing operations, so granting read access also grants write. Split it into read and write scopes.`,
        path: ['paths'],
      })
    }
  }
  return results
}

// ----------------------------------------------------------------------------
// MCP05 — Command Injection
// ----------------------------------------------------------------------------

const COMMAND_PARAM_NAME =
  /^(?:cmd|command|commands|shell|exec|execute|query|q|sql|script|code|eval|expression|expr|path|filepath|file_?path|dir|directory|url|uri|redirect|callback|template|format_?string)$/i

function isUnconstrainedStringSchema(schema: unknown): boolean {
  if (!isRecord(schema)) return false
  const isStringType = schema.type === 'string' || schema.type === undefined
  if (!isStringType) return false
  // Any of these meaningfully constrains the value → not free-form.
  return !('enum' in schema) && !('pattern' in schema) && !('format' in schema) && !('const' in schema)
}

function unconstrainedCommandParam(root: unknown): IFunctionResult[] {
  const paths = getPaths(root)
  if (!paths) return []
  const results: IFunctionResult[] = []

  const checkParam = (param: unknown, path: Array<string | number>): void => {
    if (!isRecord(param) || typeof param.name !== 'string') return
    if (!COMMAND_PARAM_NAME.test(param.name)) return
    if (isUnconstrainedStringSchema(param.schema)) {
      results.push({
        message: `OWASP MCP05 (Command Injection): parameter "${param.name}" is a free-form string with no enum, pattern, or format. If the handler passes it to a shell, filesystem, or query, an agent can inject. Constrain it or validate server-side.`,
        path,
      })
    }
  }

  for (const [route, item] of Object.entries(paths)) {
    if (!isRecord(item)) continue
    if (Array.isArray(item.parameters)) {
      item.parameters.forEach((p, i) => checkParam(p, ['paths', route, 'parameters', i]))
    }
    for (const method of HTTP_METHODS) {
      const operation = item[method]
      if (!isRecord(operation) || !Array.isArray(operation.parameters)) continue
      operation.parameters.forEach((p, i) =>
        checkParam(p, ['paths', route, method, 'parameters', i]),
      )
    }
  }
  return results
}

// ----------------------------------------------------------------------------
// MCP10 — Context Injection & Over-Sharing
// ----------------------------------------------------------------------------

const SENSITIVE_FIELD =
  /(?:^|_)(?:password|passwd|pwd|secret|token|api[_-]?key|apikey|access[_-]?token|refresh[_-]?token|private[_-]?key|client[_-]?secret|ssn|social[_-]?security|credit[_-]?card|card[_-]?number|cardnumber|cvv|cvc|pin|passcode)(?:$|_)/i

function responseOversharing(root: unknown): IFunctionResult[] {
  const paths = getPaths(root)
  if (!paths) return []
  const results: IFunctionResult[] = []
  const seen = new Set<string>()

  for (const [route, item] of Object.entries(paths)) {
    if (!isRecord(item)) continue
    for (const method of HTTP_METHODS) {
      const operation = item[method]
      if (!isRecord(operation) || !isRecord(operation.responses)) continue
      for (const [code, response] of Object.entries(operation.responses)) {
        if (!/^2(?:\d{2}|XX)$/.test(code) || !isRecord(response) || !isRecord(response.content)) continue
        for (const [mediaType, media] of Object.entries(response.content)) {
          if (!isRecord(media) || !isRecord(media.schema)) continue
          walkObjects(media.schema, [], (node, subPath) => {
            if (!isRecord(node.properties)) return
            for (const name of Object.keys(node.properties)) {
              if (!SENSITIVE_FIELD.test(name)) continue
              const key = `${method} ${route} ${code} ${name}`
              if (seen.has(key)) continue
              seen.add(key)
              results.push({
                message: `OWASP MCP10 (Over-Sharing): ${method.toUpperCase()} ${route} response (${code}) exposes a sensitive-looking field "${name}". Anything a tool returns enters the model's context — confirm the agent should see this, or omit/redact it.`,
                path: ['paths', route, method, 'responses', code, 'content', mediaType, 'schema', ...subPath, 'properties', name],
              })
            }
          })
        }
      }
    }
  }
  return results
}

// ----------------------------------------------------------------------------
// MCP09 — Shadow MCP Servers (partial)
// ----------------------------------------------------------------------------

function localOrPrivateServer(root: unknown): IFunctionResult[] {
  const results: IFunctionResult[] = []
  eachServerUrl(root, (url, index) => {
    const host = serverHost(url)
    if (!host) return
    const isLocal =
      host === 'localhost' ||
      host === '::1' ||
      /^127\./.test(host) ||
      host === '0.0.0.0' ||
      /^10\./.test(host) ||
      /^192\.168\./.test(host) ||
      /^172\.(?:1[6-9]|2\d|3[01])\./.test(host)
    if (isLocal) {
      results.push({
        message: `OWASP MCP09 (Shadow Servers): server "${url}" points at a localhost/private address. If this reached a published spec, it may be a leftover dev or ungoverned endpoint — remove it before shipping.`,
        path: ['servers', index, 'url'],
      })
    }
  })
  return results
}

// ----------------------------------------------------------------------------

/** A short, single-line preview of the matched injection substring for the message. */
function previewMatch(text: string, re: RegExp): string {
  const m = re.exec(text)
  const snippet = (m ? m[0] : text).replace(/\s+/g, ' ').trim()
  return snippet.length > 60 ? snippet.slice(0, 57) + '…' : snippet
}
