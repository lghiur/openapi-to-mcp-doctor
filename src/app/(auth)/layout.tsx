import { redirect } from 'next/navigation'
import type { ReactNode } from 'react'
import { getOptionalSession } from '@/lib/auth'

/** Auth guard: unauthenticated users are redirected to the landing page. */
export default async function AuthLayout({ children }: { children: ReactNode }) {
  const session = await getOptionalSession()
  if (!session) {
    redirect('/?next=dashboard')
  }
  return <>{children}</>
}
