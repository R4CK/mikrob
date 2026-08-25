// Card 900178fa: /clear must fire ONLY on a genuine card switch (the target holds a DIFFERENT
// in_progress card), never on a first pickup or a re-dispatch of the SAME card (rule 14's own
// exception for multiple gate-rounds on one card). Delivery must reuse sendPromptToSession
// (the same primitive the message-router itself uses) rather than a raw tmux call, and a delivery
// failure must never throw out of the guard.
import { describe, it, expect, vi, beforeEach } from 'vitest'

let inProgressCards: Array<{ id: string; assignee: string }> = []
vi.mock('../db.js', () => ({
  getInProgressCardsForAssignee: (assignee: string) => inProgressCards.filter((c) => c.assignee === assignee),
}))

export let sendCalls: Array<{ session: string; text: string; host: string | null; opts: unknown }> = []
let sendShouldThrow: Error | null = null
vi.mock('../web/agent-process.js', () => ({
  agentSessionName: (name: string) => `agent-${name}`,
  sendPromptToSession: async (session: string, text: string, host: string | null, opts: unknown) => {
    sendCalls.push({ session, text, host, opts })
    if (sendShouldThrow) throw sendShouldThrow
    return 'sent'
  },
}))

vi.mock('../web/agent-config.js', () => ({
  readAgentRemoteHost: () => null,
}))

let warnLogs: Array<Record<string, unknown>> = []
vi.mock('../logger.js', () => ({
  logger: { warn: (o: Record<string, unknown>) => warnLogs.push(o), info: () => {} },
}))

const { isGenuineCardSwitch, clearBeforeDispatchIfSwitching } = await import('../web/kanban-dispatch-clear-guard.js')

beforeEach(() => {
  inProgressCards = []
  sendCalls = []
  sendShouldThrow = null
  warnLogs = []
})

describe('isGenuineCardSwitch', () => {
  it('false on a first pickup (no other in_progress card for the assignee)', () => {
    expect(isGenuineCardSwitch('backend2', 'newcard1')).toBe(false)
  })

  it('false on a re-dispatch of the SAME card (only match is the card itself)', () => {
    inProgressCards = [{ id: 'cardA', assignee: 'backend2' }]
    expect(isGenuineCardSwitch('backend2', 'cardA')).toBe(false)
  })

  it('true when the assignee holds a DIFFERENT in_progress card', () => {
    inProgressCards = [{ id: 'cardA', assignee: 'backend2' }]
    expect(isGenuineCardSwitch('backend2', 'cardB')).toBe(true)
  })

  it('ignores other assignees entirely', () => {
    inProgressCards = [{ id: 'cardA', assignee: 'backend' }]
    expect(isGenuineCardSwitch('backend2', 'cardB')).toBe(false)
  })
})

describe('clearBeforeDispatchIfSwitching', () => {
  it('sends /clear via sendPromptToSession with onBusyTimeout abort on a genuine switch', async () => {
    inProgressCards = [{ id: 'cardA', assignee: 'backend2' }]
    await clearBeforeDispatchIfSwitching('backend2', 'cardB')
    expect(sendCalls).toHaveLength(1)
    expect(sendCalls[0]).toMatchObject({ session: 'agent-backend2', text: '/clear', host: null })
    expect(sendCalls[0]!.opts).toMatchObject({ onBusyTimeout: 'abort' })
  })

  it('sends nothing on a first pickup or same-card re-dispatch', async () => {
    await clearBeforeDispatchIfSwitching('backend2', 'newcard1')
    inProgressCards = [{ id: 'cardA', assignee: 'backend2' }]
    await clearBeforeDispatchIfSwitching('backend2', 'cardA')
    expect(sendCalls).toHaveLength(0)
  })

  it('never throws when the underlying send fails -- logs and returns', async () => {
    inProgressCards = [{ id: 'cardA', assignee: 'backend2' }]
    sendShouldThrow = new Error('pane send failed')
    await expect(clearBeforeDispatchIfSwitching('backend2', 'cardB')).resolves.toBeUndefined()
    expect(warnLogs).toHaveLength(1)
  })
})
