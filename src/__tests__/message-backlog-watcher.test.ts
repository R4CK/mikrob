// The message-backlog watcher (card 1e7ba5c1, round 2 after CYBERED NO-GO).
//
// WHAT IT IS FOR, corrected. Round 1 claimed nothing watched the backlog. That was wrong and Cybered
// measured it: message-router.ts emits `[session-stuck]` into the same inbox, 174 times in 7 days,
// carrying pane state this file cannot see. The gap that IS real: the router's `agentStuckSince` map
// lives in memory, so a dashboard restart zeroes it while the messages' `created_at` survives -- a
// backlog older than the restart can fall out of `[session-stuck]` entirely. So this watcher is a
// supplement that speaks only where the router has been silent.
//
// The policy is a pure function and the tick takes injected deps, so everything below runs offline.
import { describe, it, expect, beforeEach } from 'vitest'
import {
  backlogAlerts,
  formatBacklogAlert,
  agentsAlreadyAlerted,
  sweepMessageBacklog,
  resetBacklogCooldownsForTest,
  BACKLOG_AGE_ALERT_SECONDS,
  BACKLOG_ALERT_COOLDOWN_MS,
  type BacklogSweepDeps,
} from '../web/message-backlog-watcher.js'
import { formatStuckSessionAlert } from '../web/message-router.js'

const HOUR = 3600
const row = (agent: string, pending: number, oldestAgeSeconds: number) => ({ agent, pending, oldestAgeSeconds })
const base = { nowMs: 0, lastAlertAt: new Map<string, number>(), mainAgentId: 'mikrob' }

describe('backlogAlerts: age decides, not count', () => {
  it('reports an agent whose oldest message is past the threshold', () => {
    const out = backlogAlerts([row('backend', 27, 5 * HOUR)], base)
    expect(out.map((a) => a.agent)).toEqual(['backend'])
    expect(out[0]!.pending).toBe(27)
  })

  it('stays silent on a BUSY agent with a fresh queue -- that is normal, not a fault', () => {
    // Twenty messages a minute old is an agent mid-turn. Alerting here would train everyone to
    // ignore the alert, which is the failure mode that matters most for a signal like this.
    expect(backlogAlerts([row('qa', 20, 60)], base)).toEqual([])
  })

  it('a single OLD message is worth reporting even though the count is one', () => {
    expect(backlogAlerts([row('fron-ted', 1, 4 * HOUR)], base).map((a) => a.agent)).toEqual(['fron-ted'])
  })

  it('the boundary is inclusive at the threshold and silent one second below it', () => {
    expect(backlogAlerts([row('a', 1, BACKLOG_AGE_ALERT_SECONDS)], base)).toHaveLength(1)
    expect(backlogAlerts([row('a', 1, BACKLOG_AGE_ALERT_SECONDS - 1)], base)).toHaveLength(0)
  })
})

describe('backlogAlerts: the main agent is never reported (Cybered F2, BLOCKER)', () => {
  it('refuses to alert the main agent about the main agent', () => {
    // The notice is DELIVERED to the main agent, so this would land in the very queue it describes
    // and the watcher would start measuring its own output. Replayed over 7 real days: 11 of 57
    // alerts were this, and by the eighth hourly repeat 7 of the 11 pending rows would have been
    // self-generated -- a monitor mostly measuring itself.
    expect(backlogAlerts([row('mikrob', 4, 8 * HOUR)], base)).toEqual([])
  })

  it('still reports everyone else in the same sweep', () => {
    const out = backlogAlerts([row('mikrob', 4, 8 * HOUR), row('backend', 27, 5 * HOUR)], base)
    expect(out.map((a) => a.agent)).toEqual(['backend'])
  })
})

