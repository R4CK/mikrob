// Contract tests for formatStuckSessionAlert: a session continuously not-ready
// past the escalation threshold must produce an ALERT the main agent receives,
// not only a warn log.
//
// Root cause (2026-07-27 incident, card 0a641b52): two messages to prisma sat
// pending for 2.5h while its session was wedged at 100% context. The router
// logged 'session STUCK' at warn level every escalation window -- but the log
// reaches nobody, so the stall was found by hand. The fix routes the same
// escalation into the main agent's inbox as a [session-stuck] message; the
// escalation-window reset in the tick doubles as the notification cooldown.
// formatStuckSessionAlert is the pure decision extracted from the notifier;
// these tests pin it.

import { describe, it, expect, beforeAll } from 'vitest'
import {
  formatStuckSessionAlert,
  shouldEscalateStuckSession,
  notifyOrchestratorOfStuckSession,
} from '../web/message-router.js'
import { detectPaneState } from '../pane-state.js'
import { initDatabase, getDb } from '../db.js'
import { MAIN_AGENT_ID } from '../config.js'

const MAIN = 'marveen'

const SEP = '─'.repeat(80)
const MIN = 60 * 1000

// Real pane shapes, run through detectPaneState rather than passing the
// 'busy' literal directly -- the escalation is only as good as the detection
// that feeds it, and a test that hands in the answer would pass even if the
// pane were read wrong.
const BUSY_PANE = [
  '✢ Combobulating… (52s · ↓ 2.6k tokens · thinking some more)',
  '',
  SEP,
  '❯ ',
  SEP,
  '  ⏵⏵ bypass permissions on (shift+tab to cycle) · esc to interrupt',
].join('\n')

const IDLE_PANE = [
  '',
  SEP,
  '❯ ',
  SEP,
  '  ⏵⏵ bypass permissions on (shift+tab to cycle)',
].join('\n')

describe('formatStuckSessionAlert: silent stall becomes a main-agent alert', () => {
  it('produces a [session-stuck] alert naming agent, session, duration and queue depth', () => {
    const alert = formatStuckSessionAlert('prisma', MAIN, 'agent-prisma', 150 * 60 * 1000, 2)
    expect(alert).not.toBeNull()
    // The marker the main agent's triage keys on.
    expect(alert).toContain('[session-stuck]')
    // Enough to act without a second lookup: who, where, how long, how much is blocked.
    expect(alert).toContain("'prisma'")
    expect(alert).toContain('agent-prisma')
    expect(alert).toContain('150 min')
    expect(alert).toContain('2 pending message(s)')
    // Points at the runbook step rather than leaving "now what".
    expect(alert).toContain('delivery-stall diagnosis')
  })

  it('never alerts the main agent about itself (no self-loop)', () => {
    // Messages TO the main agent use the pull model and never enter the stuck
    // branch; this guards the invariant if that ever changes.
    expect(formatStuckSessionAlert(MAIN, MAIN, 'marveen-channels', 20 * 60 * 1000, 5)).toBeNull()
  })

  it('rounds the stall duration to whole minutes', () => {
    // 11 min 29 s -> 11 min; the alert is triage, not telemetry.
    expect(formatStuckSessionAlert('edina1', MAIN, 'agent-edina1', 689_000, 1)).toContain('11 min')
  })

  it('says "working, do not restart" when the pane was busy', () => {
    // A busy-pane alert that reads like the wedged one gets acted on like the
    // wedged one. It has to name what it actually saw.
    const alert = formatStuckSessionAlert('prisma', MAIN, 'agent-prisma', 35 * MIN, 2, 'busy')!
    expect(alert).toContain('BUSY')
    expect(alert).toContain('Do NOT restart on this alert alone')
    expect(alert).not.toContain('restart the agent if it is wedged')
  })
})

