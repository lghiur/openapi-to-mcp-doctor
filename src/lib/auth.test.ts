import { describe, expect, it } from 'vitest'
import { sessionWithAccessToken, withAccessToken } from '@/lib/auth'

describe('withAccessToken', () => {
  it('stores a fresh access token on the JWT', () => {
    expect(withAccessToken({}, { access_token: 'gho_abc' })).toEqual({ accessToken: 'gho_abc' })
  })

  it('leaves the token unchanged when no account is present', () => {
    expect(withAccessToken({ accessToken: 'existing' }, null)).toEqual({ accessToken: 'existing' })
  })
})

describe('sessionWithAccessToken', () => {
  it('copies the access token onto the session', () => {
    const session = { user: 'x' }
    expect(sessionWithAccessToken(session, { accessToken: 'gho_abc' })).toMatchObject({
      user: 'x',
      accessToken: 'gho_abc',
    })
  })
})