describe('backlogAlerts: defers to the router\'s [session-stuck] (Cybered F1)', () => {
  it('says nothing about an agent the router already alerted on', () => {
    const out = backlogAlerts([row('backend', 27, 5 * HOUR)], {
      ...base, alreadyAlerted: new Set(['backend']),
    })
    expect(out).toEqual([])
  })

  it('speaks for an agent the router has been silent about -- the restart-spanning case', () => {
    const out = backlogAlerts([row('backend', 27, 5 * HOUR)], {
      ...base, alreadyAlerted: new Set(['fron-ted']),
    })
    expect(out.map((a) => a.agent)).toEqual(['backend'])
  })

  it('extracts the agent from the ROUTER\'S OWN alert text, not a re-typed copy', () => {
    // The dedup is coupled to formatStuckSessionAlert's wording. Feeding it the real formatter means
    // a reworded alert fails HERE, instead of silently disabling the dedup and doubling the traffic.
    const busy = formatStuckSessionAlert('backend', 'mikrob', 'agent-backend', 30 * 60_000, 22, 'busy')
    const notReady = formatStuckSessionAlert('qa', 'mikrob', 'agent-qa', 12 * 60_000, 3, null)
    expect(busy).not.toBeNull()
    expect(notReady).not.toBeNull()
    expect(agentsAlreadyAlerted([busy!, notReady!])).toEqual(new Set(['backend', 'qa']))
  })

  it('ignores unrelated system chatter', () => {
    expect(agentsAlreadyAlerted(['[handoff-failure] something else', ''])).toEqual(new Set())
  })
})

describe('backlogAlerts: the cooldown is a rate limit, per agent', () => {
  it('does not re-alert about the same agent inside the cooldown', () => {
    const now = 10_000_000
    const seen = new Map([['backend', now - 1]])
    expect(backlogAlerts([row('backend', 27, 5 * HOUR)], { ...base, nowMs: now, lastAlertAt: seen })).toEqual([])
  })

  it('alerts again once the cooldown has fully elapsed -- deliberately, the backlog is still real', () => {
    const now = 10_000_000
    const seen = new Map([['backend', now - BACKLOG_ALERT_COOLDOWN_MS]])
    expect(backlogAlerts([row('backend', 27, 5 * HOUR)], { ...base, nowMs: now, lastAlertAt: seen })).toHaveLength(1)
  })

  it('one noisy agent must not mute another', () => {
    const now = 10_000_000
    const seen = new Map([['backend', now - 1]])
    const out = backlogAlerts([row('backend', 27, 5 * HOUR), row('qa', 3, 2 * HOUR)], {
      ...base, nowMs: now, lastAlertAt: seen,
    })
    expect(out.map((a) => a.agent)).toEqual(['qa'])
  })
})

