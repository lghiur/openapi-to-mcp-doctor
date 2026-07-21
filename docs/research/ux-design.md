# UX Design — Web App & CLI

OpenAPI MCP Doctor — high-fidelity interaction design reference.
This document is the implementation contract for all UI and CLI work.

---

## Web App

### Information Architecture

```
/                           Public landing + paste mode (no auth required)
/connect                    GitHub OAuth entry point
/dashboard                  Repo overview (requires auth)
/analysis/[jobId]           Live analysis view
/analysis/[jobId]/review    Post-analysis suggestion review (same page, different state)
/history                    All past runs
/history/[runId]            Single run detail
/settings                   LLM config, GitHub connection, preferences
```

Route groups:

- `(public)` — `/`, no auth gate
- `(auth)` — everything else, redirects to `/` with `?next=` if unauthenticated

---

### Page: Landing (`/`)

Two distinct states depending on auth.

**Unauthenticated state:**

```
┌─────────────────────────────────────────────────────────────────┐
│  ⚕ MCP Doctor                                      Connect GitHub│
├─────────────────────────────────────────────────────────────────┤
│                                                                  │
│         Is your OpenAPI spec ready for MCP?                      │
│   Diagnose and fix it before your AI agents hallucinate.         │
│                                                                  │
│   ┌─────────────────────────────────────────────────────────┐   │
│   │  Connect GitHub to analyse your repo                 →  │   │
│   └─────────────────────────────────────────────────────────┘   │
│                                                                  │
│   Or paste a spec to get a free structural report:               │
│   ┌─────────────────────────────────────────────────────────┐   │
│   │                                                         │   │
│   │   Paste or drop your OpenAPI 3.x spec here (YAML/JSON) │   │
│   │                                                         │   │
│   └─────────────────────────────────────────────────────────┘   │
│   [ Run structural analysis ]   No account needed               │
│                                                                  │
│   ✓ Checks operationId format      ✓ Validates descriptions      │
│   ✓ Finds missing examples         ✓ MCP tool count thresholds   │
│   ✓ Detects enum gaps              ✓ Spots near-duplicate tools  │
│                                                                  │
└─────────────────────────────────────────────────────────────────┘
```

Key decisions:

- Primary CTA is GitHub connection, not paste. Paste is explicitly secondary.
- Feature bullets are concrete checks, not vague promises.
- "No account needed" is explicit — removes hesitation for paste mode.
- AI-powered features (description rewrites, near-duplicate detection) are not shown until GitHub is connected.

**Authenticated state (no repo connected yet):**
Redirect to `/dashboard` which shows the repo selector.

---

### Page: Dashboard — Multi-Repo Overview (`/dashboard`)

**Multiple repos are supported.** The user can analyse as many repos as they want and see all of them on the dashboard. This is the SonarCloud / Vercel project list model — one organisation, many services, a health score for each.

Mirrors Vercel's import flow and Heroku's GitHub integration. The user arrives here after OAuth and sees their repos.

```
┌─────────────────────────────────────────────────────────────────┐
│  ⚕ MCP Doctor          History   Settings       @laurentiu  ▼  │
├─────────────────────────────────────────────────────────────────┤
│                                                                  │
│  Select a repository to analyse                                  │
│                                                                  │
│  ┌─────────────────────────────────────────────┐                │
│  │ 🔍 Search repositories...                   │                │
│  └─────────────────────────────────────────────┘                │
│                                                                  │
│  ┌─────────────────────────────────────────────────────────┐    │
│  │ TykTechnologies / tyk                  Go  ★ 9.2k   →  │    │
│  ├─────────────────────────────────────────────────────────┤    │
│  │ TykTechnologies / tyk-gateway          Go  ★ 1.4k   →  │    │
│  ├─────────────────────────────────────────────────────────┤    │
│  │ my-org / user-service                  Go  ★ 12     →  │    │
│  ├─────────────────────────────────────────────────────────┤    │
│  │ my-org / orders-api               TypeScript  ★ 3   →  │    │
│  └─────────────────────────────────────────────────────────┘    │
│                                          Load more               │
│                                                                  │
│  Your connected repos:                                           │
│  ─────────────────────                                           │
│  TykTechnologies/tyk-gateway  ✓ 9 fixed  ⚠ 2 open  2h ago  →   │
│  my-org/user-service          ✓ clean  4d ago                →   │
│  my-org/orders-api            ● Not yet analysed              →   │
│                                                                  │
└─────────────────────────────────────────────────────────────────┘
```

**Connected repos section (replaces "recently analysed"):**

- Shows every repo that has been analysed at least once, with its most recent run status
- Health status at a glance: ✓ clean / ⚠ N open findings / ● never run
- Clicking a row navigates to that repo's analysis config (same inline panel)
- "Not yet analysed" repos are shown for repos that were connected but never run
- New repos discovered from GitHub appear in the "Select a repository" list above and move to "connected repos" after first analysis

After clicking a repo, an inline configuration panel expands (no page navigation):

