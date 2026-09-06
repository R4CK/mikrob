// Card 3bd457ed: the two places that decide whether an inter-agent message
// WAKES the main agent, exercised behaviourally rather than by reading source.
//
//   1. message-router: fires `[inbox-wakeup: ...]` into the channels session.
//   2. inbox-nudge-watcher: types a nudge line, which costs a paid autonomous
//      turn. This is the expensive one, and it is a SEPARATE code path -- a
//      wake:false honoured only in the router would leave it wide open.
//
// Both are covered here, in one file, because they are one behaviour split
// across two modules: "a wake:false message reaches the inbox and waits, it does
// not buy an interruption". The structural pin that they both call the shared
// predicate lives in message-wake-field.test.ts.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

// Inlined as a literal inside every vi.mock factory below: those factories are
// hoisted above this const, so referencing it there is a TDZ error.
const MAIN = 'orin'

const mockSendPrompt = vi.fn<(session: string, text: string, host?: unknown, opts?: unknown) => Promise<'sent'>>(
  () => Promise.resolve('sent'),
)
let pendingRows: unknown[] = []

vi.mock('../logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() },
}))

vi.mock('../config.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../config.js')>()),
  MAIN_AGENT_ID: 'orin',
  // message-router imports maybeWakeSubAgentsForTelegram, which reads this
  // flag; keep it off so the wake watcher early-returns and this file stays
  // about the two deciders it names.
  SUBAGENT_TELEGRAM_WAKE_ENABLED: false,
}))

vi.mock('../db.js', () => ({
  // Both consumers ask the same function. The router's per-agent reconnect
  // pre-pass never queries MAIN (it is excluded from receiversInTick), so the
  // single list is unambiguous here.
  getPendingMessages: () => pendingRows,
  markMessageDelivered: () => true,
  markMessageFailed: () => true,
  markMessageDone: () => true,
  markPendingFederatedFailed: () => 0,
  closeMessagesWithoutDelivery: () => 0,
  setMessageResult: () => false,
  createAgentMessage: () => ({ id: 999 }),
  getKanbanCardStateByIdPrefix: () => null,
  countNewerMessagesFromSameSender: () => 0,
  stampMessageTrace: () => false,
  upsertOtelSpan: () => undefined,
  closeOtelSpanIfOpen: () => false,
}))

vi.mock('../web/voice-directive.js', () => ({ resolveAgentChannelStateDir: () => '/tmp/none' }))
vi.mock('../web/agent-config.js', () => ({
  readAgentRemoteHost: () => null,
  readAgentVoiceConfig: () => ({ responseMode: 'text' }),
}))
vi.mock('../web/agent-process.js', () => ({
  agentSessionName: (name: string) => `agent-${name}`,
  isSessionReadyForPrompt: async () => true,
  clearStaleParkedInput: () => false,
  sendPromptToSession: (session: string, text: string, host?: unknown, opts?: unknown) =>
    mockSendPrompt(session, text, host, opts),
  sessionExistsOnHost: () => true,
  capturePane: () => null,
}))
vi.mock('../web/voice-modality.js', () => ({ setLastInboundModality: vi.fn() }))
vi.mock('../web/main-agent.js', () => ({ MAIN_CHANNELS_SESSION: 'orin-channels' }))
vi.mock('../web/agent-message-wrap.js', () => ({
  classifyAgentMessage: () => ({ category: 'trusted-peer', safeFrom: 'orin' }),
  wrapAgentMessageForDelivery: () => ({ prefix: '', wrapped: '' }),
}))
vi.mock('../web/channel-monitor.js', () => ({ sendAlert: vi.fn() }))
vi.mock('../settings-store.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../settings-store.js')>()),
  getEffectiveSettingValue: () => 'hu',
}))

import { runMessageRouterTick } from '../web/message-router.js'
import {
  startInboxNudgeWatcher,
  INBOX_NUDGE_INITIAL_DELAY_MS,
  INBOX_NUDGE_INTERVAL_MS,
} from '../web/inbox-nudge-watcher.js'

function row(id: number, wake: number, ageMs: number) {
  return {
    id,
    from_agent: 'system',
    to_agent: MAIN,
    content: '[session-stuck] fron-ted not-ready',
    status: 'pending' as const,
    result: null,
    created_at: Math.floor((Date.now() - ageMs) / 1000),
    delivered_at: null,
    completed_at: null,
    origin_note: null,
    trace_id: null,
    span_id: null,
    parent_span_id: null,
    wake,
  }
}

function wakeupCalls(): number {
  return mockSendPrompt.mock.calls.filter(
    (c) => typeof c[1] === 'string' && c[1].includes('inbox-wakeup'),
  ).length
}

describe('message-router: the main-agent wakeup', () => {
  // The router keeps a MODULE-level 45s wakeup cooldown (lastMainAgentWakeupMs),
  // so a test that fires a wakeup would silence the next test in this file and
  // make its assertion pass for the wrong reason. Each case therefore runs on
  // its own clock, ten minutes past the previous one.
  let clock = 1_750_000_000_000

  beforeEach(() => {
    clock += 10 * 60_000
    vi.useFakeTimers()
    vi.setSystemTime(clock)
    mockSendPrompt.mockClear()
    pendingRows = []
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('fires nothing for a queue of wake:false messages', async () => {
    pendingRows = [row(1, 0, 60_000), row(2, 0, 60_000)]
    await runMessageRouterTick()
    expect(wakeupCalls()).toBe(0)
  })

  it('CONTROL: the same queue with wake:true DOES fire -- the suppression is the field, not the harness', async () => {
    // Without this control the test above would pass just as happily against a
    // router that never wakes anyone, e.g. because a mock is wrong.
    pendingRows = [row(3, 1, 60_000)]
    await runMessageRouterTick()
    expect(wakeupCalls()).toBe(1)
  })

  it('a wake:false message does not shield a waking one behind it in the same tick', async () => {
    // The decision is per message. An older silenced row must not consume the
    // tick's single wakeup slot on behalf of a younger real message -- that
    // would turn a "quiet" class into a way to delay everyone else's mail.
    pendingRows = [row(4, 0, 120_000), row(5, 1, 60_000)]
    await runMessageRouterTick()
    expect(wakeupCalls()).toBe(1)
  })
})

describe('inbox-nudge watcher: the path that spends a paid turn', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(1_750_000_000_000)
    mockSendPrompt.mockClear()
    pendingRows = []
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('does NOT buy a turn for a wake:false backlog, and DOES once a waking message arrives', async () => {
    // Phase 1: the inbox holds nothing but silenced automation.
    pendingRows = [row(1, 0, 60_000), row(2, 0, 60_000)]
    const timer = startInboxNudgeWatcher()
    await vi.advanceTimersByTimeAsync(INBOX_NUDGE_INITIAL_DELAY_MS + 10)
    expect(mockSendPrompt).not.toHaveBeenCalled()

    // Phase 2: a normal message arrives behind the silenced ones. The nudge
    // fires -- the field suppresses a wake, it does not disable the watcher,
    // and an older wake:false row does not shield a younger waking one.
    pendingRows = [row(1, 0, 120_000), row(3, 1, 60_000)]
    await vi.advanceTimersByTimeAsync(INBOX_NUDGE_INTERVAL_MS + 10)
    expect(mockSendPrompt).toHaveBeenCalledTimes(1)

    clearInterval(timer)
  })
})
