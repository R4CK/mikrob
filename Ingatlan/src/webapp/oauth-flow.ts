// OAuth logic against an INJECTED client port, not a direct google-auth-library import -- so
// this is fully unit-testable with a fake client (no real Google credentials or network access
// needed to prove the logic correct). The composition root (webapp-server.ts) passes a real
// google-auth-library OAuth2Client here, which already structurally satisfies this interface.
export interface TokenResponse {
  tokens: { id_token?: string | null }
}

export interface IdTokenPayload {
  email?: string
  email_verified?: boolean
  name?: string
}

export interface LoginTicketPort {
  getPayload(): IdTokenPayload | undefined
}

export interface OAuthClientPort {
  generateAuthUrl(opts: { access_type: string; scope: string[]; state: string }): string
  getToken(code: string): Promise<TokenResponse>
  verifyIdToken(opts: { idToken: string; audience: string }): Promise<LoginTicketPort>
}

export interface GoogleProfile {
  email: string
  emailVerified: boolean
  name: string | null
}

const SCOPES = ['openid', 'email', 'profile']

// `state` is the caller's CSRF token (see state-store.ts) -- this function does not generate or
// validate it, only carries it through to Google so the callback can be checked against it.
export function buildAuthUrl(client: OAuthClientPort, state: string): string {
  return client.generateAuthUrl({ access_type: 'online', scope: SCOPES, state })
}

export class OAuthExchangeError extends Error {}

export async function exchangeCodeForProfile(
  client: OAuthClientPort,
  code: string,
  clientId: string,
): Promise<GoogleProfile> {
  const { tokens } = await client.getToken(code)
  if (!tokens.id_token) throw new OAuthExchangeError('Google did not return an id_token')

  // audience MUST be checked -- without it, an id_token minted for a DIFFERENT Google OAuth
  // client (any app, not just ours) would verify successfully and grant a session here.
  const ticket = await client.verifyIdToken({ idToken: tokens.id_token, audience: clientId })
  const payload = ticket.getPayload()
  if (!payload?.email) throw new OAuthExchangeError('verified ID token carried no email claim')

  return { email: payload.email, emailVerified: payload.email_verified ?? false, name: payload.name ?? null }
}
