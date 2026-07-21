# GitHub Action PR Mode — Autonomous Spec Reviewer

## Problem Statement

How might we make MCP Doctor act as a standalone PR reviewer that catches
spec↔code drift in both directions and fixes it, with zero web-app dependency?

## Recommended Direction

One composite action, one `behavior` ladder — each level cumulative:

| Level | Adds | Needs |
| --- | --- | --- |
| `summary` | Job Summary + `::error file=…,line=…` workflow annotations + `fail-on` gate | default read token (works on forks) |
| `comment` | Sticky PR comment (marker-based, updated in place), delta-gated vs base | `pull-requests: write` |
| `review` | PR review with inline comments on **both** spec lines (JSON-path→YAML-line resolver) **and** handler lines (grounding knows registration sites); resolved comments dismissed on push | `pull-requests: write` |
| `fix-pr` | Patched spec via `applyFixes`/`verifyFixes`, opened as an idempotent stacked PR | `contents: write` + `pull-requests: write` |

Direction detection diffs the PR: route/handler files changed → run
undocumented-endpoint discovery; spec changed → run grounding mismatch checks;
neither → lint only (zero LLM cost). All PR-visible output is delta-gated
against a base-branch run; pre-existing debt lives only in the Job Summary.
Fork PRs (no secrets, read-only token) degrade automatically to `summary`.

**Stacked fix-PR rules:**

- Branch name: `<original-branch>-mcp-doctor-fixes`, targeting the PR's head branch.
- Idempotent: subsequent pushes force-update the same branch/PR, never duplicate.
- Lifecycle: when the source PR closes/merges, the fix PR's base is re-pointed
  to the original PR's target branch (master, release-1.x, …) so surviving
  fixes can land on their own; if nothing is left to offer, it closes itself
  with a note.

**v1.1 (committed):** `/mcp-doctor fix` issue-comment command — triggers the
`fix-pr` behavior on demand for one PR regardless of configured level, with a
permission check on the commenter.

## Supporting knobs (all levels)

| Input | Values | Default |
| --- | --- | --- |
| `behavior` | `summary` / `comment` / `review` / `fix-pr` | `comment` |
| `fail-on` | `error` / `warning` / `never` | `never` (advisory) |
| `confidence-threshold` | `high` / `medium` / `low` | `high` |
| `mismatch-mode` | `flag` / `fix` | `flag` |
| `spec` | path, or omit → auto-detect | auto |
| `route-paths` | csv, or omit → auto-discover in workspace | auto |
| `llm-base-url` / `llm-api-token` | secrets; absent → lint-only tier | — |

## Key Assumptions to Validate

- [ ] JSON-path → YAML line resolution is reliable enough for inline comments — spike with the `yaml` CST on the Tyk swagger.yml
- [ ] Grounding degrades silently (not noisily) on unsupported frameworks — run against 3 random OSS repos
- [ ] Delta gating (base scan + head scan + report diff) fits in acceptable CI time — measure on tyk repo
- [ ] Stacked fix-PR merges cleanly back into the PR without confusing authors — dogfood first

## Validation plan (lghiur/tyk-analytics fork)

Three PRs opened via `gh` against the fork to prove behavior end-to-end:

1. **Code → spec drift:** add a new endpoint, no swagger change → expect
   undocumented-endpoint finding + suggested swagger.yml stub / fix PR.
2. **Low-detail spec:** add a new endpoint with a minimal swagger entry →
   expect description/quality findings + enrichment suggestions.
3. **Spec → code drift:** add endpoints/configs to swagger that don't exist in
   code → expect `SPEC_CODE_MISMATCH` findings, flagged not auto-corrected.

## MVP Scope

In: `behavior` input incl. `review`, PR context parsing, direction detection,
delta gating, sticky comment, inline review comments (spec + handler lines),
stacked fix-PR with re-pointing lifecycle, local route-file auto-discovery,
fork-PR graceful degradation.
Out (this iteration): SARIF, `/mcp-doctor fix` comment command (v1.1).

## Not Doing (and Why)

- `pull_request_target` by default — secret-exfiltration foot-gun; forks get the degraded tier instead
- Direct commits to the author's branch — stacked PRs chosen; surprising pushes erode trust
- SARIF/Code Scanning — needs Advanced Security on private repos; revisit if users ask
- A separate "CI engine" — the action stays a thin consumer of `lib/engine`, per the architecture rule

## Known Limitations (reviewed, deliberately not fixed)

- **Delta identity shifts on array-index inserts.** A finding's stable identity
  is `rule + operation + spec JSON path`. Paths that address array elements by
  index (`parameters/2/...`) shift when the PR inserts an element earlier in
  the array, so an untouched finding can be re-labeled "New in this PR" (and
  its inline review comment re-posted) after such an insert. Accepted: keying
  by content instead of index would need semantic parameter matching for
  marginal benefit.
- **Outdated review comments are kept, not re-posted.** When a push moves a
  commented line out of the diff, GitHub marks the comment outdated
  (`line: null`). The sync matches it via `original_line` and keeps it rather
  than deleting and re-anchoring, so a still-valid finding can sit on an
  outdated position until the finding itself changes. Accepted: re-posting
  would notify reviewers on every push for cosmetic gain.
