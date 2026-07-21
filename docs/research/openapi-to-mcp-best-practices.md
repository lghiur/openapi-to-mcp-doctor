# OpenAPI to MCP — Mapping & Best Practices

Sources: MCP specification 2025-11-25 (current stable), SEP-986, Speakeasy, Stainless conversion lessons, TrueFoundry, FastMCP docs, Stoplight OpenAPI diff guide, Speakeasy null handling guide

Last verified: 2026-06-24

> **MCP version pin:** This tool targets MCP spec **2025-11-25** (current stable). Spec chronology: `2024-11-05 → 2025-03-26 → 2025-06-18 → 2025-11-25 (current)`, with `2026-07-28` locked as a release candidate. The pinned version is configurable via `--mcp-version`. Where a rule depends on a feature introduced in a specific version (e.g. `outputSchema` in 2025-06-18, the JSON Schema 2020-12 dialect default in 2025-11-25, SEP-986 tool-naming), the version dependency is noted inline.

---

## OpenAPI Version Support and Version-Compliance Rule

**This tool supports OpenAPI 3.x only** (3.0.x and 3.1.x). Swagger 2.0 is explicitly out of scope.

If a Swagger 2.0 spec is submitted, the linter emits a single finding — `SWAGGER_20_NOT_SUPPORTED` (error) — and stops. No further analysis runs.

**How to detect version:** Read the `openapi` field from the root of the document.

```yaml
openapi: "3.0.3"        # OpenAPI 3.0 — full support
openapi: "3.1.0"        # OpenAPI 3.1 — full support
swagger: "2.0"          # → rejected immediately, single error returned
```

### Version-Compliance Rule (non-negotiable)

**Every fix suggestion the tool emits must be valid for the detected spec version.**

This applies to:

- The structural linter (Spectral rules)
- The LLM worker agents (their suggested rewrites)
- The auto-fix mode (what gets written to the patched spec)

The detected version is passed through the entire pipeline and must be included in the prompt context given to every LLM worker agent. Agents must not suggest syntax that is incorrect for the detected version.

**Version-specific fix syntax — quick reference:**

| Concern                                  | OpenAPI 3.0.x fix                                 | OpenAPI 3.1.x fix                                                                                         |
| ---------------------------------------- | ------------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| Nullable field                           | `nullable: true`                                  | `type: ["string", "null"]`                                                                                |
| Field-level example (Schema Object only) | `example: "usr_123"`                              | `examples: ["usr_123"]` (array) — schema-level only; parameter-level `examples` is a map in both versions |
| `$ref` with extra description            | Use `allOf` workaround                            | `$ref` + sibling `description` directly (applied _in addition_, not merged into the target)               |
| Schema without `type`                    | Optional (best practice to declare; not required) | `type` optional (JSON Schema 2020-12)                                                                     |
| `exclusiveMinimum`                       | `exclusiveMinimum: true` + `minimum: 5`           | `exclusiveMinimum: 5` (value, not boolean)                                                                |

**Version detection is the first step.** No rule fires, no suggestion is generated, no agent prompt is built until the version is known. If the `openapi` field is missing or malformed, emit `OAS_VERSION_UNDETECTABLE` (error) and halt.

---

## Critical Schema Differences by Version

### Nullable fields

This is the most common source of conversion bugs. Each version handles "this field can be null" differently.

**OpenAPI 3.0.x:**

```yaml
properties:
  status:
    type: string
    nullable: true # OpenAPI-specific keyword (not in JSON Schema)
```

**OpenAPI 3.1.x:**

```yaml
properties:
  status:
    type: ['string', 'null'] # JSON Schema 2020-12 — correct form
    # OR
    oneOf:
      - type: string
      - type: 'null'
```

**What the linter checks:** Detect `nullable: true` in a 3.1 spec and flag it as `OAS_NULLABLE_DEPRECATED` (warning) — it works in some parsers but is not valid 3.1. Detect `x-nullable` in any 3.x spec and flag as `OAS_XNULLABLE_NOT_STANDARD` (warning) — `x-nullable` is a Swagger 2.0 vendor extension that has no meaning in OpenAPI 3.x.

**Why this matters for MCP:** MCP tool input schemas are JSON Schema. A converter that naively passes `nullable: true` to the MCP schema produces invalid JSON Schema that breaks strict clients (GitHub Copilot Chat, for example, validates schemas strictly).

---

### `$ref` and sibling keywords

