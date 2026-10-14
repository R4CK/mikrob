import { describe, it, expect, beforeAll, beforeEach } from 'vitest'
import type http from 'node:http'
import { Readable } from 'node:stream'
import { initDatabase, getDb } from '../db.js'
import { tryHandleAuth } from '../web/routes/auth.js'
import { _clearDeviceKeyCacheForTest } from '../web/auth-device-keys.js'
import type { RouteContext } from '../web/routes/types.js'

// Card 9655494c F1-B1 (RedHat NO-GO 17005, MikroB decision 17006): mint/rotate/revoke for an
// agent:<id> key is RETIRED from HTTP entirely, under every auth kind -- including a real
// session. The measured bypass this closes: a session proves nothing about a human, because the
// shared dashboard token can itself produce one (X1: create the first user via the bootstrap
// exception, then log in; X3: break-glass-reset an existing owner's password, then log in). This
// file replaces the old "session mints, token is rejected" contract (which the bypass defeated)
// with "nothing over HTTP mints or revokes, regardless of auth kind" -- the capability now lives
// only in the local `dashboard-user` CLI (see store/agent-key-provision.sh and its selftest).

interface MockRes {
  statusCode: number
  body: string
  writeHead(status: number): MockRes
  setHeader(): void
  end(data?: string): void
}

function mkRes(): MockRes {
  return {
    statusCode: 0,
    body: '',
    writeHead(status) {
      this.statusCode = status
      return this
    },
    setHeader() {},
    end(data) {
      if (data !== undefined) this.body += data
    },
  }
}

async function call(
  method: string,
  path: string,
  opts: { body?: unknown; auth?: RouteContext['auth'] } = {},
): Promise<{ status: number; json: () => Record<string, unknown> }> {
  const payload = opts.body === undefined ? [] : [Buffer.from(JSON.stringify(opts.body))]
  const req = Readable.from(payload) as unknown as http.IncomingMessage & Record<string, unknown>
  req.headers = {}
  const res = mkRes()
  const ctx: RouteContext = {
    req: req as http.IncomingMessage,
    res: res as unknown as http.ServerResponse,
    path,
    method,
    url: new URL(`http://127.0.0.1:3420${path}`),
    auth: opts.auth,
  }
  await tryHandleAuth(ctx)
  return { status: res.statusCode, json: () => JSON.parse(res.body || '{}') }
}

const TOKEN_AUTH: RouteContext['auth'] = { kind: 'token' }
const SESSION_AUTH: RouteContext['auth'] = { kind: 'session', user: 'peti' }
const DEVICE_AUTH: RouteContext['auth'] = { kind: 'device', device: 'agent:qa', deviceId: 1 }

beforeAll(() => {
  process.env.NODE_ENV = 'test'
  initDatabase(':memory:')
})

beforeEach(() => {
  _clearDeviceKeyCacheForTest()
  getDb().prepare('DELETE FROM device_keys').run()
})

describe('POST /api/auth/agent-keys (retired from HTTP, F1-B1)', () => {
  // X1/X3 (RedHat 17005): the whole point is that a SESSION must not be trusted here either --
  // a session is exactly the thing the shared token could forge via bootstrap or break-glass.
  it.each([
    ['session (even a real, non-forged one)', SESSION_AUTH],
    ['the shared dashboard token', TOKEN_AUTH],
    ['an authenticated agent:<id> device key', DEVICE_AUTH],
    ['no auth at all', undefined],
  ])('%s: refused with 403, nothing stored', async (_label, auth) => {
    const r = await call('POST', '/api/auth/agent-keys', { body: { agent_id: 'backend' }, auth })
    expect(r.status).toBe(403)
    expect(getDb().prepare('SELECT COUNT(*) AS n FROM device_keys').get()).toEqual({ n: 0 })
  })

  it('X1 repro: a token-created bootstrap session still cannot mint (401/403 chain break)', async () => {
    // The bootstrap/break-glass exception itself is a separate card (6eca461e per MikroB 17006);
    // this only re-asserts that EVEN IF a session exists, the agent-keys route itself refuses it.
    const r = await call('POST', '/api/auth/agent-keys', { body: { agent_id: 'qa' }, auth: SESSION_AUTH })
    expect(r.status).toBe(403)
  })
})

describe('DELETE /api/auth/agent-keys/:agentId (retired from HTTP, F1-B1)', () => {
  it.each([
    ['session', SESSION_AUTH],
    ['the shared dashboard token', TOKEN_AUTH],
    ['an authenticated agent:<id> device key', DEVICE_AUTH],
    ['no auth at all', undefined],
  ])('%s: refused with 403, regardless of whether a key exists', async (_label, auth) => {
    const r = await call('DELETE', '/api/auth/agent-keys/backend', { auth })
    expect(r.status).toBe(403)
  })
})

describe('the general device-key route is unaffected by the retirement', () => {
  it('still mints a plain device key for a session, and still rejects a colon-bearing name', async () => {
    const ok = await call('POST', '/api/auth/device-keys', { body: { name: 'Petis phone' }, auth: SESSION_AUTH })
    expect(ok.status).toBe(201)
    const bad = await call('POST', '/api/auth/device-keys', { body: { name: 'agent:backend' }, auth: SESSION_AUTH })
    expect(bad.status).toBe(400)
  })
})
