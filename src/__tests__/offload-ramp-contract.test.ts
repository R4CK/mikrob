// GET /api/local-llm/offload-config ramp contract (card e93a1dff): the read endpoint must expose the
// auto-ramp state SHAPED for fron-ted's 8b4ddcf0 panel -- {active, weeklyPercent, newDevStop, current,
// target, reason} | null -- mapped from 346d3933's raw internals WITHOUT changing ramp behaviour. These
// pin the mapping: source drives `active`/`reason`, `current` is distinct from `target`, and a missing
// weekly reading yields null.
import { describe, it, expect } from 'vitest'
import { mapRampState } from '../web/routes/local-llm.js'

// The raw offloadRampState() shape. floor is the production RAMP_FLOOR_AGGRESSIVENESS (75).
const raw = (weeklyPct: number | null, autoAggressiveness: number | null, newDevStop = 65) => ({
  weeklyPct,
  newDevStop,
  floor: 75,
  autoAggressiveness,
  autoDifficulty: null,
})

describe('mapRampState -- offload-config ramp contract (card e93a1dff)', () => {
  it('returns null when there is no live weekly reading', () => {
    expect(mapRampState(raw(null, null), 'auto', 75)).toBeNull()
    expect(mapRampState(raw(50, null), 'auto', 75)).toBeNull() // no auto value either
  })

  it('under MANUAL control the ramp is present but not active, with the manual reason key', () => {
    const c = mapRampState(raw(80, 100), 'manual', 90)
    expect(c).not.toBeNull()
    expect(c!.active).toBe(false) // manual override is not "actively ramping"
    expect(c!.reason).toBe('localLlm.offload.ramp.reason.manual')
    expect(c!.current).toBe(90) // the operator's value, distinct from the auto target
    expect(c!.target).toBe(100)
    expect(c!.weeklyPercent).toBe(80)
  })

  it('under AUTO below the threshold with an elevated target: active + ramping reason', () => {
    const c = mapRampState(raw(40, 90, 65), 'auto', 90) // 40% < 65% threshold, target 90 > floor 75
    expect(c!.active).toBe(true)
    expect(c!.reason).toBe('localLlm.offload.ramp.reason.ramping')
    expect(c!.target).toBe(90)
  })

  it('under AUTO at/above the threshold: pinned at 100, atThreshold reason', () => {
    const c = mapRampState(raw(70, 100, 65), 'auto', 100) // 70% >= 65%
    expect(c!.active).toBe(true)
    expect(c!.reason).toBe('localLlm.offload.ramp.reason.atThreshold')
    expect(c!.target).toBe(100)
  })

  it('under AUTO at the floor (weekly not yet raising it): not active, floor reason', () => {
    const c = mapRampState(raw(0, 75, 65), 'auto', 75) // target == floor
    expect(c!.active).toBe(false)
    expect(c!.reason).toBe('localLlm.offload.ramp.reason.floor')
  })

  it('current is carried through independently of target (a stepped operator value shows both)', () => {
    const c = mapRampState(raw(50, 88, 65), 'auto', 80)
    expect(c!.current).toBe(80) // what is in effect now
    expect(c!.target).toBe(88) // where the ramp would put it
    expect(c!.current).not.toBe(c!.target)
  })
})
