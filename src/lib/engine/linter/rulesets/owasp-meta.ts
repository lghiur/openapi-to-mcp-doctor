/**
 * OWASP MCP Top 10 metadata — pure data, ZERO dependencies (no Spectral, no Node).
 *
 * Kept separate from `mcp-security.ts` so both the engine normalizer AND client
 * components can import it without pulling Spectral into the browser bundle.
 */

/** Rule id → OWASP MCP Top 10 identifier. Single source of truth for tagging. */
export const OWASP_RULE_MAP: Readonly<Record<string, string>> = {
  'owasp-prompt-injection': 'MCP03',
  'owasp-hidden-unicode': 'MCP03',
  'owasp-suspicious-markup': 'MCP06',
  'owasp-secret-in-content': 'MCP01',
  'owasp-credentials-in-server-url': 'MCP01',
  'owasp-insecure-transport': 'MCP01',
  'owasp-no-security-schemes': 'MCP07',
  'owasp-mutating-operation-no-auth': 'MCP07',
  'owasp-apikey-in-query': 'MCP07',
  'owasp-broad-oauth-scope': 'MCP02',
  'owasp-shared-scope-across-verbs': 'MCP02',
  'owasp-unconstrained-command-param': 'MCP05',
  'owasp-response-oversharing': 'MCP10',
  'owasp-local-or-private-server': 'MCP09',
}

/** Human-readable OWASP MCP Top 10 risk names, keyed by id. */
export const OWASP_RISK_NAMES: Readonly<Record<string, string>> = {
  MCP01: 'Token Mismanagement & Secret Exposure',
  MCP02: 'Privilege Escalation via Scope Creep',
  MCP03: 'Tool Poisoning',
  MCP04: 'Software Supply Chain Attacks',
  MCP05: 'Command Injection & Execution',
  MCP06: 'Intent Flow Subversion',
  MCP07: 'Insufficient Authentication & Authorization',
  MCP08: 'Lack of Audit and Telemetry',
  MCP09: 'Shadow MCP Servers',
  MCP10: 'Context Injection & Over-Sharing',
}
