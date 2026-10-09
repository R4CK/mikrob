// Card 5aaf7209 + 16e60d3c: 5 upstream-capability decisions on src/web/routes/kanban.ts, paired
// with their src/db.ts half. Item 2 (GET /api/kanban/stuck) is deliberately OUT OF SCOPE here --
// split to its own follow-up card, see the REVIEW. This file covers the other four, end to end.
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { Readable } from 'node:stream'
import { mkdirSync, rmSync, existsSync } from 'node:fs'
import {
  initDatabase, createKanbanCard, getKanbanCard, archiveKanbanCard,
  listKanbanCards, parentWouldCycle, addKanbanComment, getKanbanComments,
} from '../db.js'
import { tryHandleKanban } from '../web/routes/kanban.js'
import { agentDir } from '../web/agent-config.js'
import { scaffoldAgentDir } from '../web/agent-scaffold.js'
import type { RouteContext } from '../web/routes/types.js'

// listAgentNames() reads REAL agent directories (not the DB), and this worktree checkout has none
// scaffolded -- a plain 'backend'/'qa' string is not a known agent here the way it is on a live
// install. Scaffold one real, disposable test agent so the assignee=/agent= filter has something
// genuine to validate against.
const KNOWN_TEST_AGENT = 'kbtest-5aaf7209'
beforeEach(() => {
  if (!existsSync(agentDir(KNOWN_TEST_AGENT))) { mkdirSync(agentDir(KNOWN_TEST_AGENT), { recursive: true }); scaffoldAgentDir(KNOWN_TEST_AGENT) }
})
afterEach(() => { rmSync(agentDir(KNOWN_TEST_AGENT), { recursive: true, force: true }) })

function getCtx(urlPath: string): { ctx: RouteContext; out: { status: number; body: any } } {
  const out: { status: number; body: any } = { status: 200, body: null }
  const res: any = {
    writeHead(status: number) { out.status = status; return res },
    setHeader() { return res },
    end(chunk?: string) { if (chunk) out.body = JSON.parse(chunk) },
  }
  const req: any = Readable.from([])
  const url = new URL(`http://localhost:3420${urlPath}`)
  return { ctx: { req, res, path: url.pathname, method: 'GET', url } as RouteContext, out }
}

function putCtx(id: string, payload: unknown): { ctx: RouteContext; out: { status: number; body: any } } {
  const out: { status: number; body: any } = { status: 200, body: null }
  const res: any = {
    writeHead(status: number) { out.status = status; return res },
    setHeader() { return res },
    end(chunk?: string) { if (chunk) out.body = JSON.parse(chunk) },
  }
  const req: any = Readable.from([Buffer.from(JSON.stringify(payload))])
  const url = new URL(`http://localhost:3420/api/kanban/${encodeURIComponent(id)}`)
  return { ctx: { req, res, path: url.pathname, method: 'PUT', url } as RouteContext, out }
}

function postCommentCtx(cardId: string, payload: unknown): { ctx: RouteContext; out: { status: number; body: any } } {
  const out: { status: number; body: any } = { status: 200, body: null }
  const res: any = {
    writeHead(status: number) { out.status = status; return res },
    setHeader() { return res },
    end(chunk?: string) { if (chunk) out.body = JSON.parse(chunk) },
  }
  const req: any = Readable.from([Buffer.from(JSON.stringify(payload))])
  const url = new URL(`http://localhost:3420/api/kanban/${encodeURIComponent(cardId)}/comments`)
  return { ctx: { req, res, path: url.pathname, method: 'POST', url } as RouteContext, out }
}

beforeEach(() => { initDatabase(':memory:') })

