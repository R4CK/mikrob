import { describe, it, expect, vi, beforeEach } from 'vitest'
import http from 'node:http'
import Database from 'better-sqlite3'
import type { RouteContext } from '../web/routes/types.js'

let kgEnabledValue = '0'
let topK = 3

vi.mock('../settings-store.js', () => ({
  getEffectiveSettingValue: (key: string) => {
    if (key === 'KG_ENABLED') return kgEnabledValue
    if (key === 'KG_TOPK') return topK
    if (key === 'KG_MIN_SCORE') return '0' // lenient in tests, the search.test.ts suite covers the real default
    if (key === 'KG_EXPAND_HOPS') return 1
    if (key === 'KG_SNIPPET_MAX_LINES') return 60
    if (key === 'KG_INJECT_MAX_CHARS') return 3000
    return 0
  },
}))

const realStore = await vi.importActual<typeof import('../kg/store.js')>('../kg/store.js')
const testDb = new Database(':memory:')
realStore.migrate(testDb)
realStore.upsertNode(testDb, {
  id: 'sol:route1', type: 'solution', project: 'mikrob', title: 'Fix hybridSearch guard',
  source_ref: 'kanban_comments:1', extractor: 'manual', status: 'active',
})

vi.mock('../kg/store.js', () => ({
  openKgDb: () => testDb,
  kgDbPath: () => '/dev/null/unused',
}))

vi.mock('../db.js', async () => {
  const actual = await vi.importActual<typeof import('../db.js')>('../db.js')
  return {
    ...actual,
    generateEmbedding: vi.fn(async () => null),
    getKanbanCard: vi.fn((id: string) => {
      if (id === 'cardA') return { id: 'cardA', title: 'Fix hybridSearch guard', description: '', project: 'MikroB' }
      return undefined
    }),
  }
})

const { tryHandleKg, resolveK } = await import('../web/routes/kg.js')

function makeCtx(path: string, params: Record<string, string>): { ctx: RouteContext; body: () => any; status: () => number | undefined } {
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
    ctx: { req: {} as http.IncomingMessage, res, path, method: 'GET', url },
    body: () => (responseBody ? JSON.parse(responseBody) : null),
    status: () => statusCode,
  }
}

