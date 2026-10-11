import { describe, it, expect, beforeAll, beforeEach } from 'vitest'
import type http from 'node:http'
import { Readable } from 'node:stream'
import { initDatabase, getDb } from '../db.js'
import { tryHandleAuth } from '../web/routes/auth.js'
import {
  resolveDeviceKey,
  listDeviceKeys,
  _clearDeviceKeyCacheForTest,
} from '../web/auth-device-keys.js'
import type { RouteContext } from '../web/routes/types.js'

// Card 9655494c (F1): issuance side of the agent:<id> convention (84dcc5d4 built only the
// consumer). Contract under test:
//   - minting an agent key requires a 'session' principal; the shared 'token' is REJECTED
//     (the card: "a közös token ne tudjon agent-kulcsot kiállítani");
//   - agent_id comes from its own field, validated by its own regex -- never parsed out of a
//     free-text name, and the general device-key route's name regex is UNCHANGED (still rejects
//     the colon);
//   - a second mint for the same agent_id without rotate:true is refused (409), so a key is never
//     silently duplicated;
//   - rotate:true revokes the old key(s) first, then mints a fresh one -- the old raw key stops
//     resolving;
//   - revoke (DELETE) is also session-only, and makes the key stop resolving immediately.

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

beforeAll(() => {
  process.env.NODE_ENV = 'test'
  initDatabase(':memory:')
})

beforeEach(() => {
  _clearDeviceKeyCacheForTest()
  getDb().prepare('DELETE FROM device_keys').run()
})

describe('POST /api/auth/agent-keys', () => {
  it('session auth mints a key, stored name is agent:<id>', async () => {
    const r = await call('POST', '/api/auth/agent-keys', { body: { agent_id: 'backend' }, auth: SESSION_AUTH })
    expect(r.status).toBe(201)
    const body = r.json()
    expect(body.ok).toBe(true)
    expect(body.agent_id).toBe('backend')
    expect(typeof body.key).toBe('string')
    const rows = getDb().prepare('SELECT name FROM device_keys').all() as { name: string }[]
    expect(rows).toHaveLength(1)
    expect(rows[0]!.name).toBe('agent:backend')
  })

  it('the shared dashboard token is REJECTED (403) -- cannot issue an agent key', async () => {
    const r = await call('POST', '/api/auth/agent-keys', { body: { agent_id: 'backend' }, auth: TOKEN_AUTH })
    expect(r.status).toBe(403)
    expect(getDb().prepare('SELECT COUNT(*) AS n FROM device_keys').get()).toEqual({ n: 0 })
  })

  it('no auth at all is rejected', async () => {
    const r = await call('POST', '/api/auth/agent-keys', { body: { agent_id: 'backend' } })
    expect(r.status).toBe(403)
  })

  it('an invalid agent_id (uppercase, colon, empty) is rejected with 400, nothing stored', async () => {
    for (const bad of ['Backend', 'agent:backend', '', '-backend', '1backend', 'a'.repeat(33)]) {
      const r = await call('POST', '/api/auth/agent-keys', { body: { agent_id: bad }, auth: SESSION_AUTH })
      expect(r.status).toBe(400)
    }
    expect(getDb().prepare('SELECT COUNT(*) AS n FROM device_keys').get()).toEqual({ n: 0 })
  })

  it('the general device-key route still rejects a colon-bearing name (unchanged, not loosened)', async () => {
    const r = await call('POST', '/api/auth/device-keys', { body: { name: 'agent:backend' }, auth: SESSION_AUTH })
    expect(r.status).toBe(400)
  })

  it('minting the SAME agent_id twice without rotate is refused (409), the original key survives', async () => {
    const first = await call('POST', '/api/auth/agent-keys', { body: { agent_id: 'backend' }, auth: SESSION_AUTH })
    expect(first.status).toBe(201)
    const again = await call('POST', '/api/auth/agent-keys', { body: { agent_id: 'backend' }, auth: SESSION_AUTH })
    expect(again.status).toBe(409)
    expect(getDb().prepare('SELECT COUNT(*) AS n FROM device_keys').get()).toEqual({ n: 1 })
    expect(resolveDeviceKey(first.json().key as string)).not.toBeNull()
  })

  it('rotate:true revokes the old key and mints a fresh one; the old raw key stops resolving', async () => {
    const first = await call('POST', '/api/auth/agent-keys', { body: { agent_id: 'backend' }, auth: SESSION_AUTH })
    const oldKey = first.json().key as string
    expect(resolveDeviceKey(oldKey)).not.toBeNull()

    const rotated = await call('POST', '/api/auth/agent-keys', { body: { agent_id: 'backend', rotate: true }, auth: SESSION_AUTH })
    expect(rotated.status).toBe(201)
    const body = rotated.json()
    expect(body.rotated).toBe(1)
    const newKey = body.key as string
    expect(newKey).not.toBe(oldKey)

    expect(resolveDeviceKey(oldKey)).toBeNull()
    expect(resolveDeviceKey(newKey)).not.toBeNull()
    expect(getDb().prepare('SELECT COUNT(*) AS n FROM device_keys').get()).toEqual({ n: 1 })
  })

  it('rotate:true on a never-minted agent_id just mints (rotated:0), no error', async () => {
    const r = await call('POST', '/api/auth/agent-keys', { body: { agent_id: 'fresh', rotate: true }, auth: SESSION_AUTH })
    expect(r.status).toBe(201)
    expect(r.json().rotated).toBe(0)
  })
})

describe('DELETE /api/auth/agent-keys/:agentId', () => {
  it('session auth revokes the key; it stops resolving immediately', async () => {
    const minted = await call('POST', '/api/auth/agent-keys', { body: { agent_id: 'backend' }, auth: SESSION_AUTH })
    const key = minted.json().key as string
    const del = await call('DELETE', '/api/auth/agent-keys/backend', { auth: SESSION_AUTH })
    expect(del.status).toBe(200)
    expect(del.json()).toEqual({ ok: true, revoked: 1 })
    expect(resolveDeviceKey(key)).toBeNull()
  })

  it('the shared dashboard token is REJECTED (403) -- cannot revoke an agent key either', async () => {
    await call('POST', '/api/auth/agent-keys', { body: { agent_id: 'backend' }, auth: SESSION_AUTH })
    const del = await call('DELETE', '/api/auth/agent-keys/backend', { auth: TOKEN_AUTH })
    expect(del.status).toBe(403)
    expect(listDeviceKeys()).toHaveLength(1)
  })

  it('revoking a never-minted agent_id is a 404', async () => {
    const del = await call('DELETE', '/api/auth/agent-keys/nosuchagent', { auth: SESSION_AUTH })
    expect(del.status).toBe(404)
  })
})
