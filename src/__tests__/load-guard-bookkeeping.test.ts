// load-guard-bookkeeping.sh: bookkeeping + integration + alerting for the load-guard throttle
// mechanisms (card 1128002b, Feladat 4 of the load-brake phase 19f3bbb5). --test-compute exercises
// the pure JSON-in/JSON-out diff/decision logic directly (mirrors load-guard-sigstop-target.sh's
// --test-select) -- real kanban/Telegram IO is a thin wrapper around it, not tested here (same
// role split as load-guard-cgroup-target.sh's real-source vs. tested-decision layers).
import { describe, expect, it } from 'vitest'
import { execFileSync } from 'node:child_process'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'store', 'load-guard-bookkeeping.sh')

function compute(
  cgroup: { throttled: string | null },
  sigstop: { frozen: string | null },
  prevPaused: Record<string, { mechanism: string; since: number; card_id: string | null; last_seen?: number }>,
  prevEvents: Record<string, number[]>,
  now: number,
  threshold = 2,
  window = 3600,
): {
  paused: Record<string, { mechanism: string; since: number; card_id: string | null; last_seen: number }>
  events: Record<string, number[]>
  starts: string[]
  ends: Array<{ agent: string; card_id: string | null }>
  alert_agents: string[]
} {
  const out = execFileSync('bash', [
    SCRIPT,
    '--test-compute',
    JSON.stringify(cgroup),
    JSON.stringify(sigstop),
    JSON.stringify(prevPaused),
    JSON.stringify(prevEvents),
    String(now),
    String(threshold),
    String(window),
  ]).toString()
  return JSON.parse(out)
}

describe('load-guard-bookkeeping --test-compute: pause-start transitions', () => {
  it('a fresh throttle/freeze with nothing previously paused is a new start', () => {
    const r = compute({ throttled: null }, { frozen: 'fullstack' }, {}, {}, 1000)
    expect(r.starts).toEqual(['fullstack'])
    expect(r.ends).toEqual([])
    expect(r.paused.fullstack.mechanism).toBe('sigstop_freeze')
    expect(r.paused.fullstack.card_id).toBeNull() // filled in by the real wrapper, not compute
    expect(r.events.fullstack).toEqual([1000])
    expect(r.paused.fullstack.last_seen).toBe(1000) // Cybersec/QA fce0df4e: staleness signal
  })

  it('cgroup_throttle alone is also a start, tagged with its own mechanism name', () => {
    const r = compute({ throttled: 'jogasz' }, { frozen: null }, {}, {}, 1000)
    expect(r.starts).toEqual(['jogasz'])
    expect(r.paused.jogasz.mechanism).toBe('cgroup_throttle')
  })

  it('both mechanisms hitting the SAME agent tags it with both, still one start', () => {
    const r = compute({ throttled: 'fullstack' }, { frozen: 'fullstack' }, {}, {}, 1000)
    expect(r.starts).toEqual(['fullstack'])
    expect(r.paused.fullstack.mechanism).toBe('cgroup_throttle+sigstop_freeze')
  })
})

describe('load-guard-bookkeeping --test-compute: continuation is NOT a re-start', () => {
  it('an agent already in prev_paused stays continuing, not a new start', () => {
    const prev = { fullstack: { mechanism: 'sigstop_freeze', since: 1000, card_id: 'C1' } }
    const r = compute({ throttled: null }, { frozen: 'fullstack' }, prev, { fullstack: [1000] }, 1010)
    expect(r.starts).toEqual([])
    expect(r.ends).toEqual([])
    expect(r.paused.fullstack.since).toBe(1000) // ORIGINAL since preserved, not bumped to 1010
    expect(r.paused.fullstack.card_id).toBe('C1') // preserved, not re-queried
    expect(r.paused.fullstack.last_seen).toBe(1010) // unlike since, last_seen DOES move every tick
  })

  it('a mechanism hand-off mid-pause (cgroup -> sigstop) is still a continuation, not a re-start', () => {
    const prev = { fullstack: { mechanism: 'cgroup_throttle', since: 900, card_id: 'C1' } }
    const r = compute({ throttled: null }, { frozen: 'fullstack' }, prev, { fullstack: [900] }, 1000)
    expect(r.starts).toEqual([])
    expect(r.paused.fullstack.mechanism).toBe('sigstop_freeze') // mechanism DOES update
    expect(r.paused.fullstack.since).toBe(900) // since does NOT reset on hand-off
    expect(r.paused.fullstack.last_seen).toBe(1000) // last_seen refreshes even across a hand-off
  })

  it('a bookkeeping gap (many ticks missed) still refreshes last_seen the moment it runs again', () => {
    // The whole point of last_seen: it reflects THIS tick, not a running average or a missed-tick
    // count. Simulates bookkeeping resuming long after prev_paused was last written.
    const prev = { fullstack: { mechanism: 'sigstop_freeze', since: 1000, card_id: 'C1', last_seen: 1010 } }
    const r = compute({ throttled: null }, { frozen: 'fullstack' }, prev, { fullstack: [1000] }, 5000)
    expect(r.paused.fullstack.since).toBe(1000)
    expect(r.paused.fullstack.last_seen).toBe(5000)
  })
})

