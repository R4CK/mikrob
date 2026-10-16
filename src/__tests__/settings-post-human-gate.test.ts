// Card 6eca461e (RedHat N3 on the 93ed929a re-gate): POST /api/settings had NO principal gate at
// all -- the shared fleet dashboard bearer every agent holds could rewrite arbitrary platform
// config (e.g. CLAUDE_ROTATION_ENABLED, which wires/unwires a heartbeat task). Same human-only
// posture and the same rejectIfNotHumanAuth helper as PUT /api/agents/:name's claudePlan/apiKey
// (this card) and the claude-plans route (card 93ed929a). GET /api/settings is UNCHANGED
// (read-only, not the card's concern).
import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { RouteContext } from '../web/routes/types.js'

const settings = new Map<string, string>()
vi.mock('../settings-store.js', () => ({
  getEffectiveSettingValue: (k: string) => settings.get(k) ?? '',
  setOverride: (k: string, v: unknown) => { settings.set(k, String(v)); return { ok: true } },
}))
const logConfigChange = vi.fn()
vi.mock('../db.js', () => ({ logConfigChange: (...args: unknown[]) => logConfigChange(...args) }))
vi.mock('../store-watcher.js', () => ({ setStoreWriteActor: () => {} }))
vi.mock('../web/claude-rotation-heartbeat.js', () => ({ syncRotationHeartbeatTask: () => 'unchanged' }))

const { tryHandleSettings } = await import('../web/routes/settings.js')

beforeEach(() => {
  settings.clear()
  logConfigChange.mockClear()
})

function fakePost(
  body: unknown,
  auth?: { kind: 'token' | 'session' | 'federation' | 'device'; device?: string },
): { ctx: RouteContext; out: { status: number; body: any } } {
  const out: { status: number; body: any } = { status: 0, body: null }
  const res: any = {
    writeHead(status: number) { out.status = status; return res },
    end(chunk?: string) { if (chunk) out.body = JSON.parse(chunk) },
  }
  const bodyStr = JSON.stringify(body)
  const req: any = {
    on(event: string, cb: (chunk?: Buffer) => void) {
      if (event === 'data') cb(Buffer.from(bodyStr))
      if (event === 'end') cb()
    },
  }
  return { ctx: { req, res, path: '/api/settings', method: 'POST', url: new URL('http://localhost/api/settings'), auth } as RouteContext, out }
}

const BODY = { key: 'CLAUDE_ROTATION_ENABLED', value: '1' }

describe('POST /api/settings requires a human credential (card 6eca461e)', () => {
  it.each([
    ['the shared agent bearer (kind: token)', { kind: 'token' } as const],
    ['no auth principal at all', undefined],
    ['an agent-issued device key (agent:qa)', { kind: 'device', device: 'agent:qa' } as const],
  ])('rejected (403) for %s, nothing written', async (_label, auth) => {
    const { ctx, out } = fakePost(BODY, auth)
    expect(await tryHandleSettings(ctx)).toBe(true)
    expect(out.status).toBe(403)
    expect(settings.has('CLAUDE_ROTATION_ENABLED')).toBe(false)
    expect(logConfigChange).not.toHaveBeenCalled()
  })

  it('succeeds for a real session', async () => {
    const { ctx, out } = fakePost(BODY, { kind: 'session' })
    await tryHandleSettings(ctx)
    expect(out.status).toBe(200)
    expect(settings.get('CLAUDE_ROTATION_ENABLED')).toBe('1')
  })

  it('succeeds for a non-agent device key (phone pairing)', async () => {
    const { ctx, out } = fakePost(BODY, { kind: 'device', device: 'phone' })
    await tryHandleSettings(ctx)
    expect(out.status).toBe(200)
  })

  // MUTATION PIN: with rejectIfNotHumanAuth removed from this handler, the shared-token request
  // would instead succeed (200) and actually write the setting + log the config change.
  it('MUTATION PIN: the rejection is specifically the auth gate, not an unrelated failure', async () => {
    const { ctx, out } = fakePost(BODY, { kind: 'token' })
    await tryHandleSettings(ctx)
    expect(out.status).toBe(403)
    expect(out.body?.error).toContain('browser session or a device key')
  })
})
