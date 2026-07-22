import { getServerSession, type NextAuthOptions, type Session } from 'next-auth'
import { getToken } from 'next-auth/jwt'
import GitHubProvider from 'next-auth/providers/github'
import { cookies } from 'next/headers'
import { NextRequest } from 'next/server'

/** Merge a freshly-issued GitHub access token into the JWT (pure, testable). */
export function withAccessToken<T extends { accessToken?: string }>(
  token: T,
  account: { access_token?: string | null } | null | undefined,
): T {
  if (account?.access_token) return { ...token, accessToken: account.access_token }
  return token
}

export const authOptions: NextAuthOptions = {
  providers: [
    GitHubProvider({
      clientId: process.env.GITHUB_CLIENT_ID ?? '',
      clientSecret: process.env.GITHUB_CLIENT_SECRET ?? '',
      authorization: { params: { scope: 'read:user repo' } },
    }),
  ],
  session: { strategy: 'jwt' },
  callbacks: {
    jwt({ token, account }) {
      return withAccessToken(token, account)
    },
    // SECURITY: no `session` callback on purpose. The GitHub access token lives
    // only in the encrypted JWT cookie; copying it onto the session object would
    // expose it to the browser via GET /api/auth/session (any XSS or extension
    // could read a repo-scoped token). Server code that needs the token must use
    // `getGitHubAccessToken()` below.
  },
}

/**
 * Read the session without ever throwing. next-auth raises in production when
 * `NEXTAUTH_SECRET` is unset; the anonymous landing and paste flows must keep
 * working regardless of auth configuration, so we degrade to "signed out".
 */
export async function getOptionalSession(): Promise<Session | null> {
  try {
    return await getServerSession(authOptions)
  } catch {
    return null
  }
}

/**
 * Server-only: decrypt the session JWT from the request cookies and return the
 * GitHub OAuth access token, or undefined when signed out / unconfigured.
 *
 * This is the ONLY sanctioned way to obtain the token. It never appears on the
 * `Session` object, so it can never be serialized to the client.
 */
export async function getGitHubAccessToken(): Promise<string | undefined> {
  try {
    const jar = await cookies()
    const cookieHeader = jar
      .getAll()
      .map((c) => `${c.name}=${c.value}`)
      .join('; ')
    // getToken expects a request; wrap the incoming cookies in a synthetic one.
    const req = new NextRequest('http://localhost', { headers: { cookie: cookieHeader } })
    const token = await getToken({ req })
    return token?.accessToken
  } catch {
    return undefined
  }
}
