# Implementation Plan: OpenAPI MCP Doctor (v1 + v2)

## Overview

Build the shared analysis engine first, then wrap it with three surfaces (CLI, GitHub Action, web app). v1 is **spec-only** analysis (structural + AI description/MCP-semantic quality) with GitHub connect + PR creation. v2 adds **codebase grounding** (read handler code, detect spec/code mismatches). v3 (auto-discovery, framework detection) is explicitly out of scope here.

This plan is dependency-ordered and vertically sliced: the first shippable value (`mcp-doctor scan` structural-only) lands at Checkpoint B, before any AI or web work.

---

## Scope & Boundaries

| In scope (v1)                                                                               | In scope (v2)                                                                                                   | Out of scope (v3+)                                   |
| ------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------- |
| Version detection (3.0/3.1, reject 2.0)                                                     | Worker codebase grounding (read handlers, depth-2; **Go-first**: net/http, Gin, Chi, gorilla/mux, Tyk handlers) | Auto route→handler discovery                         |
| Spectral + MCP structural ruleset                                                           | Spec/code mismatch findings (`SPEC_CODE_MISMATCH`)                                                              | Framework detection (Gin/Chi/Express/FastAPI/Rails…) |
| LLM workers (description + MCP semantic)                                                    | `--repo`/`--route-paths`/`--token`, mismatch-mode                                                               | Configurable traversal depth > 2                     |
| Post-processing (near-duplicate, coherence)                                                 | Handler-hash cache dimension (cache scenarios 3 & 4)                                                            | GitLab / Bitbucket                                   |
| Fix mode + confidence thresholds                                                            | `file_read` SSE events, agent timeline, mismatch UI cards                                                       | Multi-spec single job                                |
| Sidecar cache (spec-hash only)                                                              | GitHub handler-file fetch via Octokit                                                                           |                                                      |
| Run history (CLI JSON + web SQLite)                                                         |                                                                                                                 |                                                      |
| CLI (`scan`/`history`/`diff`), JSON report                                                  |                                                                                                                 |                                                      |
| GitHub Action + Job Summary                                                                 |                                                                                                                 |                                                      |
| Web: paste mode, GitHub OAuth, repo connect, SSE 3-panel UI, PR creation, history, settings |                                                                                                                 |                                                      |

---

## Key Architecture Decisions

1. **Engine-first.** `lib/engine/` is a pure, framework-agnostic library. It imports nothing from `app/`, `features/`, or `components/`. Enforced by an ESLint import-boundary rule (`no-restricted-imports`). CLI and web are consumers.
2. **CLI is TypeScript** sharing `lib/engine` directly (Spectral is TS-native). The standalone compiled cross-platform binary (the design doc's "open question") is deferred to a post-v1 distribution task — not v1-blocking.
   2a. **LLM client = Vercel AI SDK** (`ai` core + `@ai-sdk/openai-compatible`). Chosen for `generateObject({ schema })` with Zod — the worker and post-process stages depend heavily on validated structured output, and the SDK's provider-agnostic, framework-agnostic core fits `lib/engine` and any OpenAI-compatible endpoint. Structured output is requested in `json` mode with a `tool`-mode → `generateText`+Zod fallback to stay portable across gateways that don't support JSON-schema mode.
3. **In-process SSE job model for v1/v2.** `POST /api/analyze` creates a job; the engine exposes analysis as an **async iterator** of SSE-shaped events; `GET /api/jobs/[id]/stream` drives it directly in the request (per `nextjs-conventions.md`). No external queue/worker infra. A job store (SQLite for authed runs, in-memory for anonymous paste) holds status. This is a deliberate constraint — revisit only if serverless timeouts force it.
4. **SSE from day one** (resolved decision). No polling path.
5. **MCP version constant = `2025-11-25`**, defined once in `lib/engine` as the single source of truth, surfaced via `--mcp-version` / Settings. Every fix is validated against the detected _OpenAPI_ version before emission.
6. **v1/v2 boundary clarification (resolving a design-doc ambiguity):** GitHub OAuth + repo read + PR creation ship in **v1** (the primary flow). The genuinely-new v2 capability is **reading handler code** — operation→handler mapping, mismatch detection, the second cache hash. Stated here because the design doc's v2 header ("New: GitHub OAuth + repo connection") reads as if OAuth is v2; it is not — only codebase grounding is.
7. **Structured LLM output via Zod** at every boundary (LLM responses, GitHub API, incoming requests). No `any`.
8. **Continuous dogfooding as a CI gate (not a background loop).** The engine is tested constantly against (a) a versioned **fixture corpus** of good/bad specs with golden expected output — the deterministic regression net, grown with every engine task — and (b) **our own `openapi.yaml`**, a hand-maintained spec for this app's own Route Handlers (`/api/analyze`, `/api/jobs/[id]/stream`, GitHub/PR endpoints). CI runs the engine against both on every change and **fails the build on a health-score regression**. The self-spec is a thin engine test on its own (~5 ops, won't trip count/near-duplicate rules) but is the highest-value test of **v2 codebase grounding**: spec and handlers live in the same repo, so our own tool must catch when our spec drifts from our handlers (`SPEC_CODE_MISMATCH`). A literal always-on agent loop was rejected — a change-triggered CI gate catches regressions strictly better at lower cost. Marketing/credibility byproduct: a health-score badge on the README ("we run MCP Doctor on MCP Doctor").

---

## Dependency Graph

