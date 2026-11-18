// Card d5638d28: POST /api/kanban/:id/move (and the PUT sibling) refuse a transition INTO 'done'
// while degraded-orchestrator mode is on, unless the caller is the owner bypass (force:true,
// actor:"mikrob" -- the same allowlist every other kanban status guard already uses,
// src/kanban-force-actors.ts). Same request-building pattern as
// kanban-dispatch-claim-before-send.test.ts.
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { Readable } from 'node:stream'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type http from 'node:http'
import { initDatabase, createKanbanCard } from '../db.js'
import { tryHandleKanban } from '../web/routes/kanban.js'

async function move(id: string, body: Record<string, unknown>): Promise<{ status: number; body: unknown }> {
  const req = Readable.from([Buffer.from(JSON.stringify(body))]) as unknown as http.IncomingMessage
  const out: { status: number; body: unknown } = { status: 0, body: null }
  const res = {
    writeHead(status: number) { out.status = status; return res },
    end(chunk?: string) { if (chunk) out.body = JSON.parse(chunk) },
    setHeader() {},
  } as unknown as http.ServerResponse
  const handled = await tryHandleKanban({
    req, res, path: `/api/kanban/${id}/move`, method: 'POST', url: new URL(`http://localhost/api/kanban/${id}/move`),
  } as never)
  expect(handled).toBe(true)
  return { status: out.status || 200, body: out.body }
}

// Round 2 F4/residual 1 (CYBERED NO-GO 32207, MikroB Fix-Direction 32209 #4): the PUT sibling was
// unpinned -- RedHat's own mutant (removing the PUT guard call) left the 19-test suite green,
// because the only existing test drove POST /move. These two helpers + the describe block below
// close that.
async function put(id: string, body: Record<string, unknown>): Promise<{ status: number; body: unknown }> {
  const req = Readable.from([Buffer.from(JSON.stringify(body))]) as unknown as http.IncomingMessage
  const out: { status: number; body: unknown } = { status: 0, body: null }
  const res = {
    writeHead(status: number) { out.status = status; return res },
    end(chunk?: string) { if (chunk) out.body = JSON.parse(chunk) },
    setHeader() {},
  } as unknown as http.ServerResponse
  const handled = await tryHandleKanban({
    req, res, path: `/api/kanban/${id}`, method: 'PUT', url: new URL(`http://localhost/api/kanban/${id}`),
  } as never)
  expect(handled).toBe(true)
  return { status: out.status || 200, body: out.body }
}

async function create(body: Record<string, unknown>): Promise<{ status: number; body: unknown }> {
  const req = Readable.from([Buffer.from(JSON.stringify(body))]) as unknown as http.IncomingMessage
  const out: { status: number; body: unknown } = { status: 0, body: null }
  const res = {
    writeHead(status: number) { out.status = status; return res },
    end(chunk?: string) { if (chunk) out.body = JSON.parse(chunk) },
    setHeader() {},
  } as unknown as http.ServerResponse
  const handled = await tryHandleKanban({
    req, res, path: '/api/kanban', method: 'POST', url: new URL('http://localhost/api/kanban'),
  } as never)
  expect(handled).toBe(true)
  return { status: out.status || 200, body: out.body }
}

// Round 2 LOW (CYBERED NO-GO 32207, residual 3): a temp path via DEGRADED_ORCHESTRATOR_SWITCH
// env, not the real switch file of the tree under test.
let switchDir: string
let DEGRADED_ORCHESTRATOR_SWITCH_PATH: string

beforeEach(() => {
  initDatabase(':memory:')
  switchDir = mkdtempSync(join(tmpdir(), 'degraded-guard-move-'))
  DEGRADED_ORCHESTRATOR_SWITCH_PATH = join(switchDir, 'degraded-orchestrator-enabled.json')
  process.env.DEGRADED_ORCHESTRATOR_SWITCH = DEGRADED_ORCHESTRATOR_SWITCH_PATH
})

afterEach(() => {
  rmSync(switchDir, { recursive: true, force: true })
  delete process.env.DEGRADED_ORCHESTRATOR_SWITCH
})

