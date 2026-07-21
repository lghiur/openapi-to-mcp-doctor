import { describe, expect, it } from 'vitest'
import type { EngineEvent, Finding } from '@/types/domain'
import { encodeSSE, toWireEvent } from '@/lib/jobs/sse'

const finding: Finding = {
  id: 'f1',
  agentId: 'worker-1',
  operation: 'GET /users',
  rule: 'MCP_NO_WHEN_TO_USE',
  severity: 'warning',
  confidence: 'MEDIUM',
  message: 'vague',
  before: 'Returns users',
  after: 'Returns the paginated user list. Use when listing all users.',
  autoFixable: false,
  autoFixed: false,
  resolution: 'pending',
}

describe('toWireEvent', () => {
  it('maps a finding event to the SSE wire shape (before->current, after->suggested)', () => {
    const wire = toWireEvent({ type: 'finding', agentId: 'worker-1', finding })
    expect(wire).toMatchObject({
      type: 'finding',
      agentId: 'worker-1',
      operation: 'GET /users',
      rule: 'MCP_NO_WHEN_TO_USE',
      current: 'Returns users',
      suggested: 'Returns the paginated user list. Use when listing all users.',
      autoFixable: false,
    })
    expect('before' in wire).toBe(false)
  })

  it('passes non-finding events through unchanged', () => {
    const started: EngineEvent = {
      type: 'agent_started',
      agentId: 'worker-1',
      operations: ['GET /x'],
    }
    expect(toWireEvent(started)).toEqual(started)
  })
})

describe('encodeSSE', () => {
  it('formats an event as an SSE frame', () => {
    const frame = encodeSSE({ type: 'agent_started', agentId: 'worker-1', operations: [] })
    expect(frame).toBe(
      'event: agent_started\ndata: {"type":"agent_started","agentId":"worker-1","operations":[]}\n\n',
    )
  })
})