describe('GET /api/kg/search and /api/kg/for-card (MT-04, card 34c2d2a2)', () => {
  beforeEach(() => {
    kgEnabledValue = '0'
    topK = 3
  })

  it('KG_ENABLED off (default): both routes 404 with kg_disabled, byte-stable even with valid params', async () => {
    const { ctx: s, body: sBody, status: sStatus } = makeCtx('/api/kg/search', { q: 'fix' })
    await expect(tryHandleKg(s)).resolves.toBe(true)
    expect(sStatus()).toBe(404)
    expect(sBody()).toEqual({ error: 'kg_disabled' })

    const { ctx: f, body: fBody, status: fStatus } = makeCtx('/api/kg/for-card/cardA', {})
    await expect(tryHandleKg(f)).resolves.toBe(true)
    expect(fStatus()).toBe(404)
    expect(fBody()).toEqual({ error: 'kg_disabled' })
  })

  it('KG_ENABLED=1: search finds the seeded node and sets X-KG-Search header', async () => {
    kgEnabledValue = '1'
    const { ctx, body } = makeCtx('/api/kg/search', { q: 'fix hybridSearch guard', project: 'mikrob' })
    await expect(tryHandleKg(ctx)).resolves.toBe(true)
    const b = body()
    expect(b.results.map((r: any) => r.id)).toContain('sol:route1')
    expect(ctx.res.setHeader).toHaveBeenCalledWith('X-KG-Search', expect.stringContaining('scope=mikrob'))
  })

  it('KG_ENABLED accepts the pre-existing on/off shell convention, not only 1/0', async () => {
    kgEnabledValue = 'on'
    const { ctx, status } = makeCtx('/api/kg/search', { q: 'fix', project: 'mikrob' })
    await expect(tryHandleKg(ctx)).resolves.toBe(true)
    expect(status()).toBe(200) // not 404 -- "on" was accepted the same as "1"
  })

  it('missing q and path -> 400 q_or_path_required', async () => {
    kgEnabledValue = '1'
    const { ctx, body, status } = makeCtx('/api/kg/search', { project: 'mikrob' })
    await expect(tryHandleKg(ctx)).resolves.toBe(true)
    expect(status()).toBe(400)
    expect(body()).toEqual({ error: 'q_or_path_required' })
  })

  it('neither project nor card_id -> 400 project_or_card_id_required', async () => {
    kgEnabledValue = '1'
    const { ctx, body, status } = makeCtx('/api/kg/search', { q: 'fix' })
    await expect(tryHandleKg(ctx)).resolves.toBe(true)
    expect(status()).toBe(400)
    expect(body()).toEqual({ error: 'project_or_card_id_required' })
  })

  it('KG_ENABLED=1: for-card returns the dispatch package shape', async () => {
    kgEnabledValue = '1'
    const { ctx, body } = makeCtx('/api/kg/for-card/cardA', {})
    await expect(tryHandleKg(ctx)).resolves.toBe(true)
    const b = body()
    expect(b.card_id).toBe('cardA')
    expect(Array.isArray(b.solutions)).toBe(true)
  })

  it('an unrelated path is not handled (returns false, writes nothing)', async () => {
    kgEnabledValue = '1'
    const { ctx, body } = makeCtx('/api/kg/other', {})
    await expect(tryHandleKg(ctx)).resolves.toBe(false)
    expect(body()).toBeNull()
  })

  // WhiteHat NO-GO F2 MEDIUM (card 34c2d2a2, comment 24103): `k` had no upper bound (the KG_TOPK
  // registry max only applied to the DEFAULT, not an explicit `?k=`), and `q`/`path`/`types`/
  // `project` had no length/count bound at all. Each case here is red against the pre-fix code
  // (an unclamped `k`, and no length/count checks at all).
  describe('F2 MEDIUM: k/q/path/types/project bounds', () => {
    it('resolveK clamps an oversized k to the real KG_TOPK registry max (8)', () => {
      expect(resolveK('100000')).toBe(8)
      expect(resolveK('8')).toBe(8)
      expect(resolveK('5')).toBe(5)
      expect(resolveK('0')).toBe(3) // invalid (<=0) falls back to the default, not clamped-to-min
      expect(resolveK('not-a-number')).toBe(3)
      expect(resolveK(null)).toBe(3)
    })

    it('?k=100000 does not crash the route (end-to-end, clamp applied before the SQL LIMIT)', async () => {
      kgEnabledValue = '1'
      const { ctx, body } = makeCtx('/api/kg/search', { q: 'fix', project: 'mikrob', k: '100000' })
      await expect(tryHandleKg(ctx)).resolves.toBe(true)
      expect(body().results).toBeDefined()
    })

    it('q over 2000 chars -> 400 q_too_long, hybridKgSearch never reached', async () => {
      kgEnabledValue = '1'
      const { ctx, body, status } = makeCtx('/api/kg/search', { q: 'a'.repeat(2001), project: 'mikrob' })
      await expect(tryHandleKg(ctx)).resolves.toBe(true)
      expect(status()).toBe(400)
      expect(body()).toEqual({ error: 'q_too_long' })
    })

    it('q at exactly 2000 chars is accepted (boundary)', async () => {
      kgEnabledValue = '1'
      const { ctx, status } = makeCtx('/api/kg/search', { q: 'a'.repeat(2000), project: 'mikrob' })
      await expect(tryHandleKg(ctx)).resolves.toBe(true)
      expect(status()).not.toBe(400)
    })

    it('more than 32 repeated path/types params -> 400 too_many_values', async () => {
      kgEnabledValue = '1'
      const { ctx, body, status } = makeCtx('/api/kg/search', { q: 'fix', project: 'mikrob' })
      for (let i = 0; i < 33; i++) ctx.url.searchParams.append('path', `src/file${i}.ts`)
      await expect(tryHandleKg(ctx)).resolves.toBe(true)
      expect(status()).toBe(400)
      expect(body()).toEqual({ error: 'too_many_values' })
    })

    it('project over 2000 chars -> 400 project_too_long', async () => {
      kgEnabledValue = '1'
      const { ctx, body, status } = makeCtx('/api/kg/search', { q: 'fix', project: 'a'.repeat(2001) })
      await expect(tryHandleKg(ctx)).resolves.toBe(true)
      expect(status()).toBe(400)
      expect(body()).toEqual({ error: 'project_too_long' })
    })

    it('for-card ?k=100000 does not throw (clamped, same resolveK as search)', async () => {
      kgEnabledValue = '1'
      const { ctx, status } = makeCtx('/api/kg/for-card/cardA', { k: '100000' })
      await expect(tryHandleKg(ctx)).resolves.toBe(true)
      expect(status()).not.toBe(500)
    })
  })
})
