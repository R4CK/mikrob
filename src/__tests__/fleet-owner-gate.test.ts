// FLEETIMPORTGATE1022: a vault-password export takes the owner's SESSION specifically, not just
// "a human" -- it hands out the vault's master key and every secret, encrypted with a password
// the caller chose, and mayIssueCredentials (session-only) is stricter than the plain human-or-
// device-key check the export route already had (card ddeb2e17/O2, RedHat 17520, pre-existing).
//
// RE-DECIDED (card 1535f7f9, Koteg 28 upstream sync): this file originally also tested an
// applied-import axis and a "plain export stays on the token" claim, both upstream assumptions
// that do not hold in this fork:
// - apply=true on /api/fleet/import is HARD fail-closed (FLEET_IMPORT_APPLY_FAIL_CLOSED, card
//   3fb0ef97, RedHat NO-GO 14953) for EVERY auth kind, checked before any auth-kind test at all --
//   not conditionally gated by login state. Already covered by fleet-import-auth-gate.test.ts;
//   dropped here rather than duplicated with the wrong (owner-session) reason.
// - the plain export (no vault password) is NOT open to the shared token either: card ddeb2e17/O2
//   (pre-existing, predates this merge) denies the WHOLE /api/fleet/export route to anything but
//   a session or a human device key, vault password or not. Already covered by
//   fleet-export-auth-gate.test.ts; dropped here too.
// What is unique to FLEETIMPORTGATE1022 and kept below: a vault-password export additionally
// denies a human DEVICE key (which could plain-export) -- only a dashboard SESSION may pull
// secrets. The dry run (apply=false, writes nothing) stays open to the token, independent of
// login state, same as before.
import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest'
import type http from 'node:http'
import { Readable } from 'node:stream'

const h = vi.hoisted(() => ({
  imports: [] as Array<{ raw: string; apply: boolean; vaultPassword?: string; allowRiskyFields?: boolean }>,
  exports: [] as Array<{ vaultPassword?: string }>,
}))
vi.mock('../web/fleet-transfer.js', async (orig) => {
  const real = await orig<typeof import('../web/fleet-transfer.js')>()
  return {
    ...real,
    importFleet: (raw: string, options: { vaultPassword?: string; apply: boolean; allowRiskyFields?: boolean }) => {
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

const dryRun = (auth: RouteContext['auth']) => call(tryHandleFleet, 'POST', '/api/fleet/import', auth, FLEET_BODY)
const exportWithVault = (auth: RouteContext['auth'], headers: Record<string, string> = {}) =>
  call(tryHandleFleet, 'GET', '/api/fleet/export', auth, undefined, { 'x-vault-password': VAULT_PW, ...headers })
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

describe('a vault-password export takes the owner session; the dry run stays on the token', () => {
  it('the dry run stays on the token regardless of login state (nothing written)', async () => {
    expect((await dryRun(TOKEN_AUTH)).status).toBe(200)
    expect(h.imports).toEqual([{ raw: FLEET_BODY, apply: false, vaultPassword: undefined, allowRiskyFields: false }])
  })

  it('a vault-password export is refused for the token (non-human, same as a plain export)', async () => {
    const r = await exportWithVault(TOKEN_AUTH)
    expect(r.status).toBe(403)
    expect(h.exports).toEqual([])
  })

  it('a vault-password export is refused for a human device key too -- only a session may pull secrets', async () => {
    const r = await exportWithVault(DEVICE_AUTH)
    expect(r.status).toBe(403)
    expect(r.json().code).toBe('owner_session_required')
    expect(h.exports).toEqual([])
  })

  it('a vault-password export succeeds for an owner session', async () => {
    await addOwnerDirectly()
    expect((await exportWithVault(SESSION_AUTH)).status).toBe(200)
    expect(h.exports).toEqual([{ vaultPassword: VAULT_PW }])
  })

  // RE-DECIDED (card 1535f7f9, Koteg 28 upstream sync): mayIssueCredentials (auth.ts) explicitly
  // `void req`s its request param -- a resolved auth kind is trusted as-is, never re-derived from
  // a cookie the request happens to also carry (same card 49960046 hardening). A session cookie
  // alongside a token context therefore does NOT make the export call the owner's.
  it('a valid session cookie alongside the token does not upgrade it to the owner (no cookie fallback)', async () => {
    await addOwnerDirectly()
    const u = getDashboardUser('owner')!
    const cookie = `${SESSION_COOKIE_NAME}=${createSession({ userId: u.id, username: u.username })}`
    const r = await exportWithVault(TOKEN_AUTH, { cookie })
    expect(r.status).toBe(403)
    expect(h.exports).toEqual([])
  })
})
