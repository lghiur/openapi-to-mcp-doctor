# MCP Protocol — Rules Reference

Source: MCP Specification 2025-11-25 (current stable), SEP-986, AWS MCP Design Guidelines

---

## Tool Names (operationId → tool name)

**Format rules — two different authorities (do not conflate):**

_MCP spec (SEP-986, "Specify Format for Tool Names", SHOULD-level):_

- Allowed characters: alphanumeric, underscore `_`, dash `-`, dot `.`, forward slash `/`
- Case-sensitive
- Length **SHOULD** be ≤ 128 characters (MCP's own ceiling)
- No spaces, no special characters beyond the above

_Vendor LLM tool-call APIs (the stricter, practical limit we lint to):_

- ≤ **64 characters** — Anthropic's 64-char cap and OpenAI's `^[a-zA-Z0-9_-]{1,64}$`. This is NOT an MCP rule.
- The client tool prefix (`mcp__<server>__<tool>`) is counted against this 64-char budget; FastMCP truncates names at 56. Attribute `mcp-operationid-format` findings to "LLM tool-API compatibility," not "the MCP spec."

**Practical convention (>90% of real-world MCP tools):**

- `snake_case` — use this; GPT-4o and Claude tokenise it best
- Action-noun pattern: `get_user`, `create_ticket`, `list_orders`, `update_notification_preferences`
- Multi-word names are the norm (~95% of tools have 2+ words)
- Consistent verb set across the server: don't mix `get_` and `fetch_` for the same category of read

**What breaks without correct tool names:**

- Missing `operationId` → converter auto-generates from path+method → typically unreadable (`read_user_users__user_id__get`)
- Non-unique operationId → silent tool shadowing in MCP — one tool overwrites another
- camelCase or PascalCase → not wrong per spec but inconsistent with ecosystem; some clients have issues

---

## Tool Descriptions (operation summary + description → MCP tool description)

**What LLMs need (not what developers need):**

- Explain **when** to call this tool, not just what it does
- Explain **what it returns** in actionable terms ("returns the user's current notification preferences as a JSON object with `theme`, `notifications`, and `language` fields")
- Must not duplicate the tool name ("get_user — gets a user" is useless)
- Should mention alternatives when disambiguation matters ("use `search_users` instead when filtering by attribute; use `get_user` only when you have the exact user ID")

**Length:** No hard limit in spec. Practical sweet spot: 2–4 sentences. One sentence is almost always too short for an LLM to make correct tool selection decisions.

**Red flags in existing descriptions:**

- < 50 chars: almost certainly insufficient
- Starts with the tool name repeated
- Contains only the HTTP method and path ("GET /users/{id}")
- No mention of return value
- No disambiguation from similar operations

---

## Input Schema (parameters + requestBody → MCP input schema)

**What MCP requires:**

- Tool inputs are a single flat JSON Schema object — all path params, query params, headers, and request body are merged into one schema
- `required` array must be explicit — MCP has no inference for optional vs required
- Every property must have `description` — LLMs construct arguments from descriptions, not type names
- `$ref` cannot be used in MCP tool schemas — converters must inline/resolve all refs into `$defs`

**What our linter checks (structural, no LLM):**

- Every parameter has `description`
- Every enum value has `description` (the enum value label alone is not sufficient)
- Nested object properties have `description` at every level
- `required` vs optional is explicit (not implicit via absence)
- No parameter is named `data`, `body`, `input`, `payload` without a specific description

**Parameter naming conflicts (converter concern, not linter concern):**

- Path params, query params, and body fields that share a name must be disambiguated by converters (e.g. `path_id` vs `body_id`). Document this as a known issue in mismatch findings.

---

## Tool Count (operations → MCP tool set)

**Why it matters:**

- All tools are loaded into the LLM's context window on connection
- LLM tool-selection accuracy degrades empirically as the available-tool count grows (confirmed by MCP-Bench / MCPVerse benchmarks)
- The most concrete hard ceiling is a _client_ one: Cursor silently sends only the first 40 tools

**Our thresholds (label the provenance honestly in findings):**

- > 40 operations: WARNING — grounded in **Cursor's hard 40-tool client limit**; recommend grouping or filtering what gets exposed
- > 80 operations: ERROR — a **heuristic upper bound**, not a benchmarked or client-imposed cliff (real model tool ceilings are far higher: ~128 GPT-4o, ~512 Gemini 2.5 Pro). Present as "well past reliable tool selection for most clients"

**Mitigation to suggest:** Don't expose every endpoint. Curate the MCP tool set to the operations an agent actually needs. Internal/admin/deprecated endpoints should be excluded.

---

## Response / Output

**MCP tool output types:**

- `text` — most common; return structured text or JSON string
- `image` — base64 encoded image
- `resource` — a URI reference to a resource

**What our linter checks:**

- At least one 2xx response schema defined
- Response schema describes what fields mean (not just their types)
- Error responses (4xx, 5xx) have descriptions so the LLM knows what went wrong

---

## Cross-Operation Checks (orchestrator post-processing)

**Near-duplicate detection:**
Operations are near-duplicates when an LLM would struggle to choose between them. Signals:

- Cosine similarity > 0.85 on description embeddings (or LLM-judged similarity)
- Same HTTP method on paths that differ only by a query parameter
- Same operation on two nested paths (`/users/{id}` and `/organisations/{orgId}/users/{id}`)

**Suggested fix:** Add explicit disambiguation to both descriptions — "Use this when X; use `other_tool` when Y."

**Tool set coherence:**

- Operations that always need to be called together suggest a missing composite operation
- Operations with no logical grouping (tag or prefix) suggest the MCP server needs a `groupId` strategy

---

---

## Linting Implementation

**Runtime: Spectral** — JSONPath-based rule engine, TypeScript-native, used by Redocly and superfaceai/openapi-linter. Do not write a custom rule runner.

Custom rules live in `lib/engine/linter/rulesets/mcp.ts` and are also publishable as `@mcp-doctor/spectral-ruleset`.

Each Spectral rule follows this structure:

```typescript
import { RulesetDefinition } from '@stoplight/spectral-core'
import { pattern, truthy, schema } from '@stoplight/spectral-functions'

export const mcpRuleset: RulesetDefinition = {
  rules: {
    'mcp-operationid-required': {
      message:
        'operationId is required — missing operationId generates an unreadable MCP tool name',
      severity: 'error',
      given: '$.paths[*][*]',
      then: { field: 'operationId', function: truthy },
    },
    'mcp-operationid-format': {
      message:
        'operationId should be snake_case and ≤ 64 characters for LLM tool-API compatibility (vendor limit; MCP spec itself allows ≤128 per SEP-986)',
      severity: 'error',
      given: '$.paths[*][*].operationId',
      then: { function: pattern, functionOptions: { match: '^[a-z][a-z0-9_]{0,63}$' } },
    },
    'mcp-param-description-required': {
      message: 'Parameter description is required — LLMs use descriptions to construct arguments',
      severity: 'error',
      given: '$.paths[*][*].parameters[*]',
      then: { field: 'description', function: truthy },
    },
    // ... additional rules in lib/engine/linter/rulesets/mcp.ts
  },
}
```

---

## MCP Spec Version

This document reflects **MCP specification 2025-11-25** (current stable). Chronology: `2024-11-05 → 2025-03-26 → 2025-06-18 → 2025-11-25 (current)`, with `2026-07-28` locked as a release candidate. Note: `ToolAnnotations` (readOnlyHint/destructiveHint/idempotentHint/openWorldHint) arrived in 2025-03-26; `outputSchema`/structured output in 2025-06-18; the JSON Schema 2020-12 dialect default in 2025-11-25.

When a new spec version is released:

1. Update this file with changed rules
2. Update the `--mcp-version` default in `lib/engine/linter/`
3. Add a changelog entry noting what changed
