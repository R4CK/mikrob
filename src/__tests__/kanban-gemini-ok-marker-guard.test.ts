// Card 9e83ce97 F2 (WhiteHat GO c23ea72f komment 19825): the Gemini-route positive marker
// ("gemini-ok" label, or a "[GEMINI-OK]" title-prefix tag -- both read by
// store/offload-dispatch.sh's is_gemini_blocked()) was otherwise self-asserted: any Bearer-token
// caller could create/rename a label or edit a card title to carry it, with no privilege check
// at all. This pins the fix: introducing the marker (via title edit, label create, label rename,
// or label attach) is gated behind the SAME privileged-actor allowlist isForceActor already uses
// (kanban-force-actors.ts, today just "mikrob") -- same documented limit as that module (actor is
// self-declared, not authenticated).
import { describe, it, expect, beforeEach } from 'vitest'
import { Readable } from 'node:stream'
import type http from 'node:http'
import { initDatabase, getKanbanCard, createKanbanCard, getLabelsForCard, listLabels } from '../db.js'
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

describe('POST /api/kanban: a title carrying the "[GEMINI-OK]" marker is gated', () => {
  it('refuses with 403 and creates no card when no actor is given', async () => {
    const { ctx, out } = fakeCtx('/api/kanban', 'POST', { id: 'g1', title: '[GEMINI-OK] Clean task', status: 'planned' })
    expect(await tryHandleKanban(ctx)).toBe(true)
    expect(out.status).toBe(403)
    expect(getKanbanCard('g1')).toBeFalsy()
  })

  it('refuses with 403 for a non-privileged actor', async () => {
    const { ctx, out } = fakeCtx('/api/kanban', 'POST', { id: 'g2', title: '[GEMINI-OK] Clean task', status: 'planned', actor: 'backend3' })
    expect(await tryHandleKanban(ctx)).toBe(true)
    expect(out.status).toBe(403)
    expect(getKanbanCard('g2')).toBeFalsy()
  })

  it('allows the privileged actor ("mikrob") to create the marked card', async () => {
    const { ctx, out } = fakeCtx('/api/kanban', 'POST', { id: 'g3', title: '[GEMINI-OK] Clean task', status: 'planned', actor: 'mikrob' })
    expect(await tryHandleKanban(ctx)).toBe(true)
    expect(out.status).toBe(200)
    expect(getKanbanCard('g3')).toBeTruthy()
  })

  it('a title with no marker at all is unaffected (control)', async () => {
    const { ctx, out } = fakeCtx('/api/kanban', 'POST', { id: 'g4', title: 'Ordinary task', status: 'planned' })
    expect(await tryHandleKanban(ctx)).toBe(true)
    expect(out.status).toBe(200)
    expect(getKanbanCard('g4')).toBeTruthy()
  })
})

describe('PUT /api/kanban/:id: newly introducing the title marker is gated, pre-existing marker is not retroactively blocked', () => {
  beforeEach(() => {
    createKanbanCard({ id: 'c1', title: 'Clean task', status: 'planned' })
    createKanbanCard({ id: 'c2', title: '[GEMINI-OK] Already marked', status: 'planned' })
  })

  it('refuses adding the marker to a previously clean title, non-privileged actor, 403, title unchanged', async () => {
    const { ctx, out } = fakeCtx('/api/kanban/c1', 'PUT', { title: '[GEMINI-OK] Clean task' })
    expect(await tryHandleKanban(ctx)).toBe(true)
    expect(out.status).toBe(403)
    expect(getKanbanCard('c1')?.title).toBe('Clean task')
  })

  it('allows adding the marker when the actor is privileged', async () => {
    const { ctx, out } = fakeCtx('/api/kanban/c1', 'PUT', { title: '[GEMINI-OK] Clean task', actor: 'mikrob' })
    expect(await tryHandleKanban(ctx)).toBe(true)
    expect(out.status).toBe(200)
    expect(getKanbanCard('c1')?.title).toBe('[GEMINI-OK] Clean task')
  })

  it('editing an already-marked card\'s title (marker still present) does not retroactively demand privilege', async () => {
    const { ctx, out } = fakeCtx('/api/kanban/c2', 'PUT', { title: '[GEMINI-OK] Already marked, tweaked' })
    expect(await tryHandleKanban(ctx)).toBe(true)
    expect(out.status).toBe(200)
    expect(getKanbanCard('c2')?.title).toBe('[GEMINI-OK] Already marked, tweaked')
  })

  it('editing a non-title field on a marked card is unaffected (control)', async () => {
    const { ctx, out } = fakeCtx('/api/kanban/c2', 'PUT', { priority: 'high' })
    expect(await tryHandleKanban(ctx)).toBe(true)
    expect(out.status).toBe(200)
    expect(getKanbanCard('c2')?.priority).toBe('high')
  })

  it('editing a clean card\'s title without adding the marker is unaffected (control)', async () => {
    const { ctx, out } = fakeCtx('/api/kanban/c1', 'PUT', { title: 'Still clean task' })
    expect(await tryHandleKanban(ctx)).toBe(true)
    expect(out.status).toBe(200)
    expect(getKanbanCard('c1')?.title).toBe('Still clean task')
  })
})

