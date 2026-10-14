// Card 54e6f4c8 (RedHat delta-gate 4f4cb0df R2): POST /api/skills, PUT /api/skills/:name
// (global SKILL.md edit) and POST /api/skills/:name/assign write into (or redistribute) the
// FLEET-WIDE ~/.claude/skills directory with no auth-kind check at all -- same hibaosztály and
// same fix as the already-gated POST /api/skills/import: hard fail-closed (a literal constant,
// no bespoke approval mechanism) until card 3fb0ef97 (non-forgeable approval channel) ships.
import { describe, it, expect, vi } from 'vitest'
import { EventEmitter } from 'node:events'
import { tryHandleSkills } from '../web/routes/skills.js'
import type { RouteContext } from '../web/routes/types.js'

vi.mock('../logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}))

function fakeCtx(path: string, method: string, auth: RouteContext['auth']): { ctx: RouteContext; out: { status: number; body: any } } {
  const out: { status: number; body: any } = { status: 0, body: null }
  const res: any = {
    writeHead(status: number) { out.status = status; return res },
    end(chunk?: string) { if (chunk) { try { out.body = JSON.parse(chunk) } catch { out.body = chunk } } },
  }
  const req: any = new EventEmitter()
  req.headers = { 'content-type': 'application/json' }
  req.url = path
  const ctx = { req, res, path, method, url: new URL(`http://localhost:3420${path}`), auth } as RouteContext
  setImmediate(() => {
    req.emit('data', Buffer.from('{}'))
    req.emit('end')
  })
  return { ctx, out }
}

const AUTH_KINDS: Array<[string, RouteContext['auth']]> = [
  ['the shared agent bearer (kind: token)', { kind: 'token' } as RouteContext['auth']],
  ['no auth principal at all', undefined],
  ['a federation peer credential', { kind: 'federation', peer: 'some-peer' } as RouteContext['auth']],
  ['a browser session', { kind: 'session', user: 'peti' } as RouteContext['auth']],
  ['a device key', { kind: 'device', device: 'phone', deviceId: 1 } as RouteContext['auth']],
]

describe('POST /api/skills -- hard fail-closed (card 54e6f4c8)', () => {
  it.each(AUTH_KINDS)('refused, 403, with %s -- before any file is written', async (_label, auth) => {
    const { ctx, out } = fakeCtx('/api/skills', 'POST', auth)
    expect(await tryHandleSkills(ctx)).toBe(true)
    expect(out.status).toBe(403)
    expect(out.body.error).toMatch(/3fb0ef97/)
  })

  it('MUTATION PIN: the refusal message names the specific disabled-until-3fb0ef97 reason', async () => {
    const { ctx, out } = fakeCtx('/api/skills', 'POST', { kind: 'token' })
    expect(await tryHandleSkills(ctx)).toBe(true)
    expect(out.body.error).toBe(
      'Creating a global skill is disabled until a non-forgeable approval channel ships (card 3fb0ef97). Add the skill directory manually for now.',
    )
  })
})

describe('PUT /api/skills/:name -- global edit hard fail-closed (card 54e6f4c8)', () => {
  it.each(AUTH_KINDS)('refused, 403, with %s -- before any file is written', async (_label, auth) => {
    const { ctx, out } = fakeCtx('/api/skills/some-skill', 'PUT', auth)
    expect(await tryHandleSkills(ctx)).toBe(true)
    expect(out.status).toBe(403)
    expect(out.body.error).toMatch(/3fb0ef97/)
  })

  it('MUTATION PIN: the refusal message names the specific disabled-until-3fb0ef97 reason', async () => {
    const { ctx, out } = fakeCtx('/api/skills/some-skill', 'PUT', { kind: 'token' })
    expect(await tryHandleSkills(ctx)).toBe(true)
    expect(out.body.error).toBe(
      'Editing a global skill is disabled until a non-forgeable approval channel ships (card 3fb0ef97). Edit the SKILL.md file manually for now.',
    )
  })
})

describe('POST /api/skills/:name/assign -- hard fail-closed (card 54e6f4c8)', () => {
  it.each(AUTH_KINDS)('refused, 403, with %s -- before any file is written', async (_label, auth) => {
    const { ctx, out } = fakeCtx('/api/skills/some-skill/assign', 'POST', auth)
    expect(await tryHandleSkills(ctx)).toBe(true)
    expect(out.status).toBe(403)
    expect(out.body.error).toMatch(/3fb0ef97/)
  })

  it('MUTATION PIN: the refusal message names the specific disabled-until-3fb0ef97 reason', async () => {
    const { ctx, out } = fakeCtx('/api/skills/some-skill/assign', 'POST', { kind: 'token' })
    expect(await tryHandleSkills(ctx)).toBe(true)
    expect(out.body.error).toBe(
      'Assigning a global skill to agents is disabled until a non-forgeable approval channel ships (card 3fb0ef97). Copy the skill directory manually for now.',
    )
  })
})
