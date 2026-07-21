import type { Metadata } from 'next'
import Link from 'next/link'
import {
  ArrowRight,
  Boxes,
  Bug,
  CheckCircle2,
  Gauge,
  GitPullRequestArrow,
  History,
  KeyRound,
  Lock,
  MinusCircle,
  Radar,
  ScanText,
  ScrollText,
  ServerOff,
  Share2,
  ShieldCheck,
  Split,
  SquareTerminal,
  TerminalSquare,
  TrendingUp,
  Waypoints,
  Workflow,
  Zap,
} from 'lucide-react'
import { Header } from '@/components/app-shell/header'
import { ConnectGitHubButton } from '@/components/app-shell/auth-actions'
import { Badge } from '@/components/ui/badge'
import type { LucideIcon } from 'lucide-react'

export const metadata: Metadata = {
  title: 'Platform — MCP Doctor for OpenAPI',
  description:
    'Everything MCP Doctor checks before your OpenAPI spec becomes MCP tools — structural linting, AI-grounded fixes, and a spec-detectable OWASP MCP Top 10 security scan.',
}

// --- Capabilities -----------------------------------------------------------

const CAPABILITIES: { icon: LucideIcon; title: string; body: string }[] = [
  {
    icon: ScanText,
    title: 'Structural linter',
    body: 'Deterministic Spectral ruleset — zero LLM, fully anonymous. operationId format, param & enum descriptions, response schemas, tool-count limits.',
  },
  {
    icon: Workflow,
    title: 'AI-grounded analysis',
    body: 'Worker agents judge description quality and MCP semantics per operation, grounded in your real handler code — not guesses.',
  },
  {
    icon: Radar,
    title: 'MCP tool simulation',
    body: 'We render your spec exactly as a converter would — “X of N tools would actually load in Claude or Cursor.” Your own currency for “did the fix work?”',
  },
  {
    icon: ShieldCheck,
    title: 'OWASP MCP security scan',
    body: 'The spec-detectable slice of the OWASP MCP Top 10 — tool poisoning, auth gaps, leaked secrets, over-sharing. Honest about what a static spec can and can’t see.',
  },
  {
    icon: GitPullRequestArrow,
    title: 'GitHub PR workflow',
    body: 'Connect a repo, review every suggestion, open a pull request with accepted fixes. The PR is the edit — no in-app spec editor to trust.',
  },
  {
    icon: Gauge,
    title: 'Incremental caching',
    body: 'A gitignored sidecar hashes spec and handlers independently. 200 endpoints, 3 changed handlers → 3 agent runs, not 200.',
  },
  {
    icon: History,
    title: 'Run history',
    body: 'Every run is an append-only record — which agent found what, what you accepted, what shipped. Full audit trail in web, CLI, and Actions.',
  },
  {
    icon: TerminalSquare,
    title: 'CLI & GitHub Action',
    body: 'The same engine as a lint gate or an auto-fix pipeline. npx, a standalone binary, or a step in your workflow.',
  },
]

// --- Three-tier engine ------------------------------------------------------

const TIERS: { n: string; icon: LucideIcon; title: string; body: string; cost: string }[] = [
  {
    n: '01',
    icon: ScanText,
    title: 'Structural linter',
    body: 'Deterministic rules over the raw spec. Always runs, no inference, publishable as a standalone Spectral ruleset.',
    cost: 'Zero LLM',
  },
  {
    n: '02',
    icon: Workflow,
    title: 'Worker agents',
    body: 'Fan out 3–5 operations per agent. Description quality, MCP semantics, and security judgment in one call per operation.',
    cost: 'Parallel',
  },
  {
    n: '03',
    icon: Split,
    title: 'Orchestrator post-process',
    body: 'One pass over everything: near-duplicate tools, tool-set coherence, and cross-operation scope creep.',
    cost: 'One call',
  },
]

// --- OWASP MCP Top 10 -------------------------------------------------------

type Coverage = 'core' | 'partial' | 'runtime'

interface OwaspRisk {
  id: string
  name: string
  icon: LucideIcon
  coverage: Coverage
  detail: string
}

