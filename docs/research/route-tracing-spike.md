# Route→Handler Tracing Spike (Task 30)

**Status:** GO (text-based, Go-first), with a Go-AST fallback identified.

## Goal

Prove the worker can map a spec operation to its handler and read 2 layers deep
using text-based (LLM) reading of user-pointed route files — no per-language
parser — with **Go as the primary target** (Tyk Gateway and most Tyk services are
Go).

## Approach evaluated

A two-stage approach:

1. **Deterministic candidate mapping** (`lib/engine/grounding/map.ts`): a fast,
   regex/text pass over user-pointed route files that pairs each operation
   (`METHOD /path`) with a handler registration. This narrows the search before
   any LLM call and is fully testable.
2. **LLM grounding read** (`lib/engine/grounding/read.ts` + worker): the worker
   reads the mapped handler file plus its depth-2 service calls and judges
   spec/code mismatches (status codes, response shapes, auth).

## Go router coverage (primary)

The deterministic matcher recognizes the registration shapes used across the Go
ecosystem, normalizing the spec path so `{id}` matches `:id`, `{id}`, and the
Go 1.22 `{id}` pattern:

| Router | Registration shape | Example |
|---|---|---|
| `net/http` 1.22 | `mux.HandleFunc("GET /users/{id}", h)` | method embedded in pattern |
| Gin | `r.GET("/users/:id", h)` | method as method name |
| Chi | `r.Get("/users/{id}", h)` | method as method name |
| gorilla/mux | `r.HandleFunc("/users/{id}", h).Methods("GET")` | method via `.Methods()` |
| Tyk-style | custom middleware/plugin handlers, context injection | flagged as a known failure mode |

Express (`app.get('/users/:id', h)`) and FastAPI (`@app.get('/users/{id}')`) reuse
the same normalization and are covered as secondary targets.

## Measured behavior (fixtures)

On the multi-framework route fixtures committed in `map.test.ts`, the matcher
locates a handler candidate for the standard registration shapes above and marks
unmatched operations as `unmapped` (surfaced as a finding, never a crash).

## Failure modes (documented)

- **Tyk context injection / plugin handlers** — handlers registered indirectly via
  middleware or reflection are not statically matchable; fall back to LLM search
  over the pointed files.
- **Router groups / subrouters** — prefix is assembled across `Group("/v1")`
  calls; the matcher matches on the suffix and the LLM resolves the prefix.
- **Method-on-receiver handlers** (`(s *Server) GetUser`) — matched by symbol name.
- **Dynamic/reflection registration** — not matchable; reported as unmapped.

## Go/No-Go

**GO** on the text-based, Go-first approach for the common router shapes. If
hit-rate on real Tyk repos underperforms, the identified fallback is a lightweight
Go AST pass via `go/parser` (out of process) for Go files only — the spec/code
contract and worker stay unchanged, only the candidate-mapping step is swapped.
