'use client'

import { LogOut } from 'lucide-react'
import { signIn, signOut } from 'next-auth/react'
import { GithubMark } from '@/components/icons'
import { Button } from '@/components/ui/button'

/** "Connect GitHub" CTA — starts the GitHub OAuth flow. */
export function ConnectGitHubButton({
  size = 'md',
  label = 'Connect GitHub',
  className,
}: {
  size?: 'sm' | 'md' | 'lg'
  label?: string
  className?: string
}) {
  return (
    <Button
      size={size}
      className={className}
      onClick={() => signIn('github', { callbackUrl: '/dashboard' })}
    >
      <GithubMark className="size-4" />
      {label}
    </Button>
  )
}

/** Signed-in identity chip with a sign-out affordance. */
export function UserMenu({ email }: { email: string }) {
  const handle = email.split('@')[0] ?? email
  return (
    <div className="flex items-center gap-2">
      <span className="hidden items-center gap-2 rounded-full border border-border bg-card py-1 pl-1 pr-3 text-sm sm:inline-flex">
        <span className="grid size-6 place-items-center rounded-full bg-primary/15 text-[11px] font-semibold uppercase text-primary">
          {handle.slice(0, 2)}
        </span>
        <span className="text-muted-foreground">@{handle}</span>
      </span>
      <Button
        variant="ghost"
        size="icon"
        aria-label="Sign out"
        onClick={() => signOut({ callbackUrl: '/' })}
      >
        <LogOut className="size-4" />
      </Button>
    </div>
  )
}
