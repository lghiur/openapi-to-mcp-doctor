# OpenAPI MCP Doctor

[![MCP health](https://img.shields.io/endpoint?url=https%3A%2F%2Fraw.githubusercontent.com%2FTykTechnologies%2Fopenapi-to-mcp-doctor%2Fmain%2Fbadges%2Fhealth.json)](./openapi.yaml)

Analyze OpenAPI specs for **MCP/LLM-agent usability**, get fixes grounded in your actual
implementation code, and commit the improvements as a GitHub PR.

Your OpenAPI spec was written for humans and SDK generators. When it becomes an MCP tool set,
LLM agents read it cold: vague descriptions, missing `operationId`s, undescribed enums, and
near-duplicate operations all degrade tool selection. MCP Doctor finds those problems, explains
them, and fixes them — and (v2) reads your route handlers to catch places where the spec and the
code disagree.

> We run MCP Doctor on MCP Doctor: the badge above is the live health score of this app's own
> [`openapi.yaml`](./openapi.yaml), enforced by a CI gate that fails on regressions.

## How it works

```
OpenAPI spec ──▶ ① Structural linter (Spectral + MCP ruleset — deterministic, zero LLM)
             ──▶ ② Worker agents (per-operation description & MCP-semantic analysis)
             ──▶ ③ Post-processing (near-duplicate detection, tool-set coherence)
             ──▶ ④ Codebase grounding (v2 — reads handlers, flags spec/code mismatches)
```

- **Code is the source of truth.** When spec and code disagree, the mismatch is reported
  (`--mismatch-mode=flag`, default) or the spec is corrected (`--mismatch-mode=fix`).
- **Confidence-gated fixes.** `high` applies only structural/format fixes; `medium` adds AI
  description rewrites; `low` applies everything including mismatches — with a prominent warning.
- **Version-aware.** Detects OpenAPI 3.0 vs 3.1 (Swagger 2.0 is rejected) and every suggested
  fix uses the correct syntax for the detected version.

## Web app

The primary flow mirrors Vercel/Heroku's GitHub integration:

1. **Connect GitHub** → pick a repo, branch, and spec path.
2. **Choose operations** — select the paths/methods to analyse (all selected by default).
3. Watch the analysis stream live (SSE) in a three-panel view: operations, agent activity, findings.
4. Accept / edit / reject each suggestion, then **download the patched spec** or **create a fix PR**.

Paste mode works without signing in (structural checks only). Every authenticated run lands in
**History** with per-finding resolutions and the PR it produced.

```bash
npm install
npm run dev          # http://localhost:3000
```

Environment:

```bash
# AI analysis (any OpenAI-compatible endpoint)
LLM_BASE_URL=…
LLM_API_TOKEN=…      # never logged, never sent to the client
LLM_MODEL=…          # optional

# GitHub OAuth
GITHUB_CLIENT_ID=…
GITHUB_CLIENT_SECRET=…
NEXTAUTH_SECRET=…
NEXTAUTH_URL=http://localhost:3000
```

## CLI

```bash
npm run cli -- scan api/openapi.yaml                     # structural lint (no LLM needed)
npm run cli -- scan api/openapi.yaml --json              # machine-readable report
npm run cli -- scan api/openapi.yaml --mode=fix \
  --confidence-threshold=medium --output patched.yaml    # apply fixes
npm run cli -- scan api/openapi.yaml \
  --route-paths internal/routes.go,internal/handlers.go  # v2: ground against code
npm run cli -- history                                   # past runs (.mcp-doctor/runs)
npm run cli -- diff <run-id>                             # compare to the previous run
```

Scans reuse the `.mcp-doctor.yaml` sidecar cache next to the spec (gitignore it): an unchanged
spec re-runs nothing, a spec-only change reuses code grounding, and a handler-only change
re-runs just the affected operations. `--no-cache` disables it. Exit codes: `0` clean/fixed,
`1` error findings, `2` analysis failed, `3` bad arguments.

## GitHub Action

On pull requests the action is an autonomous spec reviewer with a cumulative
`behavior` ladder — `summary` (Job Summary + annotations) → `comment` (sticky
delta-gated PR comment) → `review` (inline comments on spec and handler lines)
→ `fix-pr` (idempotent stacked PR carrying the patched spec). All PR-visible
output is delta-gated against a base-branch scan; fork PRs degrade to `summary`.

```yaml
on:
  pull_request:
    types: [opened, synchronize, reopened, closed] # closed → fix-PR lifecycle
permissions:
  contents: read # fix-pr needs contents: write
  pull-requests: write # comment / review / fix-pr
jobs:
  mcp-doctor:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with: { fetch-depth: 0 } # base branch needed for delta gating
      # Current home (planned eventual home: TykTechnologies/openapi-to-mcp-doctor)
      - uses: lghiur/openapi-to-mcp-doctor@master
        with:
          behavior: comment # summary | comment | review | fix-pr
          # spec / route-paths auto-detected when omitted
          llm-base-url: ${{ secrets.LLM_BASE_URL }}
          llm-api-token: ${{ secrets.LLM_API_TOKEN }}
```

On non-PR events (push, workflow_dispatch) it runs a plain scan: Job Summary
plus a `fail-on` gate (default `error`; PR runs default to `never`, gating only
findings the PR introduced). See `MANUAL.md` for the full inputs table.

## Development

```bash
npm run test         # Vitest (engine, CLI, web — 350+ tests)
npm run typecheck    # tsc --noEmit (strict)
npm run lint         # ESLint
npm run dogfood      # self-spec + golden corpus health gate (also refreshes badges/health.json)
```

The analysis engine lives in `src/lib/engine/` — a pure, framework-agnostic library consumed by
the web app, the CLI, and the Action. Architecture and product decisions are documented in
[`docs/ideas/openapi-mcp-doctor.md`](./docs/ideas/openapi-mcp-doctor.md) and
[`docs/plans/implementation-plan.md`](./docs/plans/implementation-plan.md).
