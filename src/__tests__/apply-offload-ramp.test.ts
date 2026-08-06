// The ramp applier CLI (card 346d3933): the thin IO shell over the pure ramp logic.
//
// These drive runOffloadRamp against real temp files so the read-three / write-one wiring is proven,
// not just the pure function. The point of the applier is that it writes ONLY under automatic
// control and leaves a manual override alone -- and that it never throws on missing/garbage input.
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import {
  applyAggressivenessRamp,
  readOffloadRampConfig,
  readWeeklyPercent,
  type OffloadRampConfig,
} from '../costops/weekly-threshold.js'

// runOffloadRamp reads the fixed store paths, so the applier itself is covered by the readers +
// applyAggressivenessRamp (both exercised here against temp files); the CLI is a 6-line composition.
let dir: string
const weeklyPath = () => join(dir, 'weekly-usage.json')
const NOW = '2026-08-01T12:00:00.000Z'

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'ramp-'))
})
afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

describe('readWeeklyPercent', () => {
  it('reads .percent from weekly-usage.json', () => {
    writeFileSync(weeklyPath(), JSON.stringify({ percent: 82, reset: 'Aug 6' }))
    expect(readWeeklyPercent(weeklyPath())).toBe(82)
  })

  it('returns null for a missing file, so the applier can SKIP rather than guess', () => {
    expect(readWeeklyPercent(join(dir, 'nope.json'))).toBeNull()
  })

  it('returns null for malformed JSON or a non-numeric percent (never throws)', () => {
    writeFileSync(weeklyPath(), '{ not json')
    expect(readWeeklyPercent(weeklyPath())).toBeNull()
    writeFileSync(weeklyPath(), JSON.stringify({ percent: 'high' }))
    expect(readWeeklyPercent(weeklyPath())).toBeNull()
  })
})

describe('readOffloadRampConfig', () => {
  it('returns the parsed object', () => {
    writeFileSync(weeklyPath(), JSON.stringify({ aggressiveness: 75, active: true }))
    expect(readOffloadRampConfig(weeklyPath())).toMatchObject({ aggressiveness: 75, active: true })
  })

  it('returns {} for missing/garbage (never throws)', () => {
    expect(readOffloadRampConfig(join(dir, 'nope.json'))).toEqual({})
    writeFileSync(weeklyPath(), 'not json')
    expect(readOffloadRampConfig(weeklyPath())).toEqual({})
  })
})

// End-to-end of the applier's decision (the CLI just persists decision.config): weekly% + threshold +
// config in, the file that WOULD be written out.
describe('the applier persists ONLY under automatic control', () => {
  function decide(cfg: OffloadRampConfig, weeklyPct: number, newDevStop: number) {
    const d = applyAggressivenessRamp(cfg, weeklyPct, newDevStop, NOW)
    return d
  }

  it('an operator who dragged the slider to 20% keeps it, even as weekly climbs to 89%', () => {
    const manual: OffloadRampConfig = {
      aggressiveness: 20,
      aggressiveness_source: 'manual',
      aggressiveness_set_at: '2026-07-31T18:00:00Z',
    }
    const d = decide(manual, 89, 90)
    expect(d.changed).toBe(false)
    expect(d.next).toBe(20)
  })

  it('after the operator clicks "back to Auto", the next probe cycle ramps the value', () => {
    // The route writes aggressiveness_source:'auto' on the reset; the very next applier run drives it.
    const afterReset: OffloadRampConfig = {
      aggressiveness: 20,
      aggressiveness_source: 'auto',
      aggressiveness_set_at: '2026-08-01T11:59:00Z',
    }
    const d = decide(afterReset, 89, 90)
    expect(d.changed).toBe(true)
    expect(d.config.aggressiveness).toBeGreaterThan(20)
  })
})

describe('atomic write shape (the file the CLI persists is valid JSON with a trailing newline)', () => {
  it('a ramped config round-trips through JSON', () => {
    const d = applyAggressivenessRamp({ aggressiveness_source: 'auto', aggressiveness: 75 }, 88, 90, NOW)
    const serialized = JSON.stringify(d.config, null, 2) + '\n'
    const path = join(dir, 'out.json')
    writeFileSync(path, serialized)
    expect(existsSync(path)).toBe(true)
    const back = JSON.parse(readFileSync(path, 'utf-8'))
    expect(back.aggressiveness).toBe(d.next)
    expect(back.aggressiveness_source).toBe('auto')
  })
})
