// Card e25a549a (Peti, Telegram 10943, 2026-10-11): "A neveden miert van kartya? Neked kiosztani
// kell a feladatokat, nem megoldani." assignee="mikrob" must be refused at the write boundary --
// create (POST /api/kanban) and update (PUT /api/kanban/:id) -- not just discouraged in prose.
//
// Measured before this fix: neither route checked the `assignee` value at all, so a card could be
// opened or reassigned onto MikroB's own name with no pushback, and it would then sit unworked
// (MikroB does not self-advance its own cards, rule 11) and invisible to the fleet dispatch sweep.
import { describe, it, expect, beforeEach } from 'vitest'
import { Readable } from 'node:stream'
import type http from 'node:http'
import { initDatabase, getKanbanCard, createKanbanCard } from '../db.js'
import { tryHandleKanban } from '../web/routes/kanban.js'
import type { RouteContext } from '../web/routes/types.js'
import { isForbiddenAssignee } from '../web/kanban-assignee-guard.js'

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

describe('isForbiddenAssignee (pure check)', () => {
  it('matches "mikrob" case-insensitively and trims whitespace', () => {
    expect(isForbiddenAssignee('mikrob')).toBe(true)
    expect(isForbiddenAssignee('MikroB')).toBe(true)
    expect(isForbiddenAssignee('  mikrob  ')).toBe(true)
  })

  it('does not match a real role agent, null, or non-mikrob substrings', () => {
    expect(isForbiddenAssignee('backend2')).toBe(false)
    expect(isForbiddenAssignee(null)).toBe(false)
    expect(isForbiddenAssignee(undefined)).toBe(false)
    expect(isForbiddenAssignee('mikrob-infra')).toBe(false)
    expect(isForbiddenAssignee('not-mikrob')).toBe(false)
  })
})

describe('POST /api/kanban refuses assignee="mikrob"', () => {
  it('is refused with 400, and no card is created', async () => {
    const { ctx, out } = fakeCtx('/api/kanban', 'POST', { id: 'blocked01', title: 'x', status: 'planned', assignee: 'mikrob' })
    expect(await tryHandleKanban(ctx)).toBe(true)
    expect(out.status).toBe(400)
    expect(out.body.error).toMatch(/mikrob/i)
    expect(getKanbanCard('blocked01')).toBeFalsy()
  })

  it('a case/whitespace variant is refused the same way', async () => {
    const { ctx, out } = fakeCtx('/api/kanban', 'POST', { id: 'blocked02', title: 'x', status: 'planned', assignee: ' MikroB ' })
    expect(await tryHandleKanban(ctx)).toBe(true)
    expect(out.status).toBe(400)
    expect(getKanbanCard('blocked02')).toBeFalsy()
  })

  it('a real role agent still creates the card normally (control)', async () => {
    const { ctx, out } = fakeCtx('/api/kanban', 'POST', { id: 'ok01', title: 'x', status: 'planned', assignee: 'backend2' })
    expect(await tryHandleKanban(ctx)).toBe(true)
    expect(out.status).toBe(200)
    expect(getKanbanCard('ok01')?.assignee).toBe('backend2')
  })

  it('no assignee at all still creates the card normally (control)', async () => {
    const { ctx, out } = fakeCtx('/api/kanban', 'POST', { id: 'ok02', title: 'x', status: 'planned' })
    expect(await tryHandleKanban(ctx)).toBe(true)
    expect(getKanbanCard('ok02')).toBeTruthy()
    void out
  })
})

describe('PUT /api/kanban/:id refuses assignee="mikrob"', () => {
  beforeEach(() => {
    createKanbanCard({ id: 'c1', title: 'existing', status: 'planned', assignee: 'backend2' })
  })

  it('is refused with 400, and the existing assignee is unchanged', async () => {
    const { ctx, out } = fakeCtx('/api/kanban/c1', 'PUT', { assignee: 'mikrob' })
    expect(await tryHandleKanban(ctx)).toBe(true)
    expect(out.status).toBe(400)
    expect(out.body.error).toMatch(/mikrob/i)
    expect(getKanbanCard('c1')?.assignee).toBe('backend2')
  })

  it('force:true does NOT bypass the block -- there is no legitimate override for this value', async () => {
    const { ctx, out } = fakeCtx('/api/kanban/c1', 'PUT', { assignee: 'mikrob', force: true, actor: 'mikrob' })
    expect(await tryHandleKanban(ctx)).toBe(true)
    expect(out.status).toBe(400)
    expect(getKanbanCard('c1')?.assignee).toBe('backend2')
  })

  it('reassigning to a different real agent still works normally (control)', async () => {
    const { ctx, out } = fakeCtx('/api/kanban/c1', 'PUT', { assignee: 'backend3' })
    expect(await tryHandleKanban(ctx)).toBe(true)
    expect(getKanbanCard('c1')?.assignee).toBe('backend3')
    void out
  })

  it('an update that does not touch assignee at all is unaffected (control)', async () => {
    const { ctx, out } = fakeCtx('/api/kanban/c1', 'PUT', { title: 'renamed' })
    expect(await tryHandleKanban(ctx)).toBe(true)
    expect(getKanbanCard('c1')?.title).toBe('renamed')
    expect(getKanbanCard('c1')?.assignee).toBe('backend2')
    void out
  })
})
