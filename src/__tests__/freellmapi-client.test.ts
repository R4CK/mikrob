// Card 08d1aa90, RedHat NO-GO 25444: freellmapi-client.ts had no test file at all.
// Covers F2 (loopback-only base URL, fail-closed before any network call), the
// single-re-login-on-401 claim, and that the session token/credential never
// reach the logger.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { writeFileSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

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
