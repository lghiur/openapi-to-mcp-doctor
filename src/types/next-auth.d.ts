import 'next-auth/jwt'

// SECURITY: the GitHub access token is deliberately NOT declared on `Session`.
// It lives only in the encrypted JWT cookie (read server-side via
// `getGitHubAccessToken()` in `@/lib/auth`); putting it on the session would let
// GET /api/auth/session serve it to the browser.
declare module 'next-auth/jwt' {
  interface JWT {
    accessToken?: string
  }
}
