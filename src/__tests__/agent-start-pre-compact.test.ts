// Card d2c3a940: a parked agent restarted with --continue resumes whatever context its PRIOR
// session left behind, and the very first dispatch message can push it over the ceiling before
// context-compact-monitor.sh's own periodic sweep (which does not even cover every agent) gets to
// it. Measured on jogász, 2026-10-11 12:06: started, got one message, "Context limit reached"
// immediately, the card never got picked up.
//
// POST /api/agents/<name>/start now checks the resumed session's context percentage right after
// launch and, if it is already at or above the 75% threshold, sends /compact BEFORE returning --
// so by the time the caller's own next request (the queued dispatch) reaches the agent, the
// session is the post-compact one, not the near-full one.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { EventEmitter } from 'node:events'
import { mkdirSync, rmSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { PROJECT_ROOT } from '../config.js'
import { agentDir } from '../web/agent-config.js'
import { scaffoldAgentDir } from '../web/agent-scaffold.js'
import type { RouteContext } from '../web/routes/types.js'

const AGENT = 'precompacttest-d2c3a940'

const startAgentProcessMock = vi.fn(async (): Promise<{ ok: boolean; error?: string }> => ({ ok: true }))
const isSessionReadyForPromptMock = vi.fn(async () => true)
// eslint-disable-next-line @typescript-eslint/no-unused-vars -- signature must match sendPromptToSession(session, prompt, host) for mock-call-arg assertions below
const sendPromptToSessionMock = vi.fn(async (_session: string, _prompt: string, _host: string | null) => {})
const measureContextPctForAgentMock = vi.fn(async (): Promise<number | null> => null)

vi.mock('../web/agent-process.js', async (orig) => {
  const actual = await orig<typeof import('../web/agent-process.js')>()
  return {
    ...actual,
    startAgentProcess: startAgentProcessMock,
    isSessionReadyForPrompt: isSessionReadyForPromptMock,
    sendPromptToSession: sendPromptToSessionMock,
    delay: vi.fn(async () => {}), // no real waiting in the test
  }
})
vi.mock('../web/context-guard-runner.js', async (orig) => {
  const actual = await orig<typeof import('../web/context-guard-runner.js')>()
  return { ...actual, measureContextPctForAgent: measureContextPctForAgentMock }
})

const { tryHandleAgents } = await import('../web/routes/agents.js')

beforeEach(() => {
  if (!existsSync(agentDir(AGENT))) { mkdirSync(agentDir(AGENT), { recursive: true }); scaffoldAgentDir(AGENT) }
  startAgentProcessMock.mockClear()
  isSessionReadyForPromptMock.mockClear()
  sendPromptToSessionMock.mockClear()
  measureContextPctForAgentMock.mockReset()
})

afterEach(() => {
  rmSync(agentDir(AGENT), { recursive: true, force: true })
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

describe('POST /api/agents/:name/start pre-emptively compacts a near-full resumed session', () => {
  it('synthetic near-full session (90%): sends /compact BEFORE returning ok, first dispatch is never lost', async () => {
    measureContextPctForAgentMock.mockResolvedValue(0.9)
    const { status, body } = await postStart(AGENT)
    expect(status).toBe(200)
    expect(body).toEqual({ ok: true })
    expect(sendPromptToSessionMock).toHaveBeenCalledTimes(1)
    const [, promptArg] = sendPromptToSessionMock.mock.calls[0]
    expect(promptArg).toContain('/compact')
  })

  it('a session well under the threshold (10%): no compact sent', async () => {
    measureContextPctForAgentMock.mockResolvedValue(0.1)
    const { status, body } = await postStart(AGENT)
    expect(status).toBe(200)
    expect(body).toEqual({ ok: true })
    expect(sendPromptToSessionMock).not.toHaveBeenCalled()
  })

  it('exactly at the 75% threshold: compact still fires (boundary is inclusive)', async () => {
    measureContextPctForAgentMock.mockResolvedValue(0.75)
    await postStart(AGENT)
    expect(sendPromptToSessionMock).toHaveBeenCalledTimes(1)
  })

  it('unmeasurable context (null, e.g. no transcript yet): no compact, start still succeeds', async () => {
    measureContextPctForAgentMock.mockResolvedValue(null)
    const { status, body } = await postStart(AGENT)
    expect(status).toBe(200)
    expect(body).toEqual({ ok: true })
    expect(sendPromptToSessionMock).not.toHaveBeenCalled()
  })

  it('a fresh start ({"fresh":true}) skips the check entirely -- nothing to resume', async () => {
    measureContextPctForAgentMock.mockResolvedValue(0.95) // would otherwise fire
    const { status } = await postStart(AGENT, { fresh: true })
    expect(status).toBe(200)
    expect(measureContextPctForAgentMock).not.toHaveBeenCalled()
    expect(sendPromptToSessionMock).not.toHaveBeenCalled()
  })

  it('a session that never becomes ready to prompt: compact is skipped, not sent into a dead pane', async () => {
    measureContextPctForAgentMock.mockResolvedValue(0.9)
    isSessionReadyForPromptMock.mockResolvedValue(false)
    const { status, body } = await postStart(AGENT)
    expect(status).toBe(200)
    expect(body).toEqual({ ok: true })
    expect(sendPromptToSessionMock).not.toHaveBeenCalled()
  })

  it('the context check throwing does not fail the whole start request', async () => {
    measureContextPctForAgentMock.mockRejectedValue(new Error('boom'))
    const { status, body } = await postStart(AGENT)
    expect(status).toBe(200)
    expect(body).toEqual({ ok: true })
    expect(sendPromptToSessionMock).not.toHaveBeenCalled()
  })

  it('startAgentProcess failing: no compact attempt at all', async () => {
    startAgentProcessMock.mockResolvedValueOnce({ ok: false, error: 'boom' })
    measureContextPctForAgentMock.mockResolvedValue(0.95)
    await postStart(AGENT)
    expect(measureContextPctForAgentMock).not.toHaveBeenCalled()
    expect(sendPromptToSessionMock).not.toHaveBeenCalled()
  })
})