**OpenAPI 3.0.x:** `$ref` cannot have sibling keywords. This is non-standard and was a known pain point. The workaround was wrapping in `allOf`:

```yaml
# 3.0 — $ref cannot have siblings
allOf:
  - $ref: '#/components/schemas/User'
  - description: 'The authenticated user' # must use allOf workaround
```

**OpenAPI 3.1.x:** `$ref` can have siblings (aligned with JSON Schema 2020-12):

```yaml
# 3.1 — $ref can have siblings directly
$ref: '#/components/schemas/User'
description: 'The authenticated user' # valid
```

**What the linter checks:** In 3.0 specs, flag `allOf` blocks where the sole purpose is to add a description to a `$ref` (`OAS_ALLOF_DESCRIPTION_WORKAROUND` — info level). Suggest upgrading to 3.1 where this is unnecessary. Do not flag this as a conversion blocker; it's a style issue.

---

### `example` vs `examples`

**OpenAPI 3.0.x:** Uses singular `example` (OpenAPI-specific keyword):

```yaml
parameters:
  - name: userId
    schema:
      type: string
      example: 'usr_12345' # 3.0 style
```

**OpenAPI 3.1.x:** Uses plural `examples` (JSON Schema 2020-12 keyword):

```yaml
parameters:
  - name: userId
    schema:
      type: string
      examples: ['usr_12345'] # 3.1 style
```

**What the linter checks:** Accept both forms per detected spec version. Flag `examples` used in a 3.0 spec (not standard). The MCP rule `mcp-param-example-required` checks for the presence of either form — not which specific keyword is used.

> **Critical placement rule — schema-level array vs parameter-level map.** The "singular → plural array" change applies **only inside a Schema Object**. It does NOT apply at the Parameter Object or Media Type Object level:
>
> - **Schema Object** (the `schema:` block): 3.0 → `example: "usr_123"` (single value); 3.1 → `examples: ["usr_123"]` (a bare **array**). The snippet above is correct because `examples` sits _inside_ `schema:`.
> - **Parameter / Media Type / Request Body / Response level**: in **both 3.0 and 3.1**, these have their own OpenAPI `example:` (single value) and `examples:` as a **MAP** — `examples: { default: { value: "usr_123" } }` — never an array. This did not change between versions.
>
> The auto-fixer must never emit the array form (`examples: [...]`) at the parameter level — it is invalid there in every version. Schema-level → array (3.1 only); parameter/media-type-level → map (both versions).

---

### Response schema path

**OpenAPI 3.0.x and 3.1.x (only supported versions):**

```yaml
responses:
  '200':
    content:
      application/json:
        schema: # schema is nested under content → media type → schema
          $ref: '#/components/schemas/User'
```

**What the linter checks:** The `mcp-response-schema-required` Spectral rule uses the 3.x path:

```
$.paths[*][*].responses[?(@property.match(/^2(\d{2}|XX)$/))].content['application/json'].schema
```

This matches all 2xx status codes, not just `200` — a `201 Created` with a body is equally important. Both `200` and `201` are common success responses on POST operations; checking only `200` would miss them.

> **Pattern note:** Use the anchored form `/^2(\d{2}|XX)$/`, not a bare `/^2/`. Bare `/^2/` is unanchored (matches any key merely _starting_ with "2") and the anchored form deliberately includes OpenAPI's `2XX` range syntax. **Known gap:** neither form matches a `default` response, which can legitimately carry the success schema. Decide explicitly whether `default`-only operations should pass or be flagged — don't let the regex silently exclude them.

---

## Field Mapping: OpenAPI → MCP Tool (3.x, accurate)

| OpenAPI field                                         | MCP tool field                        | Notes                                                                                                                                                                                     |
| ----------------------------------------------------- | ------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `operationId`                                         | tool `name`                           | snake*case is a **convention** (not MCP-mandated); the ≤64-char limit is a **vendor LLM-API limit** (Anthropic/OpenAI `^[a-zA-Z0-9*]{1,64}$`), not MCP or OpenAPI — see naming note below |
| `summary`                                             | tool `description` first line         | Often used as short description; not a separate MCP field                                                                                                                                 |
| `description`                                         | tool `description` full               | Primary source of LLM understanding — this is what matters                                                                                                                                |
| path params                                           | tool `inputSchema.properties`         | Merged into flat input schema                                                                                                                                                             |
| query params                                          | tool `inputSchema.properties`         | Merged; naming collisions with body fields need disambiguation                                                                                                                            |
| `requestBody.content['application/json'].schema`      | tool `inputSchema`                    | Merged with params into one flat schema                                                                                                                                                   |
| `responses['2xx'].content['application/json'].schema` | tool `outputSchema` (MCP 2025-06-18+) | Optional; provides structured output. Older clients ignore it.                                                                                                                            |
| `tags`                                                | tool grouping / `serverName` prefix   | Used by some converters to organise tools into groups                                                                                                                                     |
| `security`                                            | not mapped                            | MCP has its own auth layer. Document auth requirements in description.                                                                                                                    |
| `servers`                                             | not mapped                            | MCP server handles base URL; not part of tool definition                                                                                                                                  |

