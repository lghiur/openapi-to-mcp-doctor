# OpenAPI MCP Doctor — Claude Code Guide

## What This Project Is

An open source web app + CLI tool that analyzes OpenAPI specs for MCP/LLM-agent usability, suggests fixes grounded in actual implementation code, and helps teams commit improvements via GitHub PRs. Read the full design before touching any code: `docs/ideas/openapi-mcp-doctor.md`.

---

## Stack

| Layer           | Choice                                                     | Notes                                                                                                             |
| --------------- | ---------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| Web framework   | Next.js (App Router)                                       | TypeScript strict mode, no exceptions                                                                             |
| Styling         | Tailwind CSS + shadcn/ui                                   | No CSS modules, no plain CSS                                                                                      |
| State           | React Query (server state) + Zustand (UI state)            | No Redux                                                                                                          |
| Auth            | NextAuth.js with GitHub provider                           | GitHub OAuth only                                                                                                 |
| API transport   | Next.js Route Handlers (`app/api/`)                        | Server Actions for mutations                                                                                      |
| Real-time (v2+) | Server-Sent Events via `app/api/jobs/[id]/stream/route.ts` | Not WebSocket                                                                                                     |
| LLM client      | Vercel AI SDK (`ai` + `@ai-sdk/openai-compatible`)         | Any OpenAI-compatible endpoint; configured via env vars only. `generateObject` + Zod for structured worker output |
| Testing         | Vitest + React Testing Library                             | No Jest                                                                                                           |
| Linting         | ESLint + Prettier                                          | Run before every commit                                                                                           |

---

## Project Structure

```
src/
├── app/                        # Next.js App Router
│   ├── (auth)/                 # Routes requiring GitHub login
│   ├── (public)/               # Unauthenticated routes (paste mode)
│   ├── api/                    # Route Handlers only (webhooks, SSE, public API)
│   ├── layout.tsx
│   └── page.tsx
├── features/                   # Feature-scoped code (components + actions)
│   ├── analyze/                # Spec upload, job creation, polling UI
│   ├── review/                 # Suggestion review, accept/reject/edit
│   ├── settings/               # LLM config (server-side only)
│   └── github/                 # GitHub OAuth, repo connection, PR creation
├── components/ui/              # shadcn/ui components only — no custom components here
├── components/                 # Shared cross-feature components
├── lib/
│   ├── engine/                 # THE CORE LIBRARY — framework-agnostic, used by web + CLI
│   │   ├── linter/             # Structural checks (no LLM, deterministic)
│   │   ├── orchestrator/       # Agent orchestrator
│   │   ├── workers/            # Worker agent implementations
│   │   ├── postprocess/        # Near-duplicate detection, coherence check
│   │   └── cache/              # Sidecar .mcp-doctor.yaml management
│   ├── github/                 # GitHub API client (Octokit)
│   └── llm/                    # LLM client wrapper (OpenAI-compatible)
├── hooks/                      # React hooks
└── types/                      # Shared TypeScript types
cli/                            # CLI wrapper — imports from lib/engine
```

**Rule:** `lib/engine/` must never import from `app/`, `features/`, or `components/`. It is a pure library. The web app and CLI are consumers, not peers.

---

## Component Rules

- **Server Components by default.** Add `'use client'` only when a component uses `useState`, `useEffect`, `useRef`, browser APIs, or event handlers.
- **Named exports only.** No default exports except `page.tsx`, `layout.tsx`, `error.tsx`, `loading.tsx`.
- **No inline styles.** Tailwind classes only.
- **No `any`.** TypeScript strict mode is enforced. If you're typing something as `any`, find the actual type.
- **Server Actions for mutations** (`features/*/actions.ts`). Route Handlers for public-facing endpoints and SSE streams.

---

## Architecture Constraints (non-negotiable)

These come from the design doc. Do not work around them.

**Engine architecture:**

- Structural linter → zero LLM calls, always runs, deterministic
- Orchestrator → fans out worker agents per operation batch (3–5 ops per worker)
- Worker agents → per-operation analysis, handles BOTH description quality AND MCP semantic checks in one LLM call
- Orchestrator post-processing → near-duplicate detection + coherence check, one LLM call, runs after all workers complete
- No dedicated MCP compliance agent. If you're adding a new agent for MCP rules, stop and read the design doc.

