// Card 84dcc5d4 (WhiteHat F1 on 86d5de34, HIGH): POST /api/memories trusted the body's agent_id
// unconditionally -- anyone holding the one shared dashboard token could write a memory claiming
// to be "qa" or "cybersec", and the session-start own-curated injection (card 5a4bea2e part A)
// would later surface it to THAT agent as its own trusted memory. This is a prompt-injection path
// (an attacker-authored row, framed to the victim agent as "KURÁLT MEMÓRIA ... saját ügynök-
// scope-ban").
//
// Fix, two parts:
//   1. Write side (memories.ts POST handler): when the caller authenticated with a per-agent
//      device key (name convention "agent:<id>", auth-device-keys.ts), THAT identity becomes the
//      stored agent_id (overriding the body) and is recorded in written_by_agent_key. A caller
//      using the shared dashboard token keeps the old behaviour byte-for-byte: body agent_id
//      trusted, written_by_agent_key left NULL.
//   2. Read side (db.ts hybridSearch/searchAgentMemories/vectorSearch, selfAuthenticatedOnly
//      param; wired to GET /api/memories?self_authenticated=1, which the hook now always sends
//      for its own-curated query): a row only counts as "self" when written_by_agent_key matches
//      the querying agent -- an agent_id match alone is no longer sufficient. Every row written
//      before this card (and every future shared-token write) has written_by_agent_key = NULL, so
//      none of them qualify -- this closes the hole for ALL existing data immediately, not only
//      for future writes.
import { describe, it, expect, vi, beforeAll } from 'vitest'
import { EventEmitter } from 'node:events'
import type http from 'node:http'
import { initDatabase, getDb, hybridSearch, searchAgentMemories, clearMemoryCache } from '../db.js'
import type { RouteContext } from '../web/routes/types.js'

vi.mock('../config.js', async () => {
  const actual = await vi.importActual<typeof import('../config.js')>('../config.js')
  return { ...actual, MAIN_AGENT_ID: 'marveen', ALLOWED_CHAT_ID: 'test-chat', OLLAMA_URL: '' }
})
vi.mock('../logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() },
}))
// generateEmbedding fires fire-and-forget on every save; stubbing fetch keeps it quiet/instant
// without pulling the embedding model into this test's scope.
vi.stubGlobal('fetch', vi.fn(async () => ({ json: async () => ({ embedding: null }) })))

const { tryHandleMemories } = await import('../web/routes/memories.js')

beforeAll(() => {
  process.env.NODE_ENV = 'test'
  initDatabase(':memory:')
})

function fakeReq(body: unknown): http.IncomingMessage {
  const req = new EventEmitter() as unknown as http.IncomingMessage
  queueMicrotask(() => {
    ;(req as unknown as EventEmitter).emit('data', Buffer.from(JSON.stringify(body)))
    ;(req as unknown as EventEmitter).emit('end')
  })
  return req
}

function fakeRes(): { res: http.ServerResponse; getBody: () => any } {
  let body = ''
  const res = {
    writeHead: vi.fn(),
    setHeader: vi.fn(),
    end: (b?: string) => { body = b || '' },
  } as unknown as http.ServerResponse
  return { res, getBody: () => (body ? JSON.parse(body) : null) }
}

async function post(bodyPayload: unknown, auth?: RouteContext['auth']): Promise<{ id: number }> {
  const { res, getBody } = fakeRes()
  await tryHandleMemories({
    req: fakeReq(bodyPayload),
    res,
    path: '/api/memories',
    method: 'POST',
    url: new URL('http://x/api/memories'),
    auth,
  })
  return getBody() as { id: number }
}

function rowFor(id: number): { agent_id: string; written_by_agent_key: string | null } {
  return getDb().prepare('SELECT agent_id, written_by_agent_key FROM memories WHERE id = ?').get(id) as any
}

