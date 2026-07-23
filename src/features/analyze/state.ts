import type { AnalysisPhase, FileReadRole, SSEEvent, SSEFinding } from '@/types/domain'

/** One file a grounding agent read — the evidence trail shown in the UI. */
export interface FileReadActivity {
  agentId: string
  path: string
  operation?: string
  linesRead?: number
  line?: number
  role?: FileReadRole
  symbol?: string
}

export interface AgentActivity {
  agentId: string
  operations: string[]
  findingsCount?: number
  durationMs?: number
  done: boolean
  /** Set when the agent failed — zero findings from it mean "errored", not "clean". */
  error?: string
}

/** Lifecycle of a single pipeline phase as the run progresses. */
export type PhaseStatus = 'pending' | 'active' | 'done'

export interface AnalysisState {
  agents: AgentActivity[]
  findings: SSEFinding[]
  filesRead: FileReadActivity[]
  complete: boolean
  /** Every operation in the spec, known up front — the denominator for "X of N". */
  operations: string[]
  /** The pipeline phases this run will go through, in order. */
  plannedPhases: AnalysisPhase[]
  /** Per-phase lifecycle, keyed by phase; only planned phases are present. */
  phaseStatus: Partial<Record<AnalysisPhase, PhaseStatus>>
  /** Run caveats the user must see (e.g. only part of the codebase was read). */
  notices: string[]
  totals?: { total: number; errors: number; warnings: number; info: number; durationMs: number }
}

export const initialAnalysisState: AnalysisState = {
  agents: [],
  findings: [],
  filesRead: [],
  complete: false,
  operations: [],
  plannedPhases: [],
  phaseStatus: {},
  notices: [],
}

/** Set one phase's status, returning a new phaseStatus map (no-op if not planned). */
function setPhase(
  status: AnalysisState['phaseStatus'],
  phase: AnalysisPhase,
  value: PhaseStatus,
): AnalysisState['phaseStatus'] {
  if (!(phase in status)) return status
  return { ...status, [phase]: value }
}

/** A local control action (not from the wire) used to restart a stream. */
export type AnalysisAction = SSEEvent | { type: 'reset' }

/** Fold one SSE event (or a local control action) into the analysis UI state. */
export function analysisReducer(state: AnalysisState, event: AnalysisAction): AnalysisState {
  switch (event.type) {
    case 'reset':
      return initialAnalysisState
    case 'analysis_started':
      return {
        ...state,
        operations: event.operations,
        plannedPhases: event.phases,
        phaseStatus: Object.fromEntries(event.phases.map((p) => [p, 'pending'])),
      }
    case 'agent_started': {
      // The structural linter drives the 'structural' phase; everything else
      // (worker-N) drives the 'workers' phase.
      const phase: AnalysisPhase =
        event.agentId === 'structural-linter' ? 'structural' : 'workers'
      return {
        ...state,
        phaseStatus: setPhase(state.phaseStatus, phase, 'active'),
        agents: [
          ...state.agents,
          { agentId: event.agentId, operations: event.operations, done: false },
        ],
      }
    }
    case 'agent_completed': {
      // Structural, post-process ('orchestrator') and grounding each close their
      // own phase; workers' phase closes when post-processing starts or at
      // analysis_complete.
      const phaseFor: Partial<Record<string, AnalysisPhase>> = {
        'structural-linter': 'structural',
        orchestrator: 'postprocess',
        grounding: 'grounding',
      }
      const phase = phaseFor[event.agentId]
      const phaseStatus = phase ? setPhase(state.phaseStatus, phase, 'done') : state.phaseStatus
      return {
        ...state,
        phaseStatus,
        agents: state.agents.map((agent) =>
          agent.agentId === event.agentId
            ? {
                ...agent,
                done: true,
                findingsCount: event.findingsCount,
                durationMs: event.durationMs,
                ...(event.error !== undefined ? { error: event.error } : {}),
              }
            : agent,
        ),
      }
    }
    case 'postprocess_started':
      return {
        ...state,
        phaseStatus: setPhase(
          setPhase(state.phaseStatus, 'workers', 'done'),
          'postprocess',
          'active',
        ),
      }
    case 'file_read':
      return {
        ...state,
        phaseStatus: setPhase(state.phaseStatus, 'grounding', 'active'),
        filesRead: [
          ...state.filesRead,
          {
            agentId: event.agentId,
            path: event.path,
            ...(event.operation !== undefined ? { operation: event.operation } : {}),
            ...(event.linesRead !== undefined ? { linesRead: event.linesRead } : {}),
            ...(event.line !== undefined ? { line: event.line } : {}),
            ...(event.role !== undefined ? { role: event.role } : {}),
            ...(event.symbol !== undefined ? { symbol: event.symbol } : {}),
          },
        ],
      }
    case 'finding': {
      const { type: _type, ...finding } = event
      // Upsert by id: the fix-suggester re-emits structural findings enriched
      // with an authored fix — replace the diagnostic in place, keep its position.
      const index = state.findings.findIndex((f) => f.id === finding.id)
      if (index !== -1) {
        const findings = [...state.findings]
        findings[index] = finding satisfies SSEFinding
        return { ...state, findings }
      }
      return { ...state, findings: [...state.findings, finding satisfies SSEFinding] }
    }
    case 'notice':
      // De-duplicated: a replayed or repeated caveat must not stack up.
      return state.notices.includes(event.message)
        ? state
        : { ...state, notices: [...state.notices, event.message] }
    case 'analysis_complete':
      return {
        ...state,
        complete: true,
        phaseStatus: Object.fromEntries(state.plannedPhases.map((p) => [p, 'done'])),
        totals: {
          total: event.totalFindings,
          errors: event.errors,
          warnings: event.warnings,
          info: event.info,
          durationMs: event.durationMs,
        },
      }
    default:
      return state
  }
}
