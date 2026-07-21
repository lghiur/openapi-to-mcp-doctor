import {
  ArrowRight,
  Braces,
  FileWarning,
  GitPullRequestArrow,
  Hash,
  ListChecks,
  ScanText,
  ShieldCheck,
} from 'lucide-react'
import { Header } from '@/components/app-shell/header'
import { ConnectGitHubButton } from '@/components/app-shell/auth-actions'
import { Badge } from '@/components/ui/badge'
import { PasteForm } from '@/features/analyze/components/PasteForm'

const CHECKS = [
  { icon: Hash, title: 'operationId format', body: 'snake_case, unique, ≤ 64 chars for LLM tool APIs.' },
  { icon: ScanText, title: 'Description quality', body: 'Catches missing or vague tool descriptions.' },
  { icon: Braces, title: 'Missing examples', body: 'Flags params and schemas with no example values.' },
  { icon: ListChecks, title: 'Enum gaps', body: 'Every enum value should be documented.' },
  { icon: FileWarning, title: 'Tool-count thresholds', body: 'Warns past Cursor’s 40-tool client limit.' },
  { icon: ShieldCheck, title: 'Near-duplicate tools', body: 'Spots operations an agent can’t tell apart.' },
]

const STEPS = [
  { n: '01', title: 'Connect or paste', body: 'Link a GitHub repo, or paste a spec — no account required.' },
  { n: '02', title: 'Diagnose live', body: 'Structural + AI agents stream findings as they run.' },
  { n: '03', title: 'Fix & ship', body: 'Accept suggestions, download the patched spec, or open a PR.' },
]

export default function Home() {
  return (
    <div className="flex min-h-screen flex-col">
      <Header />

      <main className="flex-1">
        {/* Hero */}
        <section className="relative overflow-hidden border-b border-border">
          <div className="bg-grid pointer-events-none absolute inset-0 opacity-40 [mask-image:radial-gradient(ellipse_at_top,black,transparent_70%)]" />
          <div className="absolute left-1/2 top-[-10%] -z-0 size-[520px] -translate-x-1/2 rounded-full bg-primary/20 blur-[120px]" />
          <div className="relative mx-auto max-w-4xl px-6 pb-14 pt-20 text-center">
            <Badge tone="primary" className="mb-5 px-3 py-1">
              <ShieldCheck className="size-3" />
              MCP spec 2025-11-25 · OpenAPI 3.0 & 3.1
            </Badge>
            <h1 className="mx-auto max-w-3xl text-balance text-5xl font-semibold tracking-tight sm:text-6xl">
              Is your OpenAPI spec ready for{' '}
              <span className="bg-gradient-to-r from-primary to-[oklch(0.7_0.2_330)] bg-clip-text text-transparent">
                AI agents?
              </span>
            </h1>
            <p className="mx-auto mt-5 max-w-xl text-pretty text-lg text-muted-foreground">
              Diagnose and fix your API spec before your MCP tools confuse the model. Grounded in
              your real handler code — not guesses.
            </p>
            <div className="mt-8 flex flex-col items-center justify-center gap-3 sm:flex-row">
              <ConnectGitHubButton size="lg" label="Connect GitHub to analyse your repo" />
              <a
                href="#paste"
                className="inline-flex items-center gap-1.5 text-sm font-medium text-muted-foreground transition-colors hover:text-foreground"
              >
                or paste a spec
                <ArrowRight className="size-4" />
              </a>
            </div>
          </div>
        </section>

        {/* Paste panel */}
        <section id="paste" className="mx-auto max-w-3xl scroll-mt-20 px-6 py-14">
          <div className="mb-5 flex items-end justify-between gap-4">
            <div>
              <h2 className="text-xl font-semibold tracking-tight">Free structural report</h2>
              <p className="mt-1 text-sm text-muted-foreground">
                Deterministic checks, zero LLM, fully anonymous. Paste a spec to get started.
              </p>
            </div>
          </div>
          <div className="rounded-2xl border border-border bg-card p-5 shadow-sm">
            <PasteForm />
          </div>

          {/* Checks grid */}
          <div className="mt-10 grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {CHECKS.map(({ icon: Icon, title, body }) => (
              <div
                key={title}
                className="group rounded-xl border border-border bg-card p-4 transition-colors hover:border-primary/40"
              >
                <div className="mb-2.5 inline-flex size-9 items-center justify-center rounded-lg bg-primary/10 text-primary transition-transform group-hover:scale-105">
                  <Icon className="size-[18px]" />
                </div>
                <p className="text-sm font-semibold">{title}</p>
                <p className="mt-0.5 text-sm text-muted-foreground">{body}</p>
              </div>
            ))}
          </div>
        </section>

        {/* How it works */}
        <section className="border-t border-border bg-surface-1/40">
          <div className="mx-auto max-w-5xl px-6 py-16">
            <h2 className="text-center text-2xl font-semibold tracking-tight">
              From spec to ship in three steps
            </h2>
            <div className="mt-10 grid grid-cols-1 gap-6 md:grid-cols-3">
              {STEPS.map(({ n, title, body }) => (
                <div key={n} className="relative rounded-xl border border-border bg-card p-6">
                  <span className="text-sm font-semibold tnum text-primary">{n}</span>
                  <p className="mt-2 text-base font-semibold">{title}</p>
                  <p className="mt-1.5 text-sm text-muted-foreground">{body}</p>
                </div>
              ))}
            </div>
            <div className="mt-10 flex items-center justify-center gap-2 text-sm text-muted-foreground">
              <GitPullRequestArrow className="size-4 text-primary" />
              Connect a repo to unlock AI-grounded fixes and one-click pull requests.
            </div>
          </div>
        </section>
      </main>

      <footer className="border-t border-border">
        <div className="mx-auto flex max-w-7xl flex-col items-center justify-between gap-3 px-6 py-6 text-sm text-muted-foreground sm:flex-row">
          <span>MCP Doctor — open source OpenAPI diagnostics for the agent era.</span>
          <span className="tnum">© 2026</span>
        </div>
      </footer>
    </div>
  )
}