```
┌─────────────────────────────────────────────────────────────────┐
│  TykTechnologies / tyk-gateway                              ✕   │
├─────────────────────────────────────────────────────────────────┤
│                                                                  │
│  Branch          [ main ▼ ]                                      │
│                                                                  │
│  OpenAPI spec    [ api/openapi.yaml              ] Browse        │
│  (path in repo)                                                  │
│                                                                  │
│  Route files     [ internal/api/routes/,handlers/ ] (optional)   │
│  (v2 codebase    Leave blank for spec-only analysis              │
│   grounding)                                                     │
│                                                                  │
│  Analysis mode   ● Lint (report only — no auto-fixes)           │
│                  ○ Fix — Conservative                            │
│                    Apply HIGH confidence only (safe)             │
│                    Format corrections, missing fields            │
│                  ○ Fix — Standard                                │
│                    Apply HIGH + MEDIUM confidence                │
│                    Includes AI description rewrites              │
│                  ○ Fix — Aggressive ⚠                           │
│                    Apply all, including LOW confidence           │
│                    May contain errors. Review before committing. │
│                                                                  │
│  Mismatch mode   ● Flag (show mismatches, require review)        │
│  (requires       ○ Fix  (auto-correct per confidence threshold)  │
│   route files)                                                   │
│                                                                  │
│  Output          ● Review & download (no PR)                     │
│                  ○ Create PR after review                        │
│                                                                  │
│  ─────────────────────────────────────────────────────────────  │
│  LLM config      ✓ Configured (via server settings)             │
│                  AI-powered analysis enabled                     │
│                                                                  │
│  [ Start Analysis ]                          Cancel              │
│                                                                  │
└─────────────────────────────────────────────────────────────────┘
```

UX notes:

- Branch defaults to the repo's default branch.
- Spec path: typing autocompletes from the repo's file tree (fetched from GitHub API).
- Route files: clearly marked optional, with an explanatory subtitle.
- Mismatch mode is greyed out and shows a tooltip ("Requires route files") when route files field is empty.
- "Fix — Aggressive" shows an inline warning banner in the suggestion review queue.
- "Output: Review & download" is the default — PR creation is opt-in, not the default.
- LLM config status is visible inline — if not configured, a warning shows here with a link to Settings.

---

### Page: Analysis View (`/analysis/[jobId]`)

This is the centrepiece of the app. Three panels, live SSE stream.

```
┌─────────────────────────────────────────────────────────────────────────────────┐
│  ⚕ MCP Doctor          History   Settings                        @laurentiu ▼  │
├─────────────────────────────────────────────────────────────────────────────────┤
│  TykTechnologies/tyk-gateway · main · api/openapi.yaml    ● Analysing  12s     │
├──────────────────┬──────────────────────────────┬───────────────────────────────┤
│  OPERATIONS      │  AGENT ACTIVITY               │  SUGGESTIONS                  │
│  ─────────────── │  ──────────────────────────── │  ─────────────────────────── │
│                  │                               │                               │
│  ● 24 total      │  ✓ Structural linter    0.1s  │  3 errors · 8 warnings        │
│  ✓ 6 clean       │    3 findings (auto-fixed)    │  Accept all  Reject all       │
│  ⚠ 12 findings   │                               │                               │
│  ○ 6 pending     │  ⟳ worker-1           4.2s   │  ┌───────────────────────┐   │
│                  │    GET /users                 │  │ GET /users/{id}       │   │
│  ─────────────── │    POST /users                │  │ ⚠ warning · MEDIUM    │   │
│                  │    ✓ GET /users done           │  │ MCP_NO_WHEN_TO_USE    │   │
│  GET /users      │    ⟳ POST /users...           │  │                       │   │
│    ⚠ 2 findings  │                               │  │ Before:               │   │
│                  │  ⟳ worker-2           3.8s   │  │ "Returns a list of    │   │
│  POST /users     │    GET /orders/{id}           │  │  users"               │   │
│    ○ pending     │    ✓ Reads handlers/users.go  │  │                       │   │
│                  │    ✓ Reads svc/users.go        │  │ After:                │   │
│  GET /orders/{id}│    ⟳ Analysing mismatch...    │  │ "Returns a paginated  │   │
│    ⚠ 3 findings  │                               │  │  list of all users.   │   │
│                  │  ○ worker-3           waiting  │  │  Use this for browse/ │   │
│  POST /orders    │    POST /orders               │  │  listing. Use         │   │
│    ○ pending     │    DELETE /orders             │  │  search_users when    │   │
│                  │                               │  │  filtering by attr."  │   │
│  DELETE /orders  │  ○ orchestrator       waiting  │  │                       │   │
│    ○ pending     │    near-duplicate check        │  │ [ ✓ Accept ]  [ ✕ ]  │   │
│                  │                               │  │ [ ✎ Edit ]            │   │
│  GET /health     │                               │  └───────────────────────┘   │
│    ✓ clean       │                               │                               │
│                  │                               │  ┌───────────────────────┐   │
│  ·····           │                               │  │ GET /users/{id}       │   │
│                  │                               │  │ ● error · HIGH        │   │
│                  │                               │  │ MCP_OPERATIONID_FORMAT│   │
│                  │                               │  │ "getUser" →           │   │
│                  │                               │  │ "get_user"            │   │
│                  │                               │  │ [auto-fixed]          │   │
│                  │                               │  └───────────────────────┘   │
├──────────────────┴──────────────────────────────┴───────────────────────────────┤
│  9 accepted · 2 rejected · 4 pending          [ Create PR ]   [ Download spec ] │
└─────────────────────────────────────────────────────────────────────────────────┘
```

**Left panel — Operations list:**

- Sorted by: findings count (most issues first), then alphabetically
- Status icons: ● (pending/not yet analysed), ⟳ (analysing), ⚠ (has findings), ✓ (clean or all accepted), ✕ (error)
- Clicking an operation scrolls the right panel to that operation's suggestions
- Active operation is highlighted

**Centre panel — Agent activity feed:**