describe('POST /api/kanban/:id/move refuses a transition into done while degraded (card d5638d28)', () => {
  it('override to an existing {"enabled": false} file (OFF): a plain card moves to done normally', async () => {
    writeFileSync(DEGRADED_ORCHESTRATOR_SWITCH_PATH, JSON.stringify({ enabled: false }))
    createKanbanCard({ id: 'deg-1', title: 'plain card', assignee: 'backend', status: 'in_progress' })
    const res = await move('deg-1', { status: 'done', actor: 'backend' })
    expect(res.status).toBe(200)
  })

  // Round 4 (CYBERED NO-GO 32270 Finding 1, MikroB decision 32246(b)): an explicit
  // DEGRADED_ORCHESTRATOR_SWITCH override to a path that does not exist is a misconfiguration,
  // not evidence of OFF -- must refuse, unlike the missing-DEFAULT-path case this suite no longer
  // simulates this way.
  it('override to a MISSING path: refused (unreadable), not treated as off', async () => {
    createKanbanCard({ id: 'deg-1b', title: 'plain card', assignee: 'backend', status: 'in_progress' })
    const res = await move('deg-1b', { status: 'done', actor: 'backend' })
    expect(res.status).toBe(409)
  })

  it('{"enabled": true}: refuses, card stays off done', async () => {
    writeFileSync(DEGRADED_ORCHESTRATOR_SWITCH_PATH, JSON.stringify({ enabled: true }))
    createKanbanCard({ id: 'deg-2', title: 'plain card', assignee: 'backend', status: 'in_progress' })
    const res = await move('deg-2', { status: 'done', actor: 'backend' })
    expect(res.status).toBe(409)
    expect((res.body as { code?: string }).code).toBe('degraded_orchestrator_blocked')
  })

  it('{"enabled": true} + owner bypass (force:true, actor:"mikrob"): passes through', async () => {
    writeFileSync(DEGRADED_ORCHESTRATOR_SWITCH_PATH, JSON.stringify({ enabled: true }))
    createKanbanCard({ id: 'deg-3', title: 'plain card', assignee: 'backend', status: 'in_progress' })
    const res = await move('deg-3', { status: 'done', actor: 'mikrob', force: true })
    expect(res.status).toBe(200)
  })

  it('a non-done transition is never touched by this guard', async () => {
    writeFileSync(DEGRADED_ORCHESTRATOR_SWITCH_PATH, JSON.stringify({ enabled: true }))
    createKanbanCard({ id: 'deg-4', title: 'plain card', assignee: 'backend', status: 'planned' })
    const res = await move('deg-4', { status: 'in_progress', actor: 'backend' })
    expect(res.status).toBe(200)
  })
})

describe('PUT /api/kanban/:id refuses a transition into done while degraded (card d5638d28 round 2, F4)', () => {
  it('override to an existing {"enabled": false} file (OFF): a plain card moves to done normally', async () => {
    writeFileSync(DEGRADED_ORCHESTRATOR_SWITCH_PATH, JSON.stringify({ enabled: false }))
    createKanbanCard({ id: 'deg-put-1', title: 'plain card', assignee: 'backend', status: 'in_progress' })
    const res = await put('deg-put-1', { status: 'done', actor: 'backend' })
    expect(res.status).toBe(200)
  })

  it('override to a MISSING path: refused (unreadable), not treated as off', async () => {
    createKanbanCard({ id: 'deg-put-1b', title: 'plain card', assignee: 'backend', status: 'in_progress' })
    const res = await put('deg-put-1b', { status: 'done', actor: 'backend' })
    expect(res.status).toBe(409)
  })

  it('{"enabled": true}: refuses, card stays off done', async () => {
    writeFileSync(DEGRADED_ORCHESTRATOR_SWITCH_PATH, JSON.stringify({ enabled: true }))
    createKanbanCard({ id: 'deg-put-2', title: 'plain card', assignee: 'backend', status: 'in_progress' })
    const res = await put('deg-put-2', { status: 'done', actor: 'backend' })
    expect(res.status).toBe(409)
    expect((res.body as { code?: string }).code).toBe('degraded_orchestrator_blocked')
  })

  it('{"enabled": true} + owner bypass (force:true, actor:"mikrob"): passes through', async () => {
    writeFileSync(DEGRADED_ORCHESTRATOR_SWITCH_PATH, JSON.stringify({ enabled: true }))
    createKanbanCard({ id: 'deg-put-3', title: 'plain card', assignee: 'backend', status: 'in_progress' })
    const res = await put('deg-put-3', { status: 'done', actor: 'mikrob', force: true })
    expect(res.status).toBe(200)
  })
})

