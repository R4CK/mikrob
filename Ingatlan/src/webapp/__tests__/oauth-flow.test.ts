import { describe, it, expect, vi } from 'vitest'
import { buildAuthUrl, exchangeCodeForProfile, OAuthExchangeError, type OAuthClientPort } from '../oauth-flow.js'

function fakeClient(overrides: Partial<OAuthClientPort> = {}): OAuthClientPort {
  return {
    generateAuthUrl: vi.fn(() => 'https://accounts.google.com/o/oauth2/v2/auth?fake=1'),
    getToken: vi.fn(async () => ({ tokens: { id_token: 'fake.id.token' } })),
    verifyIdToken: vi.fn(async () => ({
      getPayload: () => ({ email: 'peti@gmail.com', email_verified: true, name: 'Peti' }),
    })),
    ...overrides,
  }
}

describe('buildAuthUrl', () => {
  it('requests the openid/email/profile scopes and passes the state through', () => {
    const client = fakeClient()
    const url = buildAuthUrl(client, 'csrf-state-123')
    expect(url).toBe('https://accounts.google.com/o/oauth2/v2/auth?fake=1')
    expect(client.generateAuthUrl).toHaveBeenCalledWith({
      access_type: 'online',
      scope: ['openid', 'email', 'profile'],
      state: 'csrf-state-123',
    })
  })
})

describe('exchangeCodeForProfile', () => {
  it('happy path: returns the verified email/name/emailVerified', async () => {
    const client = fakeClient()
    const profile = await exchangeCodeForProfile(client, 'auth-code', 'my-client-id')
    expect(profile).toEqual({ email: 'peti@gmail.com', emailVerified: true, name: 'Peti' })
  })

  it('passes the code to getToken and the CLIENT ID as the verifyIdToken audience', async () => {
    const client = fakeClient()
    await exchangeCodeForProfile(client, 'the-auth-code', 'my-client-id')
    expect(client.getToken).toHaveBeenCalledWith('the-auth-code')
    expect(client.verifyIdToken).toHaveBeenCalledWith({ idToken: 'fake.id.token', audience: 'my-client-id' })
  })

  it('throws OAuthExchangeError when Google returns no id_token', async () => {
    const client = fakeClient({ getToken: vi.fn(async () => ({ tokens: {} })) })
    await expect(exchangeCodeForProfile(client, 'code', 'client-id')).rejects.toThrow(OAuthExchangeError)
  })

  it('throws OAuthExchangeError when the verified token carries no email claim', async () => {
    const client = fakeClient({
      verifyIdToken: vi.fn(async () => ({ getPayload: () => ({ name: 'No Email Guy' }) })),
    })
    await expect(exchangeCodeForProfile(client, 'code', 'client-id')).rejects.toThrow(OAuthExchangeError)
  })

  it('throws OAuthExchangeError when getPayload() itself returns undefined', async () => {
    const client = fakeClient({ verifyIdToken: vi.fn(async () => ({ getPayload: () => undefined })) })
    await expect(exchangeCodeForProfile(client, 'code', 'client-id')).rejects.toThrow(OAuthExchangeError)
  })

  it('defaults emailVerified to false and name to null when Google omits them', async () => {
    const client = fakeClient({
      verifyIdToken: vi.fn(async () => ({ getPayload: () => ({ email: 'peti@gmail.com' }) })),
    })
    const profile = await exchangeCodeForProfile(client, 'code', 'client-id')
    expect(profile).toEqual({ email: 'peti@gmail.com', emailVerified: false, name: null })
  })
})