- Scrolls automatically as new events arrive (auto-scroll pauses if user scrolls up manually)
- Each agent line is expandable: click to see full file list read, raw findings before LLM rewrites
- Timing shown next to each agent
- Completed agents show a checkmark and collapse to a single summary line
- Pending agents shown in muted colour with "waiting" state
- Auto-fixed findings shown inline with a distinct badge

**Right panel — Suggestion review queue:**

- Each suggestion card shows: operation, rule ID, severity badge (colour-coded), confidence badge
- Before/after diff — not a full diff view, just the relevant field value (description, parameter description, etc.)
- Three actions per suggestion: Accept, Reject, Edit
- "Edit" opens the "after" text in an inline textarea — user modifies and confirms
- Auto-fixed findings shown collapsed with "auto-fixed" badge — user can expand and undo
- Empty state when all reviewed: "All suggestions reviewed. Ready to commit."

**Bottom bar:**

- Running count of accepted / rejected / pending
- "Create PR" — enabled only when at least 1 suggestion is accepted or auto-fixed
- "Download spec" — always available, downloads current state of spec with accepted changes applied
- Shows job status: ● Analysing / ✓ Complete / ✕ Error

**After analysis completes:**
Centre panel shows a summary card at the top:

```
✓ Analysis complete — 12.4s
  14 findings  ·  3 errors  ·  8 warnings  ·  3 info
  9 auto-fixed (HIGH confidence)  ·  5 require review
```

---

### Suggestion Card — Detailed States

**Standard suggestion (pending):**

```
┌─────────────────────────────────────────────────┐
│ GET /users/{id}                          ⚠ warn  │
│ MCP_NO_WHEN_TO_USE                     ● MEDIUM  │
├─────────────────────────────────────────────────┤
│ Before                                           │
│ ──────                                           │
│   description: "Returns user by ID"              │
│                                                  │
│ After (suggested)                                │
│ ─────────────────                                │
│   description: "Returns the full user profile   │
│   for a given user ID. Use this when you have   │
│   a specific user ID. Use search_users when     │
│   filtering by email or name."                  │
├─────────────────────────────────────────────────┤
│ [ ✓ Accept ]   [ ✎ Edit ]   [ ✕ Reject ]        │
└─────────────────────────────────────────────────┘
```

**Suggestion being edited:**

```
┌─────────────────────────────────────────────────┐
│ GET /users/{id}                          ⚠ warn  │
│ MCP_NO_WHEN_TO_USE                     ● MEDIUM  │
├─────────────────────────────────────────────────┤
│ Edit suggestion:                                 │
│ ┌───────────────────────────────────────────┐   │
│ │ Returns the full user profile for a given │   │
│ │ user ID. Use this when you have a specific│   │
│ │ ID and need complete profile data. For    │   │
│ │ search by email or name, use search_users.│   │
│ └───────────────────────────────────────────┘   │
│                 [ Confirm edit ]   [ Cancel ]    │
└─────────────────────────────────────────────────┘
```

**Auto-fixed suggestion (collapsed by default):**

```
┌─────────────────────────────────────────────────┐
│ GET /users/{id}                        ● error   │
│ MCP_OPERATIONID_FORMAT               ✓ auto-fixed│
│ "getUser" → "get_user"       [ ↩ Undo ]          │
└─────────────────────────────────────────────────┘
```

**Spec/code mismatch card (always LOW confidence, never auto-fixed):**

```
┌─────────────────────────────────────────────────┐
│ GET /users/{id}                        ● error   │
│ SPEC_CODE_MISMATCH                      ▲ LOW    │
├─────────────────────────────────────────────────┤
│ Spec claims:                                     │
│   responses.200: Returns user object             │
│                                                  │
│ Code does:                                       │
│   Returns 204 No Content on success              │
│   (handlers/users.go:47)                        │
│                                                  │
│ ⚠ Confirm the code is correct before accepting. │
│   This may be a bug in the implementation.      │
├─────────────────────────────────────────────────┤
│ Suggested fix:                                   │
│   responses.200: Remove schema                  │
│   responses.204: Add (no content)               │
├─────────────────────────────────────────────────┤
│ [ ✓ Accept — fix spec ]   [ ✕ Reject — keep spec]│
└─────────────────────────────────────────────────┘
```

---

### Create PR Flow

Triggered by "Create PR" button in the bottom bar. Opens a panel (not a new page):

```
┌─────────────────────────────────────────────────┐
│  Create pull request                          ✕  │
├─────────────────────────────────────────────────┤
│  Repository   TykTechnologies/tyk-gateway         │
│  Base branch  main                               │
│  New branch   mcp-doctor/patch-2026-06-24  (auto)│
│                                                  │
│  PR title                                        │
│  ┌─────────────────────────────────────────┐    │
│  │ fix: improve OpenAPI spec for MCP       │    │
│  └─────────────────────────────────────────┘    │
│                                                  │
│  Summary                                         │
│  ┌─────────────────────────────────────────┐    │
│  │ MCP Doctor found 14 issues:             │    │
│  │ • 9 accepted (7 AI-suggested, 2 edited) │    │
│  │ • 3 auto-fixed (HIGH confidence)        │    │
│  │ • 2 rejected                            │    │
│  │                                         │    │
│  │ Key changes:                            │    │
│  │ - 6 operationId descriptions improved   │    │
│  │ - 3 operationId formats normalised      │    │
│  │ - 2 near-duplicate operations disambig. │    │
│  └─────────────────────────────────────────┘    │
│  (auto-generated, editable)                      │
│                                                  │
│  [ ✓ Create PR ]                     Cancel      │
└─────────────────────────────────────────────────┘
```

After PR created:

