/**
 * Contract test for GET /api/memories/:id.
 *
 * Until 2026-09-14 the id-addressed routes were PUT/PATCH/DELETE only: a memory
 * could be referenced by id, edited by id and deleted by id, but never READ by
 * id. The shared tier is full of such pointers ("see shared <id>"), and the only
 * way to follow one was keyword search -- which silently fails when the keywords
 * do not match.
 *
 * A sub-agent hit exactly that and read the 404 as "the record does not exist",
 * when what did not exist was the route. An absent route and an absent row must
 * not look alike, so both cases are pinned here.
 */
import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest'
import { initDatabase, saveAgentMemory } from '../db.js'
import { tryHandleMemories } from '../web/routes/memories.js'
import type { RouteContext } from '../web/routes/types.js'

vi.mock('../config.js', async () => {
  const actual = await vi.importActual<typeof import('../config.js')>('../config.js')
  return { ...actual, MAIN_AGENT_ID: 'agent-a', ALLOWED_CHAT_ID: 'test-chat', OLLAMA_URL: '' }
})

vi.mock('../logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() },
}))

function makeCtx(pathWithQuery: string, method = 'GET'): { ctx: RouteContext; getBody: () => any; status: () => number } {
  const url = new URL(`http://localhost:3420${pathWithQuery}`)
  let responseBody = ''
  let statusCode = 200
  const res = {
    writeHead: (code: number) => { statusCode = code },
    end: (body?: string) => { responseBody = body || '' },
    setHeader: () => {},
  }
  // ctx.path is the bare pathname -- the route matchers anchor with `$` and never see the query
  // string, which lives on ctx.url (url.searchParams) instead, same as the real HTTP dispatch.
  return {
    ctx: { req: { headers: {} } as any, res: res as any, path: url.pathname, method, url },
    getBody: () => (responseBody ? JSON.parse(responseBody) : null),
    status: () => statusCode,
  }
}

let seededId = 0
let victimPrivateId = 0
let victimLongId = 0

beforeAll(() => {
  initDatabase(':memory:')
  seededId = saveAgentMemory('agent-a', 'a pointer target the keyword search would miss', 'shared', 'zzz-unrelated').id
  victimPrivateId = saveAgentMemory('victim', 'victim private hot-tier content', 'hot', 'secret').id
  victimLongId = saveAgentMemory('victim', 'x'.repeat(80), 'hot', 'long-content-marker').id
})

afterAll(() => { vi.restoreAllMocks() })

describe('GET /api/memories/:id', () => {
  it('returns the row for an existing id, without needing a matching keyword', async () => {
    const { ctx, getBody } = makeCtx(`/api/memories/${seededId}`)
    const handled = await tryHandleMemories(ctx)
    expect(handled).toBe(true)
    const body = getBody()
    expect(body.id).toBe(seededId)
    expect(body.agent_id).toBe('agent-a')
    expect(body.category).toBe('shared')
    expect(body.content).toContain('pointer target')
  })

  it('404s for an id that does not exist -- distinct from the route being absent', async () => {
    const { ctx, status } = makeCtx('/api/memories/99999999')
    const handled = await tryHandleMemories(ctx)
    // handled=true is the point: the ROUTE exists and answers. Before the fix
    // this returned false and the caller saw a generic "Not found" from the
    // router, which is indistinguishable from a missing record.
    expect(handled).toBe(true)
    expect(status()).toBe(404)
  })
})

