// FLEETIMPORTGATE1022 (4): once a dashboard login exists, raising an autonomy level takes the
// owner's session. The fleet's one shared token reaches POST /api/autonomy from every agent, and
// email_send at 3 lets the mail approval gate wave every send through. Lowering (and setting
// the same level) stays on the token; the token keeps everything for the first-run setup.
import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest'
import type http from 'node:http'
import { Readable } from 'node:stream'

const h = vi.hoisted(() => ({ file: '', writes: 0 }))
vi.mock('node:fs', async (orig) => {
  const real = await orig<typeof import('node:fs')>()
  const ours = (p: unknown) => String(p).endsWith('autonomy-config.json')
  return {
    ...real,
    existsSync: (p: Parameters<typeof real.existsSync>[0]) => (ours(p) ? true : real.existsSync(p)),
    readFileSync: ((p: Parameters<typeof real.readFileSync>[0], ...rest: unknown[]) =>
      ours(p) ? h.file : (real.readFileSync as (...a: unknown[]) => unknown)(p, ...rest)) as typeof real.readFileSync,
    writeFileSync: ((p: Parameters<typeof real.writeFileSync>[0], data: unknown, ...rest: unknown[]) => {
      if (ours(p)) { h.file = String(data); h.writes++; return }
      return (real.writeFileSync as (...a: unknown[]) => unknown)(p, data, ...rest)
    }) as typeof real.writeFileSync,
  }
})

import { initDatabase, getDb, getDashboardUser, createDashboardUser } from '../db.js'
import { tryHandleAutonomy } from '../web/routes/autonomy.js'
import { hashPassword } from '../web/password-hash.js'
import { _clearSessionCacheForTest, createSession } from '../web/auth-sessions.js'
import { SESSION_COOKIE_NAME } from '../web/auth-gate.js'
import type { RouteContext } from '../web/routes/types.js'

const TOKEN_AUTH: RouteContext['auth'] = { kind: 'token' }
const SESSION_AUTH: RouteContext['auth'] = { kind: 'session', user: 'owner' }
const DEVICE_AUTH: RouteContext['auth'] = { kind: 'device', device: 'phone', deviceId: 1, scope: 'full' }

function seed(emailLevel: unknown = 2): void {
  h.file = JSON.stringify({
    version: 1, updated_at: 0,
    categories: [
      { key: 'email_send', label: 'Email', level: emailLevel, locked: false, maxLevel: 3 },
      { key: 'data_delete', label: 'Delete', level: 1, locked: true, maxLevel: 1 },
    ],
  })
  h.writes = 0
}
const levelOf = (key: string) => (JSON.parse(h.file).categories as Array<{ key: string; level: unknown }>).find((c) => c.key === key)!.level

type Handler = (ctx: RouteContext) => Promise<boolean>
async function call(handler: Handler, method: string, path: string, auth: RouteContext['auth'], body?: unknown, headers: Record<string, string> = {}) {
  const req = Readable.from(body === undefined ? [] : [Buffer.from(JSON.stringify(body))]) as unknown as http.IncomingMessage
  req.headers = headers
  const out = { status: 0, body: '' }
  const res = {
    writeHead(s: number) { out.status = s; return res },
    setHeader() {},
    end(d?: string) { if (d !== undefined) out.body += d },
  }
  const url = new URL(`http://127.0.0.1:3420${path}`)
  expect(await handler({ req, res: res as unknown as http.ServerResponse, path: url.pathname, method, url, auth, fedPeer: null })).toBe(true)
  return { status: out.status || 200, json: () => JSON.parse(out.body || '{}') as Record<string, unknown> }
}

const setLevel = (auth: RouteContext['auth'], key: string, level: number, headers: Record<string, string> = {}) =>
  call(tryHandleAutonomy, 'POST', '/api/autonomy', auth, { key, level }, headers)
