import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { EventEmitter } from 'node:events'
import { mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { initDatabase } from '../db.js'
import { MAIN_AGENT_ID, PROJECT_ROOT } from '../config.js'
import { tryHandleMessages } from '../web/routes/messages.js'
import type { RouteContext } from '../web/routes/types.js'

// MSGWARN908: POST /api/messages warned "'<to>' nem fut -- ... elveszik" for
// the MAIN agent on every send, because isAgentRunning() probes the
// `agent-<name>` session and the main agent lives in `${MAIN_AGENT_ID}-channels`.
// The claim was false twice over: the router never abandons a main-agent
// message (pull model), so nothing is ever lost. On 2026-09-08 the false
// "not running" state was relayed to the owner as a system-down report; the
// reaction it invites -- starting a second main instance -- is exactly what
// the pull model must never see. These tests run the real route handler: in a
// test environment no tmux session exists at all, so isAgentRunning() is
// false for EVERY name -- which is precisely the condition that used to
// trigger the false warning for the main agent.

function fakeCtx(body: unknown): { ctx: RouteContext; res: { statusCode: number; body: string } } {
  const req = new EventEmitter() as unknown as RouteContext['req'] & { destroy(): void }
  ;(req as unknown as { headers: Record<string, string> }).headers = {}
  ;(req as { destroy(): void }).destroy = () => { /* readBody over-limit hook */ }
  const state = { statusCode: 0, body: '' }
  const res = {
    writeHead(code: number) { state.statusCode = code; return res },
    end(data?: unknown) { state.body = String(data ?? '') },
    setHeader() { /* not used by json() */ },
  } as unknown as RouteContext['res']
  process.nextTick(() => {
    ;(req as unknown as EventEmitter).emit('data', Buffer.from(JSON.stringify(body)))
    ;(req as unknown as EventEmitter).emit('end')
  })
  const path = '/api/messages'
  return { ctx: { req, res, path, method: 'POST', url: new URL(`http://localhost${path}`), fedPeer: null }, res: state }
}

async function post(body: unknown): Promise<{ statusCode: number; json: Record<string, unknown> }> {
  const { ctx, res } = fakeCtx(body)
  const handled = await tryHandleMessages(ctx)
  expect(handled).toBe(true)
  return { statusCode: res.statusCode, json: JSON.parse(res.body) }
}

// FORK ADAPTATION (B-wave, card 42938a74). The second case needs a sub-agent that is REGISTERED
// but not running. This fork rejects an unknown local recipient with 400 before it ever reaches
// the running-probe (routes/messages.ts, card 523a1426 -- a forged to_agent opens its own router
// bucket and starves the real agents' buckets; that check survived a Cybered NO-GO and is not
// something to loosen for a test). `agents/` is per-install and gitignored, so no sub-agent is
// known inside a worktree checkout: the case registers one for its own lifetime instead. The
// intent is unchanged -- and it is now the STRONGER statement, because the warning is proven on a
// recipient the route actually accepted rather than on one it would have rejected anyway.
const STOPPED_SUB_AGENT = 'msgwarn-stopped-probe'
const STOPPED_SUB_AGENT_DIR = join(PROJECT_ROOT, 'agents', STOPPED_SUB_AGENT)

beforeAll(() => {
  process.env.NODE_ENV = 'test'
  initDatabase(':memory:')
  mkdirSync(STOPPED_SUB_AGENT_DIR, { recursive: true })
})

afterAll(() => {
  rmSync(STOPPED_SUB_AGENT_DIR, { recursive: true, force: true })
})

describe('POST /api/messages to the main agent (MSGWARN908)', () => {
  it('never carries the "not running -- will be lost" warning', async () => {
    const r = await post({ from: MAIN_AGENT_ID, to: MAIN_AGENT_ID, content: 'status probe' })
    expect(r.statusCode).toBe(200)
    expect(r.json.warning).toBeUndefined()
    expect(r.json.targetRunning).toBeUndefined()
    expect(r.json.to_agent).toBe(MAIN_AGENT_ID)
  })

  it('still warns for a genuinely stopped sub-agent (the gate is not loosened)', async () => {
    // No tmux in the test env, so any sub-agent id reads as stopped -- the
    // exemption must be main-only, not a blanket removal of the warning.
    const r = await post({ from: MAIN_AGENT_ID, to: STOPPED_SUB_AGENT, content: 'ping' })
    expect(r.statusCode).toBe(200)
    expect(r.json.targetRunning).toBe(false)
    expect(String(r.json.warning)).toContain('nem fut')
  })
})
