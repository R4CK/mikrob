// Card 4f4cb0df delta (CYBERED NO-GO B1, MikroB decision 15101/15397): POST /api/skills/import had
// NO auth-kind check at all and wrote into the FLEET-WIDE ~/.claude/skills directory -- every agent
// picks up what lands there. Same hibaosztály as agents.ts's overwrite=1 and allowRiskyFields=1
// gates, same fix: hard fail-closed (a literal constant, no bespoke approval mechanism) until card
// 3fb0ef97 (non-forgeable approval channel) ships.
import { describe, it, expect, vi } from 'vitest'
import { EventEmitter } from 'node:events'
import { tryHandleSkills } from '../web/routes/skills.js'
import type { RouteContext } from '../web/routes/types.js'

vi.mock('../logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}))

function fakeCtx(auth: RouteContext['auth']): { ctx: RouteContext; out: { status: number; body: any } } {
  const out: { status: number; body: any } = { status: 0, body: null }
  const res: any = {
    writeHead(status: number) { out.status = status; return res },
    end(chunk?: string) { if (chunk) { try { out.body = JSON.parse(chunk) } catch { out.body = chunk } } },
  }
  const req: any = new EventEmitter()
  req.headers = { 'content-type': 'multipart/form-data; boundary=x' }
  req.url = '/api/skills/import'
  const ctx = { req, res, path: '/api/skills/import', method: 'POST', url: new URL('http://localhost:3420/api/skills/import'), auth } as RouteContext
  setImmediate(() => {
    req.emit('data', Buffer.from('not-a-real-zip-but-non-empty'))
    req.emit('end')
  })
  return { ctx, out }
}

describe('POST /api/skills/import -- hard fail-closed (card 4f4cb0df delta, B1)', () => {
  it.each([
    ['the shared agent bearer (kind: token)', { kind: 'token' } as RouteContext['auth']],
    ['no auth principal at all', undefined],
    ['a federation peer credential', { kind: 'federation', peer: 'some-peer' } as RouteContext['auth']],
    ['a browser session', { kind: 'session', user: 'peti' } as RouteContext['auth']],
    ['a device key', { kind: 'device', device: 'phone', deviceId: 1 } as RouteContext['auth']],
  ])('refused, 403, with %s -- before any file is written', async (_label, auth) => {
    const { ctx, out } = fakeCtx(auth)
    expect(await tryHandleSkills(ctx)).toBe(true)
    expect(out.status).toBe(403)
    expect(out.body.error).toMatch(/3fb0ef97/)
  })

  it('MUTATION PIN: the refusal message names the specific disabled-until-3fb0ef97 reason', async () => {
    const { ctx, out } = fakeCtx({ kind: 'token' })
    expect(await tryHandleSkills(ctx)).toBe(true)
    expect(out.body.error).toBe(
      'Skill import is disabled until a non-forgeable approval channel ships (card 3fb0ef97). Add the skill directory manually for now.',
    )
  })
})
