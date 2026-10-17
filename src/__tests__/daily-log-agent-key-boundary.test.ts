// WhiteHat2 X1 (card debba303, same precedent as O1 on ddeb2e17 / card 517fdcc5 on memories.ts):
// GET /api/daily-log and GET /api/daily-log/dates read the `agent` query param with no caller
// filter at all, so an agent:<id> device key could read ANY other agent's daily-log content
// through its own key. A dashboard-token/session caller (the human operator) is unaffected.
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import { initDatabase, appendDailyLog } from '../db.js'
import { tryHandleDailyLog } from '../web/routes/daily-log.js'
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
  appendDailyLog('victim', 'victim private daily-log entry')
})

afterAll(() => { vi.restoreAllMocks() })

describe('GET /api/daily-log -- agent-key boundary (card debba303)', () => {
  it('a device key for a DIFFERENT agent does not see the victim entry, even with ?agent=victim', async () => {
    const { ctx, getBody } = makeCtx('/api/daily-log?agent=victim&date=' + new Date().toISOString().split('T')[0])
    ;(ctx as any).auth = { kind: 'device', device: 'agent:attacker' }
    const handled = await tryHandleDailyLog(ctx)
    expect(handled).toBe(true)
    expect(JSON.stringify(getBody())).not.toContain('victim private daily-log entry')
  })

  it('the owning device key still sees its own entry', async () => {
    const { ctx, getBody } = makeCtx('/api/daily-log?date=' + new Date().toISOString().split('T')[0])
    ;(ctx as any).auth = { kind: 'device', device: 'agent:victim' }
    const handled = await tryHandleDailyLog(ctx)
    expect(handled).toBe(true)
    expect(JSON.stringify(getBody())).toContain('victim private daily-log entry')
  })

  it('a shared-token caller (no device key) is UNCHANGED -- ?agent=victim still returns it', async () => {
    const { ctx, getBody } = makeCtx('/api/daily-log?agent=victim&date=' + new Date().toISOString().split('T')[0])
    const handled = await tryHandleDailyLog(ctx)
    expect(handled).toBe(true)
    expect(JSON.stringify(getBody())).toContain('victim private daily-log entry')
  })
})

describe('GET /api/daily-log/dates -- agent-key boundary (card debba303)', () => {
  it('a device key for a DIFFERENT agent does not see the victim\'s dates, even with ?agent=victim', async () => {
    const { ctx, getBody } = makeCtx('/api/daily-log/dates?agent=victim')
    ;(ctx as any).auth = { kind: 'device', device: 'agent:attacker' }
    const handled = await tryHandleDailyLog(ctx)
    expect(handled).toBe(true)
    expect(getBody()).toEqual([])
  })

  it('the owning device key still sees its own dates', async () => {
    const { ctx, getBody } = makeCtx('/api/daily-log/dates')
    ;(ctx as any).auth = { kind: 'device', device: 'agent:victim' }
    const handled = await tryHandleDailyLog(ctx)
    expect(handled).toBe(true)
    expect(getBody().length).toBeGreaterThan(0)
  })

  it('a shared-token caller (no device key) is UNCHANGED -- ?agent=victim still returns the dates', async () => {
    const { ctx, getBody } = makeCtx('/api/daily-log/dates?agent=victim')
    const handled = await tryHandleDailyLog(ctx)
    expect(handled).toBe(true)
    expect(getBody().length).toBeGreaterThan(0)
  })
})
