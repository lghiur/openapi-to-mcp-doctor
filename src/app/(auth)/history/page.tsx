import { getServerSession } from 'next-auth'
import { Header } from '@/components/app-shell/header'
import { authOptions } from '@/lib/auth'
import { computeHealthScore } from '@/lib/engine'
import { getRunStore } from '@/lib/db'
import { HistoryList, type HistoryRow } from '@/features/history/components/HistoryList'

export default async function HistoryPage() {
  const session = await getServerSession(authOptions)
  const runs = getRunStore().listRuns(session?.user?.email ?? undefined)

  const rows: HistoryRow[] = runs.map((run) => ({
    id: run.id,
    repo: run.repo ?? null,
    specFile: run.specFile,
    createdAt: run.createdAt.toISOString().slice(0, 16).replace('T', ' '),
    errors: run.summary.errors,
    warnings: run.summary.warnings,
    total: run.summary.totalFindings,
    score: computeHealthScore(run.summary),
    prUrl: run.prUrl ?? null,
  }))

  return (
    <div className="flex min-h-screen flex-col">
      <Header />
      <main className="mx-auto w-full max-w-4xl flex-1 px-4 py-10 sm:px-6">
        <div className="mb-8">
          <h1 className="text-2xl font-semibold tracking-tight">Analysis history</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Every run is recorded with its findings and health score.
          </p>
        </div>
        {rows.length === 0 ? (
          <p className="rounded-2xl border border-dashed border-border px-6 py-16 text-center text-sm text-muted-foreground">
            No runs yet. Analyse a spec to get started.
          </p>
        ) : (
          <HistoryList runs={rows} />
        )}
      </main>
    </div>
  )
}
