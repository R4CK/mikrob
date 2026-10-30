// Card 08d1aa90, RedHat NO-GO 25444: freellmapi-client.ts had no test file at all.
// Covers F2 (loopback-only base URL, fail-closed before any network call), the
// single-re-login-on-401 claim, and that the session token/credential never
// reach the logger.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { writeFileSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createServer, type Server } from 'node:http'

const logCalls: unknown[] = []
vi.mock('../logger.js', () => ({
  logger: {
    info: (...a: unknown[]) => logCalls.push(a),
    warn: (...a: unknown[]) => logCalls.push(a),
    error: (...a: unknown[]) => logCalls.push(a),
    debug: (...a: unknown[]) => logCalls.push(a),
  },
}))

const TMP_DIR = mkdtempSync(join(tmpdir(), 'freellmapi-client-test-'))
const CRED_FILE = join(TMP_DIR, 'admin')
const CREDENTIAL_PASSWORD = 'secret-admin-password-9f3c7a'
writeFileSync(CRED_FILE, `admin@test.local:${CREDENTIAL_PASSWORD}\n`)

async function freshClient() {
  vi.resetModules()
  return import('../web/freellmapi-client.js')
}

beforeEach(() => {
  logCalls.length = 0
  process.env.FREELLMAPI_ADMIN_CREDENTIAL_FILE = CRED_FILE
})

afterEach(() => {
  delete process.env.FREELLMAPI_BASE_URL
  delete process.env.FREELLMAPI_ADMIN_CREDENTIAL_FILE
  vi.unstubAllGlobals()
})

