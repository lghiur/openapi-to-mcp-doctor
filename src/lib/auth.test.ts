import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { NextRequest } from 'next/server'

vi.mock('next/headers', () => ({
  cookies: vi.fn(async () => ({
    getAll: () => [{ name: 'next-auth.session-token', value: 'encrypted-jwt' }],
  })),
}))
vi.mock('next-auth/jwt', () => ({
  getToken: vi.fn(),
}))

import { getToken } from 'next-auth/jwt'
import { authOptions, getGitHubAccessToken, withAccessToken } from '@/lib/auth'

beforeEach(() => {
  vi.mocked(getToken).mockReset()
})

describe('withAccessToken', () => {
  it('stores a fresh access token on the JWT', () => {
    expect(withAccessToken({}, { access_token: 'gho_abc' })).toEqual({ accessToken: 'gho_abc' })
  })

  it('leaves the token unchanged when no account is present', () => {
    expect(withAccessToken({ accessToken: 'existing' }, null)).toEqual({ accessToken: 'existing' })
  })
})

describe('session exposure', () => {
  it('has no session callback — the access token must never reach the session object', () => {
    // GET /api/auth/session serves the session verbatim to the browser; copying
    // the GitHub token onto it would expose a repo-scoped token to any XSS.
    expect(authOptions.callbacks?.session).toBeUndefined()
  })
})

describe('getGitHubAccessToken', () => {
  it('decrypts the JWT from the request cookies and returns the access token', async () => {
    vi.mocked(getToken).mockResolvedValue({ accessToken: 'gho_abc' })
    await expect(getGitHubAccessToken()).resolves.toBe('gho_abc')

    // the incoming session cookie was forwarded to getToken
    const params = vi.mocked(getToken).mock.calls[0]?.[0]
    const req = params?.req as NextRequest
    expect(req.headers.get('cookie')).toContain('next-auth.session-token=encrypted-jwt')
  })

  it('returns undefined when there is no session', async () => {
    vi.mocked(getToken).mockResolvedValue(null)
    await expect(getGitHubAccessToken()).resolves.toBeUndefined()
  })

  it('degrades to undefined when token decoding fails', async () => {
    vi.mocked(getToken).mockRejectedValue(new Error('NO_SECRET'))
    await expect(getGitHubAccessToken()).resolves.toBeUndefined()
  })
})
