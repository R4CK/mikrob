// Card a1d57d99: GET /api/kg/graph, GET /api/kg/activity, and the search-event recording hook
// on the EXISTING /api/kg/search handler (must not change that route's own response shape --
// kg-search-route.test.ts already pins that; this file only adds the new side effect/routes).
//
// Card 9aa41834: /api/kg/search's hybrid search awaits a REAL generateEmbedding() call (kg/search.ts
// -> db.js), which fetches the live Ollama embedding backend with a 5000ms AbortSignal timeout. Under
// land-time load (another process busy on the same backend) the fetch genuinely took close to that
// budget, and vitest's own 5000ms default test timeout fired first -- "Embedding generation failed --
// embedding backend unreachable" in the log, test marked timed out. db.js is mocked below so this file
// never performs that network call; the fetch spy proves it structurally, not just by inspection.
import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest'
import http from 'node:http'
import Database from 'better-sqlite3'
import type { RouteContext } from '../web/routes/types.js'

let kgEnabledValue = '1'
let fadeMs = 15000
let retentionRows = 5000
let graphMaxNodes = 500

vi.mock('../db.js', async () => {
  const real = await vi.importActual<typeof import('../db.js')>('../db.js')
  return { ...real, generateEmbedding: async () => null }
})

const fetchSpy = vi.spyOn(globalThis, 'fetch')
afterAll(() => {
  // STRUCTURAL PIN, not inspection: if the db.js mock above were ever removed or widened to call
  // through, kg/search.ts's real generateEmbedding would reach for the live embedding backend via
  // fetch -- exactly the live network call this file exists to never make. Asserting zero calls
  // catches that regardless of whether a backend happens to be reachable in the run environment.
  expect(fetchSpy).not.toHaveBeenCalled()
})

vi.mock('../settings-store.js', () => ({
  getEffectiveSettingValue: (key: string) => {
    if (key === 'KG_ENABLED') return kgEnabledValue
    if (key === 'KG_TOPK') return 3
    if (key === 'KG_MIN_SCORE') return '0'
    if (key === 'KG_EXPAND_HOPS') return 1
    if (key === 'KG_SNIPPET_MAX_LINES') return 60
    if (key === 'KG_INJECT_MAX_CHARS') return 3000
    if (key === 'KG_ACTIVITY_FADE_MS') return fadeMs
    if (key === 'KG_ACTIVITY_RETENTION_ROWS') return retentionRows
    if (key === 'KG_GRAPH_MAX_NODES') return graphMaxNodes
    return 0
  },
}))

const realStore = await vi.importActual<typeof import('../kg/store.js')>('../kg/store.js')
const testDb = new Database(':memory:')
realStore.migrate(testDb)
realStore.upsertNode(testDb, {
  id: 'sol:graph1', type: 'solution', project: 'mikrob', title: 'A searchable solution',
  body: 'secret-looking body text, never served by /api/kg/graph',
  source_ref: 'kanban_comments:1', extractor: 'manual', status: 'active',
})

vi.mock('../kg/store.js', () => ({
  ...realStore,
  openKgDb: () => testDb,
  kgDbPath: () => '/dev/null/unused',
}))

const { tryHandleKg } = await import('../web/routes/kg.js')

function makeCtx(
  path: string,
  params: Record<string, string>,
  agentId?: string
): { ctx: RouteContext; body: () => any; status: () => number | undefined } {
  const url = new URL(`http://localhost:3420${path}`)
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v)
  let responseBody = ''
  let statusCode: number | undefined
  const res = {
    writeHead: vi.fn((code: number) => { statusCode = code }),
    setHeader: vi.fn(),
    end: (b?: string) => { responseBody = b || '' },
  } as unknown as http.ServerResponse
  return {
    ctx: {
      req: {} as http.IncomingMessage, res, path, method: 'GET', url,
      auth: agentId ? { kind: 'token', agent: agentId } : undefined,
    },
    body: () => (responseBody ? JSON.parse(responseBody) : null),
    status: () => statusCode,
  }
}

