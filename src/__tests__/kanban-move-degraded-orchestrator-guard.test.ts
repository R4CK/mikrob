// Card d5638d28: POST /api/kanban/:id/move (and the PUT sibling) refuse a transition INTO 'done'
// while degraded-orchestrator mode is on, unless the caller is the owner bypass (force:true,
// actor:"mikrob" -- the same allowlist every other kanban status guard already uses,
// src/kanban-force-actors.ts). Same request-building pattern as
// kanban-dispatch-claim-before-send.test.ts.
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { Readable } from 'node:stream'
import { rmSync, writeFileSync } from 'node:fs'
import type http from 'node:http'
import { initDatabase, createKanbanCard } from '../db.js'
import { tryHandleKanban } from '../web/routes/kanban.js'
import { DEGRADED_ORCHESTRATOR_SWITCH_PATH } from '../degraded-orchestrator-guard.js'

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

beforeEach(() => {
  initDatabase(':memory:')
  rmSync(DEGRADED_ORCHESTRATOR_SWITCH_PATH, { force: true })
})

afterEach(() => {
  rmSync(DEGRADED_ORCHESTRATOR_SWITCH_PATH, { force: true })
})

describe('POST /api/kanban/:id/move refuses a transition into done while degraded (card d5638d28)', () => {
  it('switch missing (default OFF): a plain card moves to done normally', async () => {
    createKanbanCard({ id: 'deg-1', title: 'plain card', assignee: 'backend', status: 'in_progress' })
    const res = await move('deg-1', { status: 'done', actor: 'backend' })
    expect(res.status).toBe(200)
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
