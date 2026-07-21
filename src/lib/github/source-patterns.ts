/**
 * Shared heuristics for finding route/handler source files, used by the web
 * app's remote candidate listing (`client.ts`) and the Action's local
 * workspace discovery (`cli/gh/discover.ts`).
 */

/** Source files worth reading for spec/code grounding. */
export const SOURCE_PATTERN = /\.(go|ts|js|py|rb|java|cs|php|kt|rs)$/i

/** Dirs and test/generated files that never contain route handlers. */
export const SOURCE_EXCLUDE =
  /(^|\/)(node_modules|vendor|dist|build|\.next|out|coverage|testdata|__tests__|__mocks__|\.git)(\/|$)|(_test\.|\.test\.|\.spec\.|\.d\.ts$)|(^|\/)testutil\./i

/** Path hints that a file likely registers/handles routes. */
export const HANDLER_HINT = /(handler|route|controller|endpoint|api|server|mux|router|service)/i

/**
 * A call that actually registers a route on a router — the strongest signal a
 * file deserves one of the capped candidate slots (name hints alone let Tyk's
 * `gateway/server.go`, the file registering every `/tyk` route, rank 46th of
 * 581 and fall off the 40 cap). Mirrors the verbs `extractRegisteredRoutes`
 * can parse: a method or generic registration call whose first argument is a
 * static path literal, optionally `"METHOD /path"` (net/http 1.22).
 */
export const ROUTE_REGISTRATION =
  /\.\s*(?:handlefunc|handle|route|all|get|post|put|delete|patch|options|head|trace)\s*\(\s*["'`](?:[A-Z]+ )?\//i

/** Leading bytes of a candidate probed for `ROUTE_REGISTRATION` (bounds I/O). */
export const REGISTRATION_PROBE_BYTES = 64 * 1024

/** Cap reads so a large repo can't blow up latency / LLM cost. */
export const MAX_SOURCE_CANDIDATES = 40

/** OpenAPI spec file candidates (openapi.* / swagger.* yaml|yml|json). */
export const SPEC_FILE_PATTERN = /(^|\/)(openapi|swagger)[^/]*\.(ya?ml|json)$/i
