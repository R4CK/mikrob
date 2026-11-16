// Card d5638d28: POST /api/agents/:name/start refuses while degraded-orchestrator mode is on,
// unless the caller is the owner bypass (force:true, actor:"mikrob" -- same allowlist every other
// kanban status guard already uses, src/kanban-force-actors.ts). Same pattern/harness as
// agent-start-pre-compact.test.ts.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { EventEmitter } from 'node:events'
import { mkdirSync, mkdtempSync, rmSync, existsSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PROJECT_ROOT } from '../config.js'
import { agentDir } from '../web/agent-config.js'
import { scaffoldAgentDir } from '../web/agent-scaffold.js'
import type { RouteContext } from '../web/routes/types.js'

const AGENT = 'degradedstarttest-d5638d28'

const startAgentProcessMock = vi.fn(async (): Promise<{ ok: boolean; error?: string }> => ({ ok: true }))

vi.mock('../web/agent-process.js', async (orig) => {
  const actual = await orig<typeof import('../web/agent-process.js')>()
  return { ...actual, startAgentProcess: startAgentProcessMock }
})

const { tryHandleAgents } = await import('../web/routes/agents.js')

// Round 2 LOW (CYBERED NO-GO 32207, residual 3): a temp path via DEGRADED_ORCHESTRATOR_SWITCH env,
// not the real switch file of the tree under test (degradedOrchestratorSwitchPath() reads this
// env var fresh on every call -- see src/degraded-orchestrator-guard.ts).
let switchDir: string
let DEGRADED_ORCHESTRATOR_SWITCH_PATH: string

beforeEach(() => {
  if (!existsSync(agentDir(AGENT))) { mkdirSync(agentDir(AGENT), { recursive: true }); scaffoldAgentDir(AGENT) }
  startAgentProcessMock.mockClear()
  switchDir = mkdtempSync(join(tmpdir(), 'degraded-guard-start-'))
  DEGRADED_ORCHESTRATOR_SWITCH_PATH = join(switchDir, 'degraded-orchestrator-enabled.json')
  process.env.DEGRADED_ORCHESTRATOR_SWITCH = DEGRADED_ORCHESTRATOR_SWITCH_PATH
})

afterEach(() => {
  rmSync(agentDir(AGENT), { recursive: true, force: true })
  rmSync(switchDir, { recursive: true, force: true })
  delete process.env.DEGRADED_ORCHESTRATOR_SWITCH
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
    // Round 3 (RedHat NO-GO 32245 F2): the route's own pre-check passing is not enough -- it must
    // also FORWARD force/actor into startAgentProcess, or the SAME guard inside
    // startAgentProcessUnlocked refuses again with nothing to let it through. This mock cannot see
    // that inner refusal (it replaces the whole function), so assert on the call args directly.
    expect(startAgentProcessMock).toHaveBeenCalledWith(AGENT, expect.objectContaining({ force: true, actor: 'mikrob' }))
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
