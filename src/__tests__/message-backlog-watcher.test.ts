// The message-backlog watcher's policy (card 1e7ba5c1).
//
// WHAT IT IS FOR. getPendingBacklogByAgent() has existed since an 18-row backlog went unseen on
// 2026-07-27, and GET /api/messages/backlog serves it -- but nothing consumed either. Measured while
// writing this: backend was holding 27 undelivered messages, oldest 325 minutes, session RUNNING.
//
// WHY THE THRESHOLD MATTERS MORE THAN THE COUNT. The router holds a message until the recipient's
// session is ready, so an agent legitimately mid-task SHOULD have a queue -- a count alone would
// alert on healthy work. Age is what separates "busy" from "never going to pick it up", which is
// the same reasoning db.ts's own comment gives for returning oldestAgeSeconds at all.
//
// The decision is a pure function on purpose: no database, no clock, no interval. Everything below
// runs offline.
import { describe, it, expect } from 'vitest'
import {
  backlogAlerts,
  formatBacklogAlert,
  BACKLOG_AGE_ALERT_SECONDS,
  BACKLOG_ALERT_COOLDOWN_MS,
} from '../web/message-backlog-watcher.js'

const HOUR = 3600
const row = (agent: string, pending: number, oldestAgeSeconds: number) => ({ agent, pending, oldestAgeSeconds })

describe('backlogAlerts: age decides, not count', () => {
  it('reports an agent whose oldest message is past the threshold', () => {
    const out = backlogAlerts([row('backend', 27, 5 * HOUR)], new Map(), 0)
    expect(out).toEqual([{ agent: 'backend', pending: 27, oldestAgeSeconds: 5 * HOUR }])
  })

  it('stays silent on a BUSY agent with a fresh queue -- that is normal, not a fault', () => {
    // Twenty messages a minute old is an agent mid-turn. Alerting here would train everyone to
    // ignore the alert, which is the failure mode that matters most for a signal like this.
    expect(backlogAlerts([row('qa', 20, 60)], new Map(), 0)).toEqual([])
  })

  it('a single OLD message is worth reporting even though the count is one', () => {
    const out = backlogAlerts([row('fron-ted', 1, 4 * HOUR)], new Map(), 0)
    expect(out.map((a) => a.agent)).toEqual(['fron-ted'])
  })

  it('the boundary is inclusive at the threshold and silent one second below it', () => {
    expect(backlogAlerts([row('a', 1, BACKLOG_AGE_ALERT_SECONDS)], new Map(), 0)).toHaveLength(1)
    expect(backlogAlerts([row('a', 1, BACKLOG_AGE_ALERT_SECONDS - 1)], new Map(), 0)).toHaveLength(0)
  })
})

describe('backlogAlerts: a standing backlog is a fact, not a repeating event', () => {
  it('does not re-alert about the same agent inside the cooldown', () => {
    const rows = [row('backend', 27, 5 * HOUR)]
    const now = 10_000_000
    const seen = new Map([['backend', now - 1]])
    expect(backlogAlerts(rows, seen, now)).toEqual([])
  })

  it('alerts again once the cooldown has fully elapsed', () => {
    const rows = [row('backend', 27, 5 * HOUR)]
    const now = 10_000_000
    const seen = new Map([['backend', now - BACKLOG_ALERT_COOLDOWN_MS]])
    expect(backlogAlerts(rows, seen, now)).toHaveLength(1)
  })

  it('the cooldown is PER AGENT -- one noisy agent must not mute another', () => {
    // The bug this pins: a single shared "last alert" timestamp would hide a second agent going
    // silent while the first one's backlog stands.
    const now = 10_000_000
    const seen = new Map([['backend', now - 1]])
    const out = backlogAlerts([row('backend', 27, 5 * HOUR), row('qa', 3, 2 * HOUR)], seen, now)
    expect(out.map((a) => a.agent)).toEqual(['qa'])
  })
})

describe('the alert text', () => {
  const text = formatBacklogAlert({ agent: 'backend', pending: 27, oldestAgeSeconds: 5 * HOUR })

  it('carries the numbers a reader needs to act', () => {
    expect(text).toContain('backend')
    expect(text).toContain('27')
    expect(text).toContain('300') // minutes, rounded
  })

  it('says what to CHECK, not just that something is wrong', () => {
    // A busy agent and a wedged one look identical from the queue, so the alert has to hand the
    // reader the one observation that separates them instead of implying a fault.
    expect(text).toContain('panelt')
  })

  it('is built only from numbers and the agent id -- no message content is quoted', () => {
    // The backlog holds other agents' message bodies. An alert that quoted them would put arbitrary
    // agent-controlled text into the main agent's trusted framing.
    expect(text).not.toMatch(/content|uzenet-szoveg|"/)
  })
})