```
Scaffold + types (T1–T3)
   │
   ├── Engine: version detect (T4) ── Spectral runner (T5) ── MCP ruleset (T6a/T6b) ── runStructuralAnalysis (T7)
   │                                                                                          │
   │                                                              ┌───────────────────────────┴── CLI structural (T8–T9)  ◀ Checkpoint B (first ship)
   │                                                              │
   ├── LLM client (T10) ── orchestrator (T11) ── worker (T12) ── post-process (T13) ── runAnalysis() event API (T14)
   │                                                                                          │
   │                          ┌───────────────────────────────────────────────────────────────┼── CLI AI mode (T15)
   │                          │                                                                 │
   │   fix applier (T16) ─────┤   cache (T17)   history records (T18)   CLI history/diff (T19)  │   CLI fix (T20)  ◀ Checkpoint D
   │                          │                                                                 │
   │   GitHub Action (T21) ───┘                                                                 │
   │                                                                                            │
   └── Web shell + paste (T22) ── analyze API + SSE (T23) ── 3-panel UI (T24a/T24b)  ◀ Checkpoint E
                                                                  │
        NextAuth (T25) ── Prisma+history UI (T26a/T26b) ── repo connect (T27) ── GH analysis (T28) ── PR flow (T29) ── settings (T30)  ◀ Checkpoint F (v1 DONE)
                                                                  │
   ===================================== v2 =====================================
        Spike: route→handler tracing (T31, HIGH RISK)
                                                                  │
        handler mapping (T32) ── worker grounding + mismatch (T33) ── handler-hash cache (T34) ── runAnalysis v2 (T35)
                                                                  │
        CLI v2 (T36) ── GH handler fetch (T37) ── Web mismatch UI + file_read feed (T38) ── Action v2 (T39)  ◀ Checkpoint G (v2 DONE)
```

---

# v1 Task List

### Phase 0 — Scaffold & Foundations

## Task 1: Project scaffold + tooling

**Description:** Next.js (App Router) + TypeScript strict, Tailwind + shadcn/ui init, Vitest + RTL, ESLint + Prettier, npm scripts. Set up the `lib/engine` / `cli` / `app` / `features` directory skeleton with the import-boundary ESLint rule.
**Acceptance criteria:**

- [ ] `npm run dev`, `build`, `test`, `lint`, `typecheck` all run on an empty app
- [ ] ESLint rule fails the build if `lib/engine/**` imports from `app/`, `features/`, or `components/`
- [ ] `tsconfig` has `strict: true`; Prettier + ESLint agree (no conflicts)
      **Verification:** `npm run typecheck && npm run lint && npm run test` exit 0 on the skeleton.
      **Dependencies:** None
      **Files:** `package.json`, `tsconfig.json`, `.eslintrc`, `vitest.config.ts`, `tailwind.config.ts`, dir skeleton
      **Scope:** M

## Task 2: Shared types + constants + boundary validation

**Description:** Define `Finding`, `Severity`, `Confidence`, `OpenApiVersion`, `AnalysisRun`, `AgentRecord`, `FindingRecord`, the SSE event union, and the JSON report shape from `ux-design.md`. Define the `MCP_VERSION = '2025-11-25'` constant. Add Zod schemas for API/LLM/GitHub boundaries.
**Acceptance criteria:**

- [ ] Types match the `AnalysisRun`/`FindingRecord` schema in the design doc and the JSON report schema in `ux-design.md`
- [ ] SSE event union covers every event in `agentic-architecture.md` (incl. `file_read` for v2)
- [ ] Zod `AnalyzeRequestSchema` parses `{spec, mode, mismatchMode, confidenceThreshold}`
      **Verification:** `npm run typecheck`; unit test round-trips a sample report through the Zod schema.
      **Dependencies:** T1
      **Files:** `types/domain.ts`, `types/api.ts`, `lib/engine/constants.ts`
      **Scope:** M

### Phase 1 — Engine: Deterministic Structural Linter (zero LLM)

## Task 3: OpenAPI version detection

**Description:** Pure `detectVersion(spec)` → `'3.0' | '3.1'`; Swagger 2.0 → single `SWAGGER_20_NOT_SUPPORTED` error + halt; missing/unparseable `openapi` → `OAS_VERSION_UNDETECTABLE` + halt.
**Acceptance criteria:**

- [ ] 3.0.x and 3.1.x detected from the `openapi` field
- [ ] `swagger: "2.0"` returns exactly one finding and signals halt
- [ ] Malformed/missing version returns `OAS_VERSION_UNDETECTABLE` and signals halt
      **Verification:** `npm test -- version-detect` — table tests for 3.0, 3.1, 2.0, missing, garbage.
      **Dependencies:** T2
      **Files:** `lib/engine/linter/version.ts`, test
      **Scope:** S

## Task 4: Spectral runner + base ruleset + normalizer

**Description:** Wire `@stoplight/spectral-core` with the built-in `oas` ruleset; normalize Spectral results into our `Finding` type (severity, path, rule, confidence=HIGH for structural). Version-gate which ruleset loads.
**Acceptance criteria:**

- [ ] Runs Spectral against a 3.0 and a 3.1 fixture and returns normalized findings
- [ ] Halts with the version finding (T3) before running any ruleset on a 2.0 spec
- [ ] Every normalized finding carries `path`, `severity`, `rule`, `confidence: 'HIGH'`
      **Verification:** `npm test -- spectral-runner` against fixtures.
      **Dependencies:** T2, T3
      **Files:** `lib/engine/linter/spectral.ts`, `lib/engine/linter/normalise.ts`, fixtures
      **Scope:** M

## Task 5a: MCP ruleset — identity, descriptions, response, count

**Description:** Version-parameterized `mcpRuleset(version)` covering: `mcp-operationid-required/format/unique`, `mcp-param/enum/nested-description-required`, `mcp-response-schema-required` (anchored `/^2(\d{2}|XX)$/`), `mcp-operation-count` (40 warn / 80 error), and the description heuristics (`MCP_DESCRIPTION_TOO_SHORT`, `_IS_JUST_PATH`, `_DUPLICATE`, etc.).
**Acceptance criteria:**