describe('the alert text', () => {
  const live = formatBacklogAlert({ agent: 'backend', pending: 27, oldestAgeSeconds: 5 * HOUR, sessionAlive: true })
  const parked = formatBacklogAlert({ agent: 'fron-ted', pending: 9, oldestAgeSeconds: 3 * HOUR, sessionAlive: false })

  it('carries the numbers a reader needs to act', () => {
    expect(live).toContain('backend')
    expect(live).toContain('27')
    expect(live).toContain('300') // minutes, rounded
  })

  it('sends the reader to the pane only when there IS one (Cybered F4)', () => {
    expect(live).toContain('panelt')
    // A parked agent has no pane; advice to check one is a wasted trip that makes the alert read as
    // wrong. 9 of 57 replayed alerts landed on a parked fron-ted.
    expect(parked).not.toContain('nezd meg a panelt')
    expect(parked).toContain('PARKOLT')
  })

  it('is built only from numbers and the agent id -- no message content is quoted', () => {
    // The backlog holds other agents' message bodies. Quoting them would put arbitrary
    // agent-controlled text into the main agent's trusted framing.
    expect(live).not.toMatch(/content|uzenet-szoveg|"/)
  })
})

// ---- the tick itself (Cybered F5: round 1 left all of this unpinned) --------

function deps(over: Partial<BacklogSweepDeps> = {}): BacklogSweepDeps & { events: string[]; sentTo: string[] } {
  const events: string[] = []
  const sentTo: string[] = []
  const d = {
    events,
    sentTo,
    now: () => 1_000_000_000,
    listBacklog: () => [row('backend', 27, 5 * HOUR)],
    recentStuckAlerts: () => [] as string[],
    isSessionAlive: () => true,
    send: (to: string) => { events.push('send'); sentTo.push(to) },
    warn: (_o: Record<string, unknown>, m: string) => { events.push(m.startsWith('message-backlog watch: an agent') ? 'warn:holding' : 'warn:other') },
    mainAgentId: 'mikrob',
    ...over,
  }
  return d as BacklogSweepDeps & { events: string[]; sentTo: string[] }
}

describe('sweepMessageBacklog: the tick', () => {
  beforeEach(() => { resetBacklogCooldownsForTest() })

  it('logs BEFORE it sends -- the log is the half that cannot queue', () => {
    // The ordering is the whole point of the design note, and round 1 stated it only in prose.
    const d = deps()
    sweepMessageBacklog(d)
    expect(d.events).toEqual(['warn:holding', 'send'])
  })

  it('addresses the notice to the main agent', () => {
    const d = deps()
    sweepMessageBacklog(d)
    expect(d.sentTo).toEqual(['mikrob'])
  })

  it('a failed backlog read warns and yields nothing -- it never throws out of the tick', () => {
    const d = deps({ listBacklog: () => { throw new Error('db locked') } })
    expect(sweepMessageBacklog(d)).toEqual([])
    expect(d.events.some((e) => e.startsWith('warn:'))).toBe(true)
    expect(d.events).not.toContain('send')
  })

  it('a failed send does NOT start the cooldown, so the next tick retries (Cybered F3)', () => {
    // A write failing because the database is locked or full is exactly the state in which a queue
    // backs up. Burning the hour there would lose the alert AND mute the agent.
    const failing = deps({ send: () => { throw new Error('write failed') } })
    expect(sweepMessageBacklog(failing)).toEqual([])

    const ok = deps({ now: () => 1_000_000_000 + 1000 })
    const out = sweepMessageBacklog(ok)
    expect(out.map((a) => a.agent)).toEqual(['backend'])
  })

  it('a SUCCESSFUL send does start the cooldown -- the mutation the previous case would miss', () => {
    // Without this, "cooldown only on success" could be satisfied by never setting it at all.
    expect(sweepMessageBacklog(deps()).map((a) => a.agent)).toEqual(['backend'])
    expect(sweepMessageBacklog(deps({ now: () => 1_000_000_000 + 1000 }))).toEqual([])
  })

  it('never sends about the main agent, even when it holds the oldest backlog', () => {
    const d = deps({ listBacklog: () => [row('mikrob', 4, 8 * HOUR)] })
    expect(sweepMessageBacklog(d)).toEqual([])
    expect(d.events).not.toContain('send')
  })

  it('defers to a real [session-stuck] the router emitted', () => {
    const alert = formatStuckSessionAlert('backend', 'mikrob', 'agent-backend', 30 * 60_000, 27, 'busy')
    const d = deps({ recentStuckAlerts: () => [alert!] })
    expect(sweepMessageBacklog(d)).toEqual([])
    expect(d.events).not.toContain('send')
  })

  it('a failed dedup read fails OPEN -- one duplicate beats silencing the gap this exists for', () => {
    const d = deps({ recentStuckAlerts: () => { throw new Error('db locked') } })
    expect(sweepMessageBacklog(d).map((a) => a.agent)).toEqual(['backend'])
    expect(d.events).toContain('send')
  })

  it('carries the parked/live distinction through to the text', () => {
    const d = deps({ isSessionAlive: () => false })
    const out = sweepMessageBacklog(d)
    expect(out[0]!.sessionAlive).toBe(false)
  })
})
