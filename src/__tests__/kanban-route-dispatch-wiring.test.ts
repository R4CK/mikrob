// Card 64f56f97 requirement 1 ("Kesz, ha": route-check-audit.sh shows 0 missing for a dispatch
// triggered via a plain PUT with no actor). This proves the enforcement itself, at the real
// route-handler level (same harness as kanban-dispatch-put.test.ts: real in-memory DB, real
// tryHandleKanban), not just the fireCardBuildRoute unit in isolation:
//
//   1. a plain PUT to in_progress with NO actor, on a freshly planned card, fires it
//   2. POST /move does too (self-advance-pickup.sh and MikroB's dispatch both use /move)
//   3. a gate-FAIL REOPEN (waiting -> in_progress) does NOT fire it again -- the card already
//      has a route verdict from its original dispatch; re-routing a reopen is not what the
//      card asked for and would double-count in route-check-audit.sh's fresh-dispatch metric
//   4. a parent/phase card is untouched by this file (route-check-audit.sh's own parent-exclusion,
//      covered by its selftest) -- this file is only about WHEN the call fires, not who is exempt
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { Readable } from 'node:stream'
import { EventEmitter } from 'node:events'
import type http from 'node:http'

// Card 97f9ca58: kanban-route-dispatch.ts now calls spawn(), not execFile() (execFile silently
// drops the `detached` option in this environment -- see that file's own header). The fake child
// here emits 'exit' on the next microtask, mirroring the old queueMicrotask(cb) timing.
const { mockSpawn } = vi.hoisted(() => ({
  mockSpawn: vi.fn<(cmd: string, args: readonly string[], opts: unknown) => EventEmitter & { pid: number; stdout: EventEmitter }>(() => {
    const child = new EventEmitter() as EventEmitter & { pid: number; stdout: EventEmitter }
    child.pid = 12345
    child.stdout = new EventEmitter()
    queueMicrotask(() => child.emit('exit', 0, null))
    return child
  }),
}))

vi.mock('node:child_process', () => ({ spawn: mockSpawn }))

vi.mock('../logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() },
}))

vi.mock('../config.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../config.js')>()),
  MAIN_AGENT_ID: 'orin',
  BOT_NAME: 'Orin',
  OWNER_NAME: 'Owner',
}))

vi.mock('../web/agent-config.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../web/agent-config.js')>()),
  listAgentNames: () => ['dex'],
  readAgentDisplayName: (n: string) => n,
}))

vi.mock('../web/agent-process.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../web/agent-process.js')>()),
  isAgentRunning: () => true,
}))

import { initDatabase, createKanbanCard, getDb } from '../db.js'
import { tryHandleKanban } from '../web/routes/kanban.js'
import { __resetRouteDispatchStateForTests } from '../web/kanban-route-dispatch.js'

async function call(method: string, path: string, body: unknown): Promise<number> {
  const req = Readable.from([Buffer.from(JSON.stringify(body))]) as unknown as http.IncomingMessage
  let status = 200
  const res = {
    writeHead: vi.fn((s: number) => { status = s }),
    end: vi.fn(),
    setHeader: vi.fn(),
  } as unknown as http.ServerResponse
  const handled = await tryHandleKanban({
    req, res, path, method, url: new URL(`http://localhost${path}`),
  } as never)
  expect(handled).toBe(true)
  return status
}

const put = (id: string, fields: Record<string, unknown>) => call('PUT', `/api/kanban/${id}`, fields)
const move = (id: string, status: string, actor?: string) =>
  call('POST', `/api/kanban/${id}/move`, { status, sort_order: 0, actor, force: true })

function routeCalls(): string[] {
  return mockSpawn.mock.calls
    .filter((c) => (c[1] as string[]).some((a) => String(a).includes('card-build-route.sh')))
    .map((c) => (c[1] as string[])[1]!)
}

beforeEach(() => {
  mockSpawn.mockClear()
  initDatabase(':memory:')
  __resetRouteDispatchStateForTests()
})

describe('card-build-route.sh enforcement at the kanban write path (card 64f56f97)', () => {
  it('a plain PUT to in_progress with NO actor, on a fresh planned card, fires card-build-route.sh', async () => {
    createKanbanCard({ id: 'routecard1', title: 'Fresh planned card', assignee: 'dex' })
    expect(await put('routecard1', { status: 'in_progress' })).toBe(200)
    expect(routeCalls()).toContain('routecard1')
  })

  it('POST /move on a fresh planned card fires card-build-route.sh too', async () => {
    createKanbanCard({ id: 'routecard2', title: 'Fresh planned card', assignee: 'dex' })
    expect(await move('routecard2', 'in_progress', 'dex')).toBe(200)
    expect(routeCalls()).toContain('routecard2')
  })

  it('a gate-FAIL reopen (waiting -> in_progress) does NOT re-fire card-build-route.sh', async () => {
    createKanbanCard({ id: 'routecard3', title: 'Reopen case', assignee: 'dex' })
    await move('routecard3', 'in_progress', 'dex')
    mockSpawn.mockClear()
    getDb().prepare("UPDATE kanban_cards SET status = 'waiting' WHERE id = ?").run('routecard3')
    await move('routecard3', 'in_progress', 'dex')
    expect(routeCalls()).not.toContain('routecard3')
  })

  it('a gate-FAIL reopen via PUT (waiting -> in_progress) does NOT re-fire it either (card 97f9ca58 F3, pins mutant M1: dropping the planned-only PUT guard makes this RED)', async () => {
    createKanbanCard({ id: 'routecard3b', title: 'Reopen case via PUT', assignee: 'dex' })
    await move('routecard3b', 'in_progress', 'dex')
    mockSpawn.mockClear()
    getDb().prepare("UPDATE kanban_cards SET status = 'waiting' WHERE id = ?").run('routecard3b')
    expect(await put('routecard3b', { status: 'in_progress', actor: 'dex', force: true })).toBe(200)
    expect(routeCalls()).not.toContain('routecard3b')
  })

  it('a card left in in_progress (no status change) does not re-fire it', async () => {
    createKanbanCard({ id: 'routecard4', title: 'No-op edit', assignee: 'dex' })
    await move('routecard4', 'in_progress', 'dex')
    mockSpawn.mockClear()
    expect(await put('routecard4', { title: 'No-op edit, renamed' })).toBe(200)
    expect(routeCalls()).not.toContain('routecard4')
  })

  it('never blocks or fails the move even if the script invocation errors', async () => {
    mockSpawn.mockImplementationOnce(() => {
      const child = new EventEmitter() as EventEmitter & { pid: number; stdout: EventEmitter }
      child.pid = 54321
      child.stdout = new EventEmitter()
      queueMicrotask(() => child.emit('error', new Error('boom')))
      return child
    })
    createKanbanCard({ id: 'routecard5', title: 'Script fails', assignee: 'dex' })
    expect(await put('routecard5', { status: 'in_progress' })).toBe(200)
  })
})
