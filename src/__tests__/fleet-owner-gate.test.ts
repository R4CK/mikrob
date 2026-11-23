// FLEETIMPORTGATE1022: once a dashboard login exists, an applied fleet import and an export
// with the vault take the owner's session. The shared token reaches /api/fleet/* from every
// agent: an applied import overwrites store/autonomy-config.json (email_send to 3 switches the
// mail approval gate off) and an export with a vault password returns the vault's master key
// and every secret under a password the caller chose. The dry run and the plain export stay
// on the token; the token keeps everything only for the first-run setup (no user yet).
import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest'
import type http from 'node:http'
import { Readable } from 'node:stream'

const h = vi.hoisted(() => ({
  imports: [] as Array<{ raw: string; apply: boolean; vaultPassword?: string }>,
  exports: [] as Array<{ vaultPassword?: string }>,
}))
vi.mock('../web/fleet-transfer.js', async (orig) => {
  const real = await orig<typeof import('../web/fleet-transfer.js')>()
  return {
    ...real,
    importFleet: (raw: string, options: { vaultPassword?: string; apply: boolean }) => {
      h.imports.push({ raw, ...options })
      return options.apply ? { applied: true, warnings: [] } : { dryRun: true, errors: [], warnings: [] }
    },
    exportFleet: (options: { vaultPassword?: string } = {}) => {
      h.exports.push(options)
      return { data: '{}', exportedAt: '2026-10-27T00:00:00.000Z' }
    },
  }
})

import { initDatabase, getDb, getDashboardUser, createDashboardUser } from '../db.js'
import { tryHandleFleet } from '../web/routes/fleet.js'
import { hashPassword } from '../web/password-hash.js'
import { _clearSessionCacheForTest, createSession } from '../web/auth-sessions.js'
import { SESSION_COOKIE_NAME } from '../web/auth-gate.js'
import type { RouteContext } from '../web/routes/types.js'

const TOKEN_AUTH: RouteContext['auth'] = { kind: 'token' }
const SESSION_AUTH: RouteContext['auth'] = { kind: 'session', user: 'owner' }
const DEVICE_AUTH: RouteContext['auth'] = { kind: 'device', device: 'phone', deviceId: 1, scope: 'full' }
const VAULT_PW = 'a-long-vault-password'
const FLEET_BODY = JSON.stringify({ schemaVersion: 1, dashboardSettings: { autonomy: { categories: [{ key: 'email_send', level: 3 }] } } })

type Handler = (ctx: RouteContext) => Promise<boolean>
async function call(handler: Handler, method: string, path: string, auth: RouteContext['auth'], body?: string, headers: Record<string, string> = {}) {
  const req = Readable.from(body === undefined ? [] : [Buffer.from(body)]) as unknown as http.IncomingMessage
  req.headers = headers
  const out = { status: 0, body: '' }
  const res = {
    writeHead(s: number) { out.status = s; return res },
    setHeader() {},
    end(d?: string | Buffer) { if (d !== undefined) out.body += d.toString() },
  }
  const url = new URL(`http://127.0.0.1:3420${path}`)
  expect(await handler({ req, res: res as unknown as http.ServerResponse, path: url.pathname, method, url, auth, fedPeer: null })).toBe(true)
  return { status: out.status || 200, json: () => JSON.parse(out.body || '{}') as Record<string, unknown> }
}

const applyImport = (auth: RouteContext['auth'], headers: Record<string, string> = {}) =>
  call(tryHandleFleet, 'POST', '/api/fleet/import?apply=true', auth, FLEET_BODY, headers)
const dryRun = (auth: RouteContext['auth']) => call(tryHandleFleet, 'POST', '/api/fleet/import', auth, FLEET_BODY)
const exportWithVault = (auth: RouteContext['auth'], headers: Record<string, string> = {}) =>
  call(tryHandleFleet, 'GET', '/api/fleet/export', auth, undefined, { 'x-vault-password': VAULT_PW, ...headers })