- [ ] operationId format rule labels findings as "LLM tool-API compatibility," not "MCP spec" (per corrected `mcp-spec.md`)
- [ ] response-schema rule uses the anchored regex and is documented to skip `default`
- [ ] count thresholds emit the corrected provenance message (Cursor 40 / heuristic 80)
      **Verification:** `npm test -- mcp-ruleset-identity` against a spec with seeded violations of each rule.
      **Dependencies:** T4
      **Files:** `lib/engine/linter/rulesets/mcp.ts`, fixtures, test
      **Scope:** M

## Task 5b: MCP ruleset — version-compliance + conversion problems

**Description:** Add `mcp-nullable-deprecated` (3.1 only), `mcp-xnullable-not-standard`, example/`examples` version + placement checks (schema-array vs param-map), `MCP_EXTERNAL_REF`, `MCP_RECURSIVE_REF`, `MCP_PARAM_CONFLICT`, `MCP_MULTIPART_PARTIAL_SUPPORT`, `MCP_BINARY_NO_MCP_EQUIVALENT`, `MCP_AUTH_NOT_IN_DESCRIPTION`, `MCP_FORM_URLENCODED`.
**Acceptance criteria:**

- [ ] nullable/example rules fire only for the correct detected version
- [ ] binary-upload rule is `error`; multipart-without-binary is `warning`
- [ ] every emitted fix is valid for the detected OpenAPI version (3.0 vs 3.1 forms)
      **Verification:** `npm test -- mcp-ruleset-conversion` with 3.0 and 3.1 variants of each fixture.
      **Dependencies:** T5a
      **Files:** `lib/engine/linter/rulesets/mcp.ts` (extend), fixtures, test
      **Scope:** M

## Task 6: `runStructuralAnalysis` public API

**Description:** Compose version-detect → Spectral → MCP ruleset → normalized findings + summary + detected version. The zero-LLM, always-runs entry point.
**Acceptance criteria:**

- [ ] Single call returns `{version, findings, summary}` for a spec string
- [ ] No network/LLM calls occur (assert via mock)
- [ ] Halts cleanly on 2.0 / undetectable version
      **Verification:** `npm test -- run-structural` end-to-end on a realistic spec.
      **Dependencies:** T5b
      **Files:** `lib/engine/index.ts`, test
      **Scope:** S

### ✅ Checkpoint A — Structural engine complete

- [ ] All engine tests green; zero LLM dependency; `typecheck` + `lint` clean.
- [ ] **Dogfood:** golden corpus harness (DF1) green; structural fixtures have committed goldens.

### Phase 2 — CLI surface (structural-only first vertical slice)

## Task 7: CLI scaffold + `scan` arg parsing + exit codes

**Description:** `mcp-doctor scan <spec>` with global flags (`--no-color`, `--json`, `--mcp-version`, `--help`, `--version`) and scan flags (`--mode`, `--report`, `--verbose`). Implement the exit-code contract (0/1/2/3 from `ux-design.md`).
**Acceptance criteria:**

- [ ] `scan` runs `runStructuralAnalysis` and exits 1 when ERROR findings exist, 0 otherwise
- [ ] Bad args → exit 3; unreadable spec → exit 2
- [ ] `--help`/`--version` work
      **Verification:** Shell test asserting exit codes per scenario.
      **Dependencies:** T6
      **Files:** `cli/index.ts`, `cli/commands/scan.ts`, test
      **Scope:** M

## Task 8: CLI output — human-readable + JSON report

**Description:** Render the human-readable report (colour, summary line, grouped errors/warnings) matching `ux-design.md`; `--report path` writes the JSON report schema; `--json` prints it to stdout.
**Acceptance criteria:**

- [ ] Human output matches the documented layout (spec/version/mode header, grouped findings)
- [ ] `--report` output validates against the JSON report Zod schema (T2)
- [ ] `--no-color`/piped output has no ANSI codes
      **Verification:** `npm test -- cli-output` snapshot + JSON-schema validation.
      **Dependencies:** T7
      **Files:** `cli/render/human.ts`, `cli/render/json.ts`, test
      **Scope:** M

### ✅ Checkpoint B — FIRST SHIPPABLE: `mcp-doctor scan spec.yaml` (structural, no auth, no LLM)

- [ ] Works end-to-end on a real spec; exit codes correct; JSON report stable. **Review with human.**

### Phase 3 — Engine: AI layer

## Task 9: LLM client wrapper (Vercel AI SDK)

**Description:** Wrap the Vercel AI SDK (`ai` + `@ai-sdk/openai-compatible`) in `lib/llm/`. Reads `LLM_BASE_URL`/`LLM_API_TOKEN` from env, exposes a `generateFindings(schema, prompt)` helper over `generateObject` with a json→tool→text+Zod fallback; never logs credentials or includes them in errors.
**Acceptance criteria:**

- [ ] `createOpenAICompatible` configured from env only; absent env → AI features disabled, no crash
- [ ] `generateObject` returns Zod-validated, typed output; malformed output triggers the fallback then a typed error (never `any`)
- [ ] Credentials never appear in logs or thrown errors (assert in test)
      **Verification:** `npm test -- llm-client` with a mocked AI SDK provider + a log-capture assertion.
      **Dependencies:** T2
      **Files:** `lib/llm/client.ts`, `lib/llm/schemas.ts`, test
      **Scope:** M

## Task 10: Orchestrator (fan-out, event emission)

