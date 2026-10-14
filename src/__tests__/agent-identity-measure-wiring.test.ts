// Card 2520b85a (L1, QA FAIL 16481 / WhiteHat2 NO-GO 16476): the three wiring points
// (measureAgentIdentityClaim calls in kanban.ts POST /:id/move, kanban.ts POST /:id/comments,
// messages.ts POST /api/messages) were only grepped for in the earlier REVIEW, never exercised
// through the real router. This file closes that gap: real tryHandleKanban / tryHandleMessages,
// real in-memory DB, real device key, a logger spy watching for the measurement's own log line.
import { describe, it, expect, vi, beforeAll, afterEach } from 'vitest'
import { Readable } from 'node:stream'
import { initDatabase, createKanbanCard } from '../db.js'
import { logger } from '../logger.js'
import { mintAgentDeviceKey, resolveDeviceKey } from '../web/auth-device-keys.js'
import { tryHandleKanban } from '../web/routes/kanban.js'
import { tryHandleMessages } from '../web/routes/messages.js'
import type { RouteContext } from '../web/routes/types.js'

function call(router: (ctx: RouteContext) => Promise<boolean>, pathWithQuery: string, method: string, auth: RouteContext['auth'], body: unknown) {
  const url = new URL(`http://localhost:3420${pathWithQuery}`)
  const bodyStr = body === undefined ? '' : JSON.stringify(body)
  const req = Readable.from([Buffer.from(bodyStr)]) as unknown as RouteContext['req']
  const res = { writeHead: () => res, end: () => {}, setHeader: () => {} } as unknown as RouteContext['res']
  const ctx = { req, res, path: url.pathname, method, url, auth } as unknown as RouteContext
  return router(ctx)
}

let agentAuth: RouteContext['auth']

beforeAll(() => {
  initDatabase(':memory:')
  createKanbanCard({ id: 'WIRE0001', title: 'card for wiring test' })
  const minted = mintAgentDeviceKey('backend')
  const principal = resolveDeviceKey(minted.key)!
  agentAuth = { kind: 'device', device: principal.name, deviceId: principal.id }
})

afterEach(() => {
  vi.restoreAllMocks()
})

const WIRED_ENDPOINTS = new Set(['POST /api/kanban/:id/move', 'POST /api/kanban/:id/comments', 'POST /api/messages'])

describe('agent-identity-measure wiring: the real route handlers actually call it', () => {
  it('POST /api/kanban/:id/move calls the measurement with the actor claim', async () => {
    const info = vi.spyOn(logger, 'info').mockImplementation(() => logger as never)
    await call(tryHandleKanban, '/api/kanban/WIRE0001/move', 'POST', agentAuth, { status: 'in_progress', actor: 'backend', reason: 'wiring test' })
    const hit = info.mock.calls.find((c) => (c[0] as { endpoint?: string })?.endpoint === 'POST /api/kanban/:id/move')
    expect(hit).toBeDefined()
    expect(hit![0]).toMatchObject({ authKind: 'agent-key', agentId: 'backend' })
  })

  it('POST /api/kanban/:id/comments calls the measurement with the author claim', async () => {
    const info = vi.spyOn(logger, 'info').mockImplementation(() => logger as never)
    await call(tryHandleKanban, '/api/kanban/WIRE0001/comments', 'POST', agentAuth, { author: 'backend', content: 'wiring test comment' })
    const hit = info.mock.calls.find((c) => (c[0] as { endpoint?: string })?.endpoint === 'POST /api/kanban/:id/comments')
    expect(hit).toBeDefined()
    expect(hit![0]).toMatchObject({ authKind: 'agent-key', agentId: 'backend' })
  })

  it('POST /api/messages calls the measurement with the from claim', async () => {
    const info = vi.spyOn(logger, 'info').mockImplementation(() => logger as never)
    await call(tryHandleMessages, '/api/messages', 'POST', agentAuth, { from: 'backend', to: 'mikrob', content: 'wiring test message' })
    const hit = info.mock.calls.find((c) => (c[0] as { endpoint?: string })?.endpoint === 'POST /api/messages')
    expect(hit).toBeDefined()
    expect(hit![0]).toMatchObject({ authKind: 'agent-key', agentId: 'backend' })
  })

  // Negative control: a route NOT in the three wiring points (GET /api/kanban, listing) must
  // never emit this log line -- otherwise the three "hit" assertions above would be meaningless
  // (any route call could coincidentally produce a matching line).
  it('CONTROL: an unrelated route (GET /api/kanban) never emits the measurement log line', async () => {
    const info = vi.spyOn(logger, 'info').mockImplementation(() => logger as never)
    await call(tryHandleKanban, '/api/kanban', 'GET', agentAuth, undefined)
    const hit = info.mock.calls.find((c) => WIRED_ENDPOINTS.has((c[0] as { endpoint?: string })?.endpoint ?? ''))
    expect(hit).toBeUndefined()
  })
})