// Card 517fdcc5 (QA FAIL 10812, CRITICAL): GET /api/memories/:id had NO agent-boundary check --
// anyone who knew or guessed a trivially-sequential id could read ANY other agent's private
// ('hot'/'warm'/'cold', i.e. not 'shared') memory in full. There was also a second, dead-code copy
// of this handler added by the same merge (identical route match, shadowed by the one above) --
// deleting it is covered implicitly: if it had survived instead of being deleted, these tests
// would exercise it and fail the same way, since both paths are reached through tryHandleMemories.
describe('GET /api/memories/:id -- agent-boundary check (card 517fdcc5)', () => {
  it('a `?agent=` scope that does not own the row, and the row is not shared, 404s -- not the content', async () => {
    const { ctx, getBody, status } = makeCtx(`/api/memories/${victimPrivateId}?agent=attacker`)
    const handled = await tryHandleMemories(ctx)
    expect(handled).toBe(true)
    expect(status()).toBe(404)
    expect(JSON.stringify(getBody())).not.toContain('victim private hot-tier content')
  })

  it('the owning agent\'s own `?agent=` scope still gets the full row', async () => {
    const { ctx, getBody, status } = makeCtx(`/api/memories/${victimPrivateId}?agent=victim`)
    const handled = await tryHandleMemories(ctx)
    expect(handled).toBe(true)
    expect(status()).toBe(200)
    expect(getBody().content).toBe('victim private hot-tier content')
  })

  it('a `?agent=` scope CAN still read a shared row (shared is cross-agent by design)', async () => {
    const { ctx, getBody, status } = makeCtx(`/api/memories/${seededId}?agent=attacker`)
    const handled = await tryHandleMemories(ctx)
    expect(handled).toBe(true)
    expect(status()).toBe(200)
    expect(getBody().content).toContain('pointer target')
  })

  it('a device key for a DIFFERENT agent overrides a forged `?agent=` param, not just a missing one', async () => {
    const { ctx, status } = makeCtx(`/api/memories/${victimPrivateId}?agent=victim`)
    ;(ctx as any).auth = { kind: 'device', device: 'agent:attacker' }
    const handled = await tryHandleMemories(ctx)
    expect(handled).toBe(true)
    // Without the auth override this would be 200 (the ?agent=victim claim alone would pass) --
    // the device identity must win over a caller-supplied agent param, the same precedent as the
    // POST handler's authenticatedAgentId (card 84dcc5d4).
    expect(status()).toBe(404)
  })

  // Backward-compat pin: no scope at all (no device key, no ?agent=) keeps today's status quo --
  // full isolation for the shared-token caller is explicitly out of scope here (card 2520b85a),
  // this card only closes the identified-caller gap.
  it('no scope at all (shared-token caller, no ?agent=) is UNCHANGED -- still returns the row', async () => {
    const { ctx, getBody, status } = makeCtx(`/api/memories/${victimPrivateId}`)
    const handled = await tryHandleMemories(ctx)
    expect(handled).toBe(true)
    expect(status()).toBe(200)
    expect(getBody().content).toBe('victim private hot-tier content')
  })
})

// Card 517fdcc5 delta #2 (RedHat NO-GO 16623, MikroB decision): the /:id fix above closed the
// boundary for a device-key caller on /:id, but GET /api/memories (list) and its q-search
// branch read the SAME agentId variable and, until this delta, resolved it from `?agent=`
// alone -- a device agent:<id> caller could still read a DIFFERENT agent's private row through
// the list or a keyword search, bypassing the /:id check entirely by never hitting it.
describe('GET /api/memories (list + search) -- agent-boundary check (card 517fdcc5 delta #2)', () => {
  it('a device key for a DIFFERENT agent, with a forged `?agent=`, does not see the victim row in the LIST', async () => {
    const { ctx, getBody } = makeCtx(`/api/memories?agent=victim`)
    ;(ctx as any).auth = { kind: 'device', device: 'agent:attacker' }
    const handled = await tryHandleMemories(ctx)
    expect(handled).toBe(true)
    const body = getBody()
    expect(Array.isArray(body)).toBe(true)
    expect(body.find((m: any) => m.id === victimPrivateId)).toBeUndefined()
  })

  it('the same device key, with NO `?agent=` at all, does not see the victim row via q-SEARCH', async () => {
    const { ctx, getBody } = makeCtx(`/api/memories?q=victim`)
    ;(ctx as any).auth = { kind: 'device', device: 'agent:attacker' }
    const handled = await tryHandleMemories(ctx)
    expect(handled).toBe(true)
    const body = getBody()
    expect(Array.isArray(body)).toBe(true)
    expect(body.find((m: any) => m.id === victimPrivateId)).toBeUndefined()
  })

  it('the owning device key still sees its own row in the list', async () => {
    const { ctx, getBody } = makeCtx(`/api/memories?agent=attacker`)
    ;(ctx as any).auth = { kind: 'device', device: 'agent:victim' }
    const handled = await tryHandleMemories(ctx)
    expect(handled).toBe(true)
    const body = getBody()
    expect(body.find((m: any) => m.id === victimPrivateId)).toBeDefined()
  })

  // Backward-compat pin: a shared-token/session caller (no device key) keeps today's behaviour --
  // the `?agent=` param alone decides, unaffected by this delta.
  it('a shared-token caller (no device key) is UNCHANGED -- `?agent=victim` still returns the row', async () => {
    const { ctx, getBody } = makeCtx(`/api/memories?agent=victim`)
    const handled = await tryHandleMemories(ctx)
    expect(handled).toBe(true)
    const body = getBody()
    expect(body.find((m: any) => m.id === victimPrivateId)).toBeDefined()
  })

  // RedHat N1 (cheap, non-blocking test-gap, folded into this card): the truncation hint carries
  // `?agent=` through so a follow-up /:id call stays scoped the same way the list was.
  it('the truncation hint carries `?agent=` through to the follow-up /:id fetch', async () => {
    const { ctx, getBody } = makeCtx(`/api/memories?agent=victim&max_chars=50&tier=hot`)
    const handled = await tryHandleMemories(ctx)
    expect(handled).toBe(true)
    const row = getBody().find((m: any) => m.id === victimLongId)
    expect(row.content).toContain(`GET /api/memories/${victimLongId}?agent=victim`)
  })
})
