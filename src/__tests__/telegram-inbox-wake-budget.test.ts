// Card df193354. The weekly self-audit found a floating promise at telegram-inbox-wake.ts:214, and
// looking at it turned up a second, larger defect on the same three lines: sendPromptToSession does
// not just resolve or throw, it returns 'sent' | 'aborted-busy' | 'skipped-locked', and `attempts`
// was bumped for all three. A waiting sub-agent's wake BUDGET was therefore spent on nudges that
// never reached its pane -- adding the missing `await` alone would not have fixed that.
//
// WHY A NEW FILE. telegram-inbox-wake.test.ts covers the two PURE helpers
// (shouldWakeForTelegramInbox, wakeBackoffMs) and nothing else. The bug was not in either of them:
// it was in the effectful sweep that calls them, which had no test at all. That is exactly how it
// survived. These tests drive maybeWakeSubAgentsForTelegram itself.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const MIN_AGE_MS = 25_000
const NOW = 1_800_000_000_000
/** Older than MIN_AGE_MS, so the cheap age gate lets the agent through to the send. */
const INBOX_MTIME = NOW - 5 * MIN_AGE_MS

const sendPromptToSession =
  vi.fn<(session: string, text: string, host: string | null) => Promise<string>>()
const listAgentNames = vi.fn<() => string[]>()

vi.mock('../config.js', async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  SUBAGENT_TELEGRAM_WAKE_ENABLED: true,
  MAIN_AGENT_ID: 'mikrob',
}))
vi.mock('../web/agent-config.js', () => ({
  listAgentNames: () => listAgentNames(),
  readAgentRemoteHost: () => null,
}))
vi.mock('../web/agent-process.js', () => ({
  agentSessionName: (n: string) => `sess-${n}`,
  sessionExistsOnHost: () => true,
  isSessionReadyForPrompt: () => Promise.resolve(true),
  sendPromptToSession: (s: string, t: string, h: string | null) => sendPromptToSession(s, t, h),
}))
vi.mock('../web/voice-directive.js', () => ({
  resolveAgentChannelStateDir: (n: string) => `/nonexistent/${n}`,
}))
const warn = vi.fn()
vi.mock('../logger.js', () => ({
  logger: {
    warn: (...a: unknown[]) => warn(...a),
    info: () => undefined,
    debug: () => undefined,
    error: () => undefined,
  },
}))
vi.mock('node:fs', async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  statSync: () => ({ size: 42, mtimeMs: INBOX_MTIME }),
}))

const { maybeWakeSubAgentsForTelegram } = await import('../web/telegram-inbox-wake.js')

/** A fresh agent name per test: the module keeps its backoff state in a private Map keyed by name,
 *  and an unused key is the honest way to start from zero without reaching into module internals. */
let seq = 0
function freshAgent(): string {
  seq += 1
  const name = `sub-${seq}`
  listAgentNames.mockReturnValue([name])
  return name
}

/** Advance far enough that the debounce never masks what the budget is doing. */
const laterTick = (i: number) => NOW + i * 60 * 60 * 1000

beforeEach(() => {
  sendPromptToSession.mockReset()
  warn.mockReset()
})
afterEach(() => {
  vi.clearAllMocks()
})

describe('the wake budget counts DELIVERED nudges only (card df193354)', () => {
  it('a delivered nudge consumes the budget: five sends, then the agent is left alone', async () => {
    freshAgent()
    sendPromptToSession.mockResolvedValue('sent')
    for (let i = 0; i < 8; i += 1) await maybeWakeSubAgentsForTelegram(laterTick(i))
    // MAX_ATTEMPTS is 5, so the sixth tick onwards must not send.
    expect(sendPromptToSession).toHaveBeenCalledTimes(5)
  })

  it('THE BUG: a refused nudge must NOT consume the budget -- it never reached the pane', async () => {
    // Before the fix these three outcomes were indistinguishable: `attempts` was bumped for all of
    // them, so five busy panes in a row permanently gave up on an agent that was genuinely waiting.
    for (const outcome of ['aborted-busy', 'skipped-locked'] as const) {
      sendPromptToSession.mockReset()
      freshAgent()
      sendPromptToSession.mockResolvedValue(outcome)
      for (let i = 0; i < 8; i += 1) await maybeWakeSubAgentsForTelegram(laterTick(i))
      expect(sendPromptToSession, outcome).toHaveBeenCalledTimes(8)
    }
  })

  it('a mix behaves per-outcome: only the delivered ones count towards the give-up budget', async () => {
    freshAgent()
    // refused, refused, sent, refused, sent, ... -- with MAX_ATTEMPTS=5 the loop should keep going
    // well past the point where counting every call would have stopped it.
    let call = 0
    sendPromptToSession.mockImplementation(() => {
      call += 1
      return Promise.resolve(call % 3 === 0 ? 'sent' : 'skipped-locked')
    })
    for (let i = 0; i < 12; i += 1) await maybeWakeSubAgentsForTelegram(laterTick(i))
    expect(sendPromptToSession).toHaveBeenCalledTimes(12)
  })

  it('a REJECTED send lands in the LOCAL catch, with the agent in the log line', async () => {
    // The floating call meant a rejection bypassed the try/catch on the very next line and surfaced
    // only at the global unhandledRejection handler, whose message carries no agent and no session.
    //
    // Asserting on the absence of an unhandledRejection event does NOT work here and was tried
    // first: vitest installs its own handler, so that version passed with and without the fix --
    // a green test proving nothing. The claim worth making is positive and local: the module's own
    // catch ran, and it logged WHICH agent failed.
    const name = freshAgent()
    sendPromptToSession.mockRejectedValue(new Error('tmux send failed'))
    await expect(maybeWakeSubAgentsForTelegram(NOW)).resolves.toBeUndefined()
    expect(warn).toHaveBeenCalledWith(
      expect.objectContaining({ agent: name }),
      'telegram-inbox-wake: wake check failed'
    )
  })

  it('a throwing send does not consume the budget either, and the sweep keeps working', async () => {
    freshAgent()
    sendPromptToSession.mockRejectedValue(new Error('tmux send failed'))
    for (let i = 0; i < 8; i += 1) await maybeWakeSubAgentsForTelegram(laterTick(i))
    expect(sendPromptToSession).toHaveBeenCalledTimes(8)
  })

  it('the send is AWAITED: the sweep does not resolve before the send settles', async () => {
    // The ordering half of the defect. Without the await the sweep returns while the send is still
    // in flight, so `attempts` and the log line describe a delivery that has not happened yet.
    freshAgent()
    let settled = false
    sendPromptToSession.mockImplementation(
      () =>
        new Promise((resolve) =>
          setTimeout(() => {
            settled = true
            resolve('sent')
          }, 30)
        )
    )
    await maybeWakeSubAgentsForTelegram(NOW)
    expect(settled).toBe(true)
  })
})
