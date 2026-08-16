// Card 037277a0 (onaudit finding, 317b39f7): archiving a parent used to ignore its children
// entirely -- ddddc1f4 got archived with 2 non-done children still pointing parent_id at it,
// orphaning them from every parent-based summary/dispatch view. This is the regression test for
// the fix: POST /api/kanban/<id>/archive refuses (409) when open (non-done) children exist,
// unless force:true is sent, and both directions are covered (blocks / passes-through-with-force /
// passes-clean-with-done-only-children).
import { describe, it, expect, beforeEach } from 'vitest'
import { Readable } from 'node:stream'
import type http from 'node:http'
import { initDatabase, createKanbanCard, getKanbanCard, createIdea, listIdeas } from '../db.js'
import { tryHandleKanban } from '../web/routes/kanban.js'
import type { RouteContext } from '../web/routes/types.js'

function mkReq(body?: unknown): http.IncomingMessage {
  const payload = body === undefined ? [] : [Buffer.from(JSON.stringify(body))]
  const r = Readable.from(payload) as unknown as http.IncomingMessage
  return r
}

function fakeCtx(path: string, method: string, body?: unknown): { ctx: RouteContext; out: { status: number; body: any } } {
  const out: { status: number; body: any } = { status: 0, body: null }
  const res: any = {
    writeHead(status: number) { out.status = status; return res },
    end(chunk?: string) { if (chunk) out.body = JSON.parse(chunk) },
  }
  const url = new URL(`http://localhost:3420${path}`)
  const ctx = { req: mkReq(body), res, path: url.pathname, method, url } as RouteContext
  return { ctx, out }
}

describe('POST /api/kanban/<id>/archive with children (card 037277a0)', () => {
  beforeEach(() => { initDatabase(':memory:') })

  it('archives cleanly when the card has no children', async () => {
    createKanbanCard({ id: 'parent-1', title: 'no kids', status: 'done' })
    const { ctx, out } = fakeCtx('/api/kanban/parent-1/archive', 'POST')
    expect(await tryHandleKanban(ctx)).toBe(true)
    expect(out.status).toBe(200)
    expect(getKanbanCard('parent-1')?.archived_at).toBeTruthy()
  })

  it('archives cleanly when every child is done', async () => {
    createKanbanCard({ id: 'parent-2', title: 'all done kids', status: 'done' })
    createKanbanCard({ id: 'child-2a', title: 'a', status: 'done', parent_id: 'parent-2' })
    createKanbanCard({ id: 'child-2b', title: 'b', status: 'done', parent_id: 'parent-2' })
    const { ctx, out } = fakeCtx('/api/kanban/parent-2/archive', 'POST')
    expect(await tryHandleKanban(ctx)).toBe(true)
    expect(out.status).toBe(200)
    expect(getKanbanCard('parent-2')?.archived_at).toBeTruthy()
  })

  it('BLOCKS (409) when an open child exists, and does NOT set archived_at', async () => {
    createKanbanCard({ id: 'parent-3', title: 'has open kid', status: 'done' })
    createKanbanCard({ id: 'child-3a', title: 'open one', status: 'planned', parent_id: 'parent-3' })
    const { ctx, out } = fakeCtx('/api/kanban/parent-3/archive', 'POST')
    expect(await tryHandleKanban(ctx)).toBe(true)
    expect(out.status).toBe(409)
    expect(out.body.openChildren).toEqual(['child-3a'])
    expect(getKanbanCard('parent-3')?.archived_at).toBeFalsy()
  })

  it('a malformed JSON body does not accidentally grant force (fails closed, still 409)', async () => {
    createKanbanCard({ id: 'parent-4', title: 'has open kid', status: 'done' })
    createKanbanCard({ id: 'child-4a', title: 'open one', status: 'waiting', parent_id: 'parent-4' })
    const { ctx, out } = fakeCtx('/api/kanban/parent-4/archive', 'POST', 'not-json-{{{')
    expect(await tryHandleKanban(ctx)).toBe(true)
    expect(out.status).toBe(409)
    expect(getKanbanCard('parent-4')?.archived_at).toBeFalsy()
  })

  it('force:true archives despite an open child', async () => {
    createKanbanCard({ id: 'parent-5', title: 'has open kid', status: 'done' })
    createKanbanCard({ id: 'child-5a', title: 'open one', status: 'in_progress', parent_id: 'parent-5' })
    const { ctx, out } = fakeCtx('/api/kanban/parent-5/archive', 'POST', { force: true })
    expect(await tryHandleKanban(ctx)).toBe(true)
    expect(out.status).toBe(200)
    expect(getKanbanCard('parent-5')?.archived_at).toBeTruthy()
    // force does not touch the child -- it stays open, still pointing parent_id at the now-archived
    // parent. force is an explicit human override of THIS guard, not an automatic re-parent.
    expect(getKanbanCard('child-5a')?.status).toBe('in_progress')
  })

  it('a BLOCKED archive attempt must not revert the linked idea-box entry (ordering bug this fix could reintroduce)', async () => {
    createKanbanCard({ id: 'parent-6', title: 'has open kid', status: 'done' })
    createKanbanCard({ id: 'child-6a', title: 'open one', status: 'planned', parent_id: 'parent-6' })
    createIdea({
      id: 'idea-6', title: 'linked idea', description: '', category: 'general', source: 'test',
      status: 'kanban', kanban_id: 'parent-6', impact: null, effort: null,
    })

    const { ctx, out } = fakeCtx('/api/kanban/parent-6/archive', 'POST')
    expect(await tryHandleKanban(ctx)).toBe(true)
    expect(out.status).toBe(409)

    // revertIdeaFromKanban must NOT have run on a blocked attempt: the idea stays linked and
    // status 'kanban' -- if the route called it before checking the archive result (the ordering
    // bug this fix could reintroduce), it would have flipped to 'reviewed' with kanban_id cleared.
    const idea = listIdeas({ status: 'kanban' }).find(i => i.id === 'idea-6')
    expect(idea).toBeDefined()
    expect(idea?.kanban_id).toBe('parent-6')
  })
})
