// RED PROBE: an already-injected message must never be injected a second time
// by the router, and an inject that DID happen must never leave the row
// 'pending'.
//
// Why this test exists. A duplicate-delivery report turned out not to be one.
// Measured from three independent sides -- the message ledger, the router log,
// and the receiving session's own transcript -- every row had been injected
// exactly once. The duplication was on the READING side: the receiver had
// pulled those rows out-of-band from the messages API while they were still
// pending, acted on them, and later saw their first real injection.
//
// So this file does not fix a live bug; it locks the property that made that
// measurement come out clean, because the failure mode it guards is silent:
// the router's work set is "everything still pending", so ANY successful inject
// whose delivered-mark is skipped comes back on the next tick as a verbatim
// re-injection -- an agent re-executing an instruction that may since have been
// withdrawn. The pairing below is the whole of that guarantee.
import { describe, it, expect, vi, beforeEach } from 'vitest'

const mockGetPendingMessages = vi.fn()
const mockMarkDelivered = vi.fn(() => true)
const mockMarkFailed = vi.fn(() => true)
const mockSendPrompt = vi.fn(async () => 'sent' as const)

vi.mock('../logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() },
}))

vi.mock('../config.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../config.js')>()),
  MAIN_AGENT_ID: 'orin',
  SUBAGENT_TELEGRAM_WAKE_ENABLED: false,
}))

vi.mock('../db.js', () => ({
  getPendingMessages: (toAgent?: string) => {
    if (toAgent) return [] // per-agent query of the reconnect pre-pass
    return mockGetPendingMessages()
  },
  markMessageDelivered: (...a: unknown[]) => mockMarkDelivered(...a),
  markMessageFailed: (...a: unknown[]) => mockMarkFailed(...a),
  markMessageDone: () => true,
  markPendingFederatedFailed: () => true,
  setMessageResult: () => true,
  createAgentMessage: () => ({ id: 999 }),
  countNewerMessagesFromSameSender: () => 0,
  // Fork-specific (not in the upstream commit this file was ported from,
  // UJRAJATSZAS915/785ffb96): our runMessageRouterTick also checks whether a
  // dispatch was superseded by a newer kanban-card state before injecting.
  // Mocked to "no card state found" so that check is a no-op here -- this
  // file is only about the inject/delivered-mark pairing, not supersession.
  getKanbanCardStateByIdPrefix: () => null,
  stampMessageTrace: () => false,
  upsertOtelSpan: () => undefined,
  closeOtelSpan: () => false,
  // Fork-specific: closeRouterSpanOnFailure calls this on BOTH failure paths
  // (abandon + give-up-after-retries). Left unmocked, the call throws "is not
  // a function" from inside the catch block that is already handling the
  // send-keys failure -- and that second throw escapes to the OUTER safety-net
  // catch, which calls markMessageFailed a SECOND time for the same row. Not
  // hit by pendingRows() here (trace_id/span_id are null), but closeRouterSpanOnFailure
  // is actually called with a freshly-built traceCtx, not the row's own fields.
  closeOtelSpanIfOpen: () => false,
}))

vi.mock('../web/voice-directive.js', () => ({
  resolveAgentChannelStateDir: () => '/tmp/none',
}))

vi.mock('../web/agent-config.js', () => ({
  readAgentRemoteHost: () => null,
  readAgentVoiceConfig: () => ({ responseMode: 'text' }),
  readAgentWorksourceChannel: () => false,
}))

vi.mock('../web/agent-process.js', () => ({
  clearFeedbackModalAndRecheck: () => false,
  agentSessionName: (name: string) => `agent-${name}`,
  // Ready pane: the tick reaches the inject + mark pair, which is what this
  // file measures.
  isSessionReadyForPrompt: vi.fn(async () => true),
  clearStaleParkedInput: vi.fn(async () => false),
  sendPromptToSession: (...a: unknown[]) => mockSendPrompt(...a),
  sessionExistsOnHost: () => true,
  capturePane: () => '',
}))

vi.mock('../web/voice-modality.js', () => ({
  setLastInboundModality: vi.fn(),
}))

vi.mock('../web/main-agent.js', () => ({
  MAIN_CHANNELS_SESSION: 'orin-channels',
}))

vi.mock('../web/agent-message-wrap.js', () => ({
  classifyAgentMessage: () => ({ category: 'trusted-peer', safeFrom: 'orin' }),
  wrapAgentMessageForDelivery: () => ({ prefix: '', wrapped: 'payload' }),
}))

vi.mock('../web/telegram-inbox-wake.js', () => ({
  maybeWakeSubAgentsForTelegram: vi.fn(),
}))

import { runMessageRouterTick } from '../web/message-router.js'

function pendingRows(ids: number[]) {
  const nowSec = Math.floor(Date.now() / 1000)
  return ids.map((id) => ({
    id,
    from_agent: 'orin',
    to_agent: 'dex', // sub-agent -> tmux-inject path (the main agent PULLs)
    content: `payload ${id}`,
    created_at: nowSec, // fresh: well inside the abandon window
    origin_note: null,
    trace_id: null,
    span_id: null,
  }))
}

describe('message router: an injected message is never left pending', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockMarkDelivered.mockReturnValue(true)
    mockMarkFailed.mockReturnValue(true)
    mockSendPrompt.mockImplementation(async () => 'sent' as const)
  })

  it('pairs every inject with a delivered-mark for the SAME id, in order', async () => {
    mockGetPendingMessages.mockReturnValue(pendingRows([101, 102, 103]))

    await runMessageRouterTick()

    // Positive control: the tick really injected (a silently-skipped tick would
    // pass a bare "no double inject" assertion trivially).
    expect(mockSendPrompt).toHaveBeenCalledTimes(3)
    expect(mockMarkDelivered).toHaveBeenCalledTimes(3)
    expect(mockMarkDelivered.mock.calls.map((c) => c[0])).toEqual([101, 102, 103])
    expect(mockMarkFailed).not.toHaveBeenCalled()
  })

  it('does not re-inject a row the DB no longer reports as pending', async () => {
    mockGetPendingMessages.mockReturnValue(pendingRows([201]))
    await runMessageRouterTick()
    expect(mockSendPrompt).toHaveBeenCalledTimes(1)

    // Second tick: the row is delivered, so it is out of the work set.
    mockGetPendingMessages.mockReturnValue([])
    await runMessageRouterTick()
    expect(mockSendPrompt).toHaveBeenCalledTimes(1)
  })

  it('leaves a THROWN inject pending (bounded at-least-once), never marking it delivered', async () => {
    // The one deliberate re-injection path: send-keys threw, so we cannot know
    // whether the keystrokes landed. The row stays pending and the next tick
    // retries -- bounded by MAX_INJECT_FAILURES (3), after which it is failed
    // and surfaced, not retried forever.
    mockSendPrompt.mockImplementation(async () => { throw new Error('send-keys: pane gone') })
    mockGetPendingMessages.mockReturnValue(pendingRows([301]))

    await runMessageRouterTick()
    await runMessageRouterTick()
    expect(mockMarkFailed).not.toHaveBeenCalled()

    await runMessageRouterTick()
    expect(mockMarkFailed).toHaveBeenCalledTimes(1)
    expect(mockMarkFailed.mock.calls[0][0]).toBe(301)
    // Never claimed as delivered on any of the three attempts.
    expect(mockMarkDelivered).not.toHaveBeenCalled()
  })
})
