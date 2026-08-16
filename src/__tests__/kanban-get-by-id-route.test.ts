// card ebf7d95c: GET /api/kanban/<id> 404'd unconditionally -- PUT/DELETE on the SAME path already
// worked, so the missing GET route read as "the card doesn't exist / a sync bug" and repeatedly
// confused both Teszter and MikroB into the wrong diagnosis. This is the route-level regression test
// for the fix: the new handler must both WORK and not shadow the single-segment GET routes that
// already lived on /api/kanban/<word> (archived, labels, assignees, heartbeat-summary).
import { describe, it, expect, beforeEach } from 'vitest'
import { initDatabase, createKanbanCard } from '../db.js'
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

describe('GET /api/kanban/<id> (card ebf7d95c)', () => {
  beforeEach(() => { initDatabase(':memory:') })

  it('returns the card when it exists', async () => {
    createKanbanCard({ id: 'abc123', title: 'a real card', status: 'planned' })
    const { ctx, out } = fakeCtx('/api/kanban/abc123')
    expect(await tryHandleKanban(ctx)).toBe(true)
    expect(out.status).toBe(200)
    expect(out.body.id).toBe('abc123')
    expect(out.body.title).toBe('a real card')
  })

  it('404s with a descriptive message for a genuinely missing id (not a silent empty body)', async () => {
    const { ctx, out } = fakeCtx('/api/kanban/does-not-exist')
    expect(await tryHandleKanban(ctx)).toBe(true)
    expect(out.status).toBe(404)
    expect(out.body.error).toBeTruthy()
  })

  // THE REGRESSION THIS FIX COULD HAVE INTRODUCED: kanbanCardMatch's `([^/]+)` matches ANY single
  // path segment, including the literal words every other single-segment GET route on this path
  // already claims. If the new handler were checked BEFORE those, it would swallow their requests
  // and answer "card not found" for a route that has nothing to do with a card id.
  describe('does not shadow the other single-segment /api/kanban/<word> GET routes', () => {
    it('/api/kanban/archived still serves the archived-list endpoint, not a 404 for a card literally named "archived"', async () => {
      const { ctx, out } = fakeCtx('/api/kanban/archived')
      expect(await tryHandleKanban(ctx)).toBe(true)
      expect(out.status).toBe(200)
      expect(out.body).toHaveProperty('cards')
      expect(out.body).not.toHaveProperty('error')
    })

    it('/api/kanban/labels still serves the labels endpoint', async () => {
      const { ctx, out } = fakeCtx('/api/kanban/labels')
      expect(await tryHandleKanban(ctx)).toBe(true)
      expect(out.status).toBe(200)
      expect(Array.isArray(out.body)).toBe(true)
    })

    it('/api/kanban/assignees still serves the assignees endpoint', async () => {
      const { ctx, out } = fakeCtx('/api/kanban/assignees')
      expect(await tryHandleKanban(ctx)).toBe(true)
      expect(out.status).toBe(200)
      expect(out.body).not.toHaveProperty('error')
    })

    it('/api/kanban/heartbeat-summary still serves its own endpoint', async () => {
      const { ctx, out } = fakeCtx('/api/kanban/heartbeat-summary')
      expect(await tryHandleKanban(ctx)).toBe(true)
      expect(out.status).toBe(200)
      expect(out.body).not.toHaveProperty('error')
    })
  })
})