// A session mid-turn is not ready for a prompt for the same reason a wedged one
// is not, so the queue side alone cannot tell them apart. On 2026-07-31 that
// cost three false alarms in one day, each one a main-agent diagnosis round
// whose answer was "it is working".
describe('shouldEscalateStuckSession: a busy pane is work, not a stall', () => {
  it('does NOT escalate the 2026-07-31 18:56 atlas case (busy pane, 1 pending)', () => {
    // atlas: pane busy with `esc to interrupt` visible, one message queued,
    // not-ready past the 10 min threshold. Alerted; should not have.
    expect(shouldEscalateStuckSession(detectPaneState(BUSY_PANE), 12 * MIN)).toBe(false)
  })

  it('does NOT escalate the 2026-07-31 19:27 prisma case (10 min orientation, 2 pending)', () => {
    // prisma: ten minutes into a long orientation turn, two messages queued.
    expect(shouldEscalateStuckSession(detectPaneState(BUSY_PANE), 10 * MIN + 30_000)).toBe(false)
  })

  it('still escalates a busy pane once the long watchdog passes', () => {
    // A tool call can wedge with the spinner up. Half an hour of busy with mail
    // queued behind it is worth a look either way.
    expect(shouldEscalateStuckSession(detectPaneState(BUSY_PANE), 31 * MIN)).toBe(true)
    expect(shouldEscalateStuckSession(detectPaneState(BUSY_PANE), 29 * MIN)).toBe(false)
  })

  it('keeps the normal threshold for a pane that is not busy', () => {
    // The 2026-07-27 case this alert exists for: not-ready while NOT working
    // (wedged at 100% context, idle-looking or unreadable pane).
    expect(shouldEscalateStuckSession(detectPaneState(IDLE_PANE), 11 * MIN)).toBe(true)
    expect(shouldEscalateStuckSession(detectPaneState(IDLE_PANE), 9 * MIN)).toBe(false)
  })

  it('treats an unreadable pane as a reason to look sooner, not later', () => {
    // capturePane returns null when the host is down or tmux is gone. Silence
    // is not evidence of work.
    expect(shouldEscalateStuckSession(null, 11 * MIN)).toBe(true)
  })

  it('does not let a quoted "esc to interrupt" in scrollback mute the alert', () => {
    // A watchdog report pasted into the pane must not read as busy -- that
    // would mute the alert on exactly the session discussing stalls.
    const quoted = [
      'The runbook says: "esc to interrupt" means the agent is still working.',
      '',
      SEP,
      '❯ ',
      SEP,
      '  ⏵⏵ bypass permissions on (shift+tab to cycle)',
    ].join('\n')
    expect(shouldEscalateStuckSession(detectPaneState(quoted), 11 * MIN)).toBe(true)
  })
})

// Card 8f33a1a1 (parent dc35fa1a, step 3): the notifier delivers wake:false, through the
// QUIET_MESSAGE_CLASSES allowlist steps 1-2 already built for this exact caller.
// Only used by the self-loop guard test below; named separately so that test does not read as
// depending on the real tmux session-naming convention.
const MAIN_CHANNELS_SESSION_FOR_TEST = 'agent-marveen-channels'

describe('notifyOrchestratorOfStuckSession: delivers wake:false via the allowlist (card 8f33a1a1)', () => {
  beforeAll(() => {
    process.env['NODE_ENV'] = 'test'
    initDatabase(':memory:')
  })

  function lastMessageTo(agent: string): { content: string; wake: number } {
    return getDb()
      .prepare(
        'SELECT content, wake FROM agent_messages WHERE to_agent = ? ORDER BY id DESC LIMIT 1',
      )
      .get(agent) as { content: string; wake: number }
  }

  it('a not-ready alert is delivered quietly (wake=0), not just logged', () => {
    notifyOrchestratorOfStuckSession('stuck-idle-agent', 'agent-stuck-idle-agent', 15 * MIN, 2, null)
    const row = lastMessageTo(MAIN_AGENT_ID)
    expect(row.content).toContain('[session-stuck]')
    expect(row.content).toContain('not-ready')
    expect(row.wake).toBe(0)
  })

  it('a busy alert is ALSO delivered quietly -- both stuck-session variants are on the allowlist', () => {
    notifyOrchestratorOfStuckSession('stuck-busy-agent', 'agent-stuck-busy-agent', 35 * MIN, 1, 'busy')
    const row = lastMessageTo(MAIN_AGENT_ID)
    expect(row.content).toContain('BUSY')
    expect(row.wake).toBe(0)
  })

  it('MUTATION-PROOF: the FIRST notice for a never-before-seen agent is quiet too -- there is no dedup/repeat-count gate yet', () => {
    // Stated cost (MikroB decision, card 8f33a1a1): without per-agent dedup state, muting only
    // "repeats" is not what actually ships -- EVERY notice for a stuck agent, including the first
    // one, goes quiet. This case exists so that a future dedup-aware rewrite has to touch this test
    // deliberately, not discover the gap by accident.
    notifyOrchestratorOfStuckSession('freshly-stuck-agent-never-alerted-before', 'agent-fresh', 11 * MIN, 1, null)
    expect(lastMessageTo(MAIN_AGENT_ID).wake).toBe(0)
  })

  it('never fires for the main agent about itself -- formatStuckSessionAlert returns null, nothing is enqueued', () => {
    const before = getDb().prepare('SELECT COUNT(*) AS n FROM agent_messages').get() as { n: number }
    notifyOrchestratorOfStuckSession(MAIN_AGENT_ID, MAIN_CHANNELS_SESSION_FOR_TEST, 20 * MIN, 5, null)
    const after = getDb().prepare('SELECT COUNT(*) AS n FROM agent_messages').get() as { n: number }
    expect(after.n).toBe(before.n)
  })
})