describe('GET /api/kanban -- item 1: unknown query-param 400, includeArchived', () => {
  it('rejects an unknown query-parameter with 400, naming it and the known set', async () => {
    const { ctx, out } = getCtx('/api/kanban?totallyUnknown=1')
    expect(await tryHandleKanban(ctx)).toBe(true)
    expect(out.status).toBe(400)
    expect(out.body.error).toContain('totallyUnknown')
    expect(out.body.known).toEqual(expect.arrayContaining(['status', 'assignee', 'agent', 'includeArchived']))
  })

  it('a known param (status) still works, no 400', async () => {
    createKanbanCard({ id: 'c1', title: 'Card one', status: 'planned' })
    const { ctx, out } = getCtx('/api/kanban?status=planned')
    expect(await tryHandleKanban(ctx)).toBe(true)
    expect(out.status).toBe(200)
    expect(out.body.map((c: any) => c.id)).toContain('c1')
  })

  it('excludes archived cards by default', async () => {
    createKanbanCard({ id: 'c2', title: 'Card two', status: 'done' })
    archiveKanbanCard('c2', { force: true })
    const { ctx, out } = getCtx('/api/kanban')
    expect(await tryHandleKanban(ctx)).toBe(true)
    expect(out.body.map((c: any) => c.id)).not.toContain('c2')
  })

  it('includeArchived=1 includes them', async () => {
    createKanbanCard({ id: 'c3', title: 'Card three', status: 'done' })
    archiveKanbanCard('c3', { force: true })
    const { ctx, out } = getCtx('/api/kanban?includeArchived=1')
    expect(await tryHandleKanban(ctx)).toBe(true)
    expect(out.body.map((c: any) => c.id)).toContain('c3')
  })

  it('includeArchived=true (not just "1") also works', async () => {
    createKanbanCard({ id: 'c4', title: 'Card four', status: 'done' })
    archiveKanbanCard('c4', { force: true })
    const { ctx, out } = getCtx('/api/kanban?includeArchived=true')
    expect(await tryHandleKanban(ctx)).toBe(true)
    expect(out.body.map((c: any) => c.id)).toContain('c4')
  })
})

describe('listKanbanCards(includeArchived) -- db.ts unit', () => {
  it('defaults to excluding archived cards (existing callers unaffected)', () => {
    createKanbanCard({ id: 'd1', title: 'D1', status: 'done' })
    archiveKanbanCard('d1', { force: true })
    expect(listKanbanCards().map((c) => c.id)).not.toContain('d1')
  })

  it('includeArchived=true includes them', () => {
    createKanbanCard({ id: 'd2', title: 'D2', status: 'done' })
    archiveKanbanCard('d2', { force: true })
    expect(listKanbanCards(true).map((c) => c.id)).toContain('d2')
  })
})

describe('GET /api/kanban -- item 3: agent=/assignee= alias + unknown-agent 400', () => {
  it('assignee= filters by a real agent', async () => {
    createKanbanCard({ id: 'c5', title: 'Card five', status: 'planned', assignee: KNOWN_TEST_AGENT })
    createKanbanCard({ id: 'c6', title: 'Card six', status: 'planned', assignee: 'someone-else-entirely' })
    const { ctx, out } = getCtx('/api/kanban?assignee=' + KNOWN_TEST_AGENT)
    expect(await tryHandleKanban(ctx)).toBe(true)
    const ids = out.body.map((c: any) => c.id)
    expect(ids).toContain('c5')
    expect(ids).not.toContain('c6')
  })

  it('agent= is accepted as an alias for assignee= and actually filters (not just ignored)', async () => {
    createKanbanCard({ id: 'c7', title: 'Card seven', status: 'planned', assignee: KNOWN_TEST_AGENT })
    createKanbanCard({ id: 'c7b', title: 'Card seven-b', status: 'planned', assignee: 'someone-else-entirely' })
    const { ctx, out } = getCtx('/api/kanban?agent=' + KNOWN_TEST_AGENT)
    expect(await tryHandleKanban(ctx)).toBe(true)
    const ids = out.body.map((c: any) => c.id)
    expect(ids).toContain('c7')
    // The real point: if agent= were silently ignored (not wired as a filter), the full unfiltered
    // list would still "contain c7" and this assertion would pass for the wrong reason.
    expect(ids).not.toContain('c7b')
  })

  it('an unknown agent name 400s instead of silently returning an empty list', async () => {
    createKanbanCard({ id: 'c8', title: 'Card eight', status: 'planned', assignee: KNOWN_TEST_AGENT })
    const { ctx, out } = getCtx('/api/kanban?assignee=definitely-not-a-real-agent-xyz')
    expect(await tryHandleKanban(ctx)).toBe(true)
    expect(out.status).toBe(400)
    expect(out.body.error).toContain('definitely-not-a-real-agent-xyz')
  })
})

