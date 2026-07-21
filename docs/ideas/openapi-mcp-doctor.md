# OpenAPI MCP Doctor

## Problem Statement

How might we help API teams identify exactly what's semantically broken in their OpenAPI spec — and fix it with implementation-grounded accuracy — before converting to MCP, so LLM agents can actually use the tools correctly?

## Recommended Direction

An open source web app + CLI tool that runs LLM agents against your OpenAPI spec and optionally your codebase, shows agent reasoning in real time, and lets you review every suggestion before anything is committed. The core insight: existing linters check _structural validity_; this tool checks _LLM usability_ — a genuinely different bar.

**Three interaction surfaces, one shared engine:**

1. **Web app** — paste or connect a spec, watch agents work live, review findings, commit or download
2. **GitHub Action** — lint mode (report issues, block CI) or fix mode (auto-commit high-confidence changes)
3. **CLI** — same as GitHub Action, usable locally or in any ops pipeline

The shared analysis engine is a standalone library consumed by all three surfaces. Build it first, wrap it second.

---

## Feature Tiers

**Structural linting — free, no auth needed:**
The tool runs a full structural analysis without any LLM call: missing fields, operationId issues, no examples, too many operations, ambiguous parameter names (heuristic), and all MCP protocol compliance rules. Works anonymously in both web app (paste mode) and CLI.

**AI-powered analysis — requires GitHub login (web app) or LLM key (CLI):**
LLM-scored description quality, near-duplicate operation detection, codebase grounding, and high-fidelity rewrite suggestions. In the web app, AI features require GitHub OAuth — this is the abuse boundary, not a feature gate. In CLI/GitHub Actions, activated when `LLM_BASE_URL` and `LLM_API_TOKEN` are set. Designed as an add-on, not a gate.

**Why GitHub login gates AI in the web app:** The deployer's LLM key pays for every inference call. Anonymous AI usage is an open abuse surface. Structural linting stays fully anonymous — it's zero cost. AI features require identity. No rate-limiting infrastructure needed; GitHub OAuth is the control.

---

## LLM Configuration (Security-First)

The tool treats the LLM endpoint as a configurable, opaque HTTP target. It works with any OpenAI-compatible endpoint — a Tyk gateway, Azure OpenAI, AWS Bedrock adapter, local Ollama, or direct Anthropic/OpenAI API.

**Credentials are never:**

- Stored in the browser or frontend state
- Logged or included in error output
- Committed to any config file in the repo

**How it works:**

- Backend reads `LLM_BASE_URL` and `LLM_API_TOKEN` from environment at startup
- For GitHub Actions: stored as GitHub Secrets, injected as env vars at runtime
- For web app: configured via `.env` at deploy time (self-hosted) or a server-side settings page (no client exposure)
- The LLM base URL can point to a gateway that adds auth, rate limiting, audit logging — the tool doesn't care what's behind it

---

## Self-Hosting

Docker Compose is the primary deployment method. One `docker-compose.yml` with:

- `web` — the Next.js frontend
- `api` — the backend analysis engine
- Environment variables for LLM credentials, GitHub OAuth app credentials, and operational config

One-click cloud deploy (Render, Railway) as a secondary option for users who don't want to manage Docker.

---

## Core Behavior: Code Is Source of Truth

When the spec and code disagree, **the code is correct and the spec is wrong.**

The tool handles mismatches in two configurable modes — like ESLint's `--fix` flag:

**`--mismatch-mode=flag` (default):**
Reports the mismatch as a `SPEC_CODE_MISMATCH` finding with severity `error`. Shows what the spec claims, what the code actually does, and a concrete suggested change. User reviews and confirms before anything is written.

**`--mismatch-mode=fix`:**
Automatically applies the suggested correction to the spec. Only applies to high-confidence mismatches (e.g. wrong HTTP status code documented, response type clearly wrong). Medium and low confidence mismatches are always flagged for review regardless of mode.

This applies in both the CLI and the web app (web app surfaces the mode toggle in the analysis settings panel before running).

One edge case: **what if the code is wrong, not the spec?** (i.e., a bug in the implementation.) The tool surfaces: _"This may be a bug in the implementation — confirm the code is correct before accepting this spec change."_ This warning appears on every mismatch finding.

---

## MCP Protocol Compliance Checks

