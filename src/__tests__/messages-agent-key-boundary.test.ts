// WhiteHat2 X1 (card debba303, same precedent as O1 on ddeb2e17 / card 517fdcc5 on memories.ts):
// GET /api/messages (both the `agent=` filter AND the no-filter global list) had no caller filter
// at all, so an agent:<id> device key could read ANY other agent's inbox/outbox through its own
// key, or every agent's traffic fleet-wide via the global list. A dashboard-token/session caller
// (the human operator) is unaffected.
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import { EventEmitter } from 'node:events'
import { initDatabase, createAgentMessage, getAgentMessage } from '../db.js'
import { tryHandleMessages } from '../web/routes/messages.js'
import type { RouteContext } from '../web/routes/types.js'

vi.mock('../config.js', async () => {
  const actual = await vi.importActual<typeof import('../config.js')>('../config.js')
  return { ...actual, MAIN_AGENT_ID: 'agent-a', ALLOWED_CHAT_ID: 'test-chat', OLLAMA_URL: '' }
})

vi.mock('../logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() },
}))

function makeCtx(pathWithQuery: string): { ctx: RouteContext; getBody: () => any } {
  const url = new URL(`http://localhost:3420${pathWithQuery}`)
  let responseBody = ''
  const res = {
    writeHead: () => {},
    end: (body?: string) => { responseBody = body || '' },
    setHeader: () => {},
  }
  return {
    ctx: { req: { headers: {} } as any, res: res as any, path: url.pathname, method: 'GET', url },
    getBody: () => (responseBody ? JSON.parse(responseBody) : null),
  }
}

async function putStatus(id: number, body: unknown, auth?: { kind: 'device'; device: string }): Promise<{ statusCode: number; json: any }> {
  const req = new EventEmitter() as unknown as RouteContext['req']
  ;(req as unknown as { headers: Record<string, string> }).headers = {}
  const state = { statusCode: 0, body: '' }
  const res = {
    writeHead(code: number) { state.statusCode = code; return res },
    end(data?: unknown) { state.body = String(data ?? '') },
    setHeader() {},
  } as unknown as RouteContext['res']
  process.nextTick(() => {
    ;(req as unknown as EventEmitter).emit('data', Buffer.from(JSON.stringify(body)))
    ;(req as unknown as EventEmitter).emit('end')
  })
  const ctx = {
    req, res, path: `/api/messages/${id}`, method: 'PUT',
    url: new URL(`http://localhost/api/messages/${id}`), fedPeer: null,
  } as unknown as RouteContext
  if (auth) (ctx as any).auth = auth
  const handled = await tryHandleMessages(ctx)
  expect(handled).toBe(true)
  return { statusCode: state.statusCode || 200, json: state.body ? JSON.parse(state.body) : null }
}

let victimOutboundId: number
let victimInboundId: number

beforeAll(() => {
  initDatabase(':memory:')
  victimOutboundId = createAgentMessage('victim', 'someone-else', 'victim private outbound message').id
  victimInboundId = createAgentMessage('someone-else', 'victim', 'victim private inbound message').id
})

afterAll(() => { vi.restoreAllMocks() })