describe('parentWouldCycle -- db.ts unit', () => {
  it('a card cannot be its own parent', () => {
    expect(parentWouldCycle('p1', 'p1')).toBe(true)
  })

  it('direct cycle: B is A\'s parent, A cannot become B\'s parent', () => {
    createKanbanCard({ id: 'pA', title: 'A', status: 'planned' })
    createKanbanCard({ id: 'pB', title: 'B', status: 'planned', parent_id: 'pA' })
    expect(parentWouldCycle('pA', 'pB')).toBe(true)
  })

  it('indirect cycle through a chain (C -> B -> A), A cannot become C\'s parent', () => {
    createKanbanCard({ id: 'qA', title: 'A', status: 'planned' })
    createKanbanCard({ id: 'qB', title: 'B', status: 'planned', parent_id: 'qA' })
    createKanbanCard({ id: 'qC', title: 'C', status: 'planned', parent_id: 'qB' })
    expect(parentWouldCycle('qA', 'qC')).toBe(true)
  })

  it('no cycle: an unrelated card can become the parent', () => {
    createKanbanCard({ id: 'rA', title: 'A', status: 'planned' })
    createKanbanCard({ id: 'rB', title: 'B', status: 'planned' })
    expect(parentWouldCycle('rA', 'rB')).toBe(false)
  })
})

describe('PUT /api/kanban/:id -- item 4: parentWouldCycle wired, 409 on a closing re-parent', () => {
  it('refuses a re-parent that would close a loop', async () => {
    createKanbanCard({ id: 'sA', title: 'A', status: 'planned' })
    createKanbanCard({ id: 'sB', title: 'B', status: 'planned', parent_id: 'sA' })
    const { ctx, out } = putCtx('sA', { parent_id: 'sB' })
    expect(await tryHandleKanban(ctx)).toBe(true)
    expect(out.status).toBe(409)
    expect(getKanbanCard('sA')!.parent_id).toBeNull()
  })

  it('a non-cyclic re-parent still succeeds', async () => {
    createKanbanCard({ id: 'tA', title: 'A', status: 'planned' })
    createKanbanCard({ id: 'tB', title: 'B', status: 'planned' })
    const { ctx, out } = putCtx('tB', { parent_id: 'tA' })
    expect(await tryHandleKanban(ctx)).toBe(true)
    expect(out.status).toBe(200)
    expect(getKanbanCard('tB')!.parent_id).toBe('tA')
  })

  it('clearing parent_id (to null) is never checked for a cycle', async () => {
    createKanbanCard({ id: 'uA', title: 'A', status: 'planned' })
    createKanbanCard({ id: 'uB', title: 'B', status: 'planned', parent_id: 'uA' })
    const { ctx, out } = putCtx('uB', { parent_id: null })
    expect(await tryHandleKanban(ctx)).toBe(true)
    expect(out.status).toBe(200)
  })
})

describe('automated comment flag -- item 5, db.ts + route', () => {
  it('addKanbanComment defaults automated to false', () => {
    createKanbanCard({ id: 'v1', title: 'V1', status: 'planned' })
    const c = addKanbanComment('v1', 'someone', 'a normal comment')
    expect(c.automated).toBe(false)
    expect(getKanbanComments('v1')[0].automated).toBe(false)
  })

  it('addKanbanComment(automated=true) persists and round-trips as a real boolean', () => {
    createKanbanCard({ id: 'v2', title: 'V2', status: 'planned' })
    const c = addKanbanComment('v2', 'bulk-writer', 'machine comment', true)
    expect(c.automated).toBe(true)
    expect(getKanbanComments('v2')[0].automated).toBe(true)
  })

  it('POST /api/kanban/:id/comments accepts automated:true and returns it', async () => {
    createKanbanCard({ id: 'v3', title: 'V3', status: 'planned' })
    const { ctx, out } = postCommentCtx('v3', { author: 'bulk', content: 'bulk comment', automated: true })
    expect(await tryHandleKanban(ctx)).toBe(true)
    expect(out.status).toBe(200)
    expect(out.body.automated).toBe(true)
    expect(getKanbanComments('v3')[0].automated).toBe(true)
  })

  it('POST without automated defaults to false (existing callers unaffected)', async () => {
    createKanbanCard({ id: 'v4', title: 'V4', status: 'planned' })
    const { ctx, out } = postCommentCtx('v4', { author: 'someone', content: 'normal comment' })
    expect(await tryHandleKanban(ctx)).toBe(true)
    expect(out.body.automated).toBe(false)
  })
})