describe('GET /api/kg/graph', () => {
  beforeEach(() => {
    kgEnabledValue = '1'
    graphMaxNodes = 500
  })

  it('KG_ENABLED=0 -> 404 kg_disabled, same posture as /api/kg/search', async () => {
    kgEnabledValue = '0'
    const { ctx, body, status } = makeCtx('/api/kg/graph', {})
    await expect(tryHandleKg(ctx)).resolves.toBe(true)
    expect(status()).toBe(404)
    expect(body()).toEqual({ error: 'kg_disabled' })
  })

  it('returns real DB nodes/edges, no body field leaked', async () => {
    const { ctx, body } = makeCtx('/api/kg/graph', {})
    await expect(tryHandleKg(ctx)).resolves.toBe(true)
    const b = body()
    expect(b.nodes.find((n: any) => n.id === 'sol:graph1')).toEqual({
      id: 'sol:graph1', type: 'solution', label: 'A searchable solution', project: 'mikrob',
    })
    expect(JSON.stringify(b)).not.toContain('secret-looking body text')
  })

  it('an explicit limit above the registry cap is clamped, not honored', async () => {
    graphMaxNodes = 2
    const { ctx, body } = makeCtx('/api/kg/graph', { limit: '100000' })
    await expect(tryHandleKg(ctx)).resolves.toBe(true)
    expect(body().nodes.length).toBeLessThanOrEqual(2)
  })

  it('an invalid limit -> 400 limit_invalid', async () => {
    const { ctx, body, status } = makeCtx('/api/kg/graph', { limit: 'nope' })
    await expect(tryHandleKg(ctx)).resolves.toBe(true)
    expect(status()).toBe(400)
    expect(body()).toEqual({ error: 'limit_invalid' })
  })
})

describe('GET /api/kg/activity', () => {
  beforeEach(() => {
    kgEnabledValue = '1'
    fadeMs = 15000
    retentionRows = 5000
  })

  it('KG_ENABLED=0 -> 404 kg_disabled', async () => {
    kgEnabledValue = '0'
    const { ctx, status } = makeCtx('/api/kg/activity', {})
    await expect(tryHandleKg(ctx)).resolves.toBe(true)
    expect(status()).toBe(404)
  })

  it('config.fadeDurationMs reflects the registry default (15000) when unset', async () => {
    const { ctx, body } = makeCtx('/api/kg/activity', {})
    await expect(tryHandleKg(ctx)).resolves.toBe(true)
    expect(body().config).toEqual({ fadeDurationMs: 15000 })
  })

  it('config.fadeDurationMs reflects a non-default registry value, read fresh each call', async () => {
    fadeMs = 9000
    const { ctx, body } = makeCtx('/api/kg/activity', {})
    await expect(tryHandleKg(ctx)).resolves.toBe(true)
    expect(body().config).toEqual({ fadeDurationMs: 9000 })
  })

  it('since_invalid on a non-numeric since param', async () => {
    const { ctx, body, status } = makeCtx('/api/kg/activity', { since: 'nope' })
    await expect(tryHandleKg(ctx)).resolves.toBe(true)
    expect(status()).toBe(400)
    expect(body()).toEqual({ error: 'since_invalid' })
  })

  it('a search via /api/kg/search with X-Agent-Id shows up in /api/kg/activity (Kesz-ha)', async () => {
    const before = Date.now()
    const { ctx: searchCtx } = makeCtx(
      '/api/kg/search', { q: 'searchable solution', project: 'mikrob' }, 'backend2'
    )
    await expect(tryHandleKg(searchCtx)).resolves.toBe(true)

    const { ctx: activityCtx, body } = makeCtx('/api/kg/activity', { since: String(before - 1) })
    await expect(tryHandleKg(activityCtx)).resolves.toBe(true)
    const b = body()
    const ours = b.events.find((e: any) => e.agent_id === 'backend2')
    expect(ours).toBeDefined()
    expect(ours.ts).toBeGreaterThanOrEqual(before)
    expect(ours.hit).toContain('sol:graph1')
  })

  it('a secret-shaped search query is stored redacted in the activity log, not raw', async () => {
    const { ctx: searchCtx } = makeCtx(
      '/api/kg/search', { q: 'api_key=sk-abcdef1234567890', project: 'mikrob' }, 'probe-agent'
    )
    await expect(tryHandleKg(searchCtx)).resolves.toBe(true)
    const row = testDb.prepare(
      `SELECT query FROM kg_search_events WHERE agent = 'probe-agent' ORDER BY id DESC LIMIT 1`
    ).get() as { query: string }
    expect(row.query).not.toContain('sk-abcdef1234567890')
    expect(row.query).toContain('[redacted:secret]')
  })
})