**Code as source of truth:**

- When spec and code disagree, the code is correct
- `--mismatch-mode=flag` (default): report the mismatch, never auto-correct
- `--mismatch-mode=fix`: auto-correct per the confidence threshold

**Confidence threshold (applies in fix mode):**

- `high` (default) — apply only HIGH confidence: structural, format, missing-field fixes
- `medium` — apply HIGH + MEDIUM: adds AI description rewrites, disambiguation
- `low` — apply ALL including LOW: includes spec/code mismatches; warn the user prominently
- The threshold controls both the CLI `--confidence-threshold` flag and the web app fix mode selector
- LOW confidence auto-apply must always emit a prominent warning at both CLI and UI level

**Credentials:**

- LLM credentials (`LLM_BASE_URL`, `LLM_API_TOKEN`) are read from env at startup, never stored in DB, never logged, never sent to client
- GitHub tokens are session-scoped OAuth tokens only

**Feature tiers:**

- Structural linting: fully anonymous, no LLM, no auth required
- AI-powered analysis: requires GitHub OAuth in web app; requires env vars in CLI

**Progress UX — SSE from day one:**

- POST `/api/analyze` → returns `{ jobId }` → client immediately opens SSE stream at `GET /api/jobs/[id]/stream`
- SSE stream emits findings as they arrive; client renders them progressively
- No polling. SSE applies in both v1 (spec-only) and v2 (codebase grounding)
- See `docs/research/agentic-architecture.md` for the full SSE event schema

**GitHub integration — Heroku/Vercel-style (primary UX):**

- User clicks "Connect GitHub" → OAuth → sees repo list → selects repo + branch → app is connected
- From there: app reads the OpenAPI spec file from the repo, runs analysis, offers to create a PR with fixes
- Paste mode (no GitHub) is the secondary/fallback path, not the primary
- This mirrors exactly how Heroku's GitHub integration and Vercel's import flow work

**Caching:**

- Sidecar file is `.mcp-doctor.yaml` alongside the spec
- Never modify the OpenAPI spec file to store cache metadata
- Cache key = `hash(spec_file)` + `hash(handler_files)` independently

**Run history:**

- Every analysis run is persisted as a structured `AnalysisRun` record (see idea doc for full schema)
- Web app: SQLite via Prisma — `lib/db/` — no separate DB service needed for self-hosting
- CLI: JSON files in `.mcp-doctor/runs/` — one file per run, keep last 100
- History records are append-only — never mutated after the run completes
- `FindingRecord.resolution` is the only field updated post-run (when user accepts/rejects in web UI)
- CLI commands: `mcp-doctor history`, `mcp-doctor history <run-id>`, `mcp-doctor history <run-id> --json`
- GitHub Actions: write run summary as Job Summary markdown (not stored in repo)

---

## OpenAPI Version Detection (runs before everything else)

1. Parse the spec and read the `openapi` field (3.0.x or 3.1.x)
2. If `swagger: "2.0"` is detected → return `SWAGGER_20_NOT_SUPPORTED` (error), halt, do not proceed
3. If `openapi` field is missing or unparseable → return `OAS_VERSION_UNDETECTABLE` (error), halt
4. Pass the detected version (`'3.0' | '3.1'`) to every downstream component: Spectral ruleset, LLM worker agents, fix generator, auto-fix writer

**Every fix suggestion must be valid for the detected version.** This is a hard constraint:

- `nullable` field fix: 3.0 → `nullable: true`; 3.1 → `type: ["string", "null"]`
- Example syntax: 3.0 → singular `example:`; 3.1 → plural `examples:`
- `$ref` + description: 3.0 → must use `allOf` workaround; 3.1 → sibling `description` on `$ref` is valid
- `exclusiveMinimum`: 3.0 → boolean + `minimum`; 3.1 → numeric value directly

LLM worker agents receive the spec version in their system prompt. They must not generate suggestions using syntax from the wrong version. Full version-compliance reference: `docs/research/openapi-to-mcp-best-practices.md`.