const OWASP: OwaspRisk[] = [
  {
    id: 'MCP03',
    name: 'Tool Poisoning',
    icon: Bug,
    coverage: 'core',
    detail:
      'The spec IS the tool definition. We scan descriptions, enums and examples for injection strings, hidden Unicode, and instructions aimed at the agent. No linter checks this today.',
  },
  {
    id: 'MCP06',
    name: 'Intent Flow Subversion',
    icon: Waypoints,
    coverage: 'core',
    detail:
      'Same attack surface as tool poisoning — embedded secondary instructions that hijack the agent away from the user’s goal.',
  },
  {
    id: 'MCP07',
    name: 'Insufficient Auth & Authz',
    icon: Lock,
    coverage: 'core',
    detail:
      'Mutating operations with no security requirement, and apiKey-in-query schemes that leak through logs and URLs.',
  },
  {
    id: 'MCP02',
    name: 'Privilege Escalation / Scope Creep',
    icon: TrendingUp,
    coverage: 'core',
    detail:
      'One OAuth scope covering read, write and delete — flagged in orchestrator post-processing, which is the only place that sees every operation at once.',
  },
  {
    id: 'MCP01',
    name: 'Token & Secret Exposure',
    icon: KeyRound,
    coverage: 'partial',
    detail:
      'We catch the spec half: secret-shaped strings in examples, defaults and server URLs. Tokens living in a running server’s memory need runtime scanning.',
  },
  {
    id: 'MCP10',
    name: 'Context Injection & Over-Sharing',
    icon: Share2,
    coverage: 'partial',
    detail:
      'Response schemas that leak PII, tokens or internal fields — detected by field-name patterns, then adjudicated for context by a worker agent.',
  },
  {
    id: 'MCP05',
    name: 'Command Injection & Execution',
    icon: SquareTerminal,
    coverage: 'partial',
    detail:
      'A weaker static signal: free-form cmd / query / path string parameters with no pattern or enum to constrain them.',
  },
  {
    id: 'MCP04',
    name: 'Supply Chain & Dependency Tampering',
    icon: Boxes,
    coverage: 'runtime',
    detail: 'A property of the running server’s dependencies — absent from any spec. Needs runtime scanning.',
  },
  {
    id: 'MCP08',
    name: 'Lack of Audit & Telemetry',
    icon: ScrollText,
    coverage: 'runtime',
    detail: 'Logging and alerting are deployment facts, not spec facts.',
  },
  {
    id: 'MCP09',
    name: 'Shadow MCP Servers',
    icon: ServerOff,
    coverage: 'partial',
    detail:
      'We can only spot the spec-visible tell: a localhost or private-network server left in a published spec. True shadow-deployment detection needs runtime governance.',
  },
]

const COVERAGE_META: Record<
  Coverage,
  { label: string; icon: LucideIcon; pill: string; ring: string }
> = {
  core: {
    label: 'Spec-detectable',
    icon: CheckCircle2,
    pill: 'text-primary',
    ring: 'border-primary/30 hover:border-primary/60',
  },
  partial: {
    label: 'Partial — spec slice only',
    icon: CheckCircle2,
    pill: 'text-info',
    ring: 'border-info/25 hover:border-info/50',
  },
  runtime: {
    label: 'Runtime-only — out of scope',
    icon: MinusCircle,
    pill: 'text-muted-foreground',
    ring: 'border-border opacity-70 hover:opacity-100',
  },
}

const SURFACES: { icon: LucideIcon; title: string; body: string }[] = [
  {
    icon: Zap,
    title: 'Web app',
    body: 'Connect GitHub or paste a spec. Findings stream in live via SSE across a three-panel review console.',
  },
  {
    icon: TerminalSquare,
    title: 'CLI',
    body: 'npx mcp-doctor or a standalone binary — a lint gate locally or anywhere in your ops pipeline.',
  },
  {
    icon: GitPullRequestArrow,
    title: 'GitHub Action',
    body: 'Lint mode blocks CI on regressions; fix mode opens a PR with high-confidence changes.',
  },
]

