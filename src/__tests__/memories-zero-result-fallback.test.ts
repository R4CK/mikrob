/**
 * Card ad209cdf (Cybered finding, 2026-09-04): GET /api/memories returned HTTP 500 for an
 * AGENT-SCOPED search with zero matches, while the same search without `agent=` returned a clean
 * empty list. Measured live before the fix:
 *
 *   GET /api/memories?agent=cybered&q=lodash  -> 500 {"error":"Szerver hiba"}
 *   GET /api/memories?q=lodash                -> 200 []
 *
 * Root cause: `excludeToolLogShapeSql()` emits `m.content NOT LIKE ?`, qualified with the alias
 * its PRIMARY consumer needs (searchAgentMemories' FTS query does `FROM memories m JOIN
 * memories_fts f`). Two OTHER queries pasted that fragment into an UNALIASED `FROM memories`, so
 * SQLite raised `no such column: m.content` at prepare time -- every single time they ran:
 *
 *   1. routes/memories.ts -- the zero-result widening fallback (FTS tokenizes, LIKE catches
 *      substrings). Reached only when the FTS search returns nothing, which is exactly the
 *      "no results" case, so the caller could never tell "nothing matched" from "the memory
 *      system is broken". This is the reported 500.
 *   2. db.ts searchAgentMemories' own `catch` fallback -- the designated safety net for an FTS
 *      failure. Latent, because the FTS path rarely throws, but a safety net that raises a
 *      DIFFERENT error instead of catching is worse than none: it converts a recoverable
 *      degradation into a hard 500.
 *
 * Neither fallback had EVER returned a row. The test below pins both, because fixing only the
 * loud one leaves the quiet one armed for the day FTS actually fails.
 */
import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest'
import { initDatabase, saveAgentMemory, searchAgentMemories, getDb } from '../db.js'
import { tryHandleMemories } from '../web/routes/memories.js'
import type { RouteContext } from '../web/routes/types.js'

vi.mock('../config.js', async () => {
  const actual = await vi.importActual<typeof import('../config.js')>('../config.js')
  return { ...actual, MAIN_AGENT_ID: 'agent-a', ALLOWED_CHAT_ID: 'test-chat', OLLAMA_URL: '' }
})
vi.mock('../logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() },
}))

function makeCtx(searchParams: Record<string, string>): {
  ctx: RouteContext
  status: () => number
  body: () => any
} {
  const url = new URL('http://localhost:3420/api/memories')
  for (const [k, v] of Object.entries(searchParams)) url.searchParams.set(k, v)
  let code = 200
  let responseBody = ''
  const res = {
    writeHead: (c: number) => { code = c },
    end: (b?: string) => { responseBody = b || '' },
    setHeader: vi.fn(),
  }
  return {
    ctx: { req: { headers: {} } as any, res: res as any, path: '/api/memories', method: 'GET', url },
    status: () => code,
    body: () => (responseBody ? JSON.parse(responseBody) : null),
  }
}

beforeAll(() => {
  process.env.NODE_ENV = 'test'
  initDatabase(':memory:')
  saveAgentMemory('agent-a', 'the landing guard re-reads acknowledged blob shas', 'warm', 'landing guard')
  saveAgentMemory('shared', 'gate verdicts must name the sha they judged', 'shared', 'gate sha')
})

afterAll(() => { vi.restoreAllMocks() })

describe('GET /api/memories: a zero-result AGENT-SCOPED search is an empty list, not a 500 (card ad209cdf)', () => {
  it('the reported case: agent= plus a query nothing matches', async () => {
    const { ctx, status, body } = makeCtx({ agent: 'agent-a', q: 'zzzznonexistentterm' })
    await expect(tryHandleMemories(ctx)).resolves.toBe(true)
    expect(status()).toBe(200)
    expect(body()).toEqual([])
  })

  it('the same query WITHOUT agent= already worked, and still does (no regression on the good path)', async () => {
    const { ctx, status, body } = makeCtx({ q: 'zzzznonexistentterm' })
    await expect(tryHandleMemories(ctx)).resolves.toBe(true)
    expect(status()).toBe(200)
    expect(body()).toEqual([])
  })

  it('a MATCHING agent-scoped search still returns its rows (the fix must not empty the good path)', async () => {
    const { ctx, status, body } = makeCtx({ agent: 'agent-a', q: 'landing guard' })
    await expect(tryHandleMemories(ctx)).resolves.toBe(true)
    expect(status()).toBe(200)
    expect(body().length).toBeGreaterThan(0)
  })

  it('the widening fallback actually WIDENS: a substring FTS cannot tokenize now returns its row', async () => {
    // FTS matches whole tokens, so a mid-word fragment finds nothing there and falls through to
    // the LIKE fallback. Before the fix this threw; the row was unreachable by any query shape.
    const { ctx, status, body } = makeCtx({ agent: 'agent-a', q: 'cknowledged' })
    await expect(tryHandleMemories(ctx)).resolves.toBe(true)
    expect(status()).toBe(200)
    expect(body().length).toBeGreaterThan(0)
  })

  it('the shape filter the fallback carries is still ENFORCED, not dropped to make it run', async () => {
    // The lazy fix would be to delete the offending fragment. Then tool-log rows (card 3bcc1242)
    // would leak back into exactly the search path that was broken. Pin the filter, not just the
    // absence of a crash.
    saveAgentMemory('agent-a', 'Bash: rehearsing the widget rollout', 'hot', 'widget rollout', true)
    const { ctx, status, body } = makeCtx({ agent: 'agent-a', q: 'ehearsing' })
    await expect(tryHandleMemories(ctx)).resolves.toBe(true)
    expect(status()).toBe(200)
    expect(body().find((m: any) => m.content.startsWith('Bash: '))).toBeUndefined()
  })
})

describe('searchAgentMemories: its own catch-fallback must survive an FTS failure (card ad209cdf)', () => {
  it('with memories_fts gone, the fallback returns rows instead of raising a second error', () => {
    // Dropping the FTS table is the honest way to reach the catch branch: it makes the primary
    // query fail at prepare time, exactly as a corrupt or missing FTS index would in production.
    // Runs last on purpose -- inserts after this point would hit the FTS sync trigger.
    const before = searchAgentMemories('agent-a', 'landing guard', 10)
    expect(before.length).toBeGreaterThan(0)

    getDb().exec('DROP TABLE IF EXISTS memories_fts')

    const after = searchAgentMemories('agent-a', 'landing guard', 10)
    expect(after.length).toBeGreaterThan(0)
    expect(after.find((m) => m.content.startsWith('Bash: '))).toBeUndefined()
  })
})