describe('GET /api/messages -- agent-key boundary (card debba303)', () => {
  it('a device key for a DIFFERENT agent does not see the victim conversation, even with ?agent=victim', async () => {
    const { ctx, getBody } = makeCtx('/api/messages?agent=victim')
    ;(ctx as any).auth = { kind: 'device', device: 'agent:attacker' }
    const handled = await tryHandleMessages(ctx)
    expect(handled).toBe(true)
    const body = getBody()
    expect(Array.isArray(body)).toBe(true)
    expect(body.find((m: any) => m.content.includes('victim private'))).toBeUndefined()
  })

  it('a device key for a DIFFERENT agent, with NO ?agent= at all, does not see the victim traffic via the GLOBAL list', async () => {
    const { ctx, getBody } = makeCtx('/api/messages')
    ;(ctx as any).auth = { kind: 'device', device: 'agent:attacker' }
    const handled = await tryHandleMessages(ctx)
    expect(handled).toBe(true)
    const body = getBody()
    expect(Array.isArray(body)).toBe(true)
    expect(body.find((m: any) => m.content.includes('victim private'))).toBeUndefined()
  })

  it('the owning device key still sees its own conversation, with no ?agent= at all', async () => {
    const { ctx, getBody } = makeCtx('/api/messages')
    ;(ctx as any).auth = { kind: 'device', device: 'agent:victim' }
    const handled = await tryHandleMessages(ctx)
    expect(handled).toBe(true)
    const body = getBody()
    expect(body.find((m: any) => m.content.includes('victim private'))).toBeDefined()
  })

  it('a shared-token caller (no device key) is UNCHANGED -- the global list still shows victim traffic', async () => {
    const { ctx, getBody } = makeCtx('/api/messages')
    const handled = await tryHandleMessages(ctx)
    expect(handled).toBe(true)
    const body = getBody()
    expect(body.find((m: any) => m.content.includes('victim private'))).toBeDefined()
  })
})

describe('GET /api/messages/threads -- agent-key boundary (Cybersec NO-GO F1, card debba303)', () => {
  it('a device key for a DIFFERENT agent does not see the victim thread', async () => {
    const { ctx, getBody } = makeCtx('/api/messages/threads')
    ;(ctx as any).auth = { kind: 'device', device: 'agent:attacker' }
    const handled = await tryHandleMessages(ctx)
    expect(handled).toBe(true)
    const body = getBody()
    expect(Array.isArray(body)).toBe(true)
    expect(body.find((t: any) => t.agent === 'victim' || t.lastMessage?.content.includes('victim private'))).toBeUndefined()
  })

  it('the owning device key still sees its own thread', async () => {
    const { ctx, getBody } = makeCtx('/api/messages/threads')
    ;(ctx as any).auth = { kind: 'device', device: 'agent:victim' }
    const handled = await tryHandleMessages(ctx)
    expect(handled).toBe(true)
    const body = getBody()
    expect(body.find((t: any) => t.agent === 'someone-else')).toBeDefined()
  })

  it('a shared-token caller (no device key) is UNCHANGED -- the fleet-wide thread list still shows victim', async () => {
    const { ctx, getBody } = makeCtx('/api/messages/threads')
    const handled = await tryHandleMessages(ctx)
    expect(handled).toBe(true)
    const body = getBody()
    expect(body.find((t: any) => t.agent === 'victim')).toBeDefined()
  })
})

describe('GET /api/messages/:id -- agent-key boundary (Cybersec NO-GO F1, card debba303)', () => {
  it('a device key for a DIFFERENT agent gets 404 (not found) for a victim message id, not the content', async () => {
    const { ctx, getBody } = makeCtx(`/api/messages/${victimOutboundId}`)
    ;(ctx as any).auth = { kind: 'device', device: 'agent:attacker' }
    const handled = await tryHandleMessages(ctx)
    expect(handled).toBe(true)
    const body = getBody()
    expect(body).toEqual({ error: 'Message not found' })
  })

  it('the owning device key (as sender) can still read its own message by id', async () => {
    const { ctx, getBody } = makeCtx(`/api/messages/${victimOutboundId}`)
    ;(ctx as any).auth = { kind: 'device', device: 'agent:victim' }
    const handled = await tryHandleMessages(ctx)
    expect(handled).toBe(true)
    const body = getBody()
    expect(body.content).toBe('victim private outbound message')
  })

  it('the owning device key (as recipient) can still read its own message by id', async () => {
    const { ctx, getBody } = makeCtx(`/api/messages/${victimInboundId}`)
    ;(ctx as any).auth = { kind: 'device', device: 'agent:victim' }
    const handled = await tryHandleMessages(ctx)
    expect(handled).toBe(true)
    const body = getBody()
    expect(body.content).toBe('victim private inbound message')
  })

  it('a shared-token caller (no device key) is UNCHANGED -- can still read the victim message by id', async () => {
    const { ctx, getBody } = makeCtx(`/api/messages/${victimOutboundId}`)
    const handled = await tryHandleMessages(ctx)
    expect(handled).toBe(true)
    const body = getBody()
    expect(body.content).toBe('victim private outbound message')
  })
})

