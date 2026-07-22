import { AlertTriangle, FolderGit2, Inbox } from 'lucide-react'
import { getServerSession } from 'next-auth'
import Link from 'next/link'
import { Header } from '@/components/app-shell/header'
import { HealthRing } from '@/components/ui/health-ring'
import { authOptions, getGitHubAccessToken } from '@/lib/auth'
import { computeHealthScore } from '@/lib/engine'
import { getRunStore } from '@/lib/db'
import { createGitHubClient, type RepoSummary } from '@/lib/github/client'
import { isLlmEnabled } from '@/lib/llm/client'
import { RepoBrowser } from '@/features/github/components/RepoBrowser'

export default async function DashboardPage() {
  const session = await getServerSession(authOptions)
  // The GitHub token is read server-side from the JWT cookie — it is never on
  // the session object (which the browser can fetch via /api/auth/session).
  const token = await getGitHubAccessToken()
  const llmConfigured = isLlmEnabled(process.env)

  let repos: RepoSummary[] = []
  let error: string | null = null
  if (token) {
    try {
      repos = await createGitHubClient(token).listRepos()
    } catch {
      error = 'Could not load repositories. Re-connect GitHub and try again.'
    }
  }

  const runs = getRunStore().listRuns(session?.user?.email ?? undefined).slice(0, 6)

  return (
    <div className="flex min-h-screen flex-col">
      <Header />
      <main className="mx-auto w-full max-w-4xl flex-1 px-4 py-10 sm:px-6">
        <div className="mb-8">
          <h1 className="text-2xl font-semibold tracking-tight">Select a repository</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Pick a repo to analyse its OpenAPI spec — Vercel-style. Configure branch, mode, and
            optional codebase grounding inline.
          </p>
        </div>

        {error && (
          <div className="mb-6 flex items-center gap-2 rounded-xl border border-error/30 bg-error/8 px-4 py-3 text-sm text-error">
            <AlertTriangle className="size-4" />
            {error}
          </div>
        )}

        {!error && repos.length === 0 ? (
          <EmptyRepos />
        ) : (
          <RepoBrowser repos={repos} llmConfigured={llmConfigured} />
        )}

        {/* Recent analyses */}
        <section className="mt-12">
          <h2 className="mb-3 flex items-center gap-2 text-sm font-semibold uppercase tracking-wide text-muted-foreground">
            <FolderGit2 className="size-4" />
            Recent analyses
          </h2>
          {runs.length === 0 ? (
            <p className="rounded-xl border border-dashed border-border px-4 py-8 text-center text-sm text-muted-foreground">
              No analyses yet. Run one above to see it here.
            </p>
          ) : (
            <div className="grid gap-3 sm:grid-cols-2">
              {runs.map((run) => {
                const score = computeHealthScore(run.summary)
                return (
                  <Link
                    key={run.id}
                    href={`/history/${run.id}`}
                    className="flex items-center gap-4 rounded-xl border border-border bg-card p-4 transition-colors hover:border-primary/40"
                  >
                    <HealthRing score={score} size={52} stroke={5} />
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-sm font-medium">{run.repo ?? run.specFile}</p>
                      <p className="mt-0.5 truncate font-mono text-xs text-muted-foreground">
                        {run.specFile}
                      </p>
                      <p className="tnum mt-1 text-xs text-muted-foreground">
                        {run.summary.errors} errors · {run.summary.warnings} warnings ·{' '}
                        {run.createdAt.toISOString().slice(0, 10)}
                      </p>
                    </div>
                  </Link>
                )
              })}
            </div>
          )}
        </section>
      </main>
    </div>
  )
}

function EmptyRepos() {
  return (
    <div className="flex flex-col items-center gap-3 rounded-2xl border border-dashed border-border bg-grid px-6 py-16 text-center">
      <span className="grid size-12 place-items-center rounded-xl bg-muted text-muted-foreground">
        <Inbox className="size-6" />
      </span>
      <p className="text-sm font-medium">No repositories found</p>
      <p className="max-w-sm text-sm text-muted-foreground">
        Make sure the GitHub App has access to the repos you want to analyse, then refresh.
      </p>
    </div>
  )
}
