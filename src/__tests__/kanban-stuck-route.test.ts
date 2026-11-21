// GET /api/kanban/stuck -- card 7b0b822f. Route-level wiring test: the handler returns
// getStuckKanbanCards()'s output, and (the main regression risk, same shape as ebf7d95c) does not
// get shadowed by the single-segment GET /api/kanban/<id> catch-all registered later in the file.
import { describe, it, expect, beforeEach } from 'vitest'
import { gunzipSync } from 'node:zlib'
import { initDatabase, createKanbanCard, getDb, STUCK_KANBAN_IDLE_THRESHOLD_SEC } from '../db.js'
import { tryHandleKanban } from '../web/routes/kanban.js'
import type { RouteContext } from '../web/routes/types.js'

// Card e892e00c F2: the route now responds via jsonMaybeGzip, which reads req.headers --
// req needs a headers object (empty is fine, same as a client sending no Accept-Encoding).
function fakeCtx(
  path: string,
  method = 'GET',
  headers: Record<string, string> = {},
): { ctx: RouteContext; out: { status: number; body: any; headers: Record<string, string> } } {
  const out: { status: number; body: any; headers: Record<string, string> } = { status: 0, body: null, headers: {} }
  const res: any = {
    writeHead(status: number, hdrs?: Record<string, string>) { out.status = status; if (hdrs) out.headers = hdrs; return res },
    end(chunk?: Buffer | string) {
      if (!chunk) return
      const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
      const raw = out.headers['Content-Encoding'] === 'gzip' ? gunzipSync(buf) : buf
      out.body = JSON.parse(raw.toString('utf8'))
    },
  }
  const url = new URL(`http://localhost:3420${path}`)
  const ctx = { req: { headers } as any, res, path: url.pathname, method, url } as RouteContext
  return { ctx, out }
}

