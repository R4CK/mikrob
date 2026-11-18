// BASHSANDBOX1022 security review of #2149: a sandboxed agent reaches the dashboard on localhost with
// the shared fleet token, so through POST /api/settings it could take itself off BASH_SANDBOX_AGENTS.
// A setting whose registry entry says a change LOOSENS it accepts that change only from the owner,
// through the predicate that guards issuing credentials (mayIssueCredentials, #2163): the owner's
// session, also when the browser sends the stored token alongside it; the bare token only before the
// first dashboard login exists. Tightening (adding an agent) stays open to every caller.
import { describe, it, expect, vi, beforeAll, beforeEach } from 'vitest'

const settings = new Map<string, string>()
vi.mock('../settings-store.js', () => ({
  getEffectiveSettingValue: (k: string) => settings.get(k) ?? '',
  getEffectiveSettingSource: (k: string) => ({ value: settings.get(k) ?? '', source: settings.has(k) ? 'override' : 'default' }),
  getSettingFallback: () => ({ value: '', source: 'default' }),
  setOverride: (k: string, v: unknown) => { settings.set(k, String(v)); return { ok: true } },
  clearOverride: (k: string) => { const had = settings.delete(k); return { ok: true, removed: had } },
}))
vi.mock('../db.js', async (orig) => ({ ...(await orig<typeof import('../db.js')>()), logConfigChange: () => {} }))
vi.mock('../store-watcher.js', () => ({ setStoreWriteActor: () => {} }))
vi.mock('../web/claude-rotation-heartbeat.js', () => ({ syncRotationHeartbeatTask: () => {} }))

const { tryHandleSettings } = await import('../web/routes/settings.js')
const { SETTINGS_REGISTRY } = await import('../config-registry.js')
const { initDatabase, getDb, createDashboardUser } = await import('../db.js')
const { createSession, _clearSessionCacheForTest } = await import('../web/auth-sessions.js')
const { SESSION_COOKIE_NAME } = await import('../web/auth-gate.js')

type Auth = { kind: 'token' | 'session' | 'device'; scope?: 'full' | 'operator'; user?: string }
async function call(method: 'POST' | 'DELETE', path: string, body: unknown, auth: Auth, headers: Record<string, string> = {}) {
  const out: { status: number; body: any } = { status: 0, body: null }
  const res: any = { writeHead(s: number) { out.status = s; return res }, setHeader() {}, end(c?: string) { if (c) out.body = JSON.parse(c) } }
  const str = body === undefined ? '' : JSON.stringify(body)
  const req: any = { headers, on(ev: string, cb: (c?: Buffer) => void) { if (ev === 'data' && str) cb(Buffer.from(str)); if (ev === 'end') cb() } }
  const url = new URL(`http://localhost${path}`)
  expect(await tryHandleSettings({ req, res, path: url.pathname, method, url, auth } as any)).toBe(true)
  return out
}
const set = (value: string, auth: Auth, headers: Record<string, string> = {}) => call('POST', '/api/settings', { key: 'BASH_SANDBOX_AGENTS', value }, auth, headers)
let ownerId = 0
const ownerCookie = () => `${SESSION_COOKIE_NAME}=${createSession({ userId: ownerId, username: 'owner' })}`

beforeAll(() => { initDatabase(':memory:') })