**Description:** Partition operations into batches of 3–5, fan out worker calls in parallel, collect results, emit `agent_started`/`agent_completed`/`finding` events via an async iterator. Passes each worker only its batch + version + thresholds (not the full spec).
**Acceptance criteria:**

- [ ] N operations partition into ceil(N/batch) workers running concurrently
- [ ] Events stream as workers complete (not all-at-once)
- [ ] Worker context excludes other workers' results and the full spec
      **Verification:** `npm test -- orchestrator` with mocked workers asserting batching + event order.
      **Dependencies:** T9, T6
      **Files:** `lib/engine/orchestrator/index.ts`, test
      **Scope:** M

## Task 11: Worker agent (description + MCP semantic)

**Description:** Per-batch prompt covering description quality + MCP semantic checks (WHEN/returns/name-duplication/param actionability), with a version-aware system prompt. Structured Zod output. **No code reading in v1.**
**Acceptance criteria:**

- [ ] One LLM call per batch produces findings with confidence MEDIUM (or HIGH on citable rule violations)
- [ ] System prompt includes detected OpenAPI version and forbids wrong-version fix syntax
- [ ] Output validated by Zod; malformed → retried/typed-error, never `any`
      **Verification:** `npm test -- worker` with a mocked LLM returning canned structured output.
      **Dependencies:** T9
      **Files:** `lib/engine/workers/worker.ts`, `lib/engine/workers/prompt.ts`, test
      **Scope:** M

## Task 12: Post-processing (near-duplicate + coherence)

**Description:** Single LLM call over all operation descriptions after workers complete: near-duplicate detection + tool-set coherence. Emits `MCP_NEAR_DUPLICATE` findings with disambiguation suggestions.
**Acceptance criteria:**

- [ ] Runs only after all workers finish (never in parallel with them)
- [ ] Produces near-duplicate findings with both operations + suggested disambiguation
- [ ] One LLM call total for this stage
      **Verification:** `npm test -- postprocess` with a fixture containing a near-duplicate pair.
      **Dependencies:** T10
      **Files:** `lib/engine/postprocess/index.ts`, test
      **Scope:** M

## Task 13: `runAnalysis()` unified event API

**Description:** Top-level async iterator merging structural findings → worker events → post-process → `analysis_complete`. Degrades to structural-only when no LLM configured. This is the engine API both CLI and web consume.
**Acceptance criteria:**

- [ ] Yields the full documented SSE event sequence in order
- [ ] With no LLM env: yields structural findings + `analysis_complete`, no worker events
- [ ] Returns a final assembled report object
      **Verification:** `npm test -- run-analysis` asserting event order in both AI and no-AI modes.
      **Dependencies:** T10, T11, T12
      **Files:** `lib/engine/index.ts` (extend), test
      **Scope:** M

## Task 14: Wire CLI AI mode

**Description:** CLI detects LLM env, streams worker progress lines (per `ux-design.md`), `--verbose` shows all findings.
**Acceptance criteria:**

- [ ] With LLM env set, `scan` shows worker progress + AI findings
- [ ] Without it, prints "AI analysis not enabled" hint and runs structural-only
      **Verification:** Two shell runs (env set / unset) asserting output difference.
      **Dependencies:** T13, T8
      **Files:** `cli/commands/scan.ts` (extend), test
      **Scope:** S

### ✅ Checkpoint C — Full analysis engine + CLI AI mode

- [ ] Engine streams structural+AI; CLI shows live progress; all tests green. **Review with human.**

### Phase 4 — Engine: Fix mode, cache, history

## Task 15: Confidence model + version-aware fix applier

**Description:** Apply accepted/eligible fixes to the spec by confidence threshold (high/medium/low), emitting version-correct syntax; LOW always warns. Writes patched spec (YAML/JSON preserved).
**Acceptance criteria:**

- [ ] `high` applies only HIGH; `medium` adds MEDIUM; `low` applies all + prominent warning
- [ ] 3.0 vs 3.1 fix forms emitted correctly (nullable, example, exclusiveMinimum, $ref)
- [ ] Original file format (YAML vs JSON) and key order preserved where feasible
      **Verification:** `npm test -- fix-applier` round-tripping each fix type on 3.0 and 3.1 fixtures.
      **Dependencies:** T13
      **Files:** `lib/engine/fix/apply.ts`, test
      **Scope:** M

## Task 16: Sidecar cache (spec-hash; v1)

**Description:** `.mcp-doctor.yaml` read/write keyed by `hash(spec)`; handler-hash dimension stubbed (v2). Implements cache scenarios 1 & 2 (cold start, nothing changed). Schema designed now to fit v2.
**Acceptance criteria:**

- [ ] Cold start writes findings + spec_hash; unchanged spec returns cached findings with zero LLM calls
- [ ] Cache schema includes `operations[].handler_hash` field (unused in v1)
- [ ] Never modifies the spec file itself
      **Verification:** `npm test -- cache` asserting zero LLM calls on a warm-cache run.
      **Dependencies:** T13
      **Files:** `lib/engine/cache/sidecar.ts`, test
      **Scope:** M

## Task 17: Run-history records + CLI store

**Description:** Assemble `AnalysisRun`/`AgentRecord`/`FindingRecord`; CLI persists JSON to `.mcp-doctor/runs/{ts}-{id}.json`, keeps last 100. Append-only; only `resolution` mutated post-run.
**Acceptance criteria:**

- [ ] Each run writes one JSON file matching the schema
- [ ] > 100 runs prunes oldest; `--history-limit` configurable
- [ ] Records are not mutated after write (except resolution)
      **Verification:** `npm test -- history-store` for write + prune.
      **Dependencies:** T13
      **Files:** `lib/engine/history/record.ts`, `cli/history/store.ts`, test
      **Scope:** M

## Task 18: CLI `history` + `diff` commands