---

## MCP Spec Version and Tool Output

**Current spec: 2025-11-25.** Chronology: `2024-11-05 → 2025-03-26 → 2025-06-18 → 2025-11-25 (current)`; `2026-07-28` is a locked release candidate. We pin to 2025-11-25 (`--mcp-version` to override).

**`outputSchema` — introduced in 2025-06-18 (present in 2025-11-25):**
MCP tools can declare an `outputSchema` JSON Schema describing their structured output. When `outputSchema` is present, servers **MUST** provide structured results that _conform_ to it (and **SHOULD** also return the serialized JSON as a `TextContent` block for backward compatibility); clients **SHOULD** validate. Note the precise RFC-2119 levels — it is "MUST conform," not a flat "must populate `structuredContent`."

```json
{
  "name": "get_user",
  "description": "...",
  "inputSchema": { ... },
  "outputSchema": {           // new in 2025-06-18
    "type": "object",
    "properties": {
      "id": { "type": "string" },
      "email": { "type": "string" }
    }
  }
}
```

**What our linter does with this:**

- If a 2xx response schema exists in the OpenAPI spec: recommend adding it as `outputSchema` (INFO level suggestion)
- Flag it as "only supported by clients implementing MCP 2025-06-18" so the user knows older clients will ignore it
- Not a blocker — structured output is backward-compatible (servers also return JSON-encoded text for older clients)

**Breaking change in 2025-06-18 (still removed in 2025-11-25):** JSON-RPC batching was removed. This affects MCP server implementations, not our spec analysis. Note it in version compatibility warnings.

---

## MCP Tool Naming — What the Spec Actually Requires

A precise separation of authorities, because our `mcp-operationid-*` rules must not over-claim "MCP requires this":

| Constraint                                                     | Where it actually comes from                                                                                                                                       | Level       |
| -------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------- |
| `name` is a non-empty string                                   | MCP spec (all versions)                                                                                                                                            | MUST        |
| Charset `[A-Za-z0-9_.-/]`, case-sensitive, length SHOULD ≤ 128 | **SEP-986** "Specify Format for Tool Names" (Final; lands in the 2025-11-25 milestone)                                                                             | SHOULD      |
| **snake_case**                                                 | **Convention only** — not in any MCP spec version. The draft spec explicitly shows non-snake_case names (`getUser`, `DATA_EXPORT_v2`, `admin.tools.list`) as valid | convention  |
| **≤ 64 chars**                                                 | **Vendor LLM tool-call APIs** — Anthropic 64-char cap, OpenAI `^[a-zA-Z0-9_-]{1,64}$`. MCP's own ceiling is 128 (SEP-986)                                          | vendor API  |
| Prefix (`mcp__<server>__<tool>`) counts against the limit      | Client behavior — and FastMCP truncates at **56**, not 64                                                                                                          | client/tool |

**Ruleset implication:** keep `mcp-operationid-format` (snake_case, ≤64) — it's still the right default for LLM-tool-API compatibility — but in the finding message attribute it to **"LLM tool-API compatibility / convention,"** not to "the MCP spec." Reserve "MCP spec requires…" wording for the SEP-986 charset/uniqueness SHOULDs.

---

## MCP Tool Annotations — A Mapping Opportunity (candidate rule)

MCP has had **`ToolAnnotations`** since spec 2025-03-26 (carried into 2025-11-25): `title`, `readOnlyHint` (default false), `destructiveHint` (default true), `idempotentHint` (default false), `openWorldHint` (default true). They are advisory hints — the spec normatively requires clients to treat them as **untrusted unless from a trusted server**.

OpenAPI carries strong signals a converter could map to these hints, but most converters leave them empty:

| HTTP method / spec signal | Suggested annotation                           |
| ------------------------- | ---------------------------------------------- |
| `GET`, `HEAD`             | `readOnlyHint: true`                           |
| `DELETE`                  | `destructiveHint: true`, `readOnlyHint: false` |
| `PUT` (full replace)      | `idempotentHint: true`                         |
| `POST` (create)           | `idempotentHint: false`                        |

**Candidate Tier-1 (deterministic, zero-LLM) rule — `MCP_ANNOTATION_HINT_AVAILABLE` (info):** when an operation's method implies a safety hint that no `x-` extension or description conveys, suggest the mapping so the downstream converter can emit richer, safer tool definitions. This is novel — competitors don't lint for it. _Not yet a committed rule; flagged here for the design owner to accept or defer._

---

## Conversion Problems and Linter Flags

### 1. Schema `$ref` resolution

OpenAPI uses `$ref` for reusable schemas. MCP tool schemas must be self-contained — all refs must be inlined or placed in `$defs`.

**Standard refs:** Converters resolve these automatically. Our linter flags refs that point to external files (not within the same document) as `MCP_EXTERNAL_REF` (error) — these cannot be resolved without bundling first.

**Recursive refs:** Standard inlining breaks on recursive schemas (tree structures, linked lists, nested comments). Example:

```yaml
components:
  schemas:
    Category:
      type: object
      properties:
        subcategories:
          type: array
          items:
            $ref: '#/components/schemas/Category' # recursive
```