describe('POST /api/memories: agent_id authentication (card 84dcc5d4)', () => {
  it('a device key named "agent:<id>" overrides a forged body agent_id -- the AUTHENTICATED identity wins', async () => {
    const result = await post(
      { agent_id: 'qa', content: 'forged: pretending to be qa', category: 'hot' },
      { kind: 'device', device: 'agent:fullstack', deviceId: 1 },
    )
    const row = rowFor(result.id)
    expect(row.agent_id).toBe('fullstack') // NOT 'qa' -- the body claim is discarded
    expect(row.written_by_agent_key).toBe('fullstack')
  })

  it('a device key with no body agent_id at all still stamps the authenticated identity', async () => {
    const result = await post(
      { content: 'no agent_id in body', category: 'hot' },
      { kind: 'device', device: 'agent:qa', deviceId: 2 },
    )
    const row = rowFor(result.id)
    expect(row.agent_id).toBe('qa')
    expect(row.written_by_agent_key).toBe('qa')
  })

  it('the shared dashboard token keeps the OLD behaviour byte-for-byte: body agent_id trusted, written_by_agent_key stays NULL', async () => {
    const result = await post(
      { agent_id: 'qa', content: 'ordinary shared-token write', category: 'hot' },
      { kind: 'token' },
    )
    const row = rowFor(result.id)
    expect(row.agent_id).toBe('qa') // unchanged: still whatever the body said
    expect(row.written_by_agent_key).toBeNull()
  })

  it('no auth context at all (e.g. a public/ungated path reaching this handler) behaves like the token case -- never crashes, never force-authenticates', async () => {
    const result = await post({ agent_id: 'qa', content: 'no auth object', category: 'hot' }, undefined)
    const row = rowFor(result.id)
    expect(row.agent_id).toBe('qa')
    expect(row.written_by_agent_key).toBeNull()
  })

  it('a device key NOT following the "agent:" convention (e.g. a Bridge/phone key) does not authenticate an agent_id -- falls back to the body like a token write', async () => {
    const result = await post(
      { agent_id: 'qa', content: 'written from a phone device key', category: 'hot' },
      { kind: 'device', device: "Peti's iPhone", deviceId: 3 },
    )
    const row = rowFor(result.id)
    expect(row.agent_id).toBe('qa')
    expect(row.written_by_agent_key).toBeNull()
  })
})

describe('hybridSearch selfAuthenticatedOnly (card 84dcc5d4): agent_id match alone is no longer "self" for the curated-injection consumer', () => {
  beforeAll(() => clearMemoryCache())

  it('excludes a row whose agent_id matches but written_by_agent_key is NULL (an ordinary unauthenticated/shared-token write, including every pre-card row)', async () => {
    const db = getDb()
    const now = Math.floor(Date.now() / 1000)
    db.prepare(
      `INSERT INTO memories (chat_id, content, sector, salience, created_at, accessed_at, agent_id, category, keywords, written_by_agent_key)
       VALUES ('0', ?, 'semantic', 1.0, ?, ?, 'qa', 'hot', ?, NULL)`
    ).run('unauthenticated row claiming to be qa zzzqueryterm', now, now, 'zzzqueryterm')

    const unrestricted = await hybridSearch('qa', 'zzzqueryterm', 10)
    expect(unrestricted.map(m => m.content)).toContain('unauthenticated row claiming to be qa zzzqueryterm')

    const selfOnly = await hybridSearch('qa', 'zzzqueryterm', 10, undefined, undefined, true)
    expect(selfOnly.map(m => m.content)).not.toContain('unauthenticated row claiming to be qa zzzqueryterm')
  })

  it('excludes a row whose written_by_agent_key belongs to a DIFFERENT agent, even though agent_id matches the query (the exact forgery shape)', async () => {
    const db = getDb()
    const now = Math.floor(Date.now() / 1000)
    db.prepare(
      `INSERT INTO memories (chat_id, content, sector, salience, created_at, accessed_at, agent_id, category, keywords, written_by_agent_key)
       VALUES ('0', ?, 'semantic', 1.0, ?, ?, 'qa', 'hot', ?, 'attacker')`
    ).run('agent_id says qa but authenticated writer is attacker zzzqueryterm2', now, now, 'zzzqueryterm2')

    const selfOnly = await hybridSearch('qa', 'zzzqueryterm2', 10, undefined, undefined, true)
    expect(selfOnly.map(m => m.content)).not.toContain('agent_id says qa but authenticated writer is attacker zzzqueryterm2')
  })

  it('includes a row where written_by_agent_key genuinely matches the querying agent', async () => {
    const db = getDb()
    const now = Math.floor(Date.now() / 1000)
    db.prepare(
      `INSERT INTO memories (chat_id, content, sector, salience, created_at, accessed_at, agent_id, category, keywords, written_by_agent_key)
       VALUES ('0', ?, 'semantic', 1.0, ?, ?, 'qa', 'hot', ?, 'qa')`
    ).run('authenticated qa-written row zzzqueryterm3', now, now, 'zzzqueryterm3')

    const selfOnly = await hybridSearch('qa', 'zzzqueryterm3', 10, undefined, undefined, true)
    expect(selfOnly.map(m => m.content)).toContain('authenticated qa-written row zzzqueryterm3')
  })
})