**Description:** `history` (list), `history <id>` (detail), `history <id> --json`, `history <id> --finding ...`, `diff <id>` per `ux-design.md`.
**Acceptance criteria:**

- [ ] List, detail, JSON, finding-detail, and diff outputs match documented layouts
- [ ] `history clear --before <date>` removes matching runs
      **Verification:** `npm test -- cli-history` snapshots against stored fixtures.
      **Dependencies:** T17
      **Files:** `cli/commands/history.ts`, `cli/commands/diff.ts`, test
      **Scope:** M

## Task 19: CLI fix mode wiring

**Description:** `--mode=fix` + `--confidence-threshold` + `--output` writes patched spec; aggressive (low) prints the warning banner. Exit code 0 on successful apply.
**Acceptance criteria:**

- [ ] Conservative/standard/aggressive runs match documented output + skip lists
- [ ] LOW threshold prints the prominent warning
- [ ] Patched spec written to `--output`
      **Verification:** Shell tests for each threshold asserting applied/skipped counts.
      **Dependencies:** T15
      **Files:** `cli/commands/scan.ts` (extend), test
      **Scope:** S

### ✅ Checkpoint D — CLI feature-complete for v1

- [ ] lint/fix/history/diff/cache/JSON-report all work; exit codes stable. **Review with human.**

### Phase 5 — GitHub Action

## Task 20: GitHub Action wrapper + Job Summary

**Description:** Action (Docker or composite) exposing the documented inputs; runs the CLI; writes the GitHub Actions Job Summary markdown; `fail-on` gate maps to exit behaviour.
**Acceptance criteria:**

- [ ] All documented inputs map to CLI flags
- [ ] Job Summary markdown matches `ux-design.md` layout
- [ ] `fail-on: error|warning|never` controls the step's pass/fail
      **Verification:** `act` (or a CI smoke job) runs the action against a fixture spec and renders the summary.
      **Dependencies:** T19
      **Files:** `action.yml`, `cli` entrypoint, `.github/` example workflow
      **Scope:** M

### Phase 6 — Web app: anonymous paste + structural + SSE

## Task 21: App shell + landing + paste UI

**Description:** Route groups `(public)`/`(auth)`, layout, shadcn base components, landing page with paste/drop area and the "Run structural analysis" CTA (no auth).
**Acceptance criteria:**

- [ ] Landing matches the unauthenticated mock; paste accepts YAML/JSON
- [ ] Server Components by default; `'use client'` only on the paste box
      **Verification:** `npm run build`; component test renders landing + paste interaction.
      **Dependencies:** T1, T2
      **Files:** `app/(public)/page.tsx`, `app/layout.tsx`, `features/analyze/components/*`, `components/ui/*`
      **Scope:** M

## Task 22: Analyze API + SSE stream

**Description:** `POST /api/analyze` (Zod-validated) → `{jobId}` + job store; `GET /api/jobs/[id]/stream` drives `runAnalysis()` as `text/event-stream`. Anonymous paste uses in-memory job store + structural-only.
**Acceptance criteria:**

- [ ] POST returns a jobId; stream emits the documented events ending in `analysis_complete`
- [ ] Anonymous job runs structural-only (no LLM) without auth
- [ ] Credentials/env never reach the client
      **Verification:** Integration test opens the SSE stream for a posted spec and asserts event sequence.
      **Dependencies:** T13, T21
      **Files:** `app/api/analyze/route.ts`, `app/api/jobs/[id]/stream/route.ts`, `lib/jobs/store.ts`, test
      **Scope:** M

## Task 23a: Three-panel view — layout + SSE hook + operations/agent panels

**Description:** `/analysis/[jobId]` three-panel shell; `useAnalysisStream` consumes SSE; left operations list + centre agent feed render live.
**Acceptance criteria:**

- [ ] Operations list shows status icons; agent feed auto-scrolls and shows timings
- [ ] Reconnect/closed-stream handled gracefully
      **Verification:** Component test feeding mock SSE events asserts panel updates.
      **Dependencies:** T22
      **Files:** `app/(public)/analysis/[jobId]/page.tsx`, `features/analyze/hooks.ts`, `features/analyze/components/{Operations,AgentFeed}.tsx`
      **Scope:** M

## Task 23b: Three-panel view — suggestion queue + accept/edit/reject + download

**Description:** Right-panel suggestion cards (before/after, severity/confidence badges), Accept/Edit/Reject state, auto-fixed collapsed cards with Undo, "Download patched spec".
**Acceptance criteria:**

- [ ] Card states match the documented mocks (standard / editing / auto-fixed)
- [ ] Accept/edit/reject updates the running counts in the bottom bar
- [ ] Download applies accepted+auto-fixed changes via the engine fix applier
      **Verification:** Component test for each card state + a download-content assertion.
      **Dependencies:** T23a, T15
      **Files:** `features/review/components/*`, `features/review/actions.ts`
      **Scope:** M

### ✅ Checkpoint E — Anonymous paste → live analysis → download patched spec

- [ ] Full paste-mode flow works in the browser. **Review with human.**
- [ ] **Dogfood:** `openapi.yaml` + CI health-score gate (DF2) live; regression fails the build; README badge renders.

### Phase 7 — Web app: GitHub + AI + PR + history + settings

## Task 24: NextAuth GitHub provider + auth guard

**Description:** NextAuth.js GitHub provider (`repo`, `read:user` scopes); `(auth)` layout redirects unauthenticated users to `/` with `?next=`; session stores access token server-side.
**Acceptance criteria:**

