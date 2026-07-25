// Weekly-limit manual-snapshot tests (card 8388642a / FÁZIS2, part 3). Proves the MANUAL
// snapshot round-trips, validates the % fail-closed with a descriptive message (rule 12),
// and reads fail-safe (null on absent/malformed -> the gauge shows the needs-input state,
// never a fake number). No programmatic auto-read (weekly-usage-autoread-unavailable).
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import {
  readWeeklySnapshot,
  writeWeeklySnapshot,
  WeeklyLimitError,
} from '../costops/weekly-limit.js'

let dir: string
const p = () => join(dir, 'weekly-limit-snapshot.json')
const NOW = 1784913893

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'weekly-limit-'))
})
afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

describe('writeWeeklySnapshot / readWeeklySnapshot', () => {
  it('records a manual snapshot and reads it back', () => {
    const w = writeWeeklySnapshot({ pct: 87, resetAt: 'Thu 3:59 PM', note: 'Peti screenshot' }, NOW, p())
    expect(w).toEqual({
      pct: 87,
      setAt: NOW,
      source: 'manual',
      resetAt: 'Thu 3:59 PM',
      note: 'Peti screenshot',
    })
    expect(readWeeklySnapshot(p())).toEqual(w)
  })

  it('rejects an out-of-range % with a descriptive WeeklyLimitError (rule 12)', () => {
    expect(() => writeWeeklySnapshot({ pct: 130 }, NOW, p())).toThrow(WeeklyLimitError)
    expect(() => writeWeeklySnapshot({ pct: -1 }, NOW, p())).toThrow(/0 és 100/)
    expect(() => writeWeeklySnapshot({ pct: 'lots' }, NOW, p())).toThrow(WeeklyLimitError)
    expect(() => writeWeeklySnapshot({}, NOW, p())).toThrow(WeeklyLimitError)
  })

  it('rounds to one decimal + trims blank optional fields to null', () => {
    const w = writeWeeklySnapshot({ pct: 91.267, resetAt: '  ', note: '' }, NOW, p())
    expect(w.pct).toBe(91.3)
    expect(w.resetAt).toBeNull()
    expect(w.note).toBeNull()
  })

  it('reads null when never recorded (gauge -> needs-input state, not a fake number)', () => {
    expect(readWeeklySnapshot(p())).toBeNull()
  })

  it('reads null on malformed / non-numeric-pct file (fail-safe, never crashes)', () => {
    writeFileSync(p(), '{ not json')
    expect(readWeeklySnapshot(p())).toBeNull()
    writeFileSync(p(), JSON.stringify({ pct: 'x' }))
    expect(readWeeklySnapshot(p())).toBeNull()
  })

  it('clamps a stored out-of-range % on read (defense in depth)', () => {
    writeFileSync(p(), JSON.stringify({ pct: 250, setAt: NOW, source: 'manual' }))
    expect(readWeeklySnapshot(p())?.pct).toBe(100)
  })

  // card c9ce4254: forward-compat for an auto-read (store/weekly-usage-probe.sh) IF the
  // OAuth token is ever re-scoped. The reader must pass an 'oauth' source through, and
  // fall back to 'manual' for any unknown/absent value (never a fake auto-label).
  it('passes an oauth source through on read; unknown source falls back to manual', () => {
    writeFileSync(p(), JSON.stringify({ pct: 42, setAt: NOW, source: 'oauth', resetAt: 'Thu 3:59 PM' }))
    expect(readWeeklySnapshot(p())).toEqual({
      pct: 42,
      setAt: NOW,
      source: 'oauth',
      resetAt: 'Thu 3:59 PM',
      note: null,
    })
    writeFileSync(p(), JSON.stringify({ pct: 42, setAt: NOW, source: 'weird' }))
    expect(readWeeklySnapshot(p())?.source).toBe('manual')
  })
})