```
┌─────────────────────────────────────────────────┐
│  ✓ Pull request created                          │
│                                                  │
│  #42 fix: improve OpenAPI spec for MCP           │
│  TykTechnologies/tyk-gateway                     │
│                                                  │
│  [ View PR ↗ ]              [ Back to Dashboard ]│
└─────────────────────────────────────────────────┘
```

---

### Page: History (`/history`)

```
┌─────────────────────────────────────────────────────────────────────────────────┐
│  ⚕ MCP Doctor          History   Settings                        @laurentiu ▼  │
├─────────────────────────────────────────────────────────────────────────────────┤
│  Analysis History                                                                │
│                                                                                  │
│  Filter: [ All repos ▼ ]  [ All statuses ▼ ]  [ Last 30 days ▼ ]               │
│                                                                                  │
│  ┌───────────────────────────────────────────────────────────────────────────┐  │
│  │  #12  TykTechnologies/tyk-gateway · main                                  │  │
│  │       api/openapi.yaml · 24 Jun 2026 14:23 · 12.4s                       │  │
│  │       ✓ 9 fixed  ·  ⚠ 2 pending  ·  14 total findings   PR #42 ↗         │  │
│  ├───────────────────────────────────────────────────────────────────────────┤  │
│  │  #11  TykTechnologies/tyk-gateway · main                                  │  │
│  │       api/openapi.yaml · 23 Jun 2026 09:11 · 8.2s                        │  │
│  │       ⚠ 8 issues  ·  0 fixed  ·  No PR created                           │  │
│  ├───────────────────────────────────────────────────────────────────────────┤  │
│  │  #10  my-org/user-service · main                                          │  │
│  │       openapi.yaml · 22 Jun 2026 16:44 · 5.1s                            │  │
│  │       ✓ 3 fixed  ·  PR #38 ↗                                             │  │
│  └───────────────────────────────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────────────────────────────┘
```

---

### Page: Run Detail (`/history/[runId]`)

```
┌─────────────────────────────────────────────────────────────────────────────────┐
│  ⚕ MCP Doctor     ← History     History   Settings              @laurentiu ▼  │
├─────────────────────────────────────────────────────────────────────────────────┤
│  Run #12  ·  24 Jun 2026 14:23  ·  12.4s                          PR #42 ↗     │
│  TykTechnologies/tyk-gateway  ·  main  ·  api/openapi.yaml                     │
│  Mode: lint  ·  Mismatch: flag  ·  MCP spec: 2025-11-25                        │
├─────────────────────────────────────────────────────────────────────────────────┤
│                                                                                  │
│  Agent Timeline                                                                  │
│  ─────────────                                                                   │
│  structural-linter  ████░░░░░░░░░░░░░░░░░░░░░░░░  0.1s   3 findings            │
│  worker-1           ░░░░████████████░░░░░░░░░░░░  4.2s   2 findings  ▼         │
│    GET /users, POST /users                                                       │
│    Read: handlers/users.go, svc/user_service.go                                  │
│  worker-2           ░░░░██████████░░░░░░░░░░░░░░  3.8s   4 findings  ▼         │
│  worker-3           ░░░░████████████████░░░░░░░░  4.4s   2 findings  ▼         │
│  orchestrator       ░░░░░░░░░░░░░░░░░░░░██████░░  1.9s   3 findings  ▼         │
│                                                                                  │
│  (bar chart shows time overlap — workers ran in parallel)                        │
│                                                                                  │
│  Findings (14 total)                                                             │
│  ────────────────────                                                            │
│  ┌─ Tabs: All (14)  ·  Accepted (9)  ·  Rejected (2)  ·  Pending (3) ──────┐   │
│  │                                                                          │   │
│  │  ✓ GET /users/{id}  ·  MCP_NO_WHEN_TO_USE  ·  worker-1  ·  MEDIUM       │   │
│  │    accepted · description updated                              ▼         │   │
│  │    Before: "Returns user by ID"                                          │   │
│  │    After:  "Returns the full user profile..." (user-edited)              │   │
│  │                                                                          │   │
│  │  ✓ GET /users/{id}  ·  MCP_OPERATIONID_FORMAT  ·  structural  ·  HIGH   │   │
│  │    auto-fixed · "getUser" → "get_user"                         ▼         │   │
│  │                                                                          │   │
│  │  ✕ GET /orders/{id}  ·  SPEC_CODE_MISMATCH  ·  worker-2  ·  LOW         │   │
│  │    rejected by user                                            ▼         │   │
│  │                                                                          │   │
│  └──────────────────────────────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────────────────────────────┘
```

---

### Page: Settings (`/settings`)

```
┌─────────────────────────────────────────────────────────────────┐
│  Settings                                                        │
├─────────────────────────────────────────────────────────────────┤
│                                                                  │
│  LLM Configuration                                               │
│  ─────────────────                                               │
│  Base URL    [ https://my-gateway.company.com/v1  ]              │
│  API Token   [ ••••••••••••••••••••••••    ] Show  Test          │
│              Stored server-side. Never sent to browser.          │
│                                                                  │
│  [ Test connection ]  ✓ Connected · claude-3-5-sonnet            │
│                                                                  │
│  ─────────────────────────────────────────────────────────────  │
│                                                                  │
│  GitHub Connection                                               │
│  ─────────────────                                               │
│  Connected as  @laurentiu  (laurentiughiur)                      │
│  Scopes        repo, read:user                                   │
│  [ Disconnect ]                                                  │
│                                                                  │
│  ─────────────────────────────────────────────────────────────  │
│                                                                  │
│  Defaults                                                        │
│  ──────────                                                      │
│  MCP spec version   [ 2025-11-25 ▼ ]                            │
│  Analysis mode      [ Lint ▼ ]                                   │
│  Mismatch mode      [ Flag ▼ ]                                   │
│                                                                  │
│  ─────────────────────────────────────────────────────────────  │
│                                                                  │
│  History                                                         │
│  ──────────                                                      │
│  Retain runs for   [ 90 days ▼ ]                                 │
│  [ Clear history ]                                               │
│                                                                  │
└─────────────────────────────────────────────────────────────────┘
```

