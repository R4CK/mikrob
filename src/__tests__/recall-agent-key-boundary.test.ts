// WhiteHat2 X1 (card debba303, same precedent as O1 on ddeb2e17 / card 517fdcc5 on memories.ts):
// GET /api/recall and GET /api/recall/dates read the `agent` query param with no caller filter at
// all, so an agent:<id> device key could read ANY other agent's daily-log/memory content through
// its own key. A dashboard-token/session caller (the human operator) is unaffected.
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import { initDatabase, appendDailyLog, saveAgentMemory } from '../db.js'
import { tryHandleRecall } from '../web/routes/recall.js'
import type { RouteContext } from '../web/routes/types.js'

vi.mock('../config.js', async () => {
  const actual = await vi.importActual<typeof import('../config.js')>('../config.js')
  return { ...actual, MAIN_AGENT_ID: 'agent-a', ALLOWED_CHAT_ID: 'test-chat', OLLAMA_URL: '' }
})

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

const today = new Date().toISOString().split('T')[0]

beforeAll(() => {
  initDatabase(':memory:')
  appendDailyLog('victim', 'victim private recall-log entry')
  saveAgentMemory('victim', 'victim private recall-memory entry', 'hot', 'secret')
})

afterAll(() => { vi.restoreAllMocks() })

describe('GET /api/recall -- agent-key boundary (card debba303)', () => {
  it('a device key for a DIFFERENT agent does not see the victim content, even with ?agent=victim', async () => {
    const { ctx, getBody } = makeCtx(`/api/recall?date=${today}&agent=victim`)
    ;(ctx as any).auth = { kind: 'device', device: 'agent:attacker' }
    const handled = await tryHandleRecall(ctx)
    expect(handled).toBe(true)
    expect(JSON.stringify(getBody())).not.toContain('victim private')
  })

  it('the owning device key still sees its own content', async () => {
    const { ctx, getBody } = makeCtx(`/api/recall?date=${today}`)
    ;(ctx as any).auth = { kind: 'device', device: 'agent:victim' }
    const handled = await tryHandleRecall(ctx)
    expect(handled).toBe(true)
    expect(JSON.stringify(getBody())).toContain('victim private')
  })

  it('a shared-token caller (no device key) is UNCHANGED -- ?agent=victim still returns the content', async () => {
    const { ctx, getBody } = makeCtx(`/api/recall?date=${today}&agent=victim`)
    const handled = await tryHandleRecall(ctx)
    expect(handled).toBe(true)
    expect(JSON.stringify(getBody())).toContain('victim private')
  })
})

describe('GET /api/recall/dates -- agent-key boundary (card debba303)', () => {
  it('a device key for a DIFFERENT agent does not see the victim\'s dates, even with ?agent=victim', async () => {
    const { ctx, getBody } = makeCtx('/api/recall/dates?agent=victim')
    ;(ctx as any).auth = { kind: 'device', device: 'agent:attacker' }
    const handled = await tryHandleRecall(ctx)
    expect(handled).toBe(true)
    expect(getBody()).toEqual([])
  })

  it('the owning device key still sees its own dates', async () => {
    const { ctx, getBody } = makeCtx('/api/recall/dates')
    ;(ctx as any).auth = { kind: 'device', device: 'agent:victim' }
    const handled = await tryHandleRecall(ctx)
    expect(handled).toBe(true)
    expect(getBody().length).toBeGreaterThan(0)
  })
})
