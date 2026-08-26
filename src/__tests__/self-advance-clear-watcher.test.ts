// Card 5003f37e: the watcher must deliver /clear ONLY when the target agent's pane is genuinely
// idle (the whole reason self-advance cannot deliver it synchronously -- see the schema comment on
// agent_pending_clear in db.ts), never touch a busy pane, and clear the debt only when the send
// actually went through -- mirroring kanban-dispatch-clear-guard.test.ts's mock shape.
import { describe, it, expect, vi, beforeEach } from 'vitest'

let pending: Array<{ agent_id: string; card_id: string; set_at: number }> = []
let cleared: Array<{ agentId: string; cardId: string }> = []
vi.mock('../db.js', () => ({
  getPendingSelfAdvanceClears: () => pending,
  clearPendingSelfAdvanceClear: (agentId: string, cardId: string) => {
    cleared.push({ agentId, cardId })
    return true
  },
}))

let existingSessions = new Set<string>()
let readySessions = new Set<string>()
export let sendCalls: Array<{ session: string; text: string; host: string | null; opts: unknown }> = []
let sendResult: 'sent' | 'aborted-busy' | 'skipped-locked' = 'sent'
let sendShouldThrow: Error | null = null
vi.mock('../web/agent-process.js', () => ({
  agentSessionName: (name: string) => `agent-${name}`,
  sessionExistsOnHost: (_host: string | null, session: string) => existingSessions.has(session),
  isSessionReadyForPrompt: async (session: string) => readySessions.has(session),
  sendPromptToSession: async (session: string, text: string, host: string | null, opts: unknown) => {
    sendCalls.push({ session, text, host, opts })
    if (sendShouldThrow) throw sendShouldThrow
    return sendResult
  },
}))

vi.mock('../web/agent-config.js', () => ({
  readAgentRemoteHost: () => null,
}))

let warnLogs: Array<Record<string, unknown>> = []
vi.mock('../logger.js', () => ({
  logger: { warn: (o: Record<string, unknown>) => warnLogs.push(o), info: () => {} },
}))

const mod = await import('../web/self-advance-clear-watcher.js')
// tick() is not exported (mirrors inbox-nudge-watcher's own private tick) -- drive it through the
// exported interval starter, capturing and invoking the scheduled callback directly instead of
// waiting on real timers.
async function runOneTick(): Promise<void> {
  const realSetInterval = global.setInterval
  let captured: (() => void) | undefined
  // @ts-expect-error -- deliberately intercepting the callback, not the timer itself
  global.setInterval = (fn: () => void) => { captured = fn; return 0 as unknown as NodeJS.Timeout }
  const handle = mod.startSelfAdvanceClearWatcher()
  global.setInterval = realSetInterval
  clearInterval(handle)
  captured!()
  // the captured callback is `() => { void tick() }` -- flush the microtask queue it schedules
  await new Promise((r) => setTimeout(r, 0))
  await new Promise((r) => setTimeout(r, 0))
}

beforeEach(() => {
  pending = []
  cleared = []
  existingSessions = new Set()
  readySessions = new Set()
  sendCalls = []
  sendResult = 'sent'
  sendShouldThrow = null
  warnLogs = []
})

describe('self-advance-clear-watcher tick', () => {
  it('delivers /clear and clears the debt when the target session exists and is idle', async () => {
    pending = [{ agent_id: 'backend2', card_id: 'b', set_at: 1000 }]
    existingSessions.add('agent-backend2')
    readySessions.add('agent-backend2')
    await runOneTick()
    expect(sendCalls).toEqual([{ session: 'agent-backend2', text: '/clear', host: null, opts: { onBusyTimeout: 'abort' } }])
    expect(cleared).toEqual([{ agentId: 'backend2', cardId: 'b' }])
  })

  it('sends NOTHING and leaves the debt when the session is busy (not idle)', async () => {
    pending = [{ agent_id: 'backend2', card_id: 'b', set_at: 1000 }]
    existingSessions.add('agent-backend2')
    // not added to readySessions -> isSessionReadyForPrompt resolves false
    await runOneTick()
    expect(sendCalls).toEqual([])
    expect(cleared).toEqual([])
  })

  it('sends nothing when the session does not exist at all', async () => {
    pending = [{ agent_id: 'backend2', card_id: 'b', set_at: 1000 }]
    // never added to existingSessions or readySessions
    await runOneTick()
    expect(sendCalls).toEqual([])
    expect(cleared).toEqual([])
  })

  it('does not clear the debt when sendPromptToSession reports aborted-busy (the check->send race)', async () => {
    pending = [{ agent_id: 'backend2', card_id: 'b', set_at: 1000 }]
    existingSessions.add('agent-backend2')
    readySessions.add('agent-backend2')
    sendResult = 'aborted-busy'
    await runOneTick()
    expect(sendCalls).toHaveLength(1)
    expect(cleared).toEqual([])
  })

  it('never throws when the underlying send throws -- logs and moves on', async () => {
    pending = [{ agent_id: 'backend2', card_id: 'b', set_at: 1000 }]
    existingSessions.add('agent-backend2')
    readySessions.add('agent-backend2')
    sendShouldThrow = new Error('pane send failed')
    await runOneTick()
    expect(cleared).toEqual([])
    expect(warnLogs.length).toBeGreaterThan(0)
  })

  it('processes multiple pending agents independently in one tick', async () => {
    pending = [
      { agent_id: 'backend2', card_id: 'b', set_at: 1000 },
      { agent_id: 'qa', card_id: 'c', set_at: 2000 },
    ]
    existingSessions.add('agent-backend2')
    readySessions.add('agent-backend2')
    existingSessions.add('agent-qa') // qa's session exists but is NOT idle
    await runOneTick()
    expect(cleared).toEqual([{ agentId: 'backend2', cardId: 'b' }])
  })
})
