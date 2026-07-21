import { getServerSession, type NextAuthOptions, type Session } from 'next-auth'
import GitHubProvider from 'next-auth/providers/github'

/** Merge a freshly-issued GitHub access token into the JWT (pure, testable). */
export function withAccessToken<T extends { accessToken?: string }>(
  token: T,
  account: { access_token?: string | null } | null | undefined,
): T {
  if (account?.access_token) return { ...token, accessToken: account.access_token }
  return token
}

/** Expose the access token on the session for server-side GitHub calls (pure). */
export function sessionWithAccessToken<S extends object>(
  session: S,
  token: { accessToken?: string },
): S & { accessToken?: string } {
  return { ...session, accessToken: token.accessToken }
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
    session({ session, token }) {
      return sessionWithAccessToken(session, token)
    },
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