- [ ] OAuth round-trip logs the user in; token never exposed to client
- [ ] `(auth)` routes redirect when unauthenticated
      **Verification:** Integration test for the guard; manual OAuth smoke.
      **Dependencies:** T21
      **Files:** `app/api/auth/[...nextauth]/route.ts`, `app/(auth)/layout.tsx`, `features/github/actions.ts`
      **Scope:** M

## Task 25a: Prisma + SQLite schema + run persistence

**Description:** Prisma schema for `AnalysisRun`/`AgentRecord`/`FindingRecord`; persist authed runs; expose `resolution` updates.
**Acceptance criteria:**

- [ ] Migration creates the tables; a completed run persists with all agents/findings
- [ ] `FindingRecord.resolution` updatable; records otherwise append-only
      **Verification:** `npm test -- db-persistence` against a temp SQLite file.
      **Dependencies:** T24, T17
      **Files:** `prisma/schema.prisma`, `lib/db/*`, test
      **Scope:** M

## Task 25b: History UI (`/history`, `/history/[runId]`)

**Description:** History list + run detail (agent timeline bar chart, findings tabs) per `ux-design.md`.
**Acceptance criteria:**

- [ ] List + detail match documented layouts; filters work
- [ ] Run detail shows parallel agent overlap + per-finding resolution
      **Verification:** Component tests against seeded runs.
      **Dependencies:** T25a
      **Files:** `app/(auth)/history/*`, `features/*/components/*`
      **Scope:** M

## Task 26: Repo connection + dashboard

**Description:** Octokit wrapper (server-only); `/dashboard` repo list (searchable, paginated), inline config panel (branch, spec path autocomplete from file tree, analysis/mismatch/output modes), connected-repos health list.
**Acceptance criteria:**

- [ ] Repo list paginates/searches; spec-path autocompletes from the repo tree
- [ ] Config panel matches the mock; mismatch-mode greyed out without route files
      **Verification:** Component test with mocked Octokit; manual repo-select smoke.
      **Dependencies:** T24
      **Files:** `features/github/client.ts`, `app/(auth)/dashboard/page.tsx`, `features/github/components/*`
      **Scope:** M

## Task 27: GitHub-sourced AI analysis

**Description:** Read the spec file from the connected repo via Octokit, run authed `runAnalysis()` (AI enabled via server LLM config), stream to the 3-panel view.
**Acceptance criteria:**

- [ ] Spec fetched from repo+branch+path; analysis streams via SSE
- [ ] AI gated on auth (anonymous stays structural-only)
      **Verification:** Integration test with mocked Octokit + mocked LLM.
      **Dependencies:** T26, T13
      **Files:** `features/analyze/actions.ts`, `app/(auth)/analysis/[jobId]/*`
      **Scope:** M

## Task 28: Create PR flow

**Description:** "Create PR" panel: new branch, commit patched spec, open PR with the auto-generated summary template; success state with PR link.
**Acceptance criteria:**

- [ ] Creates branch + commit + PR via Octokit; PR body matches the template
- [ ] Enabled only when ≥1 suggestion accepted/auto-fixed
- [ ] Sidecar cache never committed/included in the PR
      **Verification:** Integration test with mocked Octokit asserting branch/commit/PR calls + body.
      **Dependencies:** T27, T15
      **Files:** `app/api/github/pr/route.ts`, `features/github/components/CreatePr.tsx`, `features/github/actions.ts`
      **Scope:** M

## Task 29: Settings page

**Description:** Server-side LLM config status + "Test connection", GitHub connection management, defaults (MCP version, mode, mismatch), history retention.
**Acceptance criteria:**

- [ ] LLM token never sent to client; "Test connection" validates server-side
- [ ] Defaults persist and feed new analyses
      **Verification:** Component test + a server-action test for "Test connection".
      **Dependencies:** T24
      **Files:** `app/(auth)/settings/page.tsx`, `features/settings/*`
      **Scope:** M

### ✅ Checkpoint F — v1 COMPLETE

- [ ] Connect GitHub → analyze → review → PR; paste mode; history; settings; CLI; Action. **Full review + tag v1.**

---

# v2 Task List — Codebase Grounding

### Phase 8 — De-risk spike (do this FIRST in v2)

## Task 30: Route→handler tracing spike ⚠ HIGH RISK

**Description:** Time-boxed spike proving the worker can map a spec operation to its handler and read 2 layers deep using text-based (LLM) reading of user-pointed route files — no per-language parser. **Go is the primary target** (this is the Tyk org; Tyk Gateway and most internal services are Go): cover Go `net/http`, **Gin**, **Chi**, **gorilla/mux**, and **Tyk-style handlers** (custom middleware / plugin handlers with context injection). Then validate the same approach generalizes to **Express** (Node) and **FastAPI** (Python). Validates the design doc's riskiest assumption before committing v2 architecture.
**Acceptance criteria:**

- [ ] On real repos, the worker locates the handler for ≥80% of a sample of operations at depth 2 — measured **per Go router** (net/http, Gin, Chi, gorilla/mux) first, then Express + FastAPI
- [ ] Documents Go-specific failure modes (method-on-receiver handlers, router groups/subrouters, middleware indirection, Tyk context injection, handlers registered via reflection/maps)
- [ ] Go/no-go recommendation on the text-based approach vs. a fallback (e.g. a lightweight Go AST pass via `go/parser` if text reading underperforms on Go)
      **Verification:** Spike report in `docs/research/` with measured hit-rate per framework. **Hard gate: human reviews before T31+.**
      **Dependencies:** T13
      **Files:** `docs/research/route-tracing-spike.md`, throwaway harness
      **Scope:** M

### Phase 9 — Engine: codebase grounding

## Task 31: Operation→handler mapping

