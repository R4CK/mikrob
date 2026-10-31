// Card 9b13108b: GET /api/kg/stats was missing entirely (404 on the Megoldás-tár page). Covers
// the shape web/app-kg.js's kgLoadStats already reads defensively (nodes/usage/backfill/
// ollama_available), the KG_ENABLED=0 -> 404 posture shared with search/for-card
// (kg-search-route.test.ts), and that an unauthenticated call never reaches this handler at all
// (enforced globally by requiresAuth() in web.ts for every /api/* path -- not re-tested here).
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import http from 'node:http'
import Database from 'better-sqlite3'
import type { RouteContext } from '../web/routes/types.js'

let kgEnabledValue = '0'

vi.mock('../settings-store.js', () => ({
  getEffectiveSettingValue: (key: string) => {
    if (key === 'KG_ENABLED') return kgEnabledValue
    if (key === 'KG_TOPK') return 3
    return 0
  },
}))

const realStore = await vi.importActual<typeof import('../kg/store.js')>('../kg/store.js')
const testDb = new Database(':memory:')
realStore.migrate(testDb)
realStore.upsertNode(testDb, {
  id: 'sol:stats1', type: 'solution', project: 'mikrob', title: 'Example solution',
  source_ref: 'kanban_comments:1', extractor: 'manual', status: 'active',
})
realStore.upsertNode(testDb, {
  id: 'sol:stats2', type: 'solution', project: 'mikrob', title: 'Example solution 2',
  source_ref: 'kanban_comments:2', extractor: 'manual', status: 'active',
})
realStore.upsertNode(testDb, {
  id: 'dec:stats1', type: 'decision', project: 'mikrob', title: 'Example decision',
  source_ref: 'kanban_comments:3', extractor: 'manual', status: 'active',
})
realStore.upsertNode(testDb, {
  id: 'sol:archived1', type: 'solution', project: 'mikrob', title: 'Archived solution',
  source_ref: 'kanban_comments:4', extractor: 'manual', status: 'archived',
})
testDb.prepare(
  `INSERT INTO kg_usage (node_id, card_id, agent, event, created_at) VALUES (?, ?, ?, 'offered', ?)`,
).run('sol:stats1', 'cardA', 'backend', 1000)
testDb.prepare(
  `INSERT INTO kg_usage (node_id, card_id, agent, event, created_at) VALUES (?, ?, ?, 'offered', ?)`,
).run('sol:stats2', 'cardA', 'backend', 1000)
testDb.prepare(
  `INSERT INTO kg_usage (node_id, card_id, agent, event, created_at) VALUES (?, ?, ?, 'used', ?)`,
).run('sol:stats1', 'cardA', 'backend', 1001)
testDb.prepare(
  `INSERT INTO kg_capture_queue (card_id, reason, state, created_at, updated_at) VALUES (?, 'closed', 'pending', ?, ?)`,
).run('cardQ1', 1000, 1000)
testDb.prepare(
  `INSERT INTO kg_capture_queue (card_id, reason, state, created_at, updated_at) VALUES (?, 'closed', 'done', ?, ?)`,
).run('cardQ2', 1000, 1000)

vi.mock('../kg/store.js', () => ({
  openKgDb: () => testDb,
  kgDbPath: () => '/dev/null/unused',
}))

const { tryHandleKg } = await import('../web/routes/kg.js')

function makeCtx(path: string): { ctx: RouteContext; body: () => any; status: () => number | undefined } {
  const url = new URL(`http://localhost:3420${path}`)
  let responseBody = ''
  let statusCode: number | undefined
  const res = {
    writeHead: vi.fn((code: number) => { statusCode = code }),
    setHeader: vi.fn(),
    end: (b?: string) => { responseBody = b || '' },
  } as unknown as http.ServerResponse
  return {
    ctx: { req: {} as http.IncomingMessage, res, path, method: 'GET', url },
    body: () => (responseBody ? JSON.parse(responseBody) : null),
    status: () => statusCode,
  }
}

describe('GET /api/kg/stats (card 9b13108b)', () => {
  beforeEach(() => {
    kgEnabledValue = '0'
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true }))
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('KG_ENABLED off (default): 404 kg_disabled, same posture as search/for-card', async () => {
    const { ctx, body, status } = makeCtx('/api/kg/stats')
    await expect(tryHandleKg(ctx)).resolves.toBe(true)
    expect(status()).toBe(404)
    expect(body()).toEqual({ error: 'kg_disabled' })
  })

  it('KG_ENABLED=1: returns 200 with the shape kgLoadStats reads (RED without the route)', async () => {
    kgEnabledValue = '1'
    const { ctx, body, status } = makeCtx('/api/kg/stats')
    await expect(tryHandleKg(ctx)).resolves.toBe(true)
    expect(status()).toBe(200)
    const b = body()
    expect(b.nodes.solution).toBe(2) // archived one excluded
    expect(b.nodes.decision).toBe(1)
    expect(b.usage).toEqual({ rate: 0.5 }) // 1 used / 2 offered
    expect(b.backfill).toEqual({ pending: 1, done: 1, total: 2 })
    expect(b.ollama_available).toBe(true)
  })

  it('ollama unreachable -> ollama_available: false, stats still served', async () => {
    kgEnabledValue = '1'
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('ECONNREFUSED')))
    const { ctx, body } = makeCtx('/api/kg/stats')
    await expect(tryHandleKg(ctx)).resolves.toBe(true)
    expect(body().ollama_available).toBe(false)
    expect(body().nodes.solution).toBe(2)
  })

  it('an unrelated path is not handled', async () => {
    kgEnabledValue = '1'
    const { ctx, body } = makeCtx('/api/kg/other')
    await expect(tryHandleKg(ctx)).resolves.toBe(false)
    expect(body()).toBeNull()
  })
})