describe('load-guard-bookkeeping --test-compute: resume (pause-end)', () => {
  it('an agent no longer in either state is a resume, carrying its stored card_id', () => {
    const prev = { fullstack: { mechanism: 'sigstop_freeze', since: 1000, card_id: 'C1' } }
    const r = compute({ throttled: null }, { frozen: null }, prev, { fullstack: [1000] }, 1020)
    expect(r.ends).toEqual([{ agent: 'fullstack', card_id: 'C1' }])
    expect(r.paused).toEqual({})
  })

  it('a resume with no card_id on record still ends cleanly (null, not a crash)', () => {
    const prev = { fullstack: { mechanism: 'sigstop_freeze', since: 1000, card_id: null } }
    const r = compute({ throttled: null }, { frozen: null }, prev, {}, 1020)
    expect(r.ends).toEqual([{ agent: 'fullstack', card_id: null }])
  })
})

describe('load-guard-bookkeeping --test-compute: the rolling pause-event window', () => {
  it('an event older than the window ages out before counting toward the threshold', () => {
    const r = compute({ throttled: null }, { frozen: 'fullstack' }, {}, { fullstack: [100] }, 5000, 2, 3600)
    expect(r.events.fullstack).toEqual([5000]) // the stale 100 is pruned, only this tick's own start remains
    expect(r.alert_agents).toEqual([])
  })

  it('two pause-starts within the window for the same agent crosses the repeat threshold', () => {
    const r = compute({ throttled: null }, { frozen: 'fullstack' }, {}, { fullstack: [900] }, 1000, 2, 3600)
    expect(r.events.fullstack).toEqual([900, 1000])
    expect(r.alert_agents).toEqual(['fullstack'])
  })

  it('a single pause-start does not cross a threshold of 2', () => {
    const r = compute({ throttled: null }, { frozen: 'fullstack' }, {}, {}, 1000, 2, 3600)
    expect(r.alert_agents).toEqual([])
  })

  it('a custom (lower) threshold fires on the first start alone', () => {
    const r = compute({ throttled: null }, { frozen: 'fullstack' }, {}, {}, 1000, 1, 3600)
    expect(r.alert_agents).toEqual(['fullstack'])
  })

  it('only the agent that actually crossed the threshold is in alert_agents, not every paused agent', () => {
    const r = compute({ throttled: 'jogasz' }, { frozen: 'fullstack' }, {}, { fullstack: [900] }, 1000, 2, 3600)
    expect(r.starts.sort()).toEqual(['fullstack', 'jogasz'])
    expect(r.alert_agents).toEqual(['fullstack'])
  })
})

describe('load-guard-bookkeeping --test-compute: no-op / malformed-input safety', () => {
  it('nothing throttled or frozen, nothing previously paused -> everything empty, no crash', () => {
    const r = compute({ throttled: null }, { frozen: null }, {}, {}, 1000)
    expect(r).toEqual({ paused: {}, events: {}, starts: [], ends: [], alert_agents: [] })
  })

  it('a state file that failed to parse falls back to empty, never crashes the tick', () => {
    const out = execFileSync('bash', [
      SCRIPT, '--test-compute', 'not-json', '', '', '', '1000', '2', '3600',
    ]).toString()
    expect(JSON.parse(out)).toEqual({ paused: {}, events: {}, starts: [], ends: [], alert_agents: [] })
  })
})