---

### Paste Mode (unauthenticated or authenticated but no repo)

**Paste mode is a first-class path, not a fallback.** It supports the full analysis → review → download workflow. The only thing it can't do is create a GitHub PR — you download the fixed spec instead.

Available at `/` without login. The paste area accepts the raw spec; after submitting it shows the full three-panel analysis view identical to the repo-connected mode, with one difference in the bottom bar: "Download spec" replaces "Create PR" as the primary action.

**Without LLM configured (structural only):**

```
┌─────────────────────────────────────────────────────────────────────────────────┐
│  Analysis Complete  ·  spec (pasted)  ·  3 errors  ·  0 warnings                │
│  ─────────────────────────────────────────────────────────────────────────────  │
│                                                                                  │
│  ℹ AI-powered suggestions not available.                                         │
│    For description rewrites and near-duplicate detection,                        │
│    configure an LLM endpoint in Settings, or connect GitHub.                    │
│  [ Connect GitHub ]   [ Configure LLM ]                                          │
│                                                                                  │
│  Structural findings (auto-fixable, no AI required):                             │
│                                                                                  │
│  ● 3 errors                                                                      │
│  ┌─────────────────────────────────────────────────────────────────────────┐    │
│  │ ● getUser       MCP_OPERATIONID_FORMAT    Fix: rename to "get_user"     │    │
│  │ ● createOrder   MCP_OPERATIONID_FORMAT    Fix: rename to "create_order" │    │
│  │ ● status param  MCP_ENUM_NO_DESCRIPTION   Add enum descriptions         │    │
│  └─────────────────────────────────────────────────────────────────────────┘    │
│                                                                                  │
│  [ Download report (JSON) ]          [ Download patched spec ]                   │
│                                                                                  │
└─────────────────────────────────────────────────────────────────────────────────┘
```

**With LLM configured (full AI analysis, no GitHub):**

Shows the identical three-panel analysis view (operations / agent feed / suggestions). The user reviews suggestions — accepting, rejecting, or editing each one. The bottom bar shows:

```
├──────────────────────────────────────────────────────────────────────────────────┤
│  9 accepted · 2 rejected · 4 pending         [ Download patched spec ]           │
│                                         (no PR — paste mode has no repo)         │
└──────────────────────────────────────────────────────────────────────────────────┘
```

"Download patched spec" downloads the YAML/JSON with all accepted and auto-fixed suggestions applied. The user can take that file and commit it themselves, open a PR manually, or simply use it as a starting point.

**Paste mode + GitHub connected (best of both):**

If the user is logged in but chooses to paste a spec rather than selecting a repo, they get AI analysis but still no "Create PR" button — there's no repo to target. The bottom bar shows:

```
│  [ Download patched spec ]   [ Connect a repo to create a PR ]
```

Clicking "Connect a repo" opens the repo selector inline, pre-filling the analysis with the pasted spec content.

---

### Visual Design Tokens

- **Error** — red-600, ● icon
- **Warning** — amber-500, ⚠ icon
- **Info** — blue-500, ℹ icon
- **Auto-fixed** — green-600, ✓ badge
- **Confidence HIGH** — solid pill, green tint
- **Confidence MEDIUM** — solid pill, amber tint
- **Confidence LOW** — solid pill, red tint, ▲ icon
- **Pending** — muted grey, ○ icon
- **Agent running** — animated spinner, ⟳

Font: system monospace for spec content, code paths, and finding details. System sans-serif for UI chrome.

---

---

## CLI Design

### Philosophy

- Human-readable by default. Structured (JSON/SARIF) with a flag.
- Coloured output for terminals that support it; plain text when piped or `--no-color`.
- Scannable at a glance — the summary line must tell you everything without reading the details.
- Exit codes are machine-contracts. Never change them between versions.

---

### Command Structure

```
mcp-doctor <command> [options]

Commands:
  scan       Analyse an OpenAPI spec file
  history    View past analysis runs
  diff       Show before/after for a specific finding in a run

Global flags:
  --no-color         Disable ANSI colour output
  --json             Output as JSON (where applicable)
  --mcp-version      MCP spec version to lint against (default: 2025-11-25)
  --help, -h         Show help
  --version, -v      Show version
```

---

### Command: `scan`

```
mcp-doctor scan <spec-file> [options]

Options:
  --mode                  lint | fix  (default: lint)
  --confidence-threshold  high | medium | low  (default: high, only relevant in fix mode)
                          high:   apply HIGH confidence only (format, structural fixes)
                          medium: apply HIGH + MEDIUM (adds AI description rewrites)
                          low:    apply ALL including LOW ⚠ (may contain errors)
  --mismatch-mode         flag | fix  (default: flag)
  --repo                  GitHub repo (owner/repo) for codebase grounding
  --token                 GitHub token (or $GITHUB_TOKEN)
  --route-paths           Comma-separated paths to route/handler files in repo
  --output                Path to write patched spec (default: stdout summary only)
  --report                Path to write JSON report
  --cache                 Enable sidecar cache (.mcp-doctor.yaml)
  --cache-file            Path to cache file (default: .mcp-doctor.yaml)
  --create-pr             Open a GitHub PR with fixes (requires --repo and --mode=fix)
  --pr-title              PR title (default: "fix: improve OpenAPI spec for MCP readiness")
  --verbose               Show all findings (default: top findings + summary)
```

