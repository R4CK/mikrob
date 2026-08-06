// Weekly stop-threshold tests (cards f3248478 -> d53c1e00 -> d08b98f4).
//
// The panel's two sliders decide when the fleet stops opening work and when it stops verifying it,
// so the failure modes worth pinning are: a value that silently disables a control, a pair that
// inverts the policy, and a config file that breaks the bash gate rather than falling back.
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import {
  readThresholdConfig,
  writeThresholdConfig,
  DEFAULT_THRESHOLDS,
  WeeklyThresholdError,
} from '../costops/weekly-threshold.js'

let dir: string
const p = () => join(dir, 'weekly-threshold-config.json')
const NOW = 1785487195

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'weekly-threshold-'))
})
afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

describe('writeThresholdConfig / readThresholdConfig', () => {
  it('records the two levels and reads them back', () => {
    const w = writeThresholdConfig({ newDevStop: 80, testStop: 95 }, NOW, p())
    expect(w).toEqual({ newDevStop: 80, testStop: 95, updatedAt: NOW })
    expect(readThresholdConfig(p())).toEqual(w)
  })

  it('an absent file reads as the defaults (the bash gate must never break on a missing config)', () => {
    expect(readThresholdConfig(p())).toEqual({ ...DEFAULT_THRESHOLDS, updatedAt: null })
  })

  it('a malformed file reads as the defaults, never as a throw', () => {
    writeFileSync(p(), '{not json')
    expect(readThresholdConfig(p())).toEqual({ ...DEFAULT_THRESHOLDS, updatedAt: null })
  })

  it('rejects out-of-range and non-integer values with a descriptive error (rule 12)', () => {
    for (const bad of [0, 101, 4.5, 'ninety', null, undefined]) {
      expect(() => writeThresholdConfig({ newDevStop: bad, testStop: 97 }, NOW, p())).toThrow(
        WeeklyThresholdError,
      )
      expect(() => writeThresholdConfig({ newDevStop: 90, testStop: bad }, NOW, p())).toThrow(
        WeeklyThresholdError,
      )
    }
  })

  it('REJECTS an inverted pair -- stopping the gates before new work is the dangerous order', () => {
    // Card d53c1e00's class, in the two-slider shape: each value is valid alone, together they mean
    // "keep opening work you can no longer verify".
    expect(() => writeThresholdConfig({ newDevStop: 97, testStop: 90 }, NOW, p())).toThrow(
      /nem lehet nagyobb/,
    )
  })

  it('allows the two levels to be EQUAL (stop everything at the same point is a real choice)', () => {
    expect(writeThresholdConfig({ newDevStop: 95, testStop: 95 }, NOW, p()).testStop).toBe(95)
  })

  it('a hand-edited inverted file falls back to the defaults instead of serving it', () => {
    writeFileSync(p(), JSON.stringify({ newDevStop: 99, testStop: 10, updatedAt: NOW }))
    expect(readThresholdConfig(p())).toEqual({ ...DEFAULT_THRESHOLDS, updatedAt: null })
  })

  it('clamps a hand-edited out-of-range value into 1..100 on READ (never disables the gate)', () => {
    writeFileSync(p(), JSON.stringify({ newDevStop: -5, testStop: 500, updatedAt: NOW }))
    const c = readThresholdConfig(p())
    expect(c.newDevStop).toBe(1)
    expect(c.testStop).toBe(100)
  })
})

describe('migration from the three day-dependent thresholds (card d08b98f4)', () => {
  it('adopts gt3days as newDevStop -- that value WAS the "stop new development" level', () => {
    writeFileSync(p(), JSON.stringify({ gt3days: 65, lt2days: 75, lt1day: 90, updatedAt: NOW }))
    const c = readThresholdConfig(p())
    expect(c.newDevStop).toBe(65)
  })

  it('does NOT invent a testStop from lt1day -- the old shape never expressed "stop the gates"', () => {
    // lt1day was "how hard to burn when the reset is near", a different question entirely. Deriving
    // testStop from it would silently enact a policy the operator never chose.
    writeFileSync(p(), JSON.stringify({ gt3days: 65, lt2days: 75, lt1day: 90, updatedAt: NOW }))
    expect(readThresholdConfig(p()).testStop).toBe(DEFAULT_THRESHOLDS.testStop)
  })

  it('a new-shape file is not affected by the legacy path', () => {
    writeFileSync(p(), JSON.stringify({ newDevStop: 88, testStop: 93, gt3days: 1, updatedAt: NOW }))
    const c = readThresholdConfig(p())
    expect(c).toEqual({ newDevStop: 88, testStop: 93, updatedAt: NOW })
  })

  it('writing the new shape leaves no legacy keys behind', () => {
    writeThresholdConfig({ newDevStop: 90, testStop: 97 }, NOW, p())
    const raw = JSON.parse(readFileSync(p(), 'utf-8')) as Record<string, unknown>
    expect(Object.keys(raw).sort()).toEqual(['newDevStop', 'testStop', 'updatedAt'])
  })
})
