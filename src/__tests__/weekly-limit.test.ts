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
      resetBoundarySetAt: NOW,
      note: 'Peti screenshot',
      session: null,
      fable: null,
      promo: null,
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
      resetBoundarySetAt: null,
      note: null,
      session: null,
      fable: null,
      promo: null,
    })
    writeFileSync(p(), JSON.stringify({ pct: 42, setAt: NOW, source: 'weird' }))
    expect(readWeeklySnapshot(p())?.source).toBe('manual')
  })
})

// card a91c6039: enriched /usage snapshot -- session/fable/promo captured from the dedicated
// Max-authed panel (source='panel'), all additive + backward-compatible with old snapshots.
describe('enriched /usage snapshot (session / fable / promo)', () => {
  it('round-trips all enriched metrics from a panel auto-read', () => {
    const w = writeWeeklySnapshot(
      {
        pct: 87,
        resetAt: 'Fri 11:00 AM',
        source: 'panel',
        session: { pct: 45, resetAt: 'Thu 3:59 PM' },
        fable: { pct: 20, resetAt: 'Fri 11:00 AM' },
        promo: '+50% weekly limit through Aug 19',
      },
      NOW,
      p(),
    )
    expect(w).toEqual({
      pct: 87,
      setAt: NOW,
      source: 'panel',
      resetAt: 'Fri 11:00 AM',
      resetBoundarySetAt: NOW,
      note: null,
      session: { pct: 45, resetAt: 'Thu 3:59 PM' },
      fable: { pct: 20, resetAt: 'Fri 11:00 AM' },
      promo: '+50% weekly limit through Aug 19',
    })
    expect(readWeeklySnapshot(p())).toEqual(w)
  })

  it('is backward-compatible: an old snapshot (no enriched fields) reads them as null', () => {
    writeFileSync(p(), JSON.stringify({ pct: 60, setAt: NOW, source: 'manual', resetAt: 'Thu 3:59 PM' }))
    const r = readWeeklySnapshot(p())
    expect(r?.pct).toBe(60)
    expect(r?.session).toBeNull()
    expect(r?.fable).toBeNull()
    expect(r?.promo).toBeNull()
  })

  it('omits enriched metrics that are not provided', () => {
    const w = writeWeeklySnapshot({ pct: 87, source: 'panel', session: { pct: 45 } }, NOW, p())
    expect(w.session).toEqual({ pct: 45, resetAt: null })
    expect(w.fable).toBeNull()
    expect(w.promo).toBeNull()
  })

  it('rejects a present-but-invalid enriched metric fail-closed (never stores garbage)', () => {
    expect(() => writeWeeklySnapshot({ pct: 87, session: { pct: 130 } }, NOW, p())).toThrow(/session/)
    expect(() => writeWeeklySnapshot({ pct: 87, fable: { pct: 'x' } }, NOW, p())).toThrow(/fable/)
    expect(() => writeWeeklySnapshot({ pct: 87, session: 'nope' }, NOW, p())).toThrow(WeeklyLimitError)
  })

  it('reads a stored panel source through; clamps an out-of-range enriched metric on read', () => {
    writeFileSync(
      p(),
      JSON.stringify({ pct: 50, setAt: NOW, source: 'panel', session: { pct: 250 }, fable: { pct: -5 } }),
    )
    const r = readWeeklySnapshot(p())
    expect(r?.source).toBe('panel')
    expect(r?.session?.pct).toBe(100) // clamped
    expect(r?.fable?.pct).toBe(0) // clamped
  })

  it('ignores a malformed enriched metric on read (fail-safe -> null, never crashes)', () => {
    writeFileSync(p(), JSON.stringify({ pct: 50, setAt: NOW, source: 'panel', session: { pct: 'x' }, fable: 'nope' }))
    const r = readWeeklySnapshot(p())
    expect(r?.session).toBeNull()
    expect(r?.fable).toBeNull()
  })
})

// card 87b2fef9: resetBoundarySetAt tracks WHEN the current resetAt label took effect, so the
// local-LLM "tokens saved" widget can sum only since the actual weekly reset instead of an
// all-time total or an independent rolling window. The label is free text off the /usage screen
// ('Thu 3:59 PM', 'Aug 20, 4pm (...)') with no single reliable format to parse into an absolute
// time, so the boundary is derived from a LABEL CHANGE (an event we can detect exactly), not from
// parsing the label's own text.
describe('resetBoundarySetAt (weekly-reset boundary for the tokens-saved widget)', () => {
  const LATER = NOW + 3600

  it('the first-ever snapshot with a resetAt stamps the boundary at its own setAt', () => {
    const w = writeWeeklySnapshot({ pct: 50, resetAt: 'Thu 3:59 PM' }, NOW, p())
    expect(w.resetBoundarySetAt).toBe(NOW)
  })

  it('re-confirming the SAME resetAt label carries the original boundary forward, unchanged', () => {
    writeWeeklySnapshot({ pct: 50, resetAt: 'Thu 3:59 PM' }, NOW, p())
    const w2 = writeWeeklySnapshot({ pct: 55, resetAt: 'Thu 3:59 PM' }, LATER, p())
    expect(w2.resetBoundarySetAt).toBe(NOW)
  })

  it('a DIFFERENT resetAt label (the actual weekly reset happening) stamps a fresh boundary', () => {
    writeWeeklySnapshot({ pct: 99, resetAt: 'Thu 3:59 PM' }, NOW, p())
    const w2 = writeWeeklySnapshot({ pct: 2, resetAt: 'Fri 11:00 AM' }, LATER, p())
    expect(w2.resetBoundarySetAt).toBe(LATER)
  })

  it('a write with no resetAt at all carries the previous boundary forward untouched', () => {
    writeWeeklySnapshot({ pct: 50, resetAt: 'Thu 3:59 PM' }, NOW, p())
    const w2 = writeWeeklySnapshot({ pct: 55 }, LATER, p())
    expect(w2.resetAt).toBeNull()
    expect(w2.resetBoundarySetAt).toBe(NOW)
  })

  it('no resetAt ever recorded -> boundary stays null (caller falls back to its own default)', () => {
    const w = writeWeeklySnapshot({ pct: 50 }, NOW, p())
    expect(w.resetAt).toBeNull()
    expect(w.resetBoundarySetAt).toBeNull()
  })

  it('reads an old snapshot with no resetBoundarySetAt field as null (backward-compatible)', () => {
    writeFileSync(p(), JSON.stringify({ pct: 60, setAt: NOW, source: 'manual', resetAt: 'Thu 3:59 PM' }))
    expect(readWeeklySnapshot(p())?.resetBoundarySetAt).toBeNull()
  })
})
