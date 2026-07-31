// Editable weekly new-dev-stop threshold tests (card f3248478). Proves the round-trip,
// the fail-closed 1..100 integer validation on write (rule 12: descriptive error, never
// a silent clamp surprise), and the fail-safe CLAUDE.md-default read on absent/malformed
// files (so the bash gate script never breaks even if the config is deleted or corrupted).
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
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
  it('records edited thresholds and reads them back', () => {
    const w = writeThresholdConfig({ gt3days: 80, lt2days: 85, lt1day: 97 }, NOW, p())
    expect(w).toEqual({ gt3days: 80, lt2days: 85, lt1day: 97, updatedAt: NOW })
    expect(readThresholdConfig(p())).toEqual(w)
  })

  it('reads the CLAUDE.md defaults when never configured, with updatedAt null', () => {
    expect(readThresholdConfig(p())).toEqual({ ...DEFAULT_THRESHOLDS, updatedAt: null })
  })

  it('rejects out-of-range or non-integer values with a descriptive WeeklyThresholdError (rule 12)', () => {
    expect(() => writeThresholdConfig({ gt3days: 0, lt2days: 92, lt1day: 95 }, NOW, p())).toThrow(WeeklyThresholdError)
    expect(() => writeThresholdConfig({ gt3days: 101, lt2days: 92, lt1day: 95 }, NOW, p())).toThrow(/gt3days/)
    expect(() => writeThresholdConfig({ gt3days: 90.5, lt2days: 92, lt1day: 95 }, NOW, p())).toThrow(WeeklyThresholdError)
    expect(() => writeThresholdConfig({ gt3days: 'x', lt2days: 92, lt1day: 95 }, NOW, p())).toThrow(WeeklyThresholdError)
    expect(() => writeThresholdConfig({}, NOW, p())).toThrow(WeeklyThresholdError)
  })

  it('reads the defaults on a malformed file (fail-safe, never crashes the gate script)', () => {
    writeFileSync(p(), '{ not json')
    expect(readThresholdConfig(p())).toEqual({ ...DEFAULT_THRESHOLDS, updatedAt: null })
  })

  it('clamps stored out-of-range values on read (defense in depth)', () => {
    // Clamped-but-still-monotonic combo, so this isolates clamping from the separate
    // monotonicity fallback covered below (-5 -> 1, 250 -> 100).
    writeFileSync(p(), JSON.stringify({ gt3days: -5, lt2days: 50, lt1day: 250, updatedAt: NOW }))
    const r = readThresholdConfig(p())
    expect(r.gt3days).toBe(1)
    expect(r.lt2days).toBe(50)
    expect(r.lt1day).toBe(100)
  })

  it('falls back to individual defaults for missing keys in a partial/legacy file', () => {
    writeFileSync(p(), JSON.stringify({ lt1day: 97, updatedAt: NOW }))
    expect(readThresholdConfig(p())).toEqual({ gt3days: 90, lt2days: 92, lt1day: 97, updatedAt: NOW })
  })
})

// Card d53c1e00 (Cybersec): each threshold passes 1..100 range validation on its own, so
// without a cross-field check a caller could save gt3days=100 + lt1day=1 -- individually
// valid, but it inverts the CLAUDE.md rule ("closer to reset -> higher threshold").
describe('monotonicity (gt3days <= lt2days <= lt1day)', () => {
  it('rejects a non-monotonic triple on write with a descriptive error', () => {
    expect(() => writeThresholdConfig({ gt3days: 100, lt2days: 92, lt1day: 1 }, NOW, p())).toThrow(
      WeeklyThresholdError,
    )
    expect(() => writeThresholdConfig({ gt3days: 96, lt2days: 92, lt1day: 95 }, NOW, p())).toThrow(
      /novekvo sorrendben/,
    )
  })

  it('accepts equal (non-strict) thresholds', () => {
    const w = writeThresholdConfig({ gt3days: 90, lt2days: 90, lt1day: 90 }, NOW, p())
    expect(w).toEqual({ gt3days: 90, lt2days: 90, lt1day: 90, updatedAt: NOW })
  })

  it('falls back to defaults on read when a hand-edited file is non-monotonic (defense in depth)', () => {
    writeFileSync(p(), JSON.stringify({ gt3days: 100, lt2days: 92, lt1day: 1, updatedAt: NOW }))
    expect(readThresholdConfig(p())).toEqual({ ...DEFAULT_THRESHOLDS, updatedAt: null })
  })
})