**Description:** Given user-pointed `route-paths`, map each spec operation to a candidate handler file/function (path+method matching). **Go routers are the priority surface:** `net/http` (`{id}` Go 1.22+ patterns), Gin (`:id`), Chi (`{id}`), gorilla/mux, and Tyk-style handler registration — then Express and FastAPI. User-pointed, not auto-discovery.
**Acceptance criteria:**

- [ ] Returns a handler candidate (or "unmapped") per operation
- [ ] Unmapped handler surfaces as a finding, not a crash
      **Verification:** `npm test -- handler-map` against multi-framework route fixtures.
      **Dependencies:** T30 (go decision)
      **Files:** `lib/engine/grounding/map.ts`, fixtures, test
      **Scope:** M

## Task 32: Worker codebase grounding + mismatch detection

**Description:** Extend the worker to read the mapped handler + depth-2 service calls, detect spec/code mismatches (status codes, response shapes, auth signals), synthesize high-fidelity suggestions, and emit `file_read` events. `SPEC_CODE_MISMATCH` findings are always LOW + carry the "may be a code bug" warning.
**Acceptance criteria:**

- [ ] Mismatch findings include spec-claims vs code-does + file:line + warning
- [ ] Depth capped at 2; `file_read` events emitted per file
- [ ] Confidence LOW on all mismatches; never auto-applied
      **Verification:** `npm test -- worker-grounding` with a fixture handler that contradicts its spec.
      **Dependencies:** T31
      **Files:** `lib/engine/workers/worker.ts` (extend), `lib/engine/grounding/read.ts`, test
      **Scope:** M

## Task 33: Handler-hash cache dimension (scenarios 3 & 4)

**Description:** Activate the second cache hash: hash each handler file independently; reuse grounding results when handlers are unchanged; re-run only changed handlers. Spec-hash and handler-hash are independent.
**Acceptance criteria:**

- [ ] Spec changed / code unchanged → reuse grounding, re-run spec quality only (scenario 3)
- [ ] Code changed / spec unchanged → re-run only changed handlers (scenario 4)
- [ ] Both-changed handled by independent hash checks (no special-casing)
      **Verification:** `npm test -- cache-grounding` covering all four scenarios.
      **Dependencies:** T32, T16
      **Files:** `lib/engine/cache/sidecar.ts` (extend), test
      **Scope:** M

## Task 34: `runAnalysis()` v2 (grounding integrated)

**Description:** Thread `repo`/`route-paths`/`mismatchMode` through orchestrator → grounding workers → events; structural+AI path unchanged when no route paths given.
**Acceptance criteria:**

- [ ] With route paths: emits `file_read` + mismatch findings; without: identical to v1
- [ ] `mismatch-mode=flag` reports only; `fix` respects confidence (LOW never auto-applied)
      **Verification:** `npm test -- run-analysis-v2` in grounded and non-grounded modes.
      **Dependencies:** T32, T33
      **Files:** `lib/engine/index.ts` (extend), test
      **Scope:** M

### ✅ Checkpoint H — Grounding engine complete

- [ ] Mismatch detection + handler caching proven on fixtures. **Review with human.**

### Phase 10 — Surfaces: v2

## Task 35: CLI v2 (`--repo`/`--token`/`--route-paths`/`--mismatch-mode`)

**Description:** Wire codebase-grounding flags; render mismatch findings + cache hit/miss summary per `ux-design.md`.
**Acceptance criteria:**

- [ ] Grounded scan shows mismatches + cached-operation counts
- [ ] `--mismatch-mode` + `--create-pr` (with `--repo` + `--mode=fix`) behave per docs
      **Verification:** Shell test against a fixture repo with seeded mismatch.
      **Dependencies:** T34
      **Files:** `cli/commands/scan.ts` (extend), test
      **Scope:** M

## Task 36: GitHub handler-file fetch (web)

**Description:** Octokit reads the route/handler files from the connected repo so web grounding works without local checkout.
**Acceptance criteria:**

- [ ] Route-path files fetched from repo+branch; passed to grounding workers
- [ ] Large/missing files handled gracefully (skip + finding, no crash)
      **Verification:** Integration test with mocked Octokit returning handler files.
      **Dependencies:** T34, T26
      **Files:** `features/github/client.ts` (extend), `features/analyze/actions.ts`
      **Scope:** M

## Task 37: Web mismatch UI + file_read feed + agent timeline

**Description:** Render the LOW `SPEC_CODE_MISMATCH` cards (spec-claims / code-does / warning / accept-fix-spec) and show `file_read` events in the agent feed; run-detail timeline shows files read.
**Acceptance criteria:**

- [ ] Mismatch card matches the documented mock incl. the code-bug warning
- [ ] Agent feed shows files read; run detail lists them per agent
      **Verification:** Component tests for the mismatch card + file_read feed.
      **Dependencies:** T36, T23b, T25b
      **Files:** `features/review/components/*`, `features/analyze/components/AgentFeed.tsx` (extend)
      **Scope:** M

## Task 38: GitHub Action v2 (route-paths)

**Description:** Expose `route-paths` in the action; grounding runs in CI; Job Summary includes mismatch counts.
**Acceptance criteria:**

- [ ] Action with `route-paths` runs grounded analysis and reports mismatches in the summary
      **Verification:** CI smoke job against a fixture repo.
      **Dependencies:** T35
      **Files:** `action.yml` (extend), example workflow
      **Scope:** S

### ✅ Checkpoint G — v2 COMPLETE

- [ ] Codebase grounding across CLI, web, Action; mismatch UX; caching. **Full review + tag v2.**
- [ ] **Dogfood:** v2 self-grounding (DF3) live; an introduced spec/handler drift is caught in CI as a LOW mismatch.

---

## Continuous Dogfooding (CI gate — cross-cutting)

