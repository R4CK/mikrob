import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import type { Server } from 'node:http'
import Database from 'better-sqlite3'
import { openDb, recordSighting } from '../../db.js'
import { createWebappServer, startWebappServer } from '../webapp-server.js'
import type { OAuthClientPort } from '../oauth-flow.js'

const ALLOWED_EMAIL = 'peti@gmail.com'
const CLIENT_ID = 'test-client-id'

function fakeClient(email: string | undefined, emailVerified = true): OAuthClientPort {
  return {
    generateAuthUrl: vi.fn((opts) => `https://accounts.google.com/o/oauth2/v2/auth?state=${opts.state}`),
    getToken: vi.fn(async (code: string) => ({ tokens: { id_token: `id-token-for-${code}` } })),
    verifyIdToken: vi.fn(async () => ({
      getPayload: () => (email ? { email, email_verified: emailVerified, name: 'Test User' } : undefined),
    })),
  }
}

// `fetch` follows redirects by default, which hides the Set-Cookie/Location we need to assert on
// -- every request here opts out explicitly.
const NO_REDIRECT: RequestInit = { redirect: 'manual' }

describe('webapp server (real HTTP, real DB, fake OAuth client)', () => {
  let db: Database.Database
  let server: Server
  let baseUrl: string

  async function start(email: string | undefined = ALLOWED_EMAIL, emailVerified = true) {
    db = openDb(':memory:')
    server = createWebappServer({
      oauthClient: fakeClient(email, emailVerified),
      clientId: CLIENT_ID,
      allowlist: [ALLOWED_EMAIL],
      db,
    })
    const port = await startWebappServer(server, 0)
    baseUrl = `http://127.0.0.1:${port}`
  }

  afterEach(async () => {
    db.close()
    await new Promise((resolve) => server.close(resolve))
  })

  // Drives the real /login -> /auth/google/callback round trip and returns the session cookie.
  async function login(): Promise<string> {
    const loginRes = await fetch(`${baseUrl}/login`, NO_REDIRECT)
    const state = new URL(loginRes.headers.get('location')!).searchParams.get('state')!
    const callbackRes = await fetch(`${baseUrl}/auth/google/callback?code=abc&state=${state}`, NO_REDIRECT)
    const cookieHeader = callbackRes.headers.get('set-cookie')!
    return cookieHeader.split(';')[0] // "ingatlan_session=<id>"
  }

  it('GET /login redirects to the Google auth URL carrying a state param', async () => {
    await start()
    const res = await fetch(`${baseUrl}/login`, NO_REDIRECT)
    expect(res.status).toBe(302)
    expect(res.headers.get('location')).toContain('accounts.google.com')
    expect(res.headers.get('location')).toMatch(/state=[0-9a-f]{48}/)
  })

  it('full login flow: allowed email gets a session cookie and lands on /dashboard', async () => {
    await start(ALLOWED_EMAIL)
    const loginRes = await fetch(`${baseUrl}/login`, NO_REDIRECT)
    const state = new URL(loginRes.headers.get('location')!).searchParams.get('state')!
    const callbackRes = await fetch(`${baseUrl}/auth/google/callback?code=abc&state=${state}`, NO_REDIRECT)
    expect(callbackRes.status).toBe(302)
    expect(callbackRes.headers.get('location')).toBe('/dashboard')
    expect(callbackRes.headers.get('set-cookie')).toContain('ingatlan_session=')
    expect(callbackRes.headers.get('set-cookie')).toContain('HttpOnly')
  })

  it('REGRESSION-CLASS: an email NOT on the allowlist is rejected, no session cookie issued', async () => {
    await start('valaki-mas@gmail.com')
    const loginRes = await fetch(`${baseUrl}/login`, NO_REDIRECT)
    const state = new URL(loginRes.headers.get('location')!).searchParams.get('state')!
    const callbackRes = await fetch(`${baseUrl}/auth/google/callback?code=abc&state=${state}`, NO_REDIRECT)
    expect(callbackRes.status).toBe(403)
    expect(callbackRes.headers.get('set-cookie')).toBeNull()
  })

  it('an UNVERIFIED email (even if it matches the allowlist) is rejected', async () => {
    await start(ALLOWED_EMAIL, false)
    const loginRes = await fetch(`${baseUrl}/login`, NO_REDIRECT)
    const state = new URL(loginRes.headers.get('location')!).searchParams.get('state')!
    const callbackRes = await fetch(`${baseUrl}/auth/google/callback?code=abc&state=${state}`, NO_REDIRECT)
    expect(callbackRes.status).toBe(403)
  })

  it('a missing state param is rejected (400), not silently accepted', async () => {
    await start()
    const res = await fetch(`${baseUrl}/auth/google/callback?code=abc`, NO_REDIRECT)
    expect(res.status).toBe(400)
  })

  it('an unknown/forged state param is rejected (400)', async () => {
    await start()
    const res = await fetch(`${baseUrl}/auth/google/callback?code=abc&state=forged`, NO_REDIRECT)
    expect(res.status).toBe(400)
  })

  it('CSRF REGRESSION: a state can only be used ONCE -- replaying the callback URL fails the second time', async () => {
    await start()
    const loginRes = await fetch(`${baseUrl}/login`, NO_REDIRECT)
    const state = new URL(loginRes.headers.get('location')!).searchParams.get('state')!
    const first = await fetch(`${baseUrl}/auth/google/callback?code=abc&state=${state}`, NO_REDIRECT)
    expect(first.status).toBe(302)
    const replay = await fetch(`${baseUrl}/auth/google/callback?code=abc&state=${state}`, NO_REDIRECT)
    expect(replay.status).toBe(400)
  })

  it('GET /api/trend WITHOUT a session cookie is 401', async () => {
    await start()
    const res = await fetch(`${baseUrl}/api/trend`)
    expect(res.status).toBe(401)
  })

  it('GET /api/trend WITH a valid session cookie returns real data from the DB', async () => {
    await start()
    recordSighting(db, {
      id: 'a', url: 'https://ingatlan.com/a', tipus: 'haz', allapot: null, epitesiEv: null,
      cim: null, alapteruletM2: null, ar: 1000, nm2Ar: 100,
    }, 1000)
    const cookie = await login()
    const res = await fetch(`${baseUrl}/api/trend`, { headers: { Cookie: cookie } })
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(Array.isArray(body)).toBe(true)
    expect(body.length).toBeGreaterThan(0)
  })

  it('an invalid/unknown session cookie is treated as unauthenticated (401), not trusted', async () => {
    await start()
    const res = await fetch(`${baseUrl}/api/trend`, { headers: { Cookie: 'ingatlan_session=not-a-real-session' } })
    expect(res.status).toBe(401)
  })

  it('GET /logout clears the cookie AND invalidates the session server-side', async () => {
    await start()
    const cookie = await login()
    const authedBefore = await fetch(`${baseUrl}/api/trend`, { headers: { Cookie: cookie } })
    expect(authedBefore.status).toBe(200)

    const logoutRes = await fetch(`${baseUrl}/logout`, { headers: { Cookie: cookie }, ...NO_REDIRECT })
    expect(logoutRes.status).toBe(302)
    expect(logoutRes.headers.get('location')).toBe('/login')
    expect(logoutRes.headers.get('set-cookie')).toContain('Max-Age=0')

    // the OLD cookie must no longer work -- logout is a real server-side invalidation, not just
    // a client-side cookie clear the client could ignore.
    const authedAfter = await fetch(`${baseUrl}/api/trend`, { headers: { Cookie: cookie } })
    expect(authedAfter.status).toBe(401)
  })

  it('an unauthenticated page request (not an /api/ path) redirects to /login', async () => {
    await start()
    const res = await fetch(`${baseUrl}/dashboard`, NO_REDIRECT)
    expect(res.status).toBe(302)
    expect(res.headers.get('location')).toBe('/login')
  })

  it('an authenticated page request with no serveDashboard hook gets a 200 placeholder, not a crash', async () => {
    await start()
    const cookie = await login()
    const res = await fetch(`${baseUrl}/dashboard`, { headers: { Cookie: cookie } })
    expect(res.status).toBe(200)
  })

  it('a custom serveDashboard hook is invoked for an authenticated page request', async () => {
    db = openDb(':memory:')
    const serveDashboard = vi.fn((_req, res) => { res.writeHead(200, { 'Content-Type': 'text/html' }); res.end('<html>') })
    server = createWebappServer({
      oauthClient: fakeClient(ALLOWED_EMAIL),
      clientId: CLIENT_ID,
      allowlist: [ALLOWED_EMAIL],
      db,
      serveDashboard,
    })
    const port = await startWebappServer(server, 0)
    baseUrl = `http://127.0.0.1:${port}`
    const cookie = await login()
    const res = await fetch(`${baseUrl}/dashboard`, { headers: { Cookie: cookie } })
    expect(res.status).toBe(200)
    expect(serveDashboard).toHaveBeenCalled()
  })

  it('binds to 127.0.0.1, not 0.0.0.0', async () => {
    await start()
    const addr = server.address()
    expect(typeof addr === 'object' && addr?.address).toBe('127.0.0.1')
  })
})
