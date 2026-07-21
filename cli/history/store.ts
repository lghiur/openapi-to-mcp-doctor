import { mkdir, readFile, readdir, unlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { DEFAULT_HISTORY_LIMIT } from '@/lib/engine/constants'
import type { AnalysisRun } from '@/types/domain'

const RUNS_SUBDIR = join('.mcp-doctor', 'runs')

function runsDir(baseDir: string): string {
  return join(baseDir, RUNS_SUBDIR)
}

function sortableTimestamp(date: Date): string {
  return date.toISOString().replace(/[:.]/g, '-')
}

/** Persist a run as one JSON file and prune to the last `limit` runs. */
export async function saveRun(
  run: AnalysisRun,
  baseDir: string,
  limit: number = DEFAULT_HISTORY_LIMIT,
): Promise<string> {
  const dir = runsDir(baseDir)
  await mkdir(dir, { recursive: true })
  const fileName = `${sortableTimestamp(run.createdAt)}-${run.id}.json`
  const filePath = join(dir, fileName)
  await writeFile(filePath, `${JSON.stringify(run, null, 2)}\n`)
  await prune(dir, limit)
  return filePath
}

/** All runs, newest first. Returns [] when no history exists. */
export async function listRuns(baseDir: string): Promise<AnalysisRun[]> {
  const dir = runsDir(baseDir)
  let files: string[]
  try {
    files = (await readdir(dir)).filter((f) => f.endsWith('.json'))
  } catch {
    return []
  }
  const runs = await Promise.all(files.map((file) => readRunFile(join(dir, file))))
  return runs
    .filter((r): r is AnalysisRun => r !== null)
    .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
}

export async function getRun(baseDir: string, id: string): Promise<AnalysisRun | null> {
  const runs = await listRuns(baseDir)
  return runs.find((r) => r.id === id) ?? null
}

async function readRunFile(filePath: string): Promise<AnalysisRun | null> {
  try {
    const parsed = JSON.parse(await readFile(filePath, 'utf8')) as AnalysisRun
    return { ...parsed, createdAt: new Date(parsed.createdAt) }
  } catch {
    return null
  }
}

async function prune(dir: string, limit: number): Promise<void> {
  const files = (await readdir(dir)).filter((f) => f.endsWith('.json')).sort()
  if (files.length <= limit) return
  const toDelete = files.slice(0, files.length - limit)
  await Promise.all(toDelete.map((file) => unlink(join(dir, file))))
}
