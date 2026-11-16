// Card d5638d28: POST /api/agents/:name/start refuses while degraded-orchestrator mode is on,
// unless the caller is the owner bypass (force:true, actor:"mikrob" -- same allowlist every other
// kanban status guard already uses, src/kanban-force-actors.ts). Same pattern/harness as
// agent-start-pre-compact.test.ts.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { EventEmitter } from 'node:events'
import { mkdirSync, rmSync, existsSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { PROJECT_ROOT } from '../config.js'
import { agentDir } from '../web/agent-config.js'
import { scaffoldAgentDir } from '../web/agent-scaffold.js'
import type { RouteContext } from '../web/routes/types.js'
import { DEGRADED_ORCHESTRATOR_SWITCH_PATH } from '../degraded-orchestrator-guard.js'

const AGENT = 'degradedstarttest-d5638d28'

const startAgentProcessMock = vi.fn(async (): Promise<{ ok: boolean; error?: string }> => ({ ok: true }))

vi.mock('../web/agent-process.js', async (orig) => {
  const actual = await orig<typeof import('../web/agent-process.js')>()
  return { ...actual, startAgentProcess: startAgentProcessMock }
})

const { tryHandleAgents } = await import('../web/routes/agents.js')

beforeEach(() => {
  if (!existsSync(agentDir(AGENT))) { mkdirSync(agentDir(AGENT), { recursive: true }); scaffoldAgentDir(AGENT) }
  startAgentProcessMock.mockClear()
  rmSync(DEGRADED_ORCHESTRATOR_SWITCH_PATH, { force: true })
})

afterEach(() => {
  rmSync(agentDir(AGENT), { recursive: true, force: true })
  rmSync(DEGRADED_ORCHESTRATOR_SWITCH_PATH, { force: true })
})

async function postStart(name: string, body: Record<string, unknown> = {}): Promise<{ status: number; body: unknown }> {
  const req = new EventEmitter() as unknown as RouteContext['req']
  ;(req as unknown as { headers: Record<string, string> }).headers = {}
  const out: { status: number; body: unknown } = { status: 0, body: null }
  const res = {
    writeHead(status: number) { out.status = status; return res },
    end(chunk?: string) { if (chunk) out.body = JSON.parse(chunk) },
    setHeader() {},
  }
  const url = new URL(`http://localhost:3420/api/agents/${encodeURIComponent(name)}/start`)
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

describe('POST /api/agents/:name/start refuses while degraded-orchestrator mode is on (card d5638d28)', () => {
  it('switch file missing: starts normally (default OFF)', async () => {
    const res = await postStart(AGENT)
    expect(res.status).toBe(200)
    expect(startAgentProcessMock).toHaveBeenCalledTimes(1)
  })

  it('{"enabled": true}: refuses, does not call startAgentProcess', async () => {
    writeFileSync(DEGRADED_ORCHESTRATOR_SWITCH_PATH, JSON.stringify({ enabled: true }))
    const res = await postStart(AGENT)
    expect(res.status).toBe(409)
    expect((res.body as { code?: string }).code).toBe('degraded_orchestrator_blocked')
    expect(startAgentProcessMock).not.toHaveBeenCalled()
  })

  it('{"enabled": true} + owner bypass (force:true, actor:"mikrob"): starts anyway', async () => {
    writeFileSync(DEGRADED_ORCHESTRATOR_SWITCH_PATH, JSON.stringify({ enabled: true }))
    const res = await postStart(AGENT, { force: true, actor: 'mikrob' })
    expect(res.status).toBe(200)
    expect(startAgentProcessMock).toHaveBeenCalledTimes(1)
  })

  it('{"enabled": true} + force:true but actor is NOT mikrob: still refused', async () => {
    writeFileSync(DEGRADED_ORCHESTRATOR_SWITCH_PATH, JSON.stringify({ enabled: true }))
    const res = await postStart(AGENT, { force: true, actor: 'degraded-orchestrator-loop' })
    expect(res.status).toBe(409)
    expect(startAgentProcessMock).not.toHaveBeenCalled()
  })

  it('malformed switch file: fails closed (refused), same as enabled:true', async () => {
    writeFileSync(DEGRADED_ORCHESTRATOR_SWITCH_PATH, '{not json')
    const res = await postStart(AGENT)
    expect(res.status).toBe(409)
    expect(startAgentProcessMock).not.toHaveBeenCalled()
  })
})