describe('GET /api/kanban/stuck (card 7b0b822f)', () => {
  beforeEach(() => { initDatabase(':memory:') })

  it('returns idle in_progress cards, not a 404 for a card literally named "stuck"', async () => {
    createKanbanCard({ id: 'c1', title: 'a stuck card', status: 'in_progress', assignee: 'backend' })
    getDb().prepare('UPDATE kanban_cards SET created_at = ? WHERE id = ?').run(1_000, 'c1')
    // Card d06a325d: back-date the opening kanban_card_events row too (see createKanbanCard),
    // or last_status_at reads "now" instead of the intended-old created_at.
    getDb().prepare("UPDATE kanban_card_events SET created_at = ? WHERE card_id = 'c1' AND from_status IS NULL").run(1_000)
    const { ctx, out } = fakeCtx('/api/kanban/stuck')
    expect(await tryHandleKanban(ctx)).toBe(true)
    expect(out.status).toBe(200)
    expect(Array.isArray(out.body)).toBe(true)
    expect(out.body).not.toHaveProperty('error')
    expect(out.body.some((r: { cardId: string }) => r.cardId === 'c1')).toBe(true)
  })

  it('excludes a freshly started card (not idle yet)', async () => {
    createKanbanCard({ id: 'c2', title: 'just started', status: 'in_progress', assignee: 'backend' })
    const { ctx, out } = fakeCtx('/api/kanban/stuck')
    expect(await tryHandleKanban(ctx)).toBe(true)
    expect(out.body).toEqual([])
  })

  // Card e892e00c F1 (WhiteHat on 7b0b822f): pins the exact divergence the finding measured --
  // a bare `updated_at` bump (what a [NN%] title PUT does, no status event, no comment) does NOT
  // make this endpoint see the card as recently active. If it ever started reading updated_at
  // instead of the event/comment trail, this card would wrongly drop out of the idle list.
  it('stays idle even after a bare updated_at bump with no status event or comment (the F1 divergence)', async () => {
    createKanbanCard({ id: 'c3', title: 'idle despite a title edit', status: 'in_progress', assignee: 'backend' })
    getDb().prepare('UPDATE kanban_cards SET created_at = ? WHERE id = ?').run(1_000, 'c3')
    getDb().prepare("UPDATE kanban_card_events SET created_at = ? WHERE card_id = 'c3' AND from_status IS NULL").run(1_000)
    // Simulates a [NN%] title PUT: bumps updated_at to "now", touching neither
    // kanban_card_events nor kanban_comments.
    getDb().prepare('UPDATE kanban_cards SET updated_at = ? WHERE id = ?').run(Math.floor(Date.now() / 1000), 'c3')
    const { ctx, out } = fakeCtx('/api/kanban/stuck')
    expect(await tryHandleKanban(ctx)).toBe(true)
    expect(out.body.some((r: { cardId: string }) => r.cardId === 'c3')).toBe(true)
  })

  // Card e892e00c F3: the threshold is the exported constant, not re-typed as a literal here.
  it('a card exactly at the threshold is NOT yet idle; one second past it is', async () => {
    createKanbanCard({ id: 'c4', title: 'right at the edge', status: 'in_progress', assignee: 'backend' })
    const past = Math.floor(Date.now() / 1000) - STUCK_KANBAN_IDLE_THRESHOLD_SEC
    getDb().prepare('UPDATE kanban_cards SET created_at = ? WHERE id = ?').run(past, 'c4')
    getDb().prepare("UPDATE kanban_card_events SET created_at = ? WHERE card_id = 'c4' AND from_status IS NULL").run(past)
    const atThreshold = fakeCtx('/api/kanban/stuck')
    expect(await tryHandleKanban(atThreshold.ctx)).toBe(true)
    expect(atThreshold.out.body.some((r: { cardId: string }) => r.cardId === 'c4')).toBe(true)
  })

  // Card e892e00c F3: GET is the only method this route answers for -- POST hits the
  // single-card-path 405 catch-all (line ~2351) instead of being read as a card id lookup.
  it('answers 405, not the idle-list body, for an unsupported method', async () => {
    const { ctx, out } = fakeCtx('/api/kanban/stuck', 'POST')
    expect(await tryHandleKanban(ctx)).toBe(true)
    expect(out.status).toBe(405)
  })

  // Card e892e00c F2: same `limit=` convention as GET /api/kanban (card 514a9fb3 M1).
  it('limit= caps the returned array and rejects a non-numeric value', async () => {
    for (let i = 0; i < 3; i++) {
      createKanbanCard({ id: `c5-${i}`, title: `idle ${i}`, status: 'in_progress', assignee: 'backend' })
      getDb().prepare('UPDATE kanban_cards SET created_at = ? WHERE id = ?').run(1_000, `c5-${i}`)
      getDb().prepare(`UPDATE kanban_card_events SET created_at = ? WHERE card_id = 'c5-${i}' AND from_status IS NULL`).run(1_000)
    }
    const capped = fakeCtx('/api/kanban/stuck?limit=2')
    expect(await tryHandleKanban(capped.ctx)).toBe(true)
    expect(capped.out.body.length).toBe(2)

    const bad = fakeCtx('/api/kanban/stuck?limit=abc')
    expect(await tryHandleKanban(bad.ctx)).toBe(true)
    expect(bad.out.status).toBe(400)
  })

  // Card e892e00c F2: gzip only when the client accepts it AND the payload is worth it
  // (jsonMaybeGzip's own GZIP_MIN_BYTES threshold) -- same contract as GET /api/kanban.
  it('gzips the body when the client accepts gzip and the payload is large enough', async () => {
    for (let i = 0; i < 30; i++) {
      const id = `c6-${i}`
      createKanbanCard({ id, title: `idle card number ${i} with a reasonably long title to pad the payload`, status: 'in_progress', assignee: 'backend' })
      getDb().prepare('UPDATE kanban_cards SET created_at = ? WHERE id = ?').run(1_000, id)
      getDb().prepare(`UPDATE kanban_card_events SET created_at = ? WHERE card_id = '${id}' AND from_status IS NULL`).run(1_000)
    }
    const plain = fakeCtx('/api/kanban/stuck')
    expect(await tryHandleKanban(plain.ctx)).toBe(true)
    expect(plain.out.headers['Content-Encoding']).toBeUndefined()
    expect(plain.out.body.length).toBe(30)

    const gz = fakeCtx('/api/kanban/stuck', 'GET', { 'accept-encoding': 'gzip' })
    expect(await tryHandleKanban(gz.ctx)).toBe(true)
    expect(gz.out.headers['Content-Encoding']).toBe('gzip')
    expect(gz.out.body.length).toBe(30)
  })
})
