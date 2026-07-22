# OpenAPI MCP Doctor — User Manual

Analyze OpenAPI specs for **MCP / LLM-agent usability**: structural linting (zero
LLM, always on), AI-powered description and MCP-semantic review, version-aware
fixes, and GitHub PRs.

There are two ways to use it:

1. **Web app** — paste a spec or connect a GitHub repo, watch findings stream in
   live, accept fixes, download a patched spec (or open a PR).
2. **CLI** — `mcp-doctor scan spec.yaml` for local use and CI.

---

## 0. Prerequisites (read this first)

- **Node.js ≥ 20.19** — this project is built and tested on **Node 22**. The
  latest toolchain (Vitest 4, Tailwind v4) will not run on older Node.

  ```bash
  # with nvm (the repo ships an .nvmrc pinned to 22):
  nvm use            # or: nvm install 22 && nvm use 22
  node -v            # should print v22.x
  ```

- **Install dependencies** (once):

  ```bash
  npm install
  ```

> If you installed dependencies under an older Node, reinstall under Node 22:
> `rm -rf node_modules package-lock.json && npm install`

### Environment variables

Create a `.env.local` file in the project root (all are optional — the app and
CLI work with none of them, running **structural checks only**):

```bash
# --- AI-powered analysis (any OpenAI-compatible endpoint) ---
LLM_BASE_URL=https://api.openai.com/v1     # or your gateway / Azure / Ollama / Bedrock
LLM_API_TOKEN=sk-...                       # never logged, never sent to the browser
LLM_MODEL=gpt-4o-mini                      # optional; this is the default
LLM_TIMEOUT_MS=120000                      # optional; per-request ceiling on LLM calls

# --- GitHub integration (web app only) ---
GITHUB_CLIENT_ID=...                       # from a GitHub OAuth App
GITHUB_CLIENT_SECRET=...
NEXTAUTH_SECRET=...                        # any long random string
NEXTAUTH_URL=http://localhost:3000

# --- Web run history (optional) ---
MCP_DOCTOR_DB=.mcp-doctor/web.db           # SQLite file path (this is the default)
```

- **No LLM vars** → structural linting only (still very useful, fully anonymous).
- **No GitHub vars** → the web app's paste mode works; the GitHub dashboard / PR
  features are disabled.

---

## 1. Starting the web app

### Development

```bash
npm run dev
```

Open **http://localhost:3000**.

### Production

```bash
npm run build
npm run start        # serves the production build on http://localhost:3000
```

### What you can do in the browser

| Page                | URL                 | Requires     | What it does                                                                                                                                   |
| ------------------- | ------------------- | ------------ | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| **Paste & analyze** | `/`                 | nothing      | Paste an OpenAPI 3.0/3.1 spec → **Run structural analysis**                                                                                    |
| **Live analysis**   | `/analysis/<jobId>` | nothing      | Three panels: operations, agents, and a suggestion queue. Findings stream in over SSE. Accept/reject suggestions and **Download patched spec** |
| **Dashboard**       | `/dashboard`        | GitHub login | List your repos; pick a branch + spec path and analyze it                                                                                      |
| **History**         | `/history`          | GitHub login | Past runs; click a run for full detail                                                                                                         |
| **Settings**        | `/settings`         | GitHub login | LLM status (token never shown), GitHub connection, defaults                                                                                    |

### Typical web flow

1. Go to `/` and paste a spec (YAML or JSON).
2. Click **Run structural analysis**. You're taken to `/analysis/<jobId>`.
3. Findings appear live, grouped by severity. LOW-confidence items (e.g. spec/code
   mismatches) carry a ⚠ warning — review before accepting.
4. Click **Accept** on the suggestions you want, then **Download patched spec**.

> **AI vs. structural:** anonymous paste mode always runs the deterministic
> structural linter. AI-powered description/MCP-semantic review runs when
> `LLM_BASE_URL` and `LLM_API_TOKEN` are set in the server environment.

> **GitHub connect (Heroku/Vercel-style):** with the `GITHUB_*` and `NEXTAUTH_*`
> vars set, **Connect GitHub** → pick a repo + branch + spec path → analyze →
> optionally open a fix PR. Your GitHub token is session-scoped and never sent to
> the browser.

---

## 2. Using the CLI