This is the check category no existing linter covers. Checks are distributed across three tiers based on what they need — no dedicated agent, no wasted LLM calls.

**MCP spec version:** Rules are pinned to the MCP specification version at build time (currently **2025-11-25**, the current stable spec). The version is logged at analysis start and configurable via `--mcp-version` flag to allow forward compatibility as the spec evolves. Chronology for reference: `2024-11-05 → 2025-03-26 → 2025-06-18 → 2025-11-25 (current)`, with `2026-07-28` locked as a release candidate.

### Tier 1 — Structural linter (no LLM, runs always)

Pure rule-based checks that need no inference:

**Tool name rules** (operationId → MCP tool name):

- operationId must be present — missing = auto-generated garbage name on conversion
- Must be snake_case or kebab-case, no spaces, no special characters — _convention for LLM tool-API compatibility, not an MCP-spec mandate_
- Length must be < 64 characters — _a vendor LLM tool-API limit (Anthropic/OpenAI), not MCP; MCP's own SEP-986 ceiling is 128. Note the `mcp__server__tool` client prefix consumes part of the 64-char budget_
- Must be unique across all operations — duplicates cause silent tool shadowing in MCP

**Input schema rules** (parameters + request body → MCP input schema):

- Every parameter must have a description — LLMs use these for argument construction, not just type checking
- Enum values must have descriptions — `status: "pending"` is meaningless without context
- Nested object properties must have descriptions at every level, not just the top
- `required` vs `optional` must be explicit — MCP has no tolerance for ambiguity

**Tool set rules:**

