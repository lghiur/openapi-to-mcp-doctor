import { mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { openRunStore, type RunStore } from '@/lib/db/runs'

let store: RunStore | null = null

/** Process-wide run store singleton (SQLite file under MCP_DOCTOR_DB or cwd). */
export function getRunStore(): RunStore {
  if (!store) {
    const file = process.env.MCP_DOCTOR_DB ?? join(process.cwd(), '.mcp-doctor', 'web.db')
    mkdirSync(dirname(file), { recursive: true })
    store = openRunStore(file)
  }
  return store
}

export type { RunStore }