**Human-readable output (default):**

```
$ mcp-doctor scan api/openapi.yaml

  ⚕ MCP Doctor  v1.0.0
  ─────────────────────────────────────────────
  Spec     api/openapi.yaml
  Version  OpenAPI 3.0.3
  Mode     lint

  Running structural linter...
  ✓ Structural linter complete (0.1s)  3 findings

  AI analysis not enabled. Set LLM_BASE_URL and LLM_API_TOKEN to enable.

  ─────────────────────────────────────────────
  Results: 3 errors · 0 warnings

  Errors
  ──────
  ● operationId "getUser" is not snake_case  [MCP_OPERATIONID_FORMAT]
    GET /users/{id}
    Fix: rename to "get_user"

  ● operationId "createOrder" is not snake_case  [MCP_OPERATIONID_FORMAT]
    POST /orders
    Fix: rename to "create_order"

  ● Parameter "status" has enum values without descriptions  [MCP_ENUM_NO_DESCRIPTION]
    GET /orders  ·  query.status
    Values: pending, active, cancelled
    Fix: add description to each enum value

  ─────────────────────────────────────────────
  3 errors found. Fix before MCP conversion.

$ echo $?
1
```

**With AI enabled:**

```
$ LLM_BASE_URL=https://... LLM_API_TOKEN=sk-... mcp-doctor scan api/openapi.yaml

  ⚕ MCP Doctor  v1.0.0
  ─────────────────────────────────────────────
  Spec     api/openapi.yaml
  Version  OpenAPI 3.0.3
  Mode     lint · AI enabled

  ✓ Structural linter     0.1s   3 findings (auto-fixable)
  ⟳ Analysing operations…
    ✓ worker-1  GET /users, POST /users         4.2s   2 findings
    ✓ worker-2  GET /orders/{id}                3.8s   4 findings
    ✓ worker-3  POST /orders, DELETE /orders    4.1s   2 findings
    ✓ Post-processing: near-duplicate check     1.9s   3 findings

  ─────────────────────────────────────────────
  Results: 3 errors · 8 warnings · 3 info   14 total

  Errors
  ──────
  ● [HIGH] operationId "getUser" → "get_user"  [MCP_OPERATIONID_FORMAT]
    GET /users/{id}

  ● [HIGH] operationId "createOrder" → "create_order"  [MCP_OPERATIONID_FORMAT]
    POST /orders

  ● [MEDIUM] Description explains WHAT but not WHEN to call  [MCP_NO_WHEN_TO_USE]
    GET /users/{id}
    Current: "Returns user by ID"
    Suggested: "Returns the full user profile for a given user ID. Use this when
    you have a specific user ID and need complete profile data. For search by
    email or name, use search_users."

  Warnings
  ────────
  ⚠ [MEDIUM] Near-duplicate tool descriptions  [MCP_NEAR_DUPLICATE]
    GET /users  ·  GET /users/search
    These operations have similar descriptions. LLMs may struggle to choose.
    Suggested: Add "Use list_users for paginated browse. Use search_users when
    filtering by name, email, or status."

  (5 more warnings — run with --verbose to see all)

  ─────────────────────────────────────────────
  14 findings. Run with --mode=fix to apply HIGH-confidence fixes automatically.

$ echo $?
1
```

**Fix mode — conservative (default):**

```
$ mcp-doctor scan api/openapi.yaml --mode=fix --output=api/openapi.patched.yaml

  ⚕ MCP Doctor  v1.0.0  ·  fix mode  ·  threshold: high
  ─────────────────────────────────────────────
  ✓ Structural linter     3 findings
  ✓ worker-1              2 findings
  ✓ worker-2              4 findings
  ✓ worker-3              2 findings
  ✓ Post-processing       3 findings

  Auto-applying HIGH confidence fixes (threshold: high):
  ✓ GET /users/{id}   operationId "getUser" → "get_user"
  ✓ POST /orders      operationId "createOrder" → "create_order"
  ✓ (1 more)

  Skipped (below threshold — use --confidence-threshold=medium to apply):
  ○ GET /users/{id}   MCP_NO_WHEN_TO_USE      MEDIUM  (description rewrite)
  ○ GET /users        MCP_NEAR_DUPLICATE       MEDIUM  (disambiguation)
  ○ (4 more MEDIUM, 5 more LOW)

  Patched spec written: api/openapi.patched.yaml
  Applied 3 fixes · 11 reported but not applied

$ echo $?
0
```

**Fix mode — standard (HIGH + MEDIUM):**

```
$ mcp-doctor scan api/openapi.yaml \
    --mode=fix \
    --confidence-threshold=medium \
    --output=api/openapi.patched.yaml

  ⚕ MCP Doctor  v1.0.0  ·  fix mode  ·  threshold: medium
  ─────────────────────────────────────────────
  Auto-applying HIGH + MEDIUM confidence fixes:
  ✓ GET /users/{id}   operationId "getUser" → "get_user"             HIGH
  ✓ POST /orders      operationId "createOrder" → "create_order"     HIGH
  ✓ GET /users/{id}   description rewrite (MCP_NO_WHEN_TO_USE)       MEDIUM
  ✓ GET /users        near-duplicate disambiguation                   MEDIUM
  ✓ (5 more)

  Skipped (LOW confidence — use --confidence-threshold=low to apply):
  ○ GET /users/{id}   SPEC_CODE_MISMATCH    (code/spec disagreement)
  ○ (4 more LOW)

  Patched spec written: api/openapi.patched.yaml
  Applied 9 fixes · 5 LOW confidence not applied

$ echo $?
0
```