describe('POST /api/kanban create-as-done refuses while degraded (card d5638d28 round 2, F2)', () => {
  it('override to an existing {"enabled": false} file (OFF): creating a card already done is fine', async () => {
    writeFileSync(DEGRADED_ORCHESTRATOR_SWITCH_PATH, JSON.stringify({ enabled: false }))
    const res = await create({ id: 'deg-create-1', title: 'plain card', assignee: 'backend', status: 'done' })
    expect(res.status).toBe(200)
  })

  it('override to a MISSING path: refused (unreadable), not treated as off', async () => {
    const res = await create({ id: 'deg-create-1b', title: 'plain card', assignee: 'backend', status: 'done' })
    expect(res.status).toBe(409)
  })

  it('{"enabled": true}: refuses a create straight into done', async () => {
    writeFileSync(DEGRADED_ORCHESTRATOR_SWITCH_PATH, JSON.stringify({ enabled: true }))
    const res = await create({ id: 'deg-create-2', title: 'plain card', assignee: 'backend', status: 'done' })
    expect(res.status).toBe(409)
    expect((res.body as { code?: string }).code).toBe('degraded_orchestrator_blocked')
  })

  it('{"enabled": true}: a create NOT into done is untouched by this guard', async () => {
    writeFileSync(DEGRADED_ORCHESTRATOR_SWITCH_PATH, JSON.stringify({ enabled: true }))
    const res = await create({ id: 'deg-create-3', title: 'plain card', assignee: 'backend', status: 'planned' })
    expect(res.status).toBe(200)
  })

  it('{"enabled": true} + owner bypass (force:true, actor:"mikrob"): passes through', async () => {
    writeFileSync(DEGRADED_ORCHESTRATOR_SWITCH_PATH, JSON.stringify({ enabled: true }))
    const res = await create({ id: 'deg-create-4', title: 'plain card', assignee: 'backend', status: 'done', actor: 'mikrob', force: true })
    expect(res.status).toBe(200)
  })
})

// Card e3cf26d0 (MikroB addendum, comment 32433, on RedHat GO d5638d28 @49bb67aef msg 19908): the
// `actor` field off a real HTTP body is `unknown` at runtime even though every TS signature
// downstream types it as `string | undefined` -- a mutant that dropped a call site's inline
// `typeof actor === 'string' ? actor : undefined` narrowing (create route) or weakened
// kanbanWriteActor()'s own `typeof actor !== 'string'` rejection (move/PUT routes) would let a
// non-string actor value reach the owner-bypass check with no test noticing. None of the three
// routes may ever let a non-string actor (even one shaped like `['mikrob']`, which a loose/
// coercing comparison could misread) pass as the owner.
describe('a non-string actor never reaches the owner bypass (card e3cf26d0, MikroB addendum 32433)', () => {
  it('POST /api/kanban/:id/move: actor:["mikrob"], force:true is refused, not bypassed', async () => {
    writeFileSync(DEGRADED_ORCHESTRATOR_SWITCH_PATH, JSON.stringify({ enabled: true }))
    createKanbanCard({ id: 'deg-coerce-move', title: 'plain card', assignee: 'backend', status: 'in_progress' })
    const res = await move('deg-coerce-move', { status: 'done', actor: ['mikrob'], force: true })
    expect(res.status).not.toBe(200)
  })

  it('PUT /api/kanban/:id: actor:["mikrob"], force:true is refused, not bypassed', async () => {
    writeFileSync(DEGRADED_ORCHESTRATOR_SWITCH_PATH, JSON.stringify({ enabled: true }))
    createKanbanCard({ id: 'deg-coerce-put', title: 'plain card', assignee: 'backend', status: 'in_progress' })
    const res = await put('deg-coerce-put', { status: 'done', actor: ['mikrob'], force: true })
    expect(res.status).not.toBe(200)
  })

  it('POST /api/kanban create-as-done: actor:["mikrob"], force:true is refused, not bypassed', async () => {
    writeFileSync(DEGRADED_ORCHESTRATOR_SWITCH_PATH, JSON.stringify({ enabled: true }))
    const res = await create({ id: 'deg-coerce-create', title: 'plain card', assignee: 'backend', status: 'done', actor: ['mikrob'], force: true })
    expect(res.status).not.toBe(200)
  })
})
