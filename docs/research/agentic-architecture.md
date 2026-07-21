# Agentic Architecture — Reference

Sources: Anthropic multi-agent research, Augment Code orchestration guide, Addyosmani.com Code Agent Orchestra

---

## Core Pattern: Orchestrator + Fan-out Workers

This project uses the orchestrator-worker pattern. It earns its complexity for two concrete reasons:

1. **Context isolation** — each worker gets only the code for its assigned operations, not the whole codebase
2. **True parallelism** — operations are independent; wall-clock time = slowest single worker, not sum of all

```
Structural Linter (synchronous, no LLM)
    │
    ▼
Orchestrator
    │── reads spec → partitions into batches of 3–5 operations
    │── fans out N Worker agents in parallel
    │       Worker: description quality + MCP semantic + codebase grounding
    │── collects results as workers complete → streams to client
    │
    ▼
Post-Processing (one LLM call)
    │── near-duplicate detection over all operation descriptions
    │── tool set coherence check
    ▼
Final report
```

---

## Worker Agent Responsibilities

Each worker handles a batch of 3–5 operations. One LLM call per batch (not per operation).

**Per-operation checks in a single prompt:**

1. Description quality: is this LLM-usable?
2. MCP semantic: explains WHEN, not just WHAT?
3. MCP semantic: explains what it returns in actionable terms?
4. MCP semantic: duplicates the tool name?
5. Parameter descriptions: actionable for LLM argument construction?
6. [v2+] Codebase: find handler, read 2 layers, detect mismatches, synthesise suggestions

**Why batch 3–5 operations per worker (not 1, not 20):**

- 1 operation per worker: too many agents, orchestration overhead dominates
- 20 operations per worker: context window gets crowded, quality degrades
- 3–5 operations: our **internal heuristic** for keeping workers focused

> **Attribution correction:** "3–5" is _not_ Anthropic's recommended operations-per-worker batch size. Anthropic's "3–5" refers to the number of **parallel subagents** a lead spins up; the "3–5 is the sweet spot" phrasing is **Addy Osmani's**, and it too is about **team size (number of agents)**, not subtasks per worker. Anthropic instead scales effort to query complexity (e.g. "1 agent with 3–10 tool calls" for simple lookups; "2–4 subagents with 10–15 calls each" for comparisons). Treat our 3–5-ops batch as a sensible default to tune empirically, not a sourced finding.

**Depth limit: 2 layers (handler + direct service calls)** — _internal heuristic, not an externally-sourced rule_

- Layer 1: route handler function
- Layer 2: functions directly called from the handler
- Layer 3+: diminishing returns, growing token cost (our judgment; no external benchmark — tune as needed)

---

## Orchestrator Responsibilities

The orchestrator does not do analysis. It coordinates.

1. Parse spec → extract operation list
2. Partition operations into batches of 3–5
3. For each batch: spawn worker agent with relevant context only
4. Collect worker results as they arrive → emit SSE events to client
5. After all workers complete: run post-processing (near-duplicate detection)
6. Assemble final report

**Context the orchestrator passes to each worker:**

- The operation definitions for its assigned batch (from the spec)
- [v2+] The route file paths to search (not the full codebase)
- The confidence thresholds for auto-fix mode
- The mismatch mode flag

**What the orchestrator does NOT pass to workers:**

- The full spec (workers only need their batch)
- The full codebase (workers search only the pointed files)
- Results from other workers (workers are independent)

---

## Confidence Scoring

Every finding must have a confidence level. This drives auto-fix behaviour.

| Level  | Definition                                                             | Auto-fix in `--mode=fix`?         |
| ------ | ---------------------------------------------------------------------- | --------------------------------- |
| HIGH   | Deterministic rule violation (missing field, format error, wrong type) | Yes                               |
| MEDIUM | LLM-judged quality issue (description vague, missing context)          | Only with `--confirm-medium` flag |
| LOW    | Spec/code mismatch or semantic ambiguity                               | Never — always human review       |

**Structural linter findings are always HIGH confidence** — they are format checks, not judgments.

