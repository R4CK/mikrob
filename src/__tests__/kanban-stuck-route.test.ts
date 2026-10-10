// GET /api/kanban/stuck -- card 7b0b822f. Route-level wiring test: the handler returns
// getStuckKanbanCards()'s output, and (the main regression risk, same shape as ebf7d95c) does not
// get shadowed by the single-segment GET /api/kanban/<id> catch-all registered later in the file.
import { describe, it, expect, beforeEach } from 'vitest'
import { initDatabase, createKanbanCard, getDb } from '../db.js'
import { tryHandleKanban } from '../web/routes/kanban.js'
import type { RouteContext } from '../web/routes/types.js'

function fakeCtx(path: string, method = 'GET'): { ctx: RouteContext; out: { status: number; body: any } } {
  const out: { status: number; body: any } = { status: 0, body: null }
  const res: any = {
    writeHead(status: number) { out.status = status; return res },
    end(chunk?: string) { if (chunk) out.body = JSON.parse(chunk) },
  }
  const url = new URL(`http://localhost:3420${path}`)
  const ctx = { req: {} as any, res, path: url.pathname, method, url } as RouteContext
  return { ctx, out }
}

describe('GET /api/kanban/stuck (card 7b0b822f)', () => {
  beforeEach(() => { initDatabase(':memory:') })

  it('returns idle in_progress cards, not a 404 for a card literally named "stuck"', async () => {
    createKanbanCard({ id: 'c1', title: 'a stuck card', status: 'in_progress', assignee: 'backend' })
    getDb().prepare('UPDATE kanban_cards SET created_at = ? WHERE id = ?').run(1_000, 'c1')
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
})