**Fix mode — aggressive (all confidence levels):**

```
$ mcp-doctor scan api/openapi.yaml \
    --mode=fix \
    --confidence-threshold=low \
    --output=api/openapi.patched.yaml

  ⚕ MCP Doctor  v1.0.0  ·  fix mode  ·  threshold: low  ⚠
  ─────────────────────────────────────────────
  ⚠  Aggressive mode — applying ALL findings including LOW confidence.
     LOW confidence findings may contain errors. Review the output carefully.

  Auto-applying all findings (14 total):
  ✓ (9 HIGH + MEDIUM applied)
  ✓ GET /users/{id}   SPEC_CODE_MISMATCH: spec updated to match code   LOW ⚠
  ✓ (4 more LOW)

  Patched spec written: api/openapi.patched.yaml
  Applied 14 fixes · 0 skipped

$ echo $?
0
```

**With codebase grounding:**

```
$ mcp-doctor scan api/openapi.yaml \
    --repo TykTechnologies/tyk-gateway \
    --token $GITHUB_TOKEN \
    --route-paths "internal/api/routes/,handlers/"

  ⚕ MCP Doctor  v1.0.0
  ─────────────────────────────────────────────
  Spec       api/openapi.yaml (OpenAPI 3.0.3)
  Repo       TykTechnologies/tyk-gateway · main
  Routes     internal/api/routes/, handlers/
  Cache      .mcp-doctor.yaml (warm — 18/24 operations cached)

  ✓ Structural linter         0.1s   3 findings
  ⟳ Codebase grounding…
    ✓ worker-1  GET /users, POST /users    4.2s   3 findings (1 mismatch)
    ✓ worker-2  GET /orders/{id}           3.8s   5 findings (2 mismatches)
    ✓ worker-3  [cached]                   0.0s   ← unchanged since last run
    ✓ Post-processing                      1.9s   3 findings

  ─────────────────────────────────────────────
  Spec/code mismatches found:

  ▲ [LOW] SPEC_CODE_MISMATCH — review required
    GET /users/{id}
    Spec claims: returns 200 with user object
    Code does:   returns 204 No Content (handlers/users.go:47)
    ⚠ Confirm this is not a code bug before accepting.

  [Full results: 16 findings total]
  Run with --output=report.json for machine-readable output.
```

---

### Command: `history`

```
$ mcp-doctor history

  ⚕ MCP Doctor — Run History
  ──────────────────────────────────────────────────────────────
  ID        Date                 Status         Findings   PR
  ──────────────────────────────────────────────────────────────
  run-12    2026-06-24 14:23     ✓ 9 fixed      14         #42
  run-11    2026-06-23 09:11     ⚠ 8 issues      8         —
  run-10    2026-06-22 16:44     ✓ 3 fixed        3        #38
  run-09    2026-06-21 11:02     ✓ clean          0         —
  ──────────────────────────────────────────────────────────────
  4 runs stored. Use `mcp-doctor history <id>` for detail.
```

```
$ mcp-doctor history run-12

  Run run-12  ·  2026-06-24 14:23  ·  12.4s
  Repo: TykTechnologies/tyk-gateway  ·  Branch: main
  Spec: api/openapi.yaml  ·  OpenAPI 3.0.3
  Mode: lint  ·  Mismatch: flag  ·  MCP spec: 2025-11-25

  Agents
  ──────────────────────────────────────────────────────────
  structural-linter    [0.1s]   all ops       3 findings
  worker-1             [4.2s]   2 operations  2 findings
  worker-2             [3.8s]   1 operation   4 findings
  worker-3             [4.1s]   2 operations  2 findings
  orchestrator         [1.9s]   post-process  3 findings

  Accepted (9)
  ──────────────────────────────────────────────────────────
  ✓ GET /users/{id}     MCP_NO_WHEN_TO_USE      description updated [edited]
  ✓ GET /users/{id}     MCP_OPERATIONID_FORMAT  "getUser" → "get_user" [auto]
  ✓ POST /users         MCP_NO_WHEN_TO_USE      description updated
  ✓ GET /orders/{id}    MCP_NO_RETURN_VALUE     description updated
  ✓ GET /orders/{id}    MCP_PARAM_NO_DESC       orderId description added
  ✓ POST /orders        MCP_NO_WHEN_TO_USE      description updated [edited]
  ✓ POST /orders        MCP_RESPONSE_NO_SCHEMA  201 schema added
  ✓ orchestrator        MCP_NEAR_DUPLICATE      GET /users + GET /users/search
  ✓ structural          MCP_OPERATIONID_FORMAT  createOrder → create_order [auto]

  Rejected (2)
  ──────────────────────────────────────────────────────────
  ✕ GET /orders/{id}   SPEC_CODE_MISMATCH   (user confirmed spec is correct)
  ✕ DELETE /orders     MCP_DESCRIPTION_BRIEF  (user disagrees — description is fine)

  Pending (3)
  ──────────────────────────────────────────────────────────
  ○ POST /users        MCP_ENUM_NO_DESCRIPTION
  ○ GET /users         MCP_DESCRIPTION_BRIEF
  ○ DELETE /orders     MCP_NO_WHEN_TO_USE

  PR: https://github.com/TykTechnologies/tyk-gateway/pull/42
```