## Linting Engine

**Spectral is the structural linter runtime.** Do not write a custom rule runner.

```
lib/engine/linter/
├── spectral.ts           ← Spectral runner, result normaliser
├── rulesets/
│   ├── openapi-base.ts   ← Spectral's built-in OpenAPI rules (re-exported)
│   └── mcp.ts            ← custom MCP-specific rules (the novel part)
└── types.ts              ← Finding, Severity, Confidence types
```

The custom MCP ruleset (`rulesets/mcp.ts`) is publishable as `@mcp-doctor/spectral-ruleset` — a standalone npm package usable without the full tool. This is a free moat: anyone running Spectral can adopt our MCP rules.

LLM-powered checks (description quality, near-duplicate detection) run **after** Spectral, consuming its output. Spectral = deterministic rules. LLM = judgment calls. They do not overlap.

## MCP Compliance Rules

Full reference: `docs/research/mcp-spec.md`

Quick reference for the Spectral MCP ruleset:

- `mcp-operationid-required` — operationId must be present
- `mcp-operationid-format` — snake_case, ≤ 64 chars, no spaces or special chars. Note: snake_case is a **convention** and ≤64 is a **vendor LLM tool-API limit** (Anthropic/OpenAI), NOT an MCP-spec requirement — MCP's own ceiling is 128 (SEP-986). Attribute findings to "LLM tool-API compatibility," not "the MCP spec."
- `mcp-operationid-unique` — unique across all operations
- `mcp-param-description-required` — every parameter must have description
- `mcp-enum-description-required` — every enum value must have description
- `mcp-response-schema-required` — every 2xx response must have a schema (anchored regex `/^2(\d{2}|XX)$/`; does not match `default` — decide explicitly)
- `mcp-operation-count` — warning at > 40 (grounded: Cursor's hard 40-tool client limit), error at > 80 (heuristic upper bound, not a benchmarked/client cliff — real model ceilings are far higher)

---

## Commands

```bash
npm run dev          # start development server
npm run build        # production build
npm run test         # run Vitest
npm run lint         # ESLint + TypeScript check
npm run typecheck    # tsc --noEmit
```

Always run `npm run typecheck` and `npm run lint` before reporting a task complete.

---

## Environment Variables

```
# Required for LLM features
LLM_BASE_URL=          # any OpenAI-compatible endpoint
LLM_API_TOKEN=         # never logged, never exposed to client

# Required for GitHub features
GITHUB_CLIENT_ID=
GITHUB_CLIENT_SECRET=
NEXTAUTH_SECRET=
NEXTAUTH_URL=
```

---

## What NOT To Do

- Do not add LLM calls to `lib/engine/linter/` — the linter is deterministic, zero cost
- Do not import `lib/engine/` from `app/` or `features/` directly in Server Components that stream — go through an API route or Server Action
- Do not store LLM credentials anywhere except env vars
- Do not use `any` in TypeScript
- Do not default export from files outside of Next.js special files
- Do not add a fourth agent tier — the three-tier model (linter → worker → post-process) is deliberate
- Do not add a polling progress path — SSE is the transport from v1 onward (see "Progress UX — SSE from day one" above); this is a resolved decision
- Do not modify `.mcp-doctor.yaml` schema without updating `lib/engine/cache/` types and the research doc
- Do not add GitLab or Bitbucket support — GitHub only through v3
- Multi-repo is supported — the dashboard shows all analysed repos with health scores. "Multi-repo" does NOT mean analysing multiple specs in a single job; it means the dashboard aggregates across separate per-repo runs.

---

## Research Docs

Read before implementing the relevant component:

- `docs/research/mcp-spec.md` — MCP protocol rules, tool naming, input schema requirements
- `docs/research/openapi-to-mcp-best-practices.md` — how OpenAPI fields map to MCP tool definitions
- `docs/research/agentic-architecture.md` — orchestrator/worker pattern, confidence scoring, SSE event schema
- `docs/research/nextjs-conventions.md` — Next.js App Router patterns, Server vs Client components, project conventions

## Design Doc

`docs/ideas/openapi-mcp-doctor.md` — the full product design. All architecture decisions originate here. When in doubt, read it.