// RedHat NO-GO on 84dcc5d4 (msg 10474, comment 15755): a mutation and the targeted 12-file test
// cluster (131 tests) showed the real HIGH-risk gap is at the route, not at hybridSearch's own
// parameter -- the two tests above call hybridSearch directly with selfAuthenticatedOnly=true, so
// a route that silently drops ?self_authenticated=1 (never reaching hybridSearch, or reaching it
// as `false`) stayed 131/131 green. The three describe blocks below pin the three mutants RedHat
// named (M1/M2 route wiring, M4/M14 vector branch, M6 LIKE fallback), each verified to flip red
// under the exact mutation RedHat described before being added here.
function makeGetCtx(searchParams: Record<string, string>): { ctx: RouteContext; body: () => any } {
  const url = new URL('http://localhost:3420/api/memories')
  for (const [k, v] of Object.entries(searchParams)) url.searchParams.set(k, v)
  let responseBody = ''
  const res = {
    writeHead: vi.fn(),
    setHeader: vi.fn(),
    end: (b?: string) => { responseBody = b || '' },
  } as unknown as http.ServerResponse
  return {
    ctx: { req: {} as http.IncomingMessage, res, path: '/api/memories', method: 'GET', url },
    body: () => (responseBody ? JSON.parse(responseBody) : null),
  }
}

describe('GET /api/memories?self_authenticated=1 actually reaches hybridSearch through the real route (card 84dcc5d4, RedHat M1/M2)', () => {
  it('excludes a NULL written_by_agent_key row even though the route, not hybridSearch directly, is the caller', async () => {
    const db = getDb()
    const now = Math.floor(Date.now() / 1000)
    db.prepare(
      `INSERT INTO memories (chat_id, content, sector, salience, created_at, accessed_at, agent_id, category, keywords, written_by_agent_key)
       VALUES ('0', ?, 'semantic', 1.0, ?, ?, 'qa', 'hot', ?, NULL)`
    ).run('route-level unauthenticated row zzzroutequeryterm', now, now, 'zzzroutequeryterm')
    db.prepare(
      `INSERT INTO memories (chat_id, content, sector, salience, created_at, accessed_at, agent_id, category, keywords, written_by_agent_key)
       VALUES ('0', ?, 'semantic', 1.0, ?, ?, 'qa', 'hot', ?, 'qa')`
    ).run('route-level authenticated qa row zzzroutequeryterm', now, now, 'zzzroutequeryterm')

    const { ctx, body } = makeGetCtx({ agent: 'qa', q: 'zzzroutequeryterm', mode: 'hybrid', self_authenticated: '1' })
    await expect(tryHandleMemories(ctx)).resolves.toBe(true)
    const contents = (body() as { content: string }[]).map(m => m.content)
    expect(contents).toContain('route-level authenticated qa row zzzroutequeryterm')
    expect(contents).not.toContain('route-level unauthenticated row zzzroutequeryterm')
  })

  it('without self_authenticated=1, the same route returns BOTH rows (the restriction is opt-in, not always-on)', async () => {
    const { ctx, body } = makeGetCtx({ agent: 'qa', q: 'zzzroutequeryterm', mode: 'hybrid' })
    await expect(tryHandleMemories(ctx)).resolves.toBe(true)
    const contents = (body() as { content: string }[]).map(m => m.content)
    expect(contents).toContain('route-level authenticated qa row zzzroutequeryterm')
    expect(contents).toContain('route-level unauthenticated row zzzroutequeryterm')
  })
})

