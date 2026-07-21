import type { EngineEvent, SSEEvent } from '@/types/domain'

/**
 * Map an internal `EngineEvent` to the documented wire `SSEEvent`. Only the
 * `finding` variant differs (the engine carries a full `Finding`; the wire uses
 * `current`/`suggested`); all other variants are identical and pass through.
 */
export function toWireEvent(event: EngineEvent): SSEEvent {
  if (event.type !== 'finding') return event
  const f = event.finding
  return {
    type: 'finding',
    id: f.id,
    agentId: event.agentId,
    ...(f.operation !== undefined ? { operation: f.operation } : {}),
    ...(f.operations !== undefined ? { operations: f.operations } : {}),
    rule: f.rule,
    ...(f.owasp !== undefined ? { owasp: f.owasp } : {}),
    severity: f.severity,
    confidence: f.confidence,
    message: f.message,
    ...(f.before !== undefined ? { current: f.before } : {}),
    ...(f.after !== undefined ? { suggested: f.after } : {}),
    ...(f.actual !== undefined ? { actual: f.actual } : {}),
    ...(f.warning !== undefined ? { warning: f.warning } : {}),
    ...(f.path !== undefined ? { path: f.path } : {}),
    autoFixable: f.autoFixable,
  }
}

/** Encode an SSE event as a `event:`/`data:` frame. */
export function encodeSSE(event: SSEEvent): string {
  return `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`
}
