import Link from 'next/link'
import { getOptionalSession } from '@/lib/auth'
import { Logo } from '@/components/logo'
import { ThemeToggle } from '@/components/theme-toggle'
import { NavLinks } from '@/components/app-shell/nav-links'
import { ConnectGitHubButton, UserMenu } from '@/components/app-shell/auth-actions'

/**
 * Global top bar. Shows nav + identity when signed in, otherwise a Connect CTA.
 * Server component — reads the session directly. `showNav` hides links on the
 * public landing page where there is no app context yet.
 */
export async function Header({ showNav = true }: { showNav?: boolean }) {
  const session = await getOptionalSession()
  const email = session?.user?.email ?? undefined

  return (
    <header className="sticky top-0 z-40 border-b border-border/70 bg-background/80 backdrop-blur-md">
      <div className="mx-auto flex h-14 max-w-7xl items-center justify-between gap-4 px-4 sm:px-6">
        <div className="flex items-center gap-6">
          <Logo />
          {/* Public capabilities page — always reachable, signed in or not. */}
          <Link
            href="/platform"
            className="hidden text-sm font-medium text-muted-foreground transition-colors hover:text-foreground sm:block"
          >
            Platform
          </Link>
          {showNav && email && <NavLinks />}
        </div>
        <div className="flex items-center gap-2">
          <ThemeToggle />
          {email ? <UserMenu email={email} /> : <ConnectGitHubButton size="sm" />}
        </div>
      </div>
    </header>
  )
}
