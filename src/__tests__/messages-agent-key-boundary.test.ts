// WhiteHat2 X1 (card debba303, same precedent as O1 on ddeb2e17 / card 517fdcc5 on memories.ts):
// GET /api/messages (both the `agent=` filter AND the no-filter global list) had no caller filter
// at all, so an agent:<id> device key could read ANY other agent's inbox/outbox through its own
// key, or every agent's traffic fleet-wide via the global list. A dashboard-token/session caller
// (the human operator) is unaffected.
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import { initDatabase, createAgentMessage } from '../db.js'
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

beforeAll(() => {
  initDatabase(':memory:')
  createAgentMessage('victim', 'someone-else', 'victim private outbound message')
  createAgentMessage('someone-else', 'victim', 'victim private inbound message')
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