export default function Platform() {
  const detectable = OWASP.filter((r) => r.coverage !== 'runtime').length

  return (
    <div className="theme-tyk flex min-h-screen flex-col bg-background text-foreground">
      <Header showNav={false} />

      <main className="flex-1">
        {/* Hero */}
        <section className="relative overflow-hidden border-b border-border">
          <div className="bg-grid pointer-events-none absolute inset-0 opacity-30 [mask-image:radial-gradient(ellipse_at_top,black,transparent_65%)]" />
          <div className="absolute left-1/2 top-[-12%] -z-0 size-[560px] -translate-x-1/2 rounded-full bg-primary/25 blur-[130px]" />
          <div className="relative mx-auto max-w-5xl px-6 pb-16 pt-20 text-center">
            <Badge tone="primary" className="mb-5 px-3 py-1">
              <ShieldCheck className="size-3" />
              The pre-flight check for your MCP tools
            </Badge>
            <h1 className="mx-auto max-w-4xl text-balance text-5xl font-semibold tracking-tight sm:text-6xl">
              Ship an OpenAPI spec your agents can{' '}
              <span className="bg-gradient-to-r from-primary to-[var(--tyk-green-soft)] bg-clip-text text-transparent">
                actually use
              </span>{' '}
              — and can’t be turned against you.
            </h1>
            <p className="mx-auto mt-6 max-w-2xl text-pretty text-lg text-muted-foreground">
              MCP Doctor diagnoses every operation before it becomes an MCP tool: structural
              correctness, LLM usability grounded in your real handlers, and the spec-detectable
              slice of the OWASP MCP Top 10.
            </p>
            <div className="mt-9 flex flex-col items-center justify-center gap-3 sm:flex-row">
              <ConnectGitHubButton size="lg" label="Analyse your repo" />
              <Link
                href="/#paste"
                className="inline-flex items-center gap-1.5 text-sm font-medium text-muted-foreground transition-colors hover:text-foreground"
              >
                or paste a spec
                <ArrowRight className="size-4" />
              </Link>
            </div>
          </div>
        </section>

        {/* Capabilities */}
        <section className="mx-auto max-w-6xl px-6 py-20">
          <div className="mx-auto max-w-2xl text-center">
            <h2 className="text-3xl font-semibold tracking-tight">One engine. Every surface.</h2>
            <p className="mt-3 text-muted-foreground">
              A single framework-agnostic core, wrapped by a web app, a CLI, and a GitHub Action.
              Build it once, run it everywhere.
            </p>
          </div>
          <div className="mt-12 grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
            {CAPABILITIES.map(({ icon: Icon, title, body }) => (
              <div
                key={title}
                className="group rounded-2xl border border-border bg-card p-5 transition-colors hover:border-primary/40"
              >
                <div className="mb-3 inline-flex size-10 items-center justify-center rounded-xl bg-primary/10 text-primary transition-transform group-hover:scale-105">
                  <Icon className="size-5" />
                </div>
                <p className="text-[15px] font-semibold">{title}</p>
                <p className="mt-1.5 text-sm leading-relaxed text-muted-foreground">{body}</p>
              </div>
            ))}
          </div>
        </section>

        {/* Three-tier engine */}
        <section className="border-y border-border bg-surface-1/40">
          <div className="mx-auto max-w-6xl px-6 py-20">
            <div className="mx-auto max-w-2xl text-center">
              <Badge tone="neutral" className="mb-4">
                <Workflow className="size-3" />
                How the engine works
              </Badge>
              <h2 className="text-3xl font-semibold tracking-tight">
                Three tiers. No wasted inference.
              </h2>
              <p className="mt-3 text-muted-foreground">
                Every check runs where it belongs — deterministic rules stay free, judgment calls
                ride the worker call, cross-operation checks run once at the end.
              </p>
            </div>
            <div className="mt-12 grid grid-cols-1 gap-5 md:grid-cols-3">
              {TIERS.map(({ n, icon: Icon, title, body, cost }) => (
                <div
                  key={n}
                  className="relative overflow-hidden rounded-2xl border border-border bg-card p-6"
                >
                  <div className="flex items-center justify-between">
                    <span className="grid size-11 place-items-center rounded-xl bg-primary/10 text-primary">
                      <Icon className="size-[22px]" />
                    </span>
                    <span className="tnum text-4xl font-semibold text-border">{n}</span>
                  </div>
                  <p className="mt-4 text-base font-semibold">{title}</p>
                  <p className="mt-1.5 text-sm leading-relaxed text-muted-foreground">{body}</p>
                  <Badge tone="primary" className="mt-4">
                    {cost}
                  </Badge>
                </div>
              ))}
            </div>
          </div>
        </section>

        {/* OWASP MCP Top 10 — the star section */}
        <section className="relative overflow-hidden">
          <div className="absolute right-[-10%] top-1/4 -z-0 size-[480px] rounded-full bg-destructive/10 blur-[140px]" />
          <div className="relative mx-auto max-w-6xl px-6 py-24">
            <div className="mx-auto max-w-3xl text-center">
              <Badge tone="primary" className="mb-4">
                <ShieldCheck className="size-3" />
                OWASP MCP Top 10 · v0.1 (2025)
              </Badge>
              <h2 className="text-balance text-3xl font-semibold tracking-tight sm:text-4xl">
                Security the way a spec can honestly deliver it
              </h2>
              <p className="mt-4 text-pretty text-muted-foreground">
                Most of the OWASP MCP Top 10 is about a{' '}
                <span className="text-foreground">running</span> MCP server. MCP Doctor reads a{' '}
                <span className="text-foreground">static spec</span>. So we scan the risks a spec can
                actually reveal —{' '}
                <span className="font-semibold text-primary">{detectable} of 10</span> — and are
                explicit about the {10 - detectable} that need runtime scanning. No compliance
                theatre.
              </p>
            </div>

            {/* Legend */}
            <div className="mt-8 flex flex-wrap items-center justify-center gap-x-6 gap-y-2 text-xs">
              <span className="inline-flex items-center gap-1.5 text-primary">
                <CheckCircle2 className="size-3.5" /> Spec-detectable
              </span>
              <span className="inline-flex items-center gap-1.5 text-info">
                <CheckCircle2 className="size-3.5" /> Partial — spec slice only
              </span>
              <span className="inline-flex items-center gap-1.5 text-muted-foreground">
                <MinusCircle className="size-3.5" /> Runtime-only — out of scope
              </span>
            </div>

            <div className="mt-10 grid grid-cols-1 gap-4 md:grid-cols-2">
              {OWASP.map(({ id, name, icon: Icon, coverage, detail }) => {
                const meta = COVERAGE_META[coverage]
                const Status = meta.icon
                return (
                  <div
                    key={id}
                    className={`flex gap-4 rounded-2xl border bg-card p-5 transition-all ${meta.ring}`}
                  >
                    <span className="grid size-11 shrink-0 place-items-center rounded-xl bg-secondary text-foreground">
                      <Icon className="size-5" />
                    </span>
                    <div className="min-w-0">
                      <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1">
                        <span className="tnum text-xs font-semibold text-muted-foreground">
                          {id}
                        </span>
                        <span className="text-[15px] font-semibold">{name}</span>
                        <span
                          className={`inline-flex items-center gap-1 text-[11px] font-medium ${meta.pill}`}
                        >
                          <Status className="size-3" />
                          {meta.label}
                        </span>
                      </div>
                      <p className="mt-1.5 text-sm leading-relaxed text-muted-foreground">
                        {detail}
                      </p>
                    </div>
                  </div>
                )
              })}
            </div>

            <p className="mx-auto mt-8 max-w-2xl text-center text-xs leading-relaxed text-muted-foreground">
              Deterministic patterns run in the free Spectral ruleset; ambiguous cases (is this an
              injection or a legitimate note?) are adjudicated by a worker agent. Security findings
              are always flagged for human review — never auto-fixed.
            </p>
          </div>
        </section>

        {/* Surfaces + CTA */}
        <section className="border-t border-border bg-surface-1/40">
          <div className="mx-auto max-w-6xl px-6 py-20">
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
              {SURFACES.map(({ icon: Icon, title, body }) => (
                <div key={title} className="rounded-2xl border border-border bg-card p-5">
                  <Icon className="size-5 text-primary" />
                  <p className="mt-3 text-[15px] font-semibold">{title}</p>
                  <p className="mt-1.5 text-sm leading-relaxed text-muted-foreground">{body}</p>
                </div>
              ))}
            </div>

            <div className="mt-14 rounded-3xl border border-primary/25 bg-card p-10 text-center glow-primary">
              <h2 className="text-balance text-3xl font-semibold tracking-tight">
                Diagnose your spec before your agents do.
              </h2>
              <p className="mx-auto mt-3 max-w-xl text-muted-foreground">
                Free structural report, no account. Connect GitHub for AI-grounded fixes, the OWASP
                security scan, and one-click pull requests.
              </p>
              <div className="mt-7 flex flex-col items-center justify-center gap-3 sm:flex-row">
                <ConnectGitHubButton size="lg" label="Connect GitHub" />
                <Link
                  href="/#paste"
                  className="inline-flex items-center gap-1.5 text-sm font-medium text-muted-foreground transition-colors hover:text-foreground"
                >
                  or paste a spec
                  <ArrowRight className="size-4" />
                </Link>
              </div>
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