const plainExport = (auth: RouteContext['auth']) => call(tryHandleFleet, 'GET', '/api/fleet/export', auth)
// Card 49960046 (RedHat 17005 X1): creating a dashboard user, including the first, is a
// session-only mint path -- the shared token gets FORBIDDEN_KIND (403) even with zero
// dashboard_users rows. The real first-run path is the local CLI (scripts/dashboard-user.ts), so
// a fixture that wants "a login exists" creates the row directly, not through the HTTP route.
const addOwnerDirectly = async (username = 'owner') => createDashboardUser(username, await hashPassword('super-secret-pw'))

beforeAll(() => {
  process.env.NODE_ENV = 'test'
  initDatabase(':memory:')
})

beforeEach(() => {
  getDb().exec('DELETE FROM auth_sessions; DELETE FROM dashboard_users')
  _clearSessionCacheForTest()
  h.imports = []
  h.exports = []
})

// RE-DECIDED (card 1535f7f9, Koteg 28 upstream sync): upstream's mayIssueCredentials carries a
// first-run exception (no dashboard_users row yet -> the token may still act as owner). This fork
// retired that exact exception (card 49960046, RedHat 17005 finding X1: the shared bearer could
// mint itself a session with zero dashboard_users rows and escalate from there, chaining into
// exactly this fleet-import-apply/vault-export surface) -- no first-run carve-out anywhere in
// this fork, by design. The behavior below is the fork's actual answer, not upstream's.
describe('first-run setup (no dashboard user yet): the token still cannot import or export the vault', () => {
  it('an applied import and a vault export are both refused the same as with a login already present', async () => {
    const imp = await applyImport(TOKEN_AUTH)
    expect(imp.status).toBe(403)
    expect(imp.json().code).toBe('owner_session_required')
    expect(h.imports).toEqual([])
    const exp = await exportWithVault(TOKEN_AUTH)
    expect(exp.status).toBe(403)
    expect(exp.json().code).toBe('owner_session_required')
    expect(h.exports).toEqual([])
  })
})

describe('once a login exists, the token cannot apply an import or export the vault', () => {
  beforeEach(async () => {
    await addOwnerDirectly()
  })

  it('an applied import is refused before anything is imported', async () => {
    const r = await applyImport(TOKEN_AUTH)
    expect(r.status).toBe(403)
    expect(r.json().code).toBe('owner_session_required')
    expect(h.imports).toEqual([])
  })

  it('an export with a vault password is refused before anything is exported', async () => {
    const r = await exportWithVault(TOKEN_AUTH)
    expect(r.status).toBe(403)
    expect(r.json().code).toBe('owner_session_required')
    expect(h.exports).toEqual([])
  })

  it('a full device key is refused too (it never was the owner)', async () => {
    expect((await applyImport(DEVICE_AUTH)).status).toBe(403)
    expect((await exportWithVault(DEVICE_AUTH)).status).toBe(403)
    expect(h.imports).toEqual([])
    expect(h.exports).toEqual([])
  })

  it('the dry run and the plain export stay on the token (nothing written, no secret)', async () => {
    expect((await dryRun(TOKEN_AUTH)).status).toBe(200)
    expect(h.imports).toEqual([{ raw: FLEET_BODY, apply: false, vaultPassword: undefined }])
    expect((await plainExport(TOKEN_AUTH)).status).toBe(200)
    expect(h.exports).toEqual([{ vaultPassword: undefined }])
  })

  it('the owner session applies and exports', async () => {
    expect((await applyImport(SESSION_AUTH)).status).toBe(200)
    expect(h.imports).toEqual([{ raw: FLEET_BODY, apply: true, vaultPassword: undefined }])
    expect((await exportWithVault(SESSION_AUTH)).status).toBe(200)
    expect(h.exports).toEqual([{ vaultPassword: VAULT_PW }])
  })

  it("the owner's browser that also keeps the token: a valid session cookie alongside it is the owner", async () => {
    const u = getDashboardUser('owner')!
    const cookie = `${SESSION_COOKIE_NAME}=${createSession({ userId: u.id, username: u.username })}`
    expect((await applyImport(TOKEN_AUTH, { cookie })).status).toBe(200)
    expect((await exportWithVault(TOKEN_AUTH, { cookie })).status).toBe(200)
    expect(h.imports).toHaveLength(1)
    expect(h.exports).toHaveLength(1)
  })
})