The CLI runs through `tsx` (no separate build needed). Invoke it with the `cli`
npm script and pass arguments after `--`:

```bash
npm run cli -- <command> [options]
```

> Tip: for shorter commands, alias it in your shell:
>
> ```bash
> alias mcp-doctor="node --import tsx $(pwd)/cli/index.ts"
> mcp-doctor scan api/openapi.yaml
> ```

Built-in help:

```bash
npm run cli -- --help
npm run cli -- --version
```

### 2.1 `scan` — analyze a spec

```bash
npm run cli -- scan path/to/openapi.yaml
```

Example output (human-readable, colored):

```
mcp-doctor — api/openapi.yaml (OpenAPI 3.0, MCP 2025-11-25)

Health score: 8/100
19 findings: 5 errors, 14 warnings, 0 info

Errors
  ✖ mcp-operationid-format  GET /users/{id}
     operationId should be snake_case and ≤ 64 characters for LLM tool-API compatibility …
  ...
```

**Scan options**

| Flag                                         | Description                                                                  |
| -------------------------------------------- | ---------------------------------------------------------------------------- |
| `--json`                                     | Print the machine-readable JSON report to stdout instead of the human report |
| `--report <path>`                            | Write the JSON report to a file                                              |
| `--no-color`                                 | Disable ANSI colors (also auto-disabled when piped)                          |
| `--mcp-version <v>`                          | MCP spec version to target (default `2025-11-25`)                            |
| `--verbose`                                  | Show all findings and agent progress                                         |
| `--mode <lint\|fix>`                         | `lint` (default) reports; `fix` applies eligible fixes                       |
| `--confidence-threshold <high\|medium\|low>` | Which fixes `--mode=fix` applies (default `high`)                            |
| `--output <path>`                            | Where to write the patched spec in fix mode                                  |
| `--route-paths <a,b,c>`                      | **v2**: comma-separated handler files for codebase grounding (needs LLM)     |
| `--mismatch-mode <flag\|fix>`                | **v2**: how to treat spec/code mismatches (default `flag`)                   |
| `--no-cache`                                 | Skip the `.mcp-doctor.yaml` sidecar cache next to the spec                   |
| `--no-history`                               | Do not record this run under `.mcp-doctor/runs`                              |

Enum-valued flags (`--mode`, `--confidence-threshold`, `--mismatch-mode`) are
validated: an unknown value exits `3` with an error instead of being silently
coerced to a default. `--json` and `--report` also work in fix mode — they emit
the post-fix report (applied fixes appear as `autoFixed: true` findings, and
`summary.autoFixed` counts them); the human fix summary moves to stderr under
`--json`.

**Examples**

```bash
# Structural report to a file (great for CI artifacts)
npm run cli -- scan api/openapi.yaml --report report.json

# Pipe JSON to jq
npm run cli -- scan api/openapi.yaml --json | jq '.summary'

# Apply only HIGH-confidence fixes and write the patched spec
npm run cli -- scan api/openapi.yaml --mode fix --output api/openapi.fixed.yaml

# Aggressive fixes (applies LOW-confidence too — prints a prominent warning)
npm run cli -- scan api/openapi.yaml --mode fix --confidence-threshold low --output out.yaml

# v2: ground findings against Go/Express handlers (needs LLM_BASE_URL + LLM_API_TOKEN)
npm run cli -- scan api/openapi.yaml --route-paths internal/api/routes.go,handlers/users.go
```

**AI mode:** when `LLM_BASE_URL` and `LLM_API_TOKEN` are set, `scan` adds
description-quality and MCP-semantic findings and shows per-worker progress on
stderr. Without them, it prints a hint and runs structural-only.

**Exit codes** (stable contract — safe for CI):

| Code | Meaning                                                                               |
| ---- | ------------------------------------------------------------------------------------- |
| `0`  | No ERROR-severity findings (warnings allowed), or fix mode applied successfully       |
| `1`  | One or more ERROR-severity findings                                                   |
| `2`  | Analysis failed (spec unreadable, unsupported/undetectable version, e.g. Swagger 2.0) |
| `3`  | Invalid arguments or configuration (incl. unknown flag values and unwritable `--report`/`--output` paths) |

