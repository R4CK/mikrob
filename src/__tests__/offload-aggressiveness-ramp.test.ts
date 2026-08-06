// Auto-aggressiveness ramp (card 346d3933, Peti 2026-08-01).
//
// The three rules the gate cares about, each pinned by a test that FAILS if the rule is dropped:
//   1. monotone non-decreasing in weekly% (a higher weekly reading never lowers aggressiveness);
//   2. AT/above the threshold with no manual override -> exactly 100;
//   3. a MANUAL source is never overwritten by the ramp -- the load-bearing override rule.
import { describe, it, expect } from 'vitest'
import {
  applyAggressivenessRamp,
  rampAggressiveness,
  resolveAggressivenessSource,
  RAMP_FLOOR_AGGRESSIVENESS,
  type OffloadRampConfig,
} from '../costops/weekly-threshold.js'

const NOW = '2026-08-01T12:00:00.000Z'
const THRESHOLD = 90

describe('rampAggressiveness (rule 1: monotone curve, rule 2: 100 at the threshold)', () => {
  it('sits at the floor far from the threshold and reaches 100 at it', () => {
    expect(rampAggressiveness(0, THRESHOLD)).toBe(RAMP_FLOOR_AGGRESSIVENESS)
    expect(rampAggressiveness(THRESHOLD, THRESHOLD)).toBe(100)
  })

  it('pins to 100 AT or ABOVE the threshold', () => {
    expect(rampAggressiveness(90, 90)).toBe(100)
    expect(rampAggressiveness(95, 90)).toBe(100)
    expect(rampAggressiveness(100, 90)).toBe(100)
  })

  it('is genuinely BETWEEN floor and 100 partway up (not a step function)', () => {
    const mid = rampAggressiveness(45, 90) // halfway to a 90 threshold
    expect(mid).toBeGreaterThan(RAMP_FLOOR_AGGRESSIVENESS)
    expect(mid).toBeLessThan(100)
  })

  it('NEVER DECREASES as weekly% rises -- swept across the whole range', () => {
    let prev = -1
    for (let w = 0; w <= 100; w += 1) {
      const a = rampAggressiveness(w, THRESHOLD)
      expect(a).toBeGreaterThanOrEqual(prev)
      prev = a
    }
  })

  it('never dips below the standing proactive baseline (turning the ramp on cannot weaken offload)', () => {
    for (let w = 0; w <= 100; w += 5) {
      expect(rampAggressiveness(w, THRESHOLD)).toBeGreaterThanOrEqual(RAMP_FLOOR_AGGRESSIVENESS)
    }
  })

  it('fails SAFE to 100 on a broken threshold (cannot tell how close to the limit we are)', () => {
    expect(rampAggressiveness(50, 0)).toBe(100)
    expect(rampAggressiveness(50, -5)).toBe(100)
    expect(rampAggressiveness(50, NaN)).toBe(100)
    expect(rampAggressiveness(NaN, 90)).toBe(100)
  })
})

describe('resolveAggressivenessSource (safe legacy default)', () => {
  it('honours an explicit source', () => {
    expect(resolveAggressivenessSource({ aggressiveness_source: 'manual' })).toBe('manual')
    expect(resolveAggressivenessSource({ aggressiveness_source: 'auto' })).toBe('auto')
  })

  it('treats a legacy file that HAS a set value as manual -- do not clobber an operator value', () => {
    expect(
      resolveAggressivenessSource({ aggressiveness: 100, aggressiveness_set_at: '2026-07-31T18:00:00Z' }),
    ).toBe('manual')
  })

  it('only a pristine config (no source, no set_at) defaults to auto', () => {
    expect(resolveAggressivenessSource({})).toBe('auto')
    expect(resolveAggressivenessSource({ aggressiveness: 75 })).toBe('auto')
  })

  it('an unknown source string is treated as legacy (falls through to the set_at rule)', () => {
    expect(resolveAggressivenessSource({ aggressiveness_source: 'garbage' })).toBe('auto')
    expect(
      resolveAggressivenessSource({ aggressiveness_source: 'garbage', aggressiveness_set_at: 'x' }),
    ).toBe('manual')
  })
})

describe('applyAggressivenessRamp (rule 3: manual wins; auto follows the curve)', () => {
  it('LEAVES A MANUAL CONFIG BYTE-FOR-BYTE UNCHANGED, even at the threshold', () => {
    const cfg: OffloadRampConfig = {
      aggressiveness: 30,
      aggressiveness_source: 'manual',
      aggressiveness_set_at: '2026-07-31T18:00:00Z',
      note: 'operator set this low on purpose',
    }
    const d = applyAggressivenessRamp(cfg, 99, THRESHOLD, NOW)
    expect(d.changed).toBe(false)
    expect(d.source).toBe('manual')
    expect(d.config).toBe(cfg) // same object, not a rewritten copy
    expect(d.config.aggressiveness).toBe(30)
  })

  it('an auto config AT the threshold is driven to 100', () => {
    const d = applyAggressivenessRamp({ aggressiveness_source: 'auto' }, 90, 90, NOW)
    expect(d.changed).toBe(true)
    expect(d.config.aggressiveness).toBe(100)
    expect(d.config.aggressiveness_source).toBe('auto')
    expect(d.config.aggressiveness_set_at).toBe(NOW)
  })

  it('an auto config below the threshold follows the ramp value', () => {
    const d = applyAggressivenessRamp({ aggressiveness_source: 'auto', aggressiveness: 75 }, 45, 90, NOW)
    expect(d.next).toBe(rampAggressiveness(45, 90))
    expect(d.config.aggressiveness).toBe(d.next)
  })

  it('a pristine config is adopted as auto and ramped (activates on first run)', () => {
    const d = applyAggressivenessRamp({}, 45, 90, NOW)
    expect(d.source).toBe('auto')
    expect(d.changed).toBe(true)
    expect(d.config.aggressiveness_source).toBe('auto')
  })

  it('a legacy config with a set value is protected (manual by default -> not ramped)', () => {
    const cfg: OffloadRampConfig = { aggressiveness: 100, aggressiveness_set_at: '2026-07-30T21:15:00Z' }
    const d = applyAggressivenessRamp(cfg, 45, 90, NOW)
    expect(d.changed).toBe(false)
    expect(d.config.aggressiveness).toBe(100)
  })

  it('does NOT rewrite when the auto value is already correct (no churn / no set_at bump)', () => {
    const already = rampAggressiveness(45, 90)
    const cfg: OffloadRampConfig = {
      aggressiveness: already,
      aggressiveness_source: 'auto',
      aggressiveness_set_at: '2026-07-31T00:00:00Z',
    }
    const d = applyAggressivenessRamp(cfg, 45, 90, NOW)
    expect(d.changed).toBe(false)
    expect(d.config.aggressiveness_set_at).toBe('2026-07-31T00:00:00Z') // untouched
  })

  it('PRESERVES the rest of the directive (active/mode/note/disabledCategories) when it ramps', () => {
    const cfg: OffloadRampConfig = {
      active: true,
      mode: 'proactive',
      note: 'standing directive',
      disabledCategories: ['sql-migration'],
      aggressiveness_source: 'auto',
      aggressiveness: 75,
    }
    const d = applyAggressivenessRamp(cfg, 88, 90, NOW)
    expect(d.config.active).toBe(true)
    expect(d.config.mode).toBe('proactive')
    expect(d.config.note).toBe('standing directive')
    expect(d.config.disabledCategories).toEqual(['sql-migration'])
  })
})
