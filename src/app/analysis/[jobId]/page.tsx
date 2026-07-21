import { Header } from '@/components/app-shell/header'
import { AnalysisView } from '@/features/analyze/components/AnalysisView'
import { getJob } from '@/lib/jobs/store'

export default async function AnalysisPage({ params }: { params: Promise<{ jobId: string }> }) {
  const { jobId } = await params
  // Repo-sourced jobs carry their origin; the view uses it to label the spec
  // and to offer "Create PR" (paste jobs get the download-only flow).
  const repoRef = getJob(jobId)?.repo
  const repo = repoRef
    ? { fullName: `${repoRef.owner}/${repoRef.repo}`, branch: repoRef.branch, path: repoRef.path }
    : undefined
  return (
    <div className="flex h-screen flex-col">
      <Header />
      <main className="mx-auto flex w-full max-w-[1400px] flex-1 flex-col gap-3 overflow-hidden px-4 py-4 sm:px-6">
        <AnalysisView jobId={jobId} repo={repo} />
      </main>
    </div>
  )
}
