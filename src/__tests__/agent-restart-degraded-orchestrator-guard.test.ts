// Card d5638d28 round 4 (CYBERED NO-GO 32270 Finding 2): POST /api/agents/:name/restart's 409
// degraded_orchestrator_blocked mapping and its force/actor passthrough (via restartOptsFromBody)
// were never pinned at the route/HTTP layer -- RedHat measured that removing either the
// restartOptsFromBody force/actor assignments or the route's 409 mapping block left the suite
// green (64/64). restartAgentProcess itself is mocked here (same harness as
// restart-respects-stop.test.ts) so no tmux session is ever launched; the real (unmocked)
// restartAgentProcess is already pinned separately in agent-start-restart-degraded-orchestrator-real.test.ts.
import { mkdirSync, rmSync } from 'node:fs'
import { EventEmitter } from 'node:events'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { PROJECT_ROOT, STORE_DIR } from '../config.js'
import { agentDir } from '../web/agent-config.js'
import { removeDesiredAgent } from '../web/agent-desired-state.js'
import type { RouteContext } from '../web/routes/types.js'

const restartAgentProcessMock = vi.fn(async (): Promise<{ ok: boolean; error?: string }> => ({ ok: true }))

vi.mock('../web/agent-process.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../web/agent-process.js')>()
  return {
    ...actual,
    agentRunState: () => 'running' as const,
    isAgentRunning: () => true,
    restartAgentProcess: restartAgentProcessMock,
  }
})

const { tryHandleAgents } = await import('../web/routes/agents.js')

const AGENT = 'degradedrestarttest-d5638d28'

async function postRestart(body: Record<string, unknown> = {}): Promise<{ status: number; body: unknown }> {
  const req = new EventEmitter() as unknown as RouteContext['req']
  ;(req as unknown as { headers: Record<string, string> }).headers = {}
  const out: { status: number; body: unknown } = { status: 0, body: null }
  const res = {
    writeHead(status: number) { out.status = status; return res },
    end(chunk?: string) { if (chunk) out.body = JSON.parse(chunk) },
    setHeader() {},
  }
  const url = new URL(`http://localhost:3420/api/agents/${encodeURIComponent(AGENT)}/restart`)
  process.nextTick(() => {
    ;(req as unknown as EventEmitter).emit('data', Buffer.from(JSON.stringify(body)))
    ;(req as unknown as EventEmitter).emit('end')
  })
  const handled = await tryHandleAgents(
    { req, res, path: url.pathname, method: 'POST', url } as unknown as RouteContext,
    join(PROJECT_ROOT, 'web'),
  )
  expect(handled).toBe(true)
  return { status: out.status || 200, body: out.body }
}

beforeEach(() => {
  mkdirSync(agentDir(AGENT), { recursive: true })
  mkdirSync(STORE_DIR, { recursive: true })
  removeDesiredAgent(AGENT)
  restartAgentProcessMock.mockClear()
})

afterEach(() => {
  rmSync(agentDir(AGENT), { recursive: true, force: true })
  removeDesiredAgent(AGENT)
})

describe('POST /api/agents/:name/restart: degraded-orchestrator 409 mapping + force/actor passthrough (card d5638d28)', () => {
  it('maps a degraded-orchestrator refusal from restartAgentProcess to 409 + code, not the generic 400', async () => {
    restartAgentProcessMock.mockResolvedValueOnce({
      ok: false,
      error: 'degraded-orchestrator guard: degraded mode is ON -- refusing agent restart (card d5638d28). Owner override: force:true with actor:"mikrob".',
    })
    const res = await postRestart({})
    expect(res.status).toBe(409)
    expect((res.body as { code?: string }).code).toBe('degraded_orchestrator_blocked')
  })

  it('an UNRELATED restart failure still gets the generic 400, not the degraded-orchestrator code', async () => {
    restartAgentProcessMock.mockResolvedValueOnce({ ok: false, error: 'some other failure' })
    const res = await postRestart({})
    expect(res.status).toBe(400)
    expect((res.body as { code?: string }).code).toBeUndefined()
  })

  it('force:true + actor:"mikrob" in the body reach restartAgentProcess via restartOptsFromBody', async () => {
    const res = await postRestart({ force: true, actor: 'mikrob' })
    expect(res.status).toBe(200)
    expect(restartAgentProcessMock).toHaveBeenCalledTimes(1)
    expect(restartAgentProcessMock).toHaveBeenCalledWith(AGENT, expect.objectContaining({ force: true, actor: 'mikrob' }))
  })

  it('a plain body (no force/actor) reaches restartAgentProcess with force:false', async () => {
    const res = await postRestart({})
    expect(res.status).toBe(200)
    expect(restartAgentProcessMock).toHaveBeenCalledWith(AGENT, expect.objectContaining({ force: false }))
  })
})
