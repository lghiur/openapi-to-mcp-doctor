/**
 * Shared heuristics for finding route/handler source files, used by the web
 * app's remote candidate listing (`client.ts`) and the Action's local
 * workspace discovery (`cli/gh/discover.ts`).
 */

/** Source files worth reading for spec/code grounding. */
export const SOURCE_PATTERN = /\.(go|ts|js|py|rb|java|cs|php|kt|rs)$/i

/** Dirs and test/generated files that never contain route handlers. */
export const SOURCE_EXCLUDE =
  /(^|\/)(node_modules|vendor|dist|build|\.next|out|coverage|testdata|__tests__|__mocks__|\.git)(\/|$)|(_test\.|\.test\.|\.spec\.|\.d\.ts$)/i

/** Path hints that a file likely registers/handles routes. */
export const HANDLER_HINT = /(handler|route|controller|endpoint|api|server|mux|router|service)/i

/** Cap reads so a large repo can't blow up latency / LLM cost. */
export const MAX_SOURCE_CANDIDATES = 40

/** OpenAPI spec file candidates (openapi.* / swagger.* yaml|yml|json). */
export const SPEC_FILE_PATTERN = /(^|\/)(openapi|swagger)[^/]*\.(ya?ml|json)$/i
