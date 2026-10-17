// O2 (RedHat 17520 on 9655494c, card ddeb2e17): GET /api/fleet/export returns EVERY agent's
// memories and daily_logs (plus vault secrets with a password) and, before this card, had NO
// auth-kind check -- the shared fleet bearer (every agent's curl) or a future per-agent device
// key could download the whole fleet's data in one request. Same posture as the import apply=true
// gate (card 68254bd7, fleet-import-auth-gate.test.ts): human-only (session, or a device key that
// is NOT an `agent:<id>` key).
import { describe, it, expect, vi } from 'vitest'
import { EventEmitter } from 'node:events'
import { tryHandleFleet } from '../web/routes/fleet.js'
import type { RouteContext } from '../web/routes/types.js'

vi.mock('../logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}))

vi.mock('../web/fleet-transfer.js', () => ({
  exportFleet: vi.fn().mockReturnValue({ data: '{"ok":true}', exportedAt: '2026-10-17T00:00:00.000Z' }),
  importFleet: vi.fn(),
  MIN_VAULT_PASSWORD_LEN: 8,
  UserFacingError: class UserFacingError extends Error {},
}))

function fakeCtx(auth: RouteContext['auth']): { ctx: RouteContext; out: { status: number; body: any } } {
  const out: { status: number; body: any } = { status: 0, body: null }
  const res: any = {
    writeHead(status: number) { out.status = status; return res },
    end(chunk?: Buffer | string) {
      if (!chunk) return
      const text = chunk.toString()
      try { out.body = JSON.parse(text) } catch { out.body = text }
    },
  }
  const req: any = new EventEmitter()
  req.headers = {}
  const url = new URL('http://localhost:3420/api/fleet/export')
  const ctx = { req, res, path: url.pathname, method: 'GET', url, auth } as RouteContext
  return { ctx, out }
}

describe('GET /api/fleet/export -- human-only auth gate (O2, card ddeb2e17)', () => {
  it.each([
    ['the shared agent bearer (kind: token)', { kind: 'token' } as RouteContext['auth']],
    ['no auth principal at all', undefined],
    ['a federation peer credential', { kind: 'federation', peer: 'some-peer' } as RouteContext['auth']],
    ['an agent device key (agent:<id>)', { kind: 'device', device: 'agent:attacker', deviceId: 1 } as RouteContext['auth']],
  ])('refused, 403, with %s', async (_label, auth) => {
    const { ctx, out } = fakeCtx(auth)
    expect(await tryHandleFleet(ctx)).toBe(true)
    expect(out.status).toBe(403)
    expect(out.body.error).toMatch(/megosztott flotta-tokennel nem/)
  })

  it('a browser session is allowed through (existing human path)', async () => {
    const { ctx, out } = fakeCtx({ kind: 'session', user: 'peti' })
    expect(await tryHandleFleet(ctx)).toBe(true)
    expect(out.status).toBe(200)
  })

  it('a human device key (not agent:<id>) is allowed through', async () => {
    const { ctx, out } = fakeCtx({ kind: 'device', device: "Peti's iPhone", deviceId: 2 })
    expect(await tryHandleFleet(ctx)).toBe(true)
    expect(out.status).toBe(200)
  })
})