describe('hybridSearch vector branch honors selfAuthenticatedOnly (card 84dcc5d4, RedHat M4/M14)', () => {
  it('excludes a NULL written_by_agent_key row that matches ONLY by embedding, not by FTS text', async () => {
    const db = getDb()
    const now = Math.floor(Date.now() / 1000)
    // Neither row's content/keywords contain the query term below, so the FTS branch finds
    // nothing and the answer -- if any -- comes from the vector branch alone, isolating M4/M14.
    db.prepare(
      `INSERT INTO memories (chat_id, content, sector, salience, created_at, accessed_at, agent_id, category, keywords, embedding, written_by_agent_key)
       VALUES ('0', ?, 'semantic', 1.0, ?, ?, 'qa', 'hot', 'alpha', ?, NULL)`
    ).run('vector-only unauthenticated row', now, now, JSON.stringify([1, 0, 0, 0]))
    db.prepare(
      `INSERT INTO memories (chat_id, content, sector, salience, created_at, accessed_at, agent_id, category, keywords, embedding, written_by_agent_key)
       VALUES ('0', ?, 'semantic', 1.0, ?, ?, 'qa', 'hot', 'alpha', ?, 'qa')`
    ).run('vector-only authenticated qa row', now, now, JSON.stringify([1, 0, 0, 0]))

    vi.stubGlobal('fetch', vi.fn(async () => ({ json: async () => ({ embedding: [1, 0, 0, 0] }) })))
    try {
      const selfOnly = await hybridSearch('qa', 'zzzznincsilyenszovectoronly', 10, undefined, undefined, true)
      const contents = selfOnly.map(m => m.content)
      expect(contents).toContain('vector-only authenticated qa row')
      expect(contents).not.toContain('vector-only unauthenticated row')
    } finally {
      // Restore the file-wide null-embedding stub so later tests are unaffected.
      vi.stubGlobal('fetch', vi.fn(async () => ({ json: async () => ({ embedding: null }) })))
    }
  })
})

// Runs last on purpose (mirrors ad209cdf's own pattern): dropping memories_fts forces every FTS
// query in the rest of this suite's shared :memory: DB to fail, which is the only honest way to
// reach searchAgentMemories' catch/LIKE fallback without mocking the database driver itself.
describe('searchAgentMemories LIKE fallback honors selfAuthenticatedOnly when FTS is unavailable (card 84dcc5d4, RedHat M6)', () => {
  it('excludes a NULL written_by_agent_key row via the catch-branch LIKE query, category filter included', () => {
    const db = getDb()
    const now = Math.floor(Date.now() / 1000)
    db.prepare(
      `INSERT INTO memories (chat_id, content, sector, salience, created_at, accessed_at, agent_id, category, keywords, written_by_agent_key)
       VALUES ('0', ?, 'semantic', 1.0, ?, ?, 'qa', 'hot', ?, NULL)`
    ).run('fallback unauthenticated row zzzfallbackqueryterm', now, now, 'zzzfallbackqueryterm')
    db.prepare(
      `INSERT INTO memories (chat_id, content, sector, salience, created_at, accessed_at, agent_id, category, keywords, written_by_agent_key)
       VALUES ('0', ?, 'semantic', 1.0, ?, ?, 'qa', 'hot', ?, 'qa')`
    ).run('fallback authenticated qa row zzzfallbackqueryterm', now, now, 'zzzfallbackqueryterm')

    db.exec('DROP TABLE IF EXISTS memories_fts')

    const selfOnly = searchAgentMemories('qa', 'zzzfallbackqueryterm', 10, undefined, true, 'hot', true)
    const contents = selfOnly.map(m => m.content)
    expect(contents).toContain('fallback authenticated qa row zzzfallbackqueryterm')
    expect(contents).not.toContain('fallback unauthenticated row zzzfallbackqueryterm')
  })
})