These tasks implement Architecture Decision 8. They are not a phase; they thread through the whole build. DF1 lands right after the structural engine (Checkpoint A) so every later task plugs into it; DF2 follows once the app has its own API routes; DF3 is the v2 self-grounding payoff.

## Task DF1: Golden fixture corpus + regression harness

**Description:** Establish `fixtures/specs/` (clean + one-violation-per-rule + 3.0/3.1 pairs + a >40-op spec + a near-duplicate pair) with golden expected `Finding` output per fixture, and a Vitest harness that asserts engine output matches golden (mocked LLM for determinism). Every engine task (T4–T15, T31–T34) adds/updates fixtures here.
**Acceptance criteria:**

- [ ] Each fixture has a committed golden output file; harness diffs actual vs golden
- [ ] LLM-dependent goldens use a mocked provider (deterministic, no network)
- [ ] A "health score" is computed from findings (errors/warnings weighting) and asserted per fixture
      **Verification:** `npm test -- golden-corpus` green; intentionally breaking a rule flips the matching golden test red.
      **Dependencies:** T6 (structural API); extended at T13 (AI), T34 (grounding)
      **Files:** `fixtures/specs/*`, `fixtures/golden/*`, `test/golden-corpus.test.ts`
      **Scope:** M

## Task DF2: Self-spec (`openapi.yaml`) + CI health-score gate

**Description:** Hand-author `openapi.yaml` describing this app's own Route Handlers; add a CI job (and an `npm run dogfood` script) that runs the engine against the self-spec + the golden corpus and **fails on a health-score regression** vs a committed baseline. Emit a README health badge from the result.
**Acceptance criteria:**

- [ ] `openapi.yaml` covers `/api/analyze`, `/api/jobs/[id]/stream`, and the GitHub/PR routes
- [ ] CI step fails when the self-spec or any corpus health score drops below baseline
- [ ] Baseline is a committed file updated deliberately (PR-reviewed), not auto-overwritten
      **Verification:** CI smoke: lowering a description in `openapi.yaml` drops the score and fails the gate.
      **Dependencies:** DF1, T22 (API routes exist to document)
      **Files:** `openapi.yaml`, `.github/workflows/dogfood.yml`, `scripts/dogfood.ts`, `dogfood-baseline.json`
      **Scope:** S

## Task DF3: v2 self-grounding (spec-vs-our-own-handlers)

**Description:** Once codebase grounding lands, point the self-spec dogfood run at our own Route Handler files so the tool detects drift between `openapi.yaml` and the actual handlers — the canonical `SPEC_CODE_MISMATCH` test on a real, controlled codebase, in CI.
**Acceptance criteria:**

- [ ] Dogfood CI runs grounded analysis with `route-paths` pointing at `app/api/**`
- [ ] An intentionally-introduced spec/handler drift is caught as a LOW mismatch finding
      **Verification:** CI: editing a handler's status code without updating `openapi.yaml` surfaces a mismatch.
      **Dependencies:** DF2, T34
      **Files:** `.github/workflows/dogfood.yml` (extend), `scripts/dogfood.ts` (extend)
      **Scope:** S

## Parallelization Opportunities

- **After Checkpoint A (engine structural):** CLI (T7–T8) and Web shell (T21) can start in parallel.
- **After Checkpoint C (engine event API):** Fix/cache/history (T15–T17), GitHub Action (T20), and Web paste (T22–T23) are largely independent — parallelizable across sessions once the `runAnalysis()` contract is frozen.
- **v2:** T31/T32/T33 are sequential (shared grounding state); but CLI v2 (T35), web fetch (T36), and Action v2 (T38) parallelize once T34 lands.
- **Always coordinate first:** the `Finding`/SSE/report contracts (T2) and the `runAnalysis()` event shape (T13) — freeze these before fanning out surface work.

## Risks & Mitigations

| Risk                                                  | Impact | Mitigation                                                                                                                             |
| ----------------------------------------------------- | ------ | -------------------------------------------------------------------------------------------------------------------------------------- |
| Route→handler tracing unreliable across frameworks    | High   | T30 spike is a hard gate before any v2 build; go/no-go on text-based approach                                                          |
| SSE long-running analysis hits serverless timeouts    | High   | In-process job model documented as a constraint; if breached, move to a job queue (revisit decision #3) — isolate behind the job store |
| LLM fix suggestions emit wrong-OpenAPI-version syntax | High   | Version threaded into every worker prompt (T11) + validated in the fix applier (T15); version-specific fixtures in tests               |
| Credential leakage to client/logs                     | High   | T9 log-capture test; LLM calls server-only; Zod boundary; no `NEXT_PUBLIC_` for secrets                                                |
| LLM output non-determinism breaks parsing             | Medium | Zod-validated structured output + retry; never `any`                                                                                   |
| Near-duplicate/coherence quality is weak              | Medium | Validate against 20 real specs (design-doc assumption) before trusting auto-suggestions                                                |
| Spectral ruleset version drift (3.0 vs 3.1)           | Medium | Version-parameterized ruleset (T5a/b) with paired 3.0/3.1 fixtures                                                                     |

## Open Questions (confirm before/at the relevant checkpoint)

- **Standalone compiled CLI binary** — deferred to a post-v1 distribution task. Confirm Node/`npx` is acceptable for v1 ops users, or pull the binary forward.
- **Anonymous paste-mode AI** — design says AI needs auth in the web app; confirm anonymous paste stays structural-only (current assumption) vs. allowing server-LLM for paste.
- **Job persistence for anonymous runs** — in-memory (lost on restart) vs. short-TTL SQLite. Current assumption: in-memory.
- **20-real-specs validation** (design-doc key assumption) — schedule before Checkpoint C trust in AI suggestions; who supplies the specs?
