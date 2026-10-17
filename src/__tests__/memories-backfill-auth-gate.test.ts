// O3 (RedHat 17520 on 9655494c, card ddeb2e17, LOW): POST /api/memories/backfill recomputes
// embeddings for every memory row fleet-wide and had NO auth-kind check -- any authenticated
// caller, including a future per-agent device key, could trigger a global recompute. Resource
// consumption, not a data leak, but the same human-only posture as the other preconditions in
// this card (fleet export, fleet import).
import { describe, it, expect, vi, beforeAll } from 'vitest'
import { initDatabase } from '../db.js'
import { tryHandleMemories } from '../web/routes/memories.js'
import type { RouteContext } from '../web/routes/types.js'

vi.mock('../config.js', async () => {
  const actual = await vi.importActual<typeof import('../config.js')>('../config.js')
  return { ...actual, MAIN_AGENT_ID: 'mikrob', OLLAMA_URL: '' }
})

vi.mock('../logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() },
}))

function makeCtx(auth?: RouteContext['auth']): { ctx: RouteContext; getBody: () => any; status: () => number } {
  const url = new URL('http://localhost:3420/api/memories/backfill')
  let responseBody = ''
  let statusCode = 200
  const res = {
    writeHead: (code: number) => { statusCode = code },
    end: (body?: string) => { responseBody = body || '' },
    setHeader: () => {},
  }
  return {
    ctx: { req: { headers: {} } as any, res: res as any, path: url.pathname, method: 'POST', url, auth },
    getBody: () => (responseBody ? JSON.parse(responseBody) : null),
    status: () => statusCode,
  }
}

beforeAll(() => {
  initDatabase(':memory:')
})

describe('POST /api/memories/backfill -- human-only auth gate (O3, card ddeb2e17)', () => {
  it.each([
    ['the shared agent bearer (kind: token)', { kind: 'token' } as RouteContext['auth']],
    ['no auth principal at all', undefined],
    ['an agent device key (agent:<id>)', { kind: 'device', device: 'agent:attacker', deviceId: 1 } as RouteContext['auth']],
  ])('refused, 403, with %s', async (_label, auth) => {
    const { ctx, status, getBody } = makeCtx(auth)
    expect(await tryHandleMemories(ctx)).toBe(true)
    expect(status()).toBe(403)
    expect(getBody().error).toMatch(/megosztott flotta-tokennel nem/)
  })

  it('a browser session is allowed through', async () => {
    const { ctx, status } = makeCtx({ kind: 'session', user: 'peti' })
    expect(await tryHandleMemories(ctx)).toBe(true)
    expect(status()).toBe(200)
  })

  it('a human device key (not agent:<id>) is allowed through', async () => {
    const { ctx, status } = makeCtx({ kind: 'device', device: "Peti's iPhone", deviceId: 2 })
    expect(await tryHandleMemories(ctx)).toBe(true)
    expect(status()).toBe(200)
  })
})
