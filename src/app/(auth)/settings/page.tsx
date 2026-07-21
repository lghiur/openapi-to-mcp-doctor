import { Settings2, Sparkles } from 'lucide-react'
import { getServerSession } from 'next-auth'
import { GithubMark } from '@/components/icons'
import { Header } from '@/components/app-shell/header'
import { authOptions } from '@/lib/auth'
import { MCP_VERSION } from '@/lib/engine'
import { isLlmEnabled } from '@/lib/llm/client'
import { TestConnectionButton } from '@/features/settings/components/TestConnectionButton'

export default async function SettingsPage() {
  const session = await getServerSession(authOptions)
  const llmConfigured = isLlmEnabled(process.env)

  return (
    <div className="flex min-h-screen flex-col">
      <Header />
      <main className="mx-auto w-full max-w-2xl flex-1 space-y-6 px-4 py-10 sm:px-6">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Settings</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Server-side configuration. Secrets stay on the server — never sent to the browser.
          </p>
        </div>

        <Section icon={Sparkles} title="LLM configuration">
          <Row label="Status">
            <span className="inline-flex items-center gap-1.5 text-sm">
              <span
                className={`size-2 rounded-full ${llmConfigured ? 'bg-success' : 'bg-warning'}`}
              />
              {llmConfigured ? 'Configured' : 'Not configured'}
            </span>
          </Row>
          <p className="text-sm text-muted-foreground">
            Set <code className="rounded bg-muted px-1 font-mono text-xs">LLM_BASE_URL</code> and{' '}
            <code className="rounded bg-muted px-1 font-mono text-xs">LLM_API_TOKEN</code> in the
            server environment. The token is read at startup and never logged or exposed.
          </p>
          <TestConnectionButton />
        </Section>

        <Section icon={GithubMark} title="GitHub connection">
          <Row label="Account">
            <span className="text-sm">
              {session?.user?.email ? (
                <span className="font-medium">{session.user.email}</span>
              ) : (
                <span className="text-muted-foreground">Not connected</span>
              )}
            </span>
          </Row>
          <Row label="Scopes">
            <span className="font-mono text-xs text-muted-foreground">repo · read:user</span>
          </Row>
        </Section>

        <Section icon={Settings2} title="Defaults">
          <Row label="MCP spec version">
            <span className="font-mono text-sm">{MCP_VERSION}</span>
          </Row>
          <Row label="Analysis mode">
            <span className="text-sm text-muted-foreground">Lint (report only)</span>
          </Row>
          <Row label="Mismatch mode">
            <span className="text-sm text-muted-foreground">Flag</span>
          </Row>
        </Section>
      </main>
    </div>
  )
}

function Section({
  icon: Icon,
  title,
  children,
}: {
  icon: React.ComponentType<{ className?: string }>
  title: string
  children: React.ReactNode
}) {
  return (
    <section className="rounded-2xl border border-border bg-card p-6">
      <h2 className="mb-4 flex items-center gap-2 text-sm font-semibold">
        <Icon className="size-4 text-primary" />
        {title}
      </h2>
      <div className="space-y-3">{children}</div>
    </section>
  )
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-4 border-b border-border/60 pb-3 last:border-0 last:pb-0">
      <span className="text-sm text-muted-foreground">{label}</span>
      {children}
    </div>
  )
}