Our linter flags these as `MCP_RECURSIVE_REF` (warning) — they require manual handling or a converter that supports `$defs` modelling (Stainless's approach). Auto-conversion will either loop infinitely or truncate the schema.

### 2. Parameter naming conflicts

Path params, query params, and body fields are merged into a flat input schema. If two sources use the same name (e.g., `id` in path and `id` in body), a naming conflict occurs. Converters typically add prefixes (`path_id`, `body_id`).

Our linter flags these as `MCP_PARAM_CONFLICT` (warning) with the conflicting names listed.

### 3. `multipart/form-data` and binary file uploads — no clean MCP equivalent

This is a hard limitation, not a fixable spec quality issue.

- MCP tools accept JSON arguments. There is no native multipart support.
- Converters must re-serialize JSON into `multipart/form-data` — this works for text fields but not binary.
- Binary file uploads (images, PDFs, any `format: binary`) have no clean equivalent. MCP can pass base64-encoded strings, but most APIs do not accept base64 on multipart endpoints.

**What the linter flags:**

- Operations with `requestBody.content['multipart/form-data']`: `MCP_MULTIPART_PARTIAL_SUPPORT` (warning) — "This operation uses multipart/form-data. Text fields will convert; binary fields may not."
- Operations with `requestBody.content['multipart/form-data']` that contain `format: binary` properties: `MCP_BINARY_NO_MCP_EQUIVALENT` (error) — "Binary file upload has no MCP equivalent. This operation requires a hand-coded MCP tool or a pre-upload strategy (get a signed URL, then call the upload separately)."

### 4. Multiple response types

OpenAPI operations can define different schemas per status code. MCP tools map to the 2xx success response. Error responses are not part of the MCP tool schema — they are handled at the MCP protocol level.

**What the linter flags:**

- No 2xx response defined: `mcp-response-schema-required` (error)
- 2xx response defined but no schema: `MCP_RESPONSE_NO_SCHEMA` (warning)
- 4xx/5xx responses with no description: `MCP_ERROR_UNDOCUMENTED` (info) — "Document error conditions in the operation description so LLMs know what can go wrong"

### 5. Too many tools

LLMs degrade with large tool sets due to context window pressure and tool selection confusion. Degradation is **empirically real** (multiple benchmarks show tool-selection accuracy dropping as tool count grows), but the specific thresholds below are operational, not benchmarked cliffs — label them honestly in findings:

- **> 40 operations: `MCP_TOOLSET_TOO_LARGE` (warning).** Grounded in the **Cursor client's hard 40-tool limit** (beyond 40, Cursor silently sends only the first 40). Cite this as the rationale, not a generic "LLMs degrade" claim.
- **> 80 operations: `MCP_TOOLSET_TOO_LARGE` (error).** This is a **heuristic upper bound, not a benchmarked or client-imposed limit** — real model tool ceilings are far higher (~128 for GPT-4o, ~512 for Gemini 2.5 Pro). Present it as "well past the point where tool selection is reliable for most clients," not as a hard model limit.

**Suggestion to include in finding:** "Consider filtering which operations are exposed as MCP tools. Not every endpoint needs an AI agent. Admin, deprecated, and internal operations are good candidates to exclude." (Filtering is the documented consensus best practice — Stainless `--tool/--tag/--operation` flags, Speakeasy `x-speakeasy-mcp` exclusions.)

### 6. Authentication — document in description, not in schema

MCP 2025-06-18 has enhanced OAuth support at the protocol level. OpenAPI `securitySchemes` do not map to MCP tool definitions.

**What the linter flags:** Operations that have `security` defined but whose description does not mention auth/authentication/permissions: `MCP_AUTH_NOT_IN_DESCRIPTION` (warning) — "This operation requires authentication. Document the auth requirements in the description so LLMs know when they can call this tool."

### 7. `application/x-www-form-urlencoded`

Similar to multipart but simpler — converters can typically handle this by serializing JSON to form-encoded format. Not a blocker but worth flagging.

**What the linter flags:** `MCP_FORM_URLENCODED` (info) — "Form-encoded body will be serialized from JSON by the converter. Verify the target converter supports this."

---

## Description Quality Heuristics (structural linter, no LLM)

These are **our heuristics**, not MCP spec requirements. Label them clearly as such in findings.

| Signal                                       | Rule ID                              | Severity | Rationale                                                 |
| -------------------------------------------- | ------------------------------------ | -------- | --------------------------------------------------------- |
| Description absent                           | `mcp-description-required`           | ERROR    | MCP tool has no description at all                        |
| Description < 50 chars                       | `MCP_DESCRIPTION_TOO_SHORT`          | ERROR    | Heuristic: almost never sufficient for LLM tool selection |
| Description < 100 chars                      | `MCP_DESCRIPTION_BRIEF`              | WARNING  | Heuristic: likely missing context                         |
| Description equals summary verbatim          | `MCP_DESCRIPTION_DUPLICATES_SUMMARY` | WARNING  | Heuristic: no additional context added                    |
| Description contains only HTTP method + path | `MCP_DESCRIPTION_IS_JUST_PATH`       | ERROR    | Heuristic: zero semantic content                          |
| Two operations have identical descriptions   | `MCP_DESCRIPTION_DUPLICATE`          | ERROR    | LLM cannot distinguish the tools                          |

**Important:** These rules fire on the raw spec text. The LLM worker agent makes the final quality call and may override or add nuance. Do not present structural heuristic findings as definitive — always show them as "structural flag, pending AI review."

---

## Spectral Version-Aware Implementation

Spectral supports OAS 2.0, 3.0, and 3.1 via its built-in `oas` ruleset, but the built-in rules are not identical across versions. Our custom MCP ruleset must be version-aware.

**Implementation approach:**

```typescript
// lib/engine/linter/spectral.ts
import { Spectral } from '@stoplight/spectral-core'
import { oas } from '@stoplight/spectral-rulesets'
import { mcpRuleset } from './rulesets/mcp'

export async function runLinter(specContent: string): Promise<NormalisedFindings[]> {
  const spectral = new Spectral()

  // Detect version before loading any ruleset
  const parsed = parseSpec(specContent)
  const version = detectVersion(parsed) // '3.0' | '3.1' | 'swagger-2.0'

  if (version === 'swagger-2.0') {
    return [
      {
        rule: 'SWAGGER_20_NOT_SUPPORTED',
        severity: 'error',
        message: 'Swagger 2.0 is not supported. This tool analyses OpenAPI 3.x specs only.',
        path: ['swagger'],
      },
    ]
  }

  spectral.setRuleset({
    extends: [oas],
    rules: mcpRuleset(version), // version-parameterised MCP rules
  })

  const results = await spectral.run(specContent)
  return normaliseResults(results, version)
}
```

**Version-parameterised MCP rules — the only place version branching happens:**

```typescript
export function mcpRuleset(version: '3.0' | '3.1') {
  return {
    'mcp-response-schema-required': {
      // same JSONPath for both 3.0 and 3.1 — response schema location is identical.
      // Anchored /^2(\d{2}|XX)$/ matches 2xx codes + the 2XX range form; does NOT match `default`.
      given:
        "$.paths[*][*].responses[?(@property.match(/^2(\\d{2}|XX)$/))].content['application/json'].schema",
      then: { function: truthy },
      message:
        '2xx response must have a schema. Without it, LLMs cannot know what this tool returns.',
    },

    'mcp-nullable-deprecated': {
      // nullable: true is valid in 3.0 but invalid in 3.1
      given: version === '3.1' ? '$.paths[*][*]..properties[*]' : '$.__never__',
      then: { field: 'nullable', function: falsy },
      message:
        'nullable: true is not valid in OpenAPI 3.1. Use type: ["string", "null"] instead. This produces invalid JSON Schema in MCP tool definitions.',
      severity: 'warning',
    },

    'mcp-xnullable-not-standard': {
      // x-nullable has no meaning in any OpenAPI 3.x spec
      given: '$.paths[*][*]..properties[*]',
      then: { field: 'x-nullable', function: falsy },
      message:
        'x-nullable is a Swagger 2.0 extension with no effect in OpenAPI 3.x. Use nullable: true (3.0) or type array (3.1).',
      severity: 'warning',
    },
  }
}
```

---

## Go Codebase Specifics (v2+ codebase grounding)

Route handler patterns by Go HTTP framework:

**Gin:**

```go
r.GET("/users/:id", handler.GetUser)      // :id style path params
```

**Chi:**

```go
r.Get("/users/{id}", getUserHandler)      // {id} style path params
```

**net/http ServeMux (Go 1.22+):**

```go
mux.HandleFunc("GET /users/{id}", getUserHandler)  // method prefix + {id}
```

**Echo:**

```go
e.GET("/users/:id", getUserHandler)       // :id style, same as Gin
```

**Gorilla Mux (legacy, still common):**

```go
r.HandleFunc("/users/{id}", getUserHandler).Methods("GET")  // separate Methods() call
```

Worker agents reading Go handlers should look for:

- Direct response writes: `c.JSON(200, ...)` (Gin), `json.NewEncoder(w).Encode(...)` (stdlib), `c.JSON(http.StatusOK, ...)` (Echo)
- Service layer calls one level deep — typically `svc.GetUser(ctx, id)` or `h.service.GetUser(...)`
- Error returns: `c.JSON(http.StatusNotFound, ...)` — these reveal undocumented status codes
- Context value reads: `ctx.Value(authKey)` or `c.Get("user")` — signals auth is in play

**Tyk-specific:** Tyk middleware often injects session/auth into context before reaching the handler. Look for `TykGetData(r)` or similar Tyk context helpers as a signal that auth is required but may not be documented in the spec.

---

## What Converters Expect — Pre-flight Checklist

Before passing to Stainless, FastMCP, Speakeasy, or any other converter:

**Version:**

- [ ] Spec is OpenAPI 3.0.x or 3.1.x — `openapi` field present and parseable
- [ ] All fix suggestions validated against the detected version before emitting

**Identity:**

- [ ] Every operation has a unique `operationId` (snake_case + ≤ 64 chars incl. server prefix — an LLM tool-API/convention target, not an MCP-spec rule; MCP's own SEP-986 ceiling is 128)
- [ ] No two operations have identical `operationId` values

**Descriptions:**

- [ ] Every operation has `description` (not just `summary`)
- [ ] Descriptions explain WHEN to call, not just WHAT the operation does
- [ ] Descriptions document what the operation returns in actionable terms
- [ ] Descriptions document auth requirements if `security` is set
- [ ] Near-duplicate operations have explicit disambiguation language

**Parameters and schema:**

- [ ] Every parameter has `description`
- [ ] Every enum value has `description` (not just the enum values themselves)
- [ ] Nested object properties have `description` at every level
- [ ] `required` vs optional is explicit on all parameters
- [ ] No `$ref` pointing to external files (bundle first)
- [ ] No recursive `$ref` chains without manual resolution strategy

**Response:**

- [ ] At least one 2xx response schema defined per operation
- [ ] Error conditions (4xx, 5xx) documented in operation `description`

**Scale:**

- [ ] Total operation count < 40 (< 80 absolute maximum)

**Problematic patterns (flag before converting):**

- [ ] No `multipart/form-data` with `format: binary` properties (no clean MCP equivalent)
- [ ] No `nullable: true` in a 3.1 spec (use `type: ["string", "null"]` — 3.1 compliant fix)
- [ ] No `x-nullable` in any 3.x spec (use `nullable: true` for 3.0, `type: ["string","null"]` for 3.1)