describe('PUT /api/messages/:id -- agent-key boundary (Cybersec N1 MEDIUM, card 799322f9)', () => {
  it('a device key for a DIFFERENT agent gets 404 (not found) closing a row addressed to the victim, and the row stays open', async () => {
    const row = createAgentMessage('someone-else', 'victim', 'foreign close attempt target')
    const { statusCode, json } = await putStatus(row.id, { status: 'done' }, { kind: 'device', device: 'agent:attacker' })
    expect(statusCode).toBe(404)
    expect(json).toEqual({ error: 'Message not found' })
    expect(getAgentMessage(row.id)?.status).toBe('pending')
  })

  it('a device key for a DIFFERENT, non-existent id gets the byte-identical 404 -- no existence oracle', async () => {
    const { statusCode, json } = await putStatus(999999999, { status: 'done' }, { kind: 'device', device: 'agent:attacker' })
    expect(statusCode).toBe(404)
    expect(json).toEqual({ error: 'Message not found' })
  })

  it('the owning device key (the recipient, to_agent) CAN close its own row', async () => {
    const row = createAgentMessage('someone-else', 'victim', 'owned close attempt target')
    const { statusCode, json } = await putStatus(row.id, { status: 'done', notify: false }, { kind: 'device', device: 'agent:victim' })
    expect(statusCode).toBe(200)
    expect(json).toEqual({ ok: true })
    expect(getAgentMessage(row.id)?.status).toBe('done')
  })

  it('a device key CANNOT close a row it only SENT (from_agent), not addressed to it -- only the recipient closes', async () => {
    const row = createAgentMessage('victim', 'someone-else', 'victim is the sender here, not the recipient')
    const { statusCode, json } = await putStatus(row.id, { status: 'done' }, { kind: 'device', device: 'agent:victim' })
    expect(statusCode).toBe(404)
    expect(json).toEqual({ error: 'Message not found' })
    expect(getAgentMessage(row.id)?.status).toBe('pending')
  })

  it('a shared-token caller (no device key) is UNCHANGED -- can still close a foreign row', async () => {
    const row = createAgentMessage('someone-else', 'victim', 'shared-token close attempt target')
    const { statusCode, json } = await putStatus(row.id, { status: 'done', notify: false })
    expect(statusCode).toBe(200)
    expect(json).toEqual({ ok: true })
    expect(getAgentMessage(row.id)?.status).toBe('done')
  })
})

describe('GET /api/messages/backlog -- agent-key boundary (Cybersec F2, card debba303)', () => {
  it('a device key for a DIFFERENT agent cannot read the victim backlog via ?agent=victim', async () => {
    const { ctx, getBody } = makeCtx('/api/messages/backlog?agent=victim')
    ;(ctx as any).auth = { kind: 'device', device: 'agent:attacker' }
    const handled = await tryHandleMessages(ctx)
    expect(handled).toBe(true)
    const body = getBody()
    expect(Array.isArray(body)).toBe(true)
    expect(body.find((r: any) => r.agent === 'victim')).toBeUndefined()
  })

  it('the owning device key sees its OWN backlog, overriding an ?agent=<other> query value', async () => {
    const { ctx, getBody } = makeCtx('/api/messages/backlog?agent=someone-else')
    ;(ctx as any).auth = { kind: 'device', device: 'agent:victim' }
    const handled = await tryHandleMessages(ctx)
    expect(handled).toBe(true)
    const body = getBody()
    expect(body.find((r: any) => r.agent === 'victim')).toBeDefined()
    expect(body.find((r: any) => r.agent === 'someone-else')).toBeUndefined()
  })

  it('a shared-token caller (no device key) is UNCHANGED -- ?agent=victim still returns the victim backlog', async () => {
    const { ctx, getBody } = makeCtx('/api/messages/backlog?agent=victim')
    const handled = await tryHandleMessages(ctx)
    expect(handled).toBe(true)
    const body = getBody()
    expect(body.find((r: any) => r.agent === 'victim')).toBeDefined()
  })
})
