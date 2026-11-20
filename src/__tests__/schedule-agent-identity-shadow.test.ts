// Card a01d8a3d (shadow mode, before any enforce): POST/PUT /api/schedules took the `agent` field
// straight from the request body with no comparison to the caller's own authenticated identity --
// any caller clearing the generic bearer gate could self-schedule as ANY agent. This pins the
// shadow-mode fix: a mismatch between the caller's derived identity (ctx.auth) and the declared
// `agent` field is logged, but the write is NEVER refused (enforce is a later, separate round
// gated on 52114c2f's own key rollout landing first -- see the card's design-comment).
//
// SANDBOX: mirrors schedule-once.test.ts's HOME/SCHEDULED_TASKS_DIR isolation and fakeCtx pattern.

import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest'
import { EventEmitter } from 'node:events'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

vi.mock('../web/schedule-registry.js', () => ({
  filterRegisteredTasks: <T,>(tasks: T[]) => tasks,
  backfillScheduledTaskRegistryOnce: () => ({ ran: false, registered: [] }),
  verifyScheduledTask: () => ({ ok: true }),
  describeVerdict: () => '',
  registerScheduledTask: () => 'test-hash',
  unregisterScheduledTask: () => true,
}))

const tmpHome = mkdtempSync(join(tmpdir(), 'schedule-agent-identity-shadow-home-'))
const realHome = process.env.HOME
process.env.HOME = tmpHome

let io: typeof import('../web/scheduled-tasks-io.js')
let route: typeof import('../web/routes/schedules.js')
let logger: typeof import('../logger.js')['logger']

beforeAll(async () => {
  io = await import('../web/scheduled-tasks-io.js')
  route = await import('../web/routes/schedules.js')
  logger = (await import('../logger.js')).logger
})
afterAll(() => {
  process.env.HOME = realHome
  rmSync(tmpHome, { recursive: true, force: true })
})

beforeEach(() => { rmSync(io.SCHEDULED_TASKS_DIR, { recursive: true, force: true }) })

type Auth = import('../web/routes/types.js').RouteContext['auth']

function fakeCtx(method: string, path: string, body: unknown, auth: Auth) {
  const req = new EventEmitter() as never as import('../web/routes/types.js').RouteContext['req'] & { destroy(): void }
  ;(req as unknown as { headers: Record<string, string> }).headers = {}
  ;(req as { destroy(): void }).destroy = () => {}
  const state = { statusCode: 0, body: '' }
  const res = {
    writeHead(code: number) { state.statusCode = code; return res },
    end(data?: unknown) { state.body = String(data ?? '') },
    setHeader() {},
  } as never
  process.nextTick(() => {
    ;(req as unknown as EventEmitter).emit('data', Buffer.from(JSON.stringify(body)))
    ;(req as unknown as EventEmitter).emit('end')
  })
  return { ctx: { req, res, path, method, url: new URL(`http://localhost${path}`), fedPeer: null, auth } as never, state }
}

async function call(method: string, path: string, body: unknown, auth: Auth) {
  const { ctx, state } = fakeCtx(method, path, body, auth)
  expect(await route.tryHandleSchedules(ctx)).toBe(true)
  return state
}

describe('shadow-mode agent-identity mismatch on POST /api/schedules', () => {
  let warn: ReturnType<typeof vi.spyOn>
  beforeEach(() => { warn = vi.spyOn(logger, 'warn').mockImplementation(() => logger) })

  const mismatchLogs = () =>
    warn.mock.calls.filter((c: unknown[]) => typeof c[1] === 'string' && /caller identity does not match/.test(c[1] as string))

  it('agent-key device claiming a DIFFERENT agent: write succeeds, a warning is logged with both values', async () => {
    const state = await call(
      'POST', '/api/schedules',
      { name: 'shadow-mismatch-post', prompt: 'p', schedule: '0 9 * * *', agent: 'cybersec' },
      { kind: 'device', device: 'agent:backend', deviceId: 1, scope: 'full' }
    )
    expect(state.statusCode).toBe(200)
    expect(mismatchLogs()).toHaveLength(1)
    expect(mismatchLogs()[0]![0]).toMatchObject({ callerIdentity: 'backend', declaredAgent: 'cybersec' })
  })

  it('X-Agent-Id token claiming a DIFFERENT agent: write succeeds, a warning is logged', async () => {
    const state = await call(
      'POST', '/api/schedules',
      { name: 'shadow-mismatch-token', prompt: 'p', schedule: '0 9 * * *', agent: 'cybersec' },
      { kind: 'token', agent: 'backend' }
    )
    expect(state.statusCode).toBe(200)
    expect(mismatchLogs()).toHaveLength(1)
    expect(mismatchLogs()[0]![0]).toMatchObject({ callerIdentity: 'backend', declaredAgent: 'cybersec' })
  })

  it('matching identity: no warning, write succeeds', async () => {
    const state = await call(
      'POST', '/api/schedules',
      { name: 'shadow-match', prompt: 'p', schedule: '0 9 * * *', agent: 'backend' },
      { kind: 'device', device: 'agent:backend', deviceId: 1, scope: 'full' }
    )
    expect(state.statusCode).toBe(200)
    expect(mismatchLogs()).toHaveLength(0)
  })

  it('plain shared token (no agent claim) declaring any agent: no warning -- the owner-equivalent path is untouched', async () => {
    const state = await call(
      'POST', '/api/schedules',
      { name: 'shadow-owner', prompt: 'p', schedule: '0 9 * * *', agent: 'cybersec' },
      { kind: 'token' }
    )
    expect(state.statusCode).toBe(200)
    expect(mismatchLogs()).toHaveLength(0)
  })

  it('a non-agent device key (e.g. a phone/Bridge pairing) declaring an agent: no warning (agentKeyToAgentId is null)', async () => {
    const state = await call(
      'POST', '/api/schedules',
      { name: 'shadow-phone', prompt: 'p', schedule: '0 9 * * *', agent: 'cybersec' },
      { kind: 'device', device: "Peti's iPhone", deviceId: 2, scope: 'full' }
    )
    expect(state.statusCode).toBe(200)
    expect(mismatchLogs()).toHaveLength(0)
  })

  it('PUT /api/schedules/<name> with a mismatched agent field: write succeeds, warning logged', async () => {
    await call(
      'POST', '/api/schedules',
      { name: 'shadow-put', prompt: 'p', schedule: '0 9 * * *', agent: 'backend' },
      { kind: 'token' }
    )
    warn.mockClear()
    const state = await call(
      'PUT', '/api/schedules/shadow-put',
      { agent: 'cybersec' },
      { kind: 'device', device: 'agent:backend', deviceId: 1, scope: 'full' }
    )
    expect(state.statusCode).toBe(200)
    expect(mismatchLogs()).toHaveLength(1)
    expect(mismatchLogs()[0]![0]).toMatchObject({ callerIdentity: 'backend', declaredAgent: 'cybersec' })
  })
})