// Card 6eca461e (RedHat N3, predates this koteg): the WHOLE POST/DELETE /api/settings surface --
// not only loosening changes -- is already gated to session/human-device (rejectIfNotHumanAuth,
// settings.ts line ~60), BEFORE the mayIssueCredentials/loosens check below ever runs. So the
// shared token cannot reach this route AT ALL, tightening included -- unlike upstream's own
// premise (token tightens freely, only loosening needs the owner). A device key is human but not
// the owner, so it is the right auth for "may tighten, may not loosen" in this fork.
describe('BASH_SANDBOX_AGENTS: a human may tighten it, only the owner session may loosen it', () => {
  const DEVICE: Auth = { kind: 'device', scope: 'operator' }
  beforeEach(() => {
    settings.clear()
    getDb().exec('DELETE FROM auth_sessions; DELETE FROM dashboard_users')
    _clearSessionCacheForTest()
    // a dashboard login exists (the normal state): the bare token is not the owner
    ownerId = createDashboardUser('owner', 'x'.repeat(60)).id
  })

  it('the shared token cannot reach this route at all, tightening included', async () => {
    const r = await set('soma', { kind: 'token' })
    expect(r.status).toBe(403)
    expect(settings.get('BASH_SANDBOX_AGENTS')).toBeUndefined()
  })

  it('a human (device key) may add agents', async () => {
    expect((await set('soma', DEVICE)).status).toBe(200)
    expect((await set('soma, trinity', DEVICE)).status).toBe(200)
    expect(settings.get('BASH_SANDBOX_AGENTS')).toBe('soma, trinity')
  })

  it('a human (device key) may not take an agent off, by POST or by reset; the value stays', async () => {
    settings.set('BASH_SANDBOX_AGENTS', 'soma, trinity')
    const r = await set('trinity', DEVICE)
    expect(r.status).toBe(403)
    expect(r.body.code).toBe('owner_session_required')
    expect((await set('', DEVICE)).status).toBe(403)
    expect((await call('DELETE', '/api/settings/BASH_SANDBOX_AGENTS', undefined, DEVICE)).status).toBe(403)
    expect(settings.get('BASH_SANDBOX_AGENTS')).toBe('soma, trinity')
  })

  it('a token with a dead or forged session cookie is still refused outright (the human gate, not the cookie)', async () => {
    settings.set('BASH_SANDBOX_AGENTS', 'soma, trinity')
    expect((await set('trinity', { kind: 'token' }, { cookie: `${SESSION_COOKIE_NAME}=not-a-session` })).status).toBe(403)
    expect(settings.get('BASH_SANDBOX_AGENTS')).toBe('soma, trinity')
  })

  it('a device key is human but still not an owner session, whatever its scope', async () => {
    settings.set('BASH_SANDBOX_AGENTS', 'soma, trinity')
    expect((await set('trinity', { kind: 'device', scope: 'operator' })).status).toBe(403)
    expect((await set('trinity', { kind: 'device', scope: 'full' })).status).toBe(403)
    expect(settings.get('BASH_SANDBOX_AGENTS')).toBe('soma, trinity')
  })

  // Card 49960046: the fork's mayIssueCredentials checks only `auth.kind` -- a token-kind caller
  // stays refused no matter what cookie it carries (upstream's own version resolves a session from
  // the cookie on a token caller too; NOT adopted, see src/web/routes/auth.ts's file-top comment).
  // It is moot here anyway: the token never reaches mayIssueCredentials, rejectIfNotHumanAuth
  // refuses it first regardless of any cookie.
  it('the owner session may loosen it; a token with the owner\'s live cookie is still refused outright', async () => {
    settings.set('BASH_SANDBOX_AGENTS', 'soma, trinity')
    expect((await set('trinity', { kind: 'session', user: 'owner' })).status).toBe(200)
    expect((await set('', { kind: 'token' }, { cookie: ownerCookie() })).status).toBe(403)
    expect((await set('', { kind: 'session', user: 'owner' })).status).toBe(200)
    settings.set('BASH_SANDBOX_AGENTS', 'soma')
    expect((await call('DELETE', '/api/settings/BASH_SANDBOX_AGENTS', undefined, { kind: 'session', user: 'owner' })).status).toBe(200)
  })

  // Card 49960046: no first-run exception in this fork -- the token can NEVER loosen (or reach
  // this route at all), even before any dashboard user exists.
  it('before the first dashboard login exists, the token is STILL refused -- no bootstrap exception in this fork', async () => {
    getDb().exec('DELETE FROM dashboard_users')
    settings.set('BASH_SANDBOX_AGENTS', 'soma')
    expect((await set('', { kind: 'token' })).status).toBe(403)
  })

  it('the loosens rule: removal loosens, reordering, spacing and case do not', () => {
    const def = SETTINGS_REGISTRY.find((d) => d.key === 'BASH_SANDBOX_AGENTS')!
    expect(def.loosens?.('soma, trinity', 'trinity')).toBe(true)
    expect(def.loosens?.('soma', '')).toBe(true)
    expect(def.loosens?.('soma', 'Trinity  SOMA')).toBe(false)
    expect(def.loosens?.('', 'soma')).toBe(false)
  })
})
