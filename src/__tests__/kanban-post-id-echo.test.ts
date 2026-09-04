// POST /api/kanban must answer with the id it actually STORED (card f27c999b, B-wave 4/6).
//
// THE BUG, adopted from upstream's fix. The handler generated an id, then spread the request body
// over it: `createKanbanCard({ id, ...normalized })`. A caller-supplied `id` therefore won in the
// DATABASE ROW while the response echoed the GENERATED one -- HTTP 200 handing back an id that
// matches no card, with the caller's real card sitting under a name it was never told.
//
// It is the quiet kind: the write succeeds, the status is 200, and every symptom appears later and
// somewhere else -- a follow-up PUT 404s, a dispatch names a card nobody can find, a parent_id
// points at nothing. Exactly the shape that cost this fleet a round on GET /api/kanban/<id> before
// (card ebf7d95c), where a missing route read as "the card does not exist".
import { describe, it, expect, beforeEach } from 'vitest'
import { Readable } from 'node:stream'
import type http from 'node:http'
import { initDatabase, getKanbanCard } from '../db.js'
import { tryHandleKanban } from '../web/routes/kanban.js'
import type { RouteContext } from '../web/routes/types.js'

function fakeCtx(path: string, method: string, body?: unknown): { ctx: RouteContext; out: { status: number; body: any } } {
  const out: { status: number; body: any } = { status: 0, body: null }
  const res: any = {
    writeHead(status: number) { out.status = status; return res },
    end(chunk?: string) { if (chunk) out.body = JSON.parse(chunk) },
  }
  const req = Readable.from(body === undefined ? [] : [Buffer.from(JSON.stringify(body))]) as unknown as http.IncomingMessage
  const url = new URL(`http://localhost:3420${path}`)
  return { ctx: { req, res, path: url.pathname, method, url } as RouteContext, out }
}

beforeEach(() => { initDatabase(':memory:') })

describe('POST /api/kanban returns the id it stored', () => {
  it('THE INCIDENT SHAPE: a caller-supplied id is echoed back, and the card exists under it', async () => {
    const { ctx, out } = fakeCtx('/api/kanban', 'POST', { id: 'mycard01', title: 'supplied id', status: 'planned' })
    expect(await tryHandleKanban(ctx)).toBe(true)
    expect(out.body.id).toBe('mycard01')
    // The assertion that would have failed before: the ECHOED id resolves to a real card.
    expect(getKanbanCard(out.body.id)).toBeTruthy()
    expect(getKanbanCard('mycard01')?.title).toBe('supplied id')
  })

  it('generates an id when the caller supplies none, and that one resolves too', async () => {
    const { ctx, out } = fakeCtx('/api/kanban', 'POST', { title: 'generated id', status: 'planned' })
    expect(await tryHandleKanban(ctx)).toBe(true)
    expect(typeof out.body.id).toBe('string')
    expect(out.body.id).toHaveLength(8)
    expect(getKanbanCard(out.body.id)?.title).toBe('generated id')
  })

  it('an empty or whitespace id is treated as absent, not stored as a blank key', async () => {
    // A blank id would create a row nothing can address -- worse than a mismatch, because there is
    // no second name under which to find it.
    for (const bad of ['', '   ']) {
      const { ctx, out } = fakeCtx('/api/kanban', 'POST', { id: bad, title: 'blank id', status: 'planned' })
      expect(await tryHandleKanban(ctx)).toBe(true)
      expect(out.body.id.trim()).not.toBe('')
      expect(getKanbanCard(out.body.id)).toBeTruthy()
    }
  })

  it('the echoed id and the stored row agree for every shape -- the property, stated once', async () => {
    for (const body of [
      { title: 'a', status: 'planned' },
      { id: 'deadbeef', title: 'b', status: 'planned' },
      { id: 'x1', title: 'c', status: 'planned', project: 'MikroB' },
    ]) {
      const { ctx, out } = fakeCtx('/api/kanban', 'POST', body)
      expect(await tryHandleKanban(ctx)).toBe(true)
      expect(getKanbanCard(out.body.id), `no card for echoed id ${out.body.id}`).toBeTruthy()
    }
  })
})
