// Card 68254bd7 (MikroB follow-up, msg 10134): POST /api/fleet/import?apply=true must come from a
// human (browser session or device key) -- never the shared fleet dashboard bearer every agent
// holds, since that is a network-reachable, unlogged path to the same write a same-UID agent could
// already make on disk (card 8eca67f0). Route-level test: the auth-kind gate runs BEFORE readBody,
// so these never need a real import pipeline -- a 403 (or its absence) is enough to pin the gate.
import { describe, it, expect, vi } from 'vitest'
import { EventEmitter } from 'node:events'
import { tryHandleFleet } from '../web/routes/fleet.js'
import type { RouteContext } from '../web/routes/types.js'

vi.mock('../logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}))

vi.mock('../web/atomic-write.js', () => ({
  atomicWriteFileSync: vi.fn(),
}))

function fakeCtx(
  qs: string,
  auth: RouteContext['auth'],
): { ctx: RouteContext; out: { status: number; body: any } } {
  const out: { status: number; body: any } = { status: 0, body: null }
  const res: any = {
    writeHead(status: number) { out.status = status; return res },
    end(chunk?: string) { if (chunk) { try { out.body = JSON.parse(chunk) } catch { out.body = chunk } } },
  }
  const req: any = new EventEmitter()
  req.headers = {}
  const url = new URL(`http://localhost:3420/api/fleet/import${qs}`)
  const ctx = { req, res, path: url.pathname, method: 'POST', url, auth } as RouteContext
  // readBody resolves on 'end' -- emit it on the next tick so tryHandleFleet's await readBody(req) sees it.
  setImmediate(() => req.emit('end'))
  return { ctx, out }
}

describe('POST /api/fleet/import -- auth-kind gate on apply=true (card 68254bd7)', () => {
  it('apply=true with the shared agent bearer (kind: token) is rejected, 403, before any body read', async () => {
    const { ctx, out } = fakeCtx('?apply=true', { kind: 'token' })
    expect(await tryHandleFleet(ctx)).toBe(true)
    expect(out.status).toBe(403)
    expect(out.body.error).toMatch(/browser session or a device key/)
  })

  it('apply=true with no auth principal at all is rejected, 403', async () => {
    const { ctx, out } = fakeCtx('?apply=true', undefined)
    expect(await tryHandleFleet(ctx)).toBe(true)
    expect(out.status).toBe(403)
  })

  it('apply=true with a federation peer credential is rejected, 403 (not on the allowlist)', async () => {
    const { ctx, out } = fakeCtx('?apply=true', { kind: 'federation', peer: 'some-peer' })
    expect(await tryHandleFleet(ctx)).toBe(true)
    expect(out.status).toBe(403)
  })

  it('apply=true with a browser session passes the gate (reaches importFleet, not a 403)', async () => {
    const { ctx, out } = fakeCtx('?apply=true', { kind: 'session', user: 'peti' })
    expect(await tryHandleFleet(ctx)).toBe(true)
    expect(out.status).not.toBe(403)
  })

  it('apply=true with a device key passes the gate (reaches importFleet, not a 403)', async () => {
    const { ctx, out } = fakeCtx('?apply=true', { kind: 'device', device: 'phone', deviceId: 1 })
    expect(await tryHandleFleet(ctx)).toBe(true)
    expect(out.status).not.toBe(403)
  })

  it('dry-run (apply absent/false) with the shared agent bearer is NOT blocked by this gate -- it writes nothing', async () => {
    const { ctx, out } = fakeCtx('', { kind: 'token' })
    expect(await tryHandleFleet(ctx)).toBe(true)
    expect(out.status).not.toBe(403)
  })

  // MUTATION PIN: without the gate, a token-credentialed apply=true would sail straight through to
  // importFleet (and 400 on the empty test body, not 403) -- this is the case that flips if the
  // `apply && ctx.auth?.kind !== 'session' && ctx.auth?.kind !== 'device'` check is ever removed.
  it('MUTATION PIN: self-check -- an empty body past the gate 400s (invalid JSON), never 403', async () => {
    const { ctx, out } = fakeCtx('?apply=true', { kind: 'session', user: 'peti' })
    expect(await tryHandleFleet(ctx)).toBe(true)
    expect(out.status).toBe(400)
    expect(out.body.errors?.[0]).toMatch(/Érvénytelen JSON/)
  })
})

// Card 68254bd7 F4 (WhiteHat NO-GO 14284): the `allowRiskyFields` QUERY STRING parsing itself
// (routes/fleet.ts: `ctx.url.searchParams.get('allowRiskyFields') === 'true'`) had no route-level
// test -- fleet-transfer.test.ts pins importFleet's OWN allowRiskyFields boolean parameter, but
// nothing proved the route actually parses the query string into it correctly. A mutant that made
// the route always pass `true` (or never read the query string) survived.
describe('POST /api/fleet/import -- allowRiskyFields query-string parsing (card 68254bd7 F4)', () => {
  function fakeCtxWithBody(
    qs: string,
    auth: RouteContext['auth'],
    body: unknown,
  ): { ctx: RouteContext; out: { status: number; body: any } } {
    const { ctx, out } = fakeCtx(qs, auth)
    const payload = JSON.stringify(body)
    // Override the no-data 'end'-only emission: emit the real body first.
    process.nextTick(() => { (ctx.req as unknown as EventEmitter).emit('data', Buffer.from(payload)) })
    return { ctx, out }
  }

  const fleetWithRiskyAgent = (): Record<string, unknown> => ({
    schemaVersion: 1,
    exportedAt: '2026-01-01T00:00:00.000Z',
    sourceHost: 'attacker',
    agents: [{
      name: 'victim',
      config: { toolDeny: ['Bash'], model: 'claude-opus-5-5' },
      claudeMd: '', soulMd: '', mcp: {}, settings: {}, channelsAccess: {}, agentSkills: [],
    }],
    skills: [], scheduledTasks: [], memories: [], dailyLogs: [],
    kanban: { cards: [], comments: [], cardEvents: [], labels: [], cardLabels: [] },
    ideaBox: { ideas: [], comments: [], statusLog: [] },
    dashboardSettings: { autonomy: {}, autoRestart: {}, agentsDesired: {}, norbertPersonal: {} },
  })

  it('omitted (default false): toolDeny is stripped before it ever reaches disk', async () => {
    const { atomicWriteFileSync } = await import('../web/atomic-write.js')
    ;(atomicWriteFileSync as any).mockClear()
    const { ctx } = fakeCtxWithBody('?apply=true', { kind: 'session', user: 'peti' }, fleetWithRiskyAgent())
    await tryHandleFleet(ctx)
    const calls = (atomicWriteFileSync as any).mock.calls
    const configCall = calls.find((c: string[]) => c[0]?.endsWith('agent-config.json'))
    expect(configCall, 'agent-config.json was never written').toBeDefined()
    expect(JSON.parse(configCall![1] as string)).not.toHaveProperty('toolDeny')
  })

  it('?allowRiskyFields=true: toolDeny survives verbatim', async () => {
    const { atomicWriteFileSync } = await import('../web/atomic-write.js')
    ;(atomicWriteFileSync as any).mockClear()
    const { ctx } = fakeCtxWithBody('?apply=true&allowRiskyFields=true', { kind: 'session', user: 'peti' }, fleetWithRiskyAgent())
    await tryHandleFleet(ctx)
    const calls = (atomicWriteFileSync as any).mock.calls
    const configCall = calls.find((c: string[]) => c[0]?.endsWith('agent-config.json'))
    expect(configCall, 'agent-config.json was never written').toBeDefined()
    expect(JSON.parse(configCall![1] as string).toolDeny).toEqual(['Bash'])
  })

  it('?allowRiskyFields=yes (not the literal "true") is still treated as false', async () => {
    const { atomicWriteFileSync } = await import('../web/atomic-write.js')
    ;(atomicWriteFileSync as any).mockClear()
    const { ctx } = fakeCtxWithBody('?apply=true&allowRiskyFields=yes', { kind: 'session', user: 'peti' }, fleetWithRiskyAgent())
    await tryHandleFleet(ctx)
    const calls = (atomicWriteFileSync as any).mock.calls
    const configCall = calls.find((c: string[]) => c[0]?.endsWith('agent-config.json'))
    expect(JSON.parse(configCall![1] as string)).not.toHaveProperty('toolDeny')
  })
})