// Card 49960046 (RedHat 17005 X1): creating a dashboard user, including the first, is a
// session-only mint path -- the shared token gets FORBIDDEN_KIND (403) even with zero
// dashboard_users rows (see auth.ts's own comment at this exact check). The real first-run path
// is the local CLI (scripts/dashboard-user.ts), so a test fixture that wants "a login exists"
// creates the row directly, the same way the CLI would, not through the HTTP route with a token.
const addOwnerDirectly = async (username = 'owner') => createDashboardUser(username, await hashPassword('super-secret-pw'))

beforeAll(() => {
  process.env.NODE_ENV = 'test'
  initDatabase(':memory:')
})

beforeEach(() => {
  getDb().exec('DELETE FROM auth_sessions; DELETE FROM dashboard_users')
  _clearSessionCacheForTest()
  seed()
})

// RE-DECIDED (card 1535f7f9, Koteg 28 upstream sync): upstream's mayIssueCredentials carries a
// first-run exception (no dashboard_users row yet -> the token may still mint/raise). This fork
// retired that exact exception (card 49960046, RedHat 17005 finding X1: the shared bearer could
// mint itself a session with zero dashboard_users rows and escalate from there) -- there is no
// first-run carve-out anywhere in this fork, by design. The title/behavior below is the fork's
// actual answer, not upstream's.
describe('first-run setup (no dashboard user yet): the token still cannot raise a level', () => {
  it('raising is refused the same as with a login already present', async () => {
    const r = await setLevel(TOKEN_AUTH, 'email_send', 3)
    expect(r.status).toBe(403)
    expect(r.json().code).toBe('owner_session_required')
    expect(levelOf('email_send')).toBe(2)
  })
})

describe('once a login exists, the token cannot raise a level', () => {
  beforeEach(async () => {
    await addOwnerDirectly()
    seed()
  })

  it('a raise is refused and nothing is written', async () => {
    const r = await setLevel(TOKEN_AUTH, 'email_send', 3)
    expect(r.status).toBe(403)
    expect(r.json().code).toBe('owner_session_required')
    expect(levelOf('email_send')).toBe(2)
    expect(h.writes).toBe(0)
  })

  it('a full device key cannot raise either', async () => {
    expect((await setLevel(DEVICE_AUTH, 'email_send', 3)).status).toBe(403)
    expect(h.writes).toBe(0)
  })

  it('a current level that is not a number counts as a raise', async () => {
    seed('2')
    expect((await setLevel(TOKEN_AUTH, 'email_send', 1)).status).toBe(403)
    expect(h.writes).toBe(0)
  })

  it('lowering and setting the same level stay on the token', async () => {
    expect((await setLevel(TOKEN_AUTH, 'email_send', 2)).status).toBe(200)
    expect((await setLevel(TOKEN_AUTH, 'email_send', 1)).status).toBe(200)
    expect(levelOf('email_send')).toBe(1)
  })

  it('the owner session raises, up to maxLevel; a locked category stays locked', async () => {
    expect((await setLevel(SESSION_AUTH, 'email_send', 3)).status).toBe(200)
    expect(levelOf('email_send')).toBe(3)
    expect((await setLevel(SESSION_AUTH, 'data_delete', 2)).status).toBe(403)
    expect(levelOf('data_delete')).toBe(1)
  })

  // RE-DECIDED (card 1535f7f9, Koteg 28 upstream sync): upstream's mayIssueCredentials takes a
  // `req` param specifically to let a session COOKIE upgrade a token-resolved context to owner
  // access. This fork's mayIssueCredentials (auth.ts) explicitly `void req`s that parameter --
  // same card 49960046 hardening this file's other RE-DECIDED tests already cover: a resolved
  // auth kind is trusted as-is, never re-derived from a cookie the request happens to also carry.
  // A cookie alongside a token context therefore does NOT make the call the owner's.
  it("a valid session cookie alongside the token does not upgrade it to the owner (no cookie fallback)", async () => {
    const u = getDashboardUser('owner')!
    const cookie = `${SESSION_COOKIE_NAME}=${createSession({ userId: u.id, username: u.username })}`
    const r = await setLevel(TOKEN_AUTH, 'email_send', 3, { cookie })
    expect(r.status).toBe(403)
    expect(levelOf('email_send')).toBe(2)
  })
})