**Worker agent findings are MEDIUM by default** unless the agent can cite a specific, unambiguous rule violation (then HIGH). Codebase mismatch findings are always LOW.

---

## SSE Event Schema (SSE from day one — v1 onward)

All events are newline-delimited JSON on the SSE stream.

```
event: agent_started
data: {"agentId": "worker-3", "operations": ["GET /users/{id}", "POST /users"]}

event: file_read
data: {"agentId": "worker-3", "path": "handlers/users.go", "linesRead": 47}

event: finding
data: {
  "agentId": "worker-3",
  "operation": "GET /users/{id}",
  "rule": "MCP_NO_WHEN_TO_USE",
  "severity": "warning",
  "confidence": "MEDIUM",
  "current": "Returns user by ID",
  "suggested": "Returns the full user profile for a given user ID. Use this when you have a specific user ID and need the complete profile. Use search_users if you need to find a user by email or name.",
  "autoFixable": false
}

event: finding
data: {
  "agentId": "worker-3",
  "operation": "GET /users/{id}",
  "rule": "SPEC_CODE_MISMATCH",
  "severity": "error",
  "confidence": "LOW",
  "current": "Returns 200 with user object",
  "actual": "Returns 204 No Content when user not found",
  "suggested": "Update response to document 204 case",
  "warning": "Confirm this is a code bug before accepting — the spec may be intentionally documenting desired behaviour",
  "autoFixable": false
}

event: agent_completed
data: {"agentId": "worker-3", "findingsCount": 3, "durationMs": 4200}

event: postprocess_started
data: {"check": "near-duplicate-detection", "operationCount": 24}

event: finding
data: {
  "agentId": "orchestrator",
  "rule": "MCP_NEAR_DUPLICATE",
  "severity": "warning",
  "confidence": "MEDIUM",
  "operations": ["GET /users", "GET /users/search"],
  "suggested": "Add disambiguation: 'Use list_users for paginated full listing; use search_users when filtering by name, email, or status'"
}

event: analysis_complete
data: {"totalFindings": 14, "errors": 3, "warnings": 8, "info": 3, "durationMs": 12400}
```

**Route:** `GET /api/jobs/[id]/stream` — returns `text/event-stream`

**SSE is the v1 transport — no polling path.** `POST /api/analyze` → `{ jobId }` → the client immediately opens the SSE stream at `GET /api/jobs/[id]/stream` and renders findings as they arrive. This is the canonical decision in the design doc ("Resolved Decisions → v1 progress UX: SSE from day one") and CLAUDE.md. A polling fallback is **not** part of v1 or v2; if one is ever added for restricted environments it is a separate, explicitly-scoped feature, not the default.

---

## Cost Model

Multi-agent is only worth it when tasks genuinely benefit from parallelism or context isolation. For this project, both apply:

- **Parallelism**: 24 operations analyzed in parallel by 6 workers ≈ 6× faster than sequential
- **Context isolation**: each worker reads only its handler files, not the full codebase

**Token overhead:** Multi-agent systems trade tokens for quality and wall-clock time. Anthropic's actual published figures: agents use **~4× more tokens** than a chat interaction, and multi-agent systems **~15× more tokens** than chats; in their eval, **token usage alone explained ~80% of performance variance** (with tool-call count and model choice making up the rest). The earlier "~58% extra token overhead" figure in this doc was **not an Anthropic statistic and has been removed** — do not cite it. The overhead is justified here because operations are independent (true parallelism) and context isolation keeps each worker focused; the alternative (one giant context) produces worse results and slower wall-clock time.

**Cost optimisation:**

- Structural linter runs first, zero LLM cost. Many findings are caught here.
- Workers run only if LLM key is configured.
- Cache prevents re-running workers on unchanged operations.

---

## What NOT To Build

- Do not add a dedicated MCP compliance agent — all MCP checks are absorbed into worker prompts or the structural linter
- Do not fan out one agent per operation — batch into 3–5
- Do not pass the full spec context to every worker — only the batch they need
- Do not exceed depth 2 in codebase traversal without explicit user opt-in
- Do not run post-processing in parallel with workers — it needs all worker results first