On exit `2` the failure reason is printed to stdout (stable machine contract);
under `--json` it is additionally mirrored to stderr so pipelines parsing
stdout still surface the error.

### 2.2 `history` — past runs

Every lint scan is recorded under `.mcp-doctor/runs/` in the current directory
by default (last 100 runs kept; opt out with `scan --no-history`).

```bash
npm run cli -- history                 # list recent runs
npm run cli -- history <run-id>        # detailed view of one run
npm run cli -- history <run-id> --json # machine-readable
```

### 2.3 `diff` — compare runs

```bash
npm run cli -- diff <run-id>           # compares a run to the previous run of the same spec
```

---

## 3. GitHub Action (CI)

On pull requests the action acts as an autonomous spec reviewer with a
cumulative `behavior` ladder; on other events it runs a plain scan with a Job
Summary. All PR-visible output is **delta-gated**: only findings the PR
introduced appear as annotations/comments — pre-existing debt stays in the Job
Summary. See `.github/workflows/mcp-doctor-example.yml` for a copy-paste
workflow.

| Level     | Adds                                                  | Permissions needed       |
| --------- | ----------------------------------------------------- | ------------------------ |
| `summary` | Job Summary + workflow annotations + `fail-on` gate   | `contents: read`         |
| `comment` | Sticky PR comment (updated in place), delta-gated     | + `pull-requests: write` |
| `review`  | Inline review comments on spec + handler lines        | + `pull-requests: write` |
| `fix-pr`  | Stacked PR with the patched spec, re-pointed on close | + `contents: write`      |

Trigger with `types: [opened, synchronize, reopened, closed]` (the `closed`
event drives the fix-PR lifecycle) and check out with `fetch-depth: 0` so the
base branch is available for delta gating. Fork PRs degrade to `summary`.

### Inputs

| Input                            | Values                                      | Default                                    |
| -------------------------------- | ------------------------------------------- | ------------------------------------------ |
| `behavior`                       | `summary` / `comment` / `review` / `fix-pr` | `comment`                                  |
| `spec`                           | path, or omit → auto-detect                 | auto                                       |
| `route-paths`                    | csv, or omit → auto-discover                | auto                                       |
| `github-token`                   | token for PR comments/reviews/fix PRs       | `${{ github.token }}`                      |
| `fail-on`                        | `error` / `warning` / `never`               | `never` on PRs (delta-gated), else `error` |
| `confidence-threshold`           | `high` / `medium` / `low`                   | `high` (`low` warns prominently)           |
| `mismatch-mode`                  | `flag` / `fix`                              | `flag`                                     |
| `fix-scope`                      | `pr` — fix only operations with findings introduced by this PR / `full` — fix the whole spec's debt | `pr` |
| `llm-base-url` / `llm-api-token` | secrets; absent → lint-only tier            | —                                          |
| `llm-model`                      | model name sent to the LLM endpoint         | endpoint default                           |
| `mcp-version`                    | MCP spec version                            | `2025-11-25`                               |

---

## 4. Handy project commands

```bash
npm run dev          # start the web app (dev)
npm run build        # production build
npm run start        # serve the production build
npm run cli -- ...   # run the CLI (see section 2)
npm test             # run the test suite (Vitest)
npm run lint         # ESLint
npm run typecheck    # tsc --noEmit
npm run dogfood      # run the engine on our own openapi.yaml + fixtures (CI health gate)
```

---

## 5. Troubleshooting

| Symptom                                                     | Fix                                                                                                              |
| ----------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| `Cannot find module './rolldown-binding…'` or native errors | You're on Node < 20.19. Run `nvm use 22`, then reinstall: `rm -rf node_modules package-lock.json && npm install` |
| `scan` says "AI analysis not enabled"                       | Set `LLM_BASE_URL` and `LLM_API_TOKEN` in your environment / `.env.local`                                        |
| Web GitHub features missing                                 | Set `GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET`, `NEXTAUTH_SECRET`, `NEXTAUTH_URL` and restart `npm run dev`      |
| `scan` exits 2 on a valid-looking file                      | The spec must be OpenAPI **3.0** or **3.1**. Swagger 2.0 is not supported — convert it first                     |
| Exit code 1 in CI but you only have warnings                | Exit 1 means **ERROR**-severity findings. Use the Action's `fail-on: warning`/`never`, or fix the errors         |