```
$ mcp-doctor history run-12 --finding "GET /users/{id}" MCP_NO_WHEN_TO_USE

  Finding Detail
  ─────────────────────────────────────────────────────
  Run:       run-12  ·  2026-06-24 14:23
  Operation: GET /users/{id}
  Rule:      MCP_NO_WHEN_TO_USE
  Agent:     worker-1
  Severity:  warning  ·  Confidence: MEDIUM
  Resolution: accepted (user-edited)

  Before:
  ┄┄┄┄┄┄┄
    description: "Returns user by ID"

  After (what was committed):
  ┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄
    description: >
      Returns the full user profile for a given user ID.
      Use this when you have a specific user ID and need
      complete profile data. For search by email or name,
      use search_users.

  (AI suggested slightly different text — user edited before accepting)
```

---

### Command: `diff` (shortcut to finding detail)

```
$ mcp-doctor diff run-12

  Accepted changes in run-12 (9 total):

  GET /users/{id}  description:
  - Returns user by ID
  + Returns the full user profile for a given user ID.
  + Use this when you have a specific user ID and need complete profile
  + data. For search by email or name, use search_users.

  GET /users/{id}  operationId:
  - getUser
  + get_user

  (7 more — run with --all to show all, --operation "GET /users/{id}" to filter)
```

---

### Exit Codes

| Code | Meaning                                                                          |
| ---- | -------------------------------------------------------------------------------- |
| `0`  | No errors found (warnings allowed), or fix mode applied all changes successfully |
| `1`  | One or more ERROR-severity findings found                                        |
| `2`  | Analysis failed (network error, spec unreadable, LLM unreachable)                |
| `3`  | Invalid arguments or configuration                                               |

These codes never change between minor versions. A breaking change to exit codes is a major version bump.

---

### GitHub Action — Full Config Reference

```yaml
- name: MCP Doctor
  uses: mcp-doctor/action@v1
  with:
    # Required
    spec: ./api/openapi.yaml

    # Mode
    mode: lint # lint | fix
    confidence-threshold: high # high | medium | low (only in fix mode)
    mismatch-mode: flag # flag | fix

    # LLM (required for AI-powered analysis)
    llm-base-url: ${{ secrets.LLM_BASE_URL }}
    llm-api-token: ${{ secrets.LLM_API_TOKEN }}

    # Codebase grounding (optional — v2 feature)
    route-paths: 'internal/api/routes/,handlers/'

    # PR creation (requires fix mode)
    create-pr: false # true | false
    pr-title: 'fix: improve OpenAPI spec for MCP readiness'

    # Cache
    cache: true

    # Thresholds for CI gate
    fail-on: error # error | warning | never

    # MCP spec version
    mcp-version: '2025-11-25'
```

**GitHub Actions Job Summary** (written automatically after every run):

```markdown
## ⚕ MCP Doctor — Run Summary

|          |                                    |
| -------- | ---------------------------------- |
| Spec     | `api/openapi.yaml` (OpenAPI 3.0.3) |
| Duration | 12.4s                              |
| MCP spec | 2025-11-25                         |

### Results

| Severity      | Count |
| ------------- | ----- |
| 🔴 Errors     | 3     |
| 🟡 Warnings   | 8     |
| 🔵 Info       | 3     |
| ✅ Auto-fixed | 3     |

### Agent Activity

| Agent             | Operations      | Findings | Duration |
| ----------------- | --------------- | -------- | -------- |
| structural-linter | all (24)        | 3        | 0.1s     |
| worker-1          | 2               | 2        | 4.2s     |
| worker-2          | 1               | 4        | 3.8s     |
| worker-3          | 2               | 2        | 4.1s     |
| orchestrator      | post-processing | 3        | 1.9s     |

### Top Findings

| Operation                         | Rule                   | Severity | Confidence |
| --------------------------------- | ---------------------- | -------- | ---------- |
| `GET /users/{id}`                 | MCP_NO_WHEN_TO_USE     | warning  | MEDIUM     |
| `GET /users/{id}`                 | MCP_OPERATIONID_FORMAT | error    | HIGH       |
| `GET /users`, `GET /users/search` | MCP_NEAR_DUPLICATE     | warning  | MEDIUM     |

[View full report](https://github.com/${{ github.repository }}/actions/runs/${{ github.run_id }})
```

---

### JSON Report Schema (`--output report.json`)

```json
{
  "runId": "run-12",
  "timestamp": "2026-06-24T14:23:00Z",
  "spec": {
    "file": "api/openapi.yaml",
    "version": "3.0.3",
    "operationCount": 24
  },
  "mcpSpecVersion": "2025-11-25",
  "mode": "lint",
  "mismatchMode": "flag",
  "durationMs": 12400,
  "summary": {
    "total": 14,
    "errors": 3,
    "warnings": 8,
    "info": 3,
    "autoFixed": 3
  },
  "agents": [
    {
      "id": "structural-linter",
      "type": "structural-linter",
      "operations": [],
      "filesRead": [],
      "findingsCount": 3,
      "durationMs": 100
    }
  ],
  "findings": [
    {
      "id": "f-001",
      "agentId": "structural-linter",
      "operation": "GET /users/{id}",
      "operationId": "getUser",
      "rule": "MCP_OPERATIONID_FORMAT",
      "severity": "error",
      "confidence": "HIGH",
      "message": "operationId must be snake_case",
      "before": "getUser",
      "after": "get_user",
      "autoFixed": false,
      "resolution": "pending",
      "path": ["paths", "/users/{id}", "get", "operationId"]
    }
  ]
}
```

This schema is stable from v1. Adding fields is a non-breaking change. Removing or renaming fields is a major version bump.