- Operation count: > 40 = warning (Cursor's hard 40-tool client limit), > 80 = error (heuristic upper bound — not a benchmarked cliff; real model ceilings are higher). Degradation with large tool sets is empirically real, but cite the 40 to the client limit, not a generic claim

### Tier 2 — Worker agent (per-operation, same LLM call as description quality)

Each worker agent is already reading and judging an operation. MCP semantic checks are added to the same call — no extra cost:

- Does the description answer **when** to call this tool, not just **what** it does?
- Does the description explain what it **returns** in actionable terms ("returns the user's current notification preferences" not "returns 200")?
- Does the description duplicate the tool name? ("getUser — gets a user" is useless to an LLM)
- Are parameter descriptions actionable enough for an LLM to construct correct arguments?

### Tier 3 — Orchestrator post-processing (one LLM call, after all workers complete)

Cross-operation checks that require seeing all operations together:

- **Near-duplicate detection**: pairs of operations with similar descriptions that would cause an LLM to pick the wrong tool (e.g. `GET /users/search` vs `GET /users` with a `q` param). Detected via semantic similarity over all operation descriptions, then flagged with a suggested disambiguation.
- **Tool set coherence**: do the operations collectively make sense as a MCP tool set? Are there obvious groupings that are missing, or operations that overlap confusingly?

---

## CI/CD Cache Design

Running a full analysis on every push is expensive — especially with LLM calls and codebase agent fan-out. The cache ensures only what actually changed gets re-analyzed.

### Sidecar file — `.mcp-doctor.yaml`

The cache lives in a separate sidecar file alongside the spec. The OpenAPI spec is never modified to store tool metadata.

```yaml
spec_hash: abc123
analyzed_at: 2026-06-23T10:00:00Z
operations:
  GET /users/{id}:
    handler_hash: def456
    status: clean
    findings: []
  POST /orders:
    handler_hash: ghi789
    status: has_issues
    findings:
      - id: missing-when-to-use
        severity: warning
        suggestion: 'Add guidance on when to use this vs PATCH /orders/{id}/status'
        confidence: MEDIUM
```

**Gitignore it, store in CI cache** (GitHub Actions `actions/cache`, keyed by branch + spec path). Cold cache means a full re-run — acceptable. The spec's own git history tracks when it changed; the sidecar doesn't need to duplicate that.

> **Implemented schema (v2, `lib/engine/cache/sidecar.ts`):** the shipped sidecar is `{ schemaVersion: 2, specHash, generatedAt, findings, summary, operations: [{ label, handlerHash?, groundingFindings? }] }`. Top-level `findings`/`summary` are the spec-quality results gated by `specHash`; each operation's `groundingFindings` are its cached spec/code-mismatch results gated by its own `handlerHash` (the hash of the exact registration + handler files its grounding read). The two dimensions are checked independently — scenarios 1–4 below fall out of that with no special-casing. Failed mismatch detections are left uncached so they retry on the next run.

### Four cache scenarios

**Scenario 1 — Cold start (no sidecar)**

```
1. No sidecar found
2. Hash the spec file → store as spec_hash
3. Run full structural lint on all operations
4. For each operation: find handler, hash handler file, run worker agent
5. Orchestrator post-processing: near-duplicate detection
6. Write all findings + all hashes to sidecar
7. Report results
```

**Scenario 2 — Nothing changed**

```
1. Hash spec → matches spec_hash ✓
2. Hash each handler file → all match handler_hash ✓
3. Return cached findings immediately
4. Zero LLM calls, instant exit
```

**Scenario 3 — Spec changed, code unchanged**

```
1. Hash spec → doesn't match spec_hash ✗
2. Re-run full structural lint (cheap, no LLM)
3. For each operation: hash handler file
   → hashes still match ✓ → reuse cached codebase grounding results
   → only re-run LLM quality scoring on spec descriptions (not codebase agents)
4. Re-run orchestrator post-processing (near-duplicate detection)
5. Update sidecar: new spec_hash, new spec findings, handler hashes unchanged
```

Spec changes do not invalidate codebase grounding. The code didn't move.

**Scenario 4 — Code changed, spec unchanged**

```
1. Hash spec → matches ✓
2. For each operation: hash handler file
   → GET /users/{id} handler changed ✗ → re-run worker agent for this operation only
   → POST /orders handler unchanged ✓ → use cached findings
3. Update sidecar: spec_hash unchanged, updated handler_hash + findings for changed operations
```

200 endpoints, 3 changed handlers → 3 agent runs, not 200.

**Edge cases:**

- **New operation in spec**: spec hash changes → full spec re-lint; no sidecar entry for new operation → cache miss → run worker agent
- **Handler file deleted/moved**: hash lookup fails → cache miss → re-run; if genuinely removed, surfaces as a mismatch
- **CI cold cache** (cache evicted): falls back to Scenario 1 cleanly
- **Both spec and code changed simultaneously**: spec hash check fails (Scenario 3) + handler hash checks fail for changed files (Scenario 4) — both run independently. The two hash types are independent, so the cache handles this correctly without special-casing.
- **Sidecar in PRs**: The sidecar is gitignored and stored only in CI cache — it is never committed to the repo and never included in PRs created by the tool.

---

## Agent Architecture (Full Picture)

```
Structural linter (no LLM)
├── MCP format/presence rules (operationId, param descriptions, enums)
├── Operation count threshold
└── Standard OpenAPI completeness checks

                    ↓ (always runs)

Orchestrator
├── Reads spec → list of operations needing semantic analysis
├── Fans out N Worker agents (parallel, each handles 3–5 operations)
│   │
│   Worker (per operation batch):
│   ├── Description quality: is this LLM-usable?
│   ├── MCP semantic: does it explain WHEN, not just WHAT?
│   ├── MCP semantic: does it explain what it returns?
│   ├── MCP semantic: does it duplicate the tool name?
│   ├── Parameter descriptions: actionable for argument construction?
│   └── [v2+] Codebase: find handler → read 2 layers deep
│                        → detect spec/code mismatches
│                        → synthesize high-fidelity suggestions
│
└── Post-processing (after all workers complete)
    ├── Near-duplicate detection (one LLM call over all descriptions)
    ├── Tool set coherence check
    └── Final report assembly → stream to UI / write to sidecar
```

**Key principle:** No dedicated MCP compliance agent. Checks are distributed to where they naturally belong:

- Structural checks → linter (zero cost)
- Per-operation semantic checks → absorbed into existing worker call (same LLM context)
- Cross-operation checks → orchestrator post-processing (one additional call)

---

## Version Scope

### v1 — Spec Doctor (weeks)

**Web app — primary flow (Heroku/Vercel-style GitHub connection):**

- User clicks "Connect GitHub" → OAuth → sees list of their repos (searchable, paginated)
- Selects repo + branch + OpenAPI spec file path within the repo
- App reads the spec from GitHub, runs analysis, streams findings via SSE in real time
- Three-panel layout from day one: operation list (left), live agent feed (centre), suggestion queue (right)
- Review suggestions inline → "Create PR" commits accepted changes to a branch and opens a PR

**Web app — secondary flow (paste/upload, no GitHub required):**

- Paste or upload an OpenAPI spec (YAML or JSON)
- Structural analysis runs immediately, no auth, no LLM key needed
- AI-powered suggestions: prompts to connect GitHub account (one-time OAuth)
- Review findings → "Download improved spec" (PR creation requires GitHub connection)

**Progress UX — SSE from day one:**

- POST /analyze → `{ jobId }` → client opens SSE stream at GET /jobs/{jobId}/stream immediately
- Findings appear as agents complete — no polling, no page refresh
- v1 centre panel shows: structural check progress, LLM quality scoring steps per operation, post-processing status

**CLI / GitHub Action:**

```bash
# Lint mode — report issues, exit 1 if errors found
mcp-doctor scan spec.yaml --mode=lint --output=report.json

# Fix mode — apply high-confidence changes, write patched spec
mcp-doctor scan spec.yaml --mode=fix --output=spec.patched.yaml

# With caching
mcp-doctor scan spec.yaml --mode=lint --cache --cache-file=.mcp-doctor.yaml
```

GitHub Action usage:

```yaml
- uses: your-org/mcp-doctor-action@v1
  with:
    spec: ./api/openapi.yaml
    mode: lint # or: fix
    mismatch-mode: flag # or: fix
    cache: true
    llm-base-url: ${{ secrets.LLM_BASE_URL }}
    llm-api-token: ${{ secrets.LLM_API_TOKEN }}
```

**CLI distribution:** Published as both an npm package (`npx mcp-doctor`) and a standalone compiled binary via GitHub Releases (cross-platform: Linux, macOS, Windows). The compiled binary requires no runtime — preferred for Go projects and ops pipelines where installing Node.js is undesirable. Implementation language for the CLI is an open question for implementation planning.

**What v1 catches:**

Structural (no LLM):

- Missing or non-unique operationId
- operationId not snake_case/kebab-case or > 64 chars
- Parameters without descriptions
- Enum values without descriptions
- Nested object properties without descriptions
- No request body description
- Missing response schemas for 2xx status codes
- No examples on parameters or request bodies
- Operation count > 40 (warning) or > 80 (error)

AI-powered (requires LLM key):

- Ambiguous descriptions ("Get data", "Update record") — LLM-scored
- Descriptions that explain WHAT but not WHEN to call
- Descriptions that don't explain return values actionably
- Descriptions that duplicate the tool name
- Parameter descriptions insufficient for LLM argument construction
- Near-duplicate operations that would confuse tool selection

---

### v2 — Codebase Grounding (2–4 months)

**New: GitHub OAuth + repo connection**

User points at route files or directories (no auto-discovery yet). The orchestrator maps spec operations to handlers, fans out worker agents, streams findings back.

**Language support in v2:** Agent reads handler code as text — language-agnostic by design. Go, TypeScript, Python, Ruby all work. The LLM understands the code regardless of language; no special parser per language is needed at this depth.

**Web app — live agent progress panel:**

- Left: operation list from spec (status per operation: pending / analyzing / has findings / reviewed)
- Center: streaming agent feed — each agent's steps appear as they happen (which file it read, what it found, confidence level)
- Right: suggestion review queue — diff view per finding, accept / edit / reject individually
- "Create PR" button: commits patched spec to a new branch, opens a GitHub PR with a generated summary of all accepted changes

**CLI / GitHub Action v2:**

```bash
mcp-doctor scan spec.yaml \
  --repo owner/repo \
  --token $GITHUB_TOKEN \
  --route-paths "internal/api/routes/,handlers/" \
  --mode=fix \
  --mismatch-mode=flag \
  --create-pr \
  --pr-title "fix: improve OpenAPI spec for MCP readiness"
```

**Confidence scoring for auto-fix mode:**

- `HIGH` (auto-apply in fix mode): missing operationId, missing required field descriptions, clearly wrong response code, operationId format violations
- `MEDIUM` (apply with `--confirm-medium` flag): description rewrites, added examples, MCP semantic improvements
- `LOW` (never auto-apply, always human review): spec/code mismatch resolutions, parameter semantic changes

---

### v3 — Auto-Discovery + Full Pipeline (long-term)

- Framework detection across two language groups:
  - **Go** (prioritised): Gin, Chi, Echo, net/http ServeMux — route registration patterns differ significantly between these; Gin is first given the Tyk context
  - **Other**: Express (Node), FastAPI (Python), Rails (Ruby), Spring (Java)
- Go is the first-class citizen in v3 auto-discovery. The other frameworks follow once Go patterns are validated.
- Automatic route-to-handler mapping without user specifying route files
- Configurable traversal depth (default 2, max 4)
- GitHub Action: `--mode=fix --create-pr` becomes a fully automated spec improvement pipeline triggered on spec file changes
- PR comment summary: "MCP Doctor found 12 issues, fixed 9 automatically, 3 require human review"

---

## UI Architecture

**Three-panel layout (v1 onward):**

- Left panel: operation list with status badges (pending / analyzing / has findings / reviewed)
- Centre panel: live agent feed via SSE — structural check progress in v1, full codebase agent activity in v2+
- Right panel: suggestion review queue — GitHub-style diff view, accept / edit / reject per suggestion

**GitHub connection UX (v1 onward) — Heroku/Vercel style:**

- "Connect GitHub" → OAuth → repo list (searchable, paginated) → select repo + branch + spec file path
- App reads spec from GitHub, analysis runs, findings stream in via SSE
- Accepted suggestions → "Create PR" → branch + PR opened in the connected repo
- Paste mode available as secondary path for users without GitHub or for quick previews

**SSE event schema (backend → frontend):**

```json
{ "type": "agent_started",       "agent_id": "worker-3", "operations": ["GET /users/{id}"] }
{ "type": "file_read",           "agent_id": "worker-3", "path": "handlers/users.go" }
{ "type": "finding",             "agent_id": "worker-3", "operation": "GET /users/{id}", "severity": "error", "rule": "SPEC_CODE_MISMATCH", "current": "Returns user object", "actual": "Returns 204 No Content on success", "suggested": "...", "confidence": "HIGH" }
{ "type": "finding",             "agent_id": "worker-3", "operation": "GET /users/{id}", "severity": "warning", "rule": "MCP_NO_WHEN_TO_USE", "suggested": "...", "confidence": "MEDIUM" }
{ "type": "agent_completed",     "agent_id": "worker-3", "findings_count": 3 }
{ "type": "postprocess_started", "check": "near-duplicate-detection" }
{ "type": "finding",             "agent_id": "orchestrator", "rule": "MCP_NEAR_DUPLICATE", "operations": ["GET /users", "GET /users/search"], "suggested": "..." }
{ "type": "analysis_complete",   "total_findings": 14, "errors": 3, "warnings": 8, "info": 3 }
```

Full SSE event schema and client implementation: `docs/research/agentic-architecture.md`

---

## Run History

Every analysis run — whether triggered from the web app, CLI, or GitHub Action — is recorded as a structured history entry. This gives users a full audit trail: what each agent did, what it found, what was accepted or rejected, and what was committed.

### Data Model

```typescript
interface AnalysisRun {
  id: string // unique run ID (used in CLI + web URLs)
  createdAt: Date
  specSource: 'github' | 'paste'
  specFile: string // path within repo, or "paste" for paste mode
  repo?: string // owner/repo if GitHub connected
  branch?: string
  mode: 'lint' | 'fix'
  mismatchMode: 'flag' | 'fix'
  durationMs: number
  status: 'running' | 'complete' | 'error'
  summary: {
    totalFindings: number
    errors: number
    warnings: number
    info: number
    accepted: number // user-accepted suggestions
    rejected: number
    autoFixed: number // HIGH-confidence fixes applied automatically
  }
  prUrl?: string
  prBranch?: string
  commitSha?: string
  agents: AgentRecord[]
  findings: FindingRecord[]
}

interface AgentRecord {
  id: string // e.g. "structural-linter", "worker-1", "orchestrator"
  type: 'structural-linter' | 'worker' | 'orchestrator'
  operations: string[] // operation IDs this agent handled
  filesRead: string[] // handler files read (v2+, empty in v1)
  findingsCount: number
  durationMs: number
}

interface FindingRecord {
  id: string
  agentId: string // which agent produced this
  operation: string // e.g. "GET /users/{id}"
  rule: string // e.g. "MCP_NO_WHEN_TO_USE"
  severity: 'error' | 'warning' | 'info'
  confidence: 'HIGH' | 'MEDIUM' | 'LOW'
  before: string // exact spec content before change
  after: string // suggested replacement
  resolution: 'accepted' | 'rejected' | 'edited' | 'auto-fixed' | 'pending'
  resolvedContent?: string // if edited: the actual content the user wrote
  autoFixed: boolean
}
```

### Storage

**Web app:** SQLite (self-hosted, via Prisma) for zero-config local storage. Runs are stored indefinitely; users can delete runs manually. No separate database service required for self-hosting.

**CLI:** JSON files in `.mcp-doctor/runs/` alongside the spec. One file per run, named by `{timestamp}-{runId}.json`. Keeps the last 100 runs by default (`--history-limit` to configure). Never stored in the cloud unless the user is authenticated to the web app.

### Web UI — History View

A dedicated "History" tab in the app, styled like Vercel's deployment list:

```
History
────────────────────────────────────────────────────────────────────
  Run        Date              Status        Findings   PR
  ─────────────────────────────────────────────────────────────────
  #12        24 Jun 14:23      ✓ 9 fixed     14 total   #42 ↗
  #11        23 Jun 09:11      ⚠ 8 issues    8 total    —
  #10        22 Jun 16:44      ✓ 3 fixed      3 total   #38 ↗
```

**Run detail view** (click any run):

- Header: timestamp, spec file, repo/branch, duration, PR link
- Agent timeline: horizontal bar chart showing each agent's run time and overlap (shows parallelism visually)
- Per-agent expandable section: which operations it handled, which files it read, how many findings it produced
- Findings list: grouped by operation, each finding shows severity badge, rule name, before/after diff, resolution badge (Accepted / Rejected / Edited / Auto-fixed)
- If edited: shows both the suggested content and what the user actually wrote

### CLI — History Commands

```bash
# List recent runs
mcp-doctor history

  Run History — api/openapi.yaml
  ─────────────────────────────────────────────────────────────
  ID        Date              Status        Findings  PR
  run-12    2026-06-24 14:23  ✓ fixed 9     14        #42
  run-11    2026-06-23 09:11  ⚠ 8 issues    8         —
  run-10    2026-06-22 16:44  ✓ fixed 3      3        #38

# Show detail for a specific run
mcp-doctor history run-12

  Run run-12 — 2026-06-24 14:23 — 12.4s
  Repo: owner/my-api   Branch: main   Spec: api/openapi.yaml

  Agents
  ├── structural-linter   [0.1s]   3 findings  (3 auto-fixed)
  ├── worker-1            [4.2s]   GET /users, POST /users       → 2 findings
  ├── worker-2            [3.8s]   GET /orders/{id}              → 4 findings
  ├── worker-3            [4.1s]   POST /orders, DELETE /orders  → 2 findings
  └── orchestrator        [1.9s]   near-duplicate check          → 3 findings

  Accepted (9)
  ├── GET /users           MCP_NO_WHEN_TO_USE      description updated
  ├── GET /users           MISSING_EXAMPLE         example added
  ├── POST /users          OPERATIONID_FORMAT      "createUser" → "create_user"  [auto]
  ├── GET /orders/{id}     MCP_NO_RETURN_VALUE     description updated
  ├── GET /orders/{id}     PARAM_NO_DESCRIPTION    orderId description added
  ├── POST /orders         MCP_NO_WHEN_TO_USE      description updated  [edited]
  ├── POST /orders         MISSING_RESPONSE_SCHEMA 201 schema added
  ├── orchestrator         MCP_NEAR_DUPLICATE      GET /users + GET /users/search disambiguated
  └── structural-linter    OPERATIONID_FORMAT      3 operationIds normalised  [auto]

  Rejected (5)
  └── ...

  PR: https://github.com/owner/my-api/pull/42

# Machine-readable output
mcp-doctor history run-12 --json

# Diff for a specific finding within a run
mcp-doctor history run-12 --finding GET /users MCP_NO_WHEN_TO_USE

  Before:
    description: "Returns a list of users"

  After (accepted):
    description: "Returns a paginated list of all users in the organisation.
      Use this for browsing or listing users. Use search_users when filtering
      by name, email, or status."

# Clear history
mcp-doctor history clear --before 2026-01-01
```

### GitHub Action History

In `--mode=lint` or `--mode=fix`, the action writes a run summary as a GitHub Actions Job Summary (the Markdown summary that appears in the Actions UI after a run):

```markdown
## MCP Doctor — Run Summary

| Metric         | Value                                        |
| -------------- | -------------------------------------------- |
| Spec           | `api/openapi.yaml`                           |
| Duration       | 12.4s                                        |
| Total findings | 14 (3 errors, 8 warnings, 3 info)            |
| Auto-fixed     | 3                                            |
| PR created     | [#42](https://github.com/owner/repo/pull/42) |

### Agents

| Agent             | Operations                   | Findings | Duration |
| ----------------- | ---------------------------- | -------- | -------- |
| structural-linter | all                          | 3        | 0.1s     |
| worker-1          | GET /users, POST /users      | 2        | 4.2s     |
| worker-2          | GET /orders/{id}             | 4        | 3.8s     |
| worker-3          | POST /orders, DELETE /orders | 2        | 4.1s     |
| orchestrator      | post-processing              | 3        | 1.9s     |
```

---

## Key Assumptions to Validate

- [ ] LLM-generated description suggestions are good enough that users accept most with minor edits — run 20 real specs through manually before building the review UI
- [ ] "Bring your own LLM endpoint" works for the target audience — most enterprise users already have an LLM gateway; validate with 3–5 potential users
- [ ] Route handler tracing works reliably for Express, FastAPI, and Gin at depth 2 — spike this before committing to v2 architecture
- [ ] PR-as-review is the right commit mechanism — users trust their existing GitHub review process more than an in-app approval flow
- [ ] Paste mode (no auth) is a meaningful entry point — check if users actually iterate on specs without a connected repo

## Not Doing (and Why)

- **In-app spec editing** — the spec lives in the repo; the PR is the edit; don't duplicate GitHub's UI
- **AST-level code analysis** — reading handler code as text with an LLM is 80% as good at 10% of the complexity; brittle parsers are a maintenance trap
- **Running LLM calls in the browser** — all inference goes through the backend; credentials never touch the client
- **Storing credentials in the app's database** — LLM credentials are env vars only; GitHub tokens are session-scoped OAuth tokens
- **A dedicated MCP compliance agent** — checks are distributed: structural rules go to the linter (free), per-operation semantic rules are absorbed into the worker call, cross-operation rules run as orchestrator post-processing
- **Auto-fixing LOW confidence findings** — human review is required for semantic changes; trust erodes fast if the tool makes bad automatic commits
- **More than 5 auto-detected frameworks in v3** — explicitly unsupported frameworks fall back to user-guided v2 mode; document this clearly
- **GitLab / Bitbucket support** — GitHub only through all three versions; other platforms are a post-v3 stretch if there is community demand
- **Multi-repo support** — a single repo containing both spec and handlers; multi-repo (API gateway + separate service repos) is out of scope through v3; it is a fundamentally different routing problem
- **Becoming an MCP converter** — this is pre-processing for converters like Stainless/FastMCP; stay in that lane

## Resolved Decisions

- **Multi-repo**: Out of scope through all versions. Explicitly documented in "Not Doing."
- **GitLab/Bitbucket**: Out of scope through all versions. GitHub only.
- **Rate limiting for paste mode**: Structural linting is fully anonymous. AI-powered features require GitHub OAuth in the web app. CLI/Actions use the deployer's own LLM key — rate limiting is their infrastructure concern.
- **v1 progress UX**: SSE from day one. POST /analyze → `jobId` → client opens SSE stream immediately. Three-panel layout applies from v1. GitHub repo connection (Heroku/Vercel-style) is the primary UX; paste mode is secondary.
- **Sidecar in PRs**: Sidecar is gitignored, stored in CI cache only. Never committed, never included in PRs.
- **GitHub Action permissions**: `fix --create-pr` requires `contents: write` and `pull-requests: write`. Documented prominently in README and action metadata — not a design concern, a documentation task.
- **MCP spec version**: Pinned to **2025-11-25** (current stable). Configurable via `--mcp-version` flag.

## Open Questions (answer before writing code)

- **Report JSON schema**: The `--output=report.json` flag needs a defined schema. Downstream CI integrations (Slack bots, dashboards, custom gates) will build on it. Define a minimal schema before v1 ships — changing it later is a breaking change.
- **PR description content**: What does the auto-generated PR body contain? Should list: total findings, auto-fixed count, human-review-required count, per-operation summary of changes. Define the template before building the PR creation feature.