describe('Label API: creating/renaming/attaching a "gemini-ok"-named label is gated', () => {
  it('POST /api/kanban/labels refuses creating "gemini-ok" with no privileged actor', async () => {
    const { ctx, out } = fakeCtx('/api/kanban/labels', 'POST', { name: 'gemini-ok', color: '#3b82f6' })
    expect(await tryHandleKanban(ctx)).toBe(true)
    expect(out.status).toBe(403)
    expect(listLabels().find((l) => l.name === 'gemini-ok')).toBeFalsy()
  })

  it('POST /api/kanban/labels allows creating "Gemini-OK" (case variant) for the privileged actor', async () => {
    const { ctx, out } = fakeCtx('/api/kanban/labels', 'POST', { name: 'Gemini-OK', color: '#3b82f6', actor: 'mikrob' })
    expect(await tryHandleKanban(ctx)).toBe(true)
    expect(out.status).toBe(200)
    expect(listLabels().find((l) => l.name === 'Gemini-OK')).toBeTruthy()
  })

  it('POST /api/kanban/labels creating an ordinary label is unaffected (control)', async () => {
    const { ctx, out } = fakeCtx('/api/kanban/labels', 'POST', { name: 'bug', color: '#3b82f6' })
    expect(await tryHandleKanban(ctx)).toBe(true)
    expect(out.status).toBe(200)
  })

  it('PUT /api/kanban/labels/:id refuses renaming an existing label TO "gemini-ok" without privilege', async () => {
    const { ctx: createCtx, out: createOut } = fakeCtx('/api/kanban/labels', 'POST', { name: 'bug', color: '#3b82f6', actor: 'mikrob' })
    await tryHandleKanban(createCtx)
    const id = createOut.body.id as string

    const { ctx, out } = fakeCtx(`/api/kanban/labels/${id}`, 'PUT', { name: 'gemini-ok' })
    expect(await tryHandleKanban(ctx)).toBe(true)
    expect(out.status).toBe(403)
    expect(listLabels().find((l) => l.id === id)?.name).toBe('bug')
  })

  it('PUT /api/kanban/labels/:id allows the privileged actor to rename a label to "gemini-ok"', async () => {
    const { ctx: createCtx, out: createOut } = fakeCtx('/api/kanban/labels', 'POST', { name: 'bug', color: '#3b82f6', actor: 'mikrob' })
    await tryHandleKanban(createCtx)
    const id = createOut.body.id as string

    const { ctx, out } = fakeCtx(`/api/kanban/labels/${id}`, 'PUT', { name: 'gemini-ok', actor: 'mikrob' })
    expect(await tryHandleKanban(ctx)).toBe(true)
    expect(out.status).toBe(200)
    expect(listLabels().find((l) => l.id === id)?.name).toBe('gemini-ok')
  })

  it('POST /api/kanban/:id/labels refuses attaching an EXISTING "gemini-ok" label without privilege', async () => {
    createKanbanCard({ id: 'card1', title: 'Clean task', status: 'planned' })
    const { ctx: createCtx, out: createOut } = fakeCtx('/api/kanban/labels', 'POST', { name: 'gemini-ok', color: '#3b82f6', actor: 'mikrob' })
    await tryHandleKanban(createCtx)
    const labelId = createOut.body.id as string

    const { ctx, out } = fakeCtx('/api/kanban/card1/labels', 'POST', { labelId })
    expect(await tryHandleKanban(ctx)).toBe(true)
    expect(out.status).toBe(403)
    expect(getLabelsForCard('card1')).toHaveLength(0)
  })

  it('POST /api/kanban/:id/labels allows the privileged actor to attach the "gemini-ok" label', async () => {
    createKanbanCard({ id: 'card1', title: 'Clean task', status: 'planned' })
    const { ctx: createCtx, out: createOut } = fakeCtx('/api/kanban/labels', 'POST', { name: 'gemini-ok', color: '#3b82f6', actor: 'mikrob' })
    await tryHandleKanban(createCtx)
    const labelId = createOut.body.id as string

    const { ctx, out } = fakeCtx('/api/kanban/card1/labels', 'POST', { labelId, actor: 'mikrob' })
    expect(await tryHandleKanban(ctx)).toBe(true)
    expect(out.status).toBe(200)
    expect(getLabelsForCard('card1')).toHaveLength(1)
  })

  it('POST /api/kanban/:id/labels attaching an ORDINARY label is unaffected regardless of actor (control)', async () => {
    createKanbanCard({ id: 'card1', title: 'Clean task', status: 'planned' })
    const { ctx: createCtx, out: createOut } = fakeCtx('/api/kanban/labels', 'POST', { name: 'bug', color: '#3b82f6' })
    await tryHandleKanban(createCtx)
    const labelId = createOut.body.id as string

    const { ctx, out } = fakeCtx('/api/kanban/card1/labels', 'POST', { labelId })
    expect(await tryHandleKanban(ctx)).toBe(true)
    expect(out.status).toBe(200)
    expect(getLabelsForCard('card1')).toHaveLength(1)
  })
})