describe('freellmapi-client', () => {
  it('refuses a non-loopback base URL fail-closed, before any network call (RedHat F2, comment 25444)', async () => {
    process.env.FREELLMAPI_BASE_URL = 'http://evil.example.com:9999'
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    const { freellmapiRequest, FreellmapiUnavailableError } = await freshClient()
    await expect(freellmapiRequest('GET', '/api/keys')).rejects.toBeInstanceOf(FreellmapiUnavailableError)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('accepts the default loopback base URL and proceeds to the network call', async () => {
    process.env.FREELLMAPI_BASE_URL = 'http://127.0.0.1:3001'
    const fetchMock = vi.fn()
      .mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ token: 'tok-1' }) })
      .mockResolvedValueOnce({ ok: true, status: 200, json: async () => ([]) })
    vi.stubGlobal('fetch', fetchMock)
    const { freellmapiRequest } = await freshClient()
    const result = await freellmapiRequest('GET', '/api/keys')
    expect(result.status).toBe(200)
    expect(fetchMock).toHaveBeenCalled()
  })

  it('re-logs in exactly once after a 401, then retries the request once', async () => {
    process.env.FREELLMAPI_BASE_URL = 'http://127.0.0.1:3001'
    const fetchMock = vi.fn()
      .mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ token: 'tok-1' }) }) // initial login
      .mockResolvedValueOnce({ ok: false, status: 401, json: async () => ({}) }) // first request -> 401
      .mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ token: 'tok-2' }) }) // re-login
      .mockResolvedValueOnce({ ok: true, status: 200, json: async () => ([]) }) // retried request
    vi.stubGlobal('fetch', fetchMock)
    const { freellmapiRequest } = await freshClient()
    const result = await freellmapiRequest('GET', '/api/keys')
    expect(result.status).toBe(200)
    expect(fetchMock).toHaveBeenCalledTimes(4)
    const loginCalls = fetchMock.mock.calls.filter((c) => String(c[0]).includes('/api/auth/login'))
    expect(loginCalls).toHaveLength(2)
  })

  it('backs off after a failed login instead of retrying immediately (WhiteHat2 L4, comment 25458)', async () => {
    process.env.FREELLMAPI_BASE_URL = 'http://127.0.0.1:3001'
    const fetchMock = vi.fn()
      .mockResolvedValueOnce({ ok: false, status: 401, json: async () => ({}) }) // first login fails (bad credential)
    vi.stubGlobal('fetch', fetchMock)
    const { freellmapiRequest, FreellmapiUnavailableError } = await freshClient()
    await expect(freellmapiRequest('GET', '/api/keys')).rejects.toThrow()
    // A second call right after the failed login must NOT attempt another login
    // (freellmapi locks the account out after 5 bad logins) -- it should fail
    // fast instead, with no additional fetch call at all.
    await expect(freellmapiRequest('GET', '/api/keys')).rejects.toBeInstanceOf(FreellmapiUnavailableError)
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('keeps failed logins under the upstream 5-bad-logins/15-min lockout (WhiteHat2 GO 25458 LOW-4, card 3c9c3a10)', async () => {
    process.env.FREELLMAPI_BASE_URL = 'http://127.0.0.1:3001'
    vi.useFakeTimers()
    const fetchMock = vi.fn().mockResolvedValue({ ok: false, status: 401, json: async () => ({}) })
    vi.stubGlobal('fetch', fetchMock)
    const { freellmapiRequest } = await freshClient()
    const WINDOW_MS = 15 * 60_000
    const start = Date.now()
    let loginAttempts = 0
    while (Date.now() - start < WINDOW_MS) {
      try {
        await freellmapiRequest('GET', '/api/keys')
      } catch {
        // expected: every call either logs in and fails, or backs off
      }
      loginAttempts = fetchMock.mock.calls.length
      await vi.advanceTimersByTimeAsync(5_000)
    }
    expect(loginAttempts).toBeLessThan(5)
    vi.useRealTimers()
  })

  it('does not follow a redirect from the base URL on login (WhiteHat2 GO 25458 LOW-3, card 3c9c3a10)', async () => {
    // Real (unstubbed) fetch against a real loopback server that issues a 307 --
    // redirect:'error' is a fetch option, so a mocked fetch can't exercise it.
    let redirectTargetHit = false
    const redirectTarget: Server = createServer((_req, res) => {
      redirectTargetHit = true
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end('{}')
    })
    await new Promise<void>((resolve) => redirectTarget.listen(0, '127.0.0.1', resolve))
    const targetPort = (redirectTarget.address() as { port: number }).port

    const redirector: Server = createServer((_req, res) => {
      res.writeHead(307, { Location: `http://127.0.0.1:${targetPort}/` })
      res.end()
    })
    await new Promise<void>((resolve) => redirector.listen(0, '127.0.0.1', resolve))
    const redirectorPort = (redirector.address() as { port: number }).port

    process.env.FREELLMAPI_BASE_URL = `http://127.0.0.1:${redirectorPort}`
    const { freellmapiRequest, FreellmapiUnavailableError } = await freshClient()
    await expect(freellmapiRequest('GET', '/api/keys')).rejects.toBeInstanceOf(FreellmapiUnavailableError)
    expect(redirectTargetHit).toBe(false)

    await new Promise<void>((resolve) => redirector.close(() => resolve()))
    await new Promise<void>((resolve) => redirectTarget.close(() => resolve()))
  })

  it('does not follow a redirect from the base URL on a request AFTER a successful login (WhiteHat2 GO 25458 LOW-3, card 3c9c3a10)', async () => {
    // Login succeeds directly (no redirect); the subsequent GET is what gets
    // redirected -- this exercises the second fetch call (doFetch), not login's.
    let redirectTargetHit = false
    const redirectTarget: Server = createServer((_req, res) => {
      redirectTargetHit = true
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end('[]')
    })
    await new Promise<void>((resolve) => redirectTarget.listen(0, '127.0.0.1', resolve))
    const targetPort = (redirectTarget.address() as { port: number }).port

    const server: Server = createServer((req, res) => {
      if (req.url === '/api/auth/login') {
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ token: 'tok-redirect-test' }))
        return
      }
      res.writeHead(307, { Location: `http://127.0.0.1:${targetPort}/api/keys` })
      res.end()
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const serverPort = (server.address() as { port: number }).port

    process.env.FREELLMAPI_BASE_URL = `http://127.0.0.1:${serverPort}`
    const { freellmapiRequest, FreellmapiUnavailableError } = await freshClient()
    await expect(freellmapiRequest('GET', '/api/keys')).rejects.toBeInstanceOf(FreellmapiUnavailableError)
    expect(redirectTargetHit).toBe(false)

    await new Promise<void>((resolve) => server.close(() => resolve()))
    await new Promise<void>((resolve) => redirectTarget.close(() => resolve()))
  })

  it('never logs the session token or the credential password', async () => {
    process.env.FREELLMAPI_BASE_URL = 'http://127.0.0.1:3001'
    const SESSION_TOKEN = 'super-secret-session-token-should-never-leak'
    const fetchMock = vi.fn()
      .mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ token: SESSION_TOKEN }) })
      .mockResolvedValueOnce({ ok: true, status: 200, json: async () => ([]) })
    vi.stubGlobal('fetch', fetchMock)
    const { freellmapiRequest } = await freshClient()
    await freellmapiRequest('GET', '/api/keys')
    expect(JSON.stringify(logCalls)).not.toContain(SESSION_TOKEN)
    expect(JSON.stringify(logCalls)).not.toContain(CREDENTIAL_PASSWORD)
  })
})
