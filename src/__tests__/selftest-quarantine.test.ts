// Card 1ce518d9: unit coverage for the quarantine list's own validation, active-set logic, and
// (CYBERSEC NO-GO 39413 F-2) the swallow/expire decision that the real it.each loop in
// store-selftests-all-run.test.ts delegates to runQuarantined. These tests are scoped to this
// module in isolation, each with a positive AND a negative case so a mutant that inverts a
// comparison or drops a check has something to fail on.
import { describe, it, expect, vi } from 'vitest'
import {
  parseQuarantineEntries,
  isActive,
  activeQuarantineNames,
  runQuarantined,
  AlwaysFatalSelftestError,
  type QuarantineEntry,
} from '../selftest-quarantine.js'

// Fixed trusted "now" for every parseQuarantineEntries call below, so the future-dated checks
// (CYBERSEC NO-GO 39413 F-1) are deterministic regardless of wall-clock time at test-run.
const NOW = new Date('2026-11-27T00:00:00.000Z')

const VALID: QuarantineEntry = {
  selftest: 'wsl-cleanup',
  owner: 'backend2',
  card: 'a1c38d36',
  added_at: '2026-11-26T00:00:00.000Z',
  expiry: '2026-11-30T00:00:00.000Z',
}

describe('parseQuarantineEntries', () => {
  it('accepts a well-formed entry', () => {
    expect(parseQuarantineEntries({ entries: [VALID] }, NOW)).toEqual([VALID])
  })

  it('rejects a payload with no entries array', () => {
    expect(() => parseQuarantineEntries({}, NOW)).toThrow(/entries/)
    expect(() => parseQuarantineEntries({ entries: 'nope' }, NOW)).toThrow(/entries/)
  })

  it('accepts an empty list (the default, safe shape)', () => {
    expect(parseQuarantineEntries({ entries: [] }, NOW)).toEqual([])
  })

  for (const field of ['selftest', 'owner', 'card', 'added_at', 'expiry'] as const) {
    it(`rejects an entry missing "${field}"`, () => {
      const { [field]: _omit, ...rest } = VALID
      expect(() => parseQuarantineEntries({ entries: [rest] }, NOW)).toThrow(new RegExp(field))
    })

    it(`rejects an entry with "${field}" as an empty string`, () => {
      expect(() => parseQuarantineEntries({ entries: [{ ...VALID, [field]: '' }] }, NOW)).toThrow(new RegExp(field))
    })
  }

  it('rejects a 4th entry', () => {
    const three = [0, 1, 2].map((i) => ({ ...VALID, selftest: `s${i}` }))
    expect(parseQuarantineEntries({ entries: three }, NOW)).toHaveLength(3)
    const four = [0, 1, 2, 3].map((i) => ({ ...VALID, selftest: `s${i}` }))
    expect(() => parseQuarantineEntries({ entries: four }, NOW)).toThrow(/max is 3/)
  })

  it('rejects an expiry more than 7 days after added_at', () => {
    expect(() =>
      parseQuarantineEntries(
        { entries: [{ ...VALID, added_at: '2026-11-26T00:00:00.000Z', expiry: '2026-12-04T00:00:00.000Z' }] },
        NOW,
      ),
    ).toThrow(/7 days/)
  })

  it('accepts an expiry exactly 7 days after added_at', () => {
    expect(
      parseQuarantineEntries(
        { entries: [{ ...VALID, added_at: '2026-11-26T00:00:00.000Z', expiry: '2026-12-03T00:00:00.000Z' }] },
        NOW,
      ),
    ).toHaveLength(1)
  })

  it('rejects an expiry at or before added_at', () => {
    // Both dates kept in the past relative to NOW, so this isolates the added_at-vs-expiry
    // ordering check from the (separately tested) added_at-in-the-future check.
    expect(() =>
      parseQuarantineEntries(
        { entries: [{ ...VALID, added_at: '2026-11-25T00:00:00.000Z', expiry: '2026-11-24T00:00:00.000Z' }] },
        NOW,
      ),
    ).toThrow(/after/)
    expect(() =>
      parseQuarantineEntries({ entries: [{ ...VALID, added_at: '2026-11-24T00:00:00.000Z', expiry: '2026-11-24T00:00:00.000Z' }] }, NOW),
    ).toThrow(/after/)
  })

  it('rejects an unparseable date', () => {
    expect(() => parseQuarantineEntries({ entries: [{ ...VALID, expiry: 'not-a-date' }] }, NOW)).toThrow(/valid date/)
  })

  // CYBERSEC NO-GO 39413 F-1: the 7-day cap used to be relative only to the entry's OWN
  // author-chosen added_at, so a far-future added_at/expiry pair passed every check and stayed
  // active indefinitely (P2/P3 in the NO-GO, both year 2030/2099). Capped against the trusted
  // `now` instead.
  it('rejects an added_at in the future (P2/P3 of the NO-GO: a far-future pair must not pass)', () => {
    expect(() =>
      parseQuarantineEntries(
        { entries: [{ ...VALID, added_at: '2030-01-01T00:00:00.000Z', expiry: '2030-01-08T00:00:00.000Z' }] },
        NOW,
      ),
    ).toThrow(/future/)
    expect(() =>
      parseQuarantineEntries(
        { entries: [{ ...VALID, added_at: '2099-01-01T00:00:00.000Z', expiry: '2099-01-08T00:00:00.000Z' }] },
        NOW,
      ),
    ).toThrow(/future/)
  })

  it('accepts added_at within the clock-skew tolerance but rejects one clearly past it', () => {
    expect(
      parseQuarantineEntries(
        { entries: [{ ...VALID, added_at: new Date(NOW.getTime() + 60_000).toISOString(), expiry: VALID.expiry }] },
        NOW,
      ),
    ).toHaveLength(1)
    expect(() =>
      parseQuarantineEntries(
        { entries: [{ ...VALID, added_at: new Date(NOW.getTime() + 60 * 60_000).toISOString(), expiry: VALID.expiry }] },
        NOW,
      ),
    ).toThrow(/future/)
  })

  it('rejects an expiry more than 7 days from the real clock, even within the added_at skew tolerance', () => {
    // added_at is 2 minutes in the future (inside the 5-minute skew tolerance, so it alone would
    // pass), and expiry is exactly 7 days after THAT added_at -- which passes the "expiry minus
    // added_at <= 7 days" check too. But expiry ends up 7 days + 2 minutes from the real `now`,
    // which the real-clock cap must still catch independently of the added_at-relative check.
    const nearFutureAdded = new Date(NOW.getTime() + 2 * 60_000).toISOString()
    const expiry = new Date(new Date(nearFutureAdded).getTime() + 7 * 24 * 60 * 60 * 1000).toISOString()
    expect(() => parseQuarantineEntries({ entries: [{ ...VALID, added_at: nearFutureAdded, expiry }] }, NOW)).toThrow(
      /7 days from now/,
    )
  })

  // CYBERSEC NO-GO 39413 F-1, P7/P8: three back-to-back (or three identical) entries for the same
  // selftest gave 21 days of coverage by chaining windows. Rejecting a duplicate selftest name
  // forces renewal to be a single, visible, new diff.
  it('rejects a duplicate selftest name across entries (P7/P8 of the NO-GO: chained windows)', () => {
    const second = { ...VALID, added_at: '2026-11-27T00:00:00.000Z', expiry: '2026-12-01T00:00:00.000Z' }
    expect(() => parseQuarantineEntries({ entries: [VALID, second] }, NOW)).toThrow(/duplicate/)
  })

  it('rejects a card id that is not an 8-hex-char id (P5 of the NO-GO: free-text "x")', () => {
    expect(() => parseQuarantineEntries({ entries: [{ ...VALID, card: 'x' }] }, NOW)).toThrow(/card/)
  })
})

describe('isActive / activeQuarantineNames', () => {
  it('an entry is active before its expiry and inactive at/after it', () => {
    expect(isActive(VALID, new Date('2026-11-29T23:59:59.999Z'))).toBe(true)
    expect(isActive(VALID, new Date('2026-11-30T00:00:00.000Z'))).toBe(false)
    expect(isActive(VALID, new Date('2026-12-01T00:00:00.000Z'))).toBe(false)
  })

  it('activeQuarantineNames includes only still-active entries by selftest name', () => {
    const expired: QuarantineEntry = { ...VALID, selftest: 'other-flake', expiry: '2026-11-25T00:00:00.000Z' }
    const now = new Date('2026-11-27T00:00:00.000Z')
    const names = activeQuarantineNames([VALID, expired], now)
    expect(names.has(VALID.selftest)).toBe(true)
    expect(names.has(expired.selftest)).toBe(false)
    expect(names.size).toBe(1)
  })
})

// CYBERSEC NO-GO 39413 F-2: the real it.each loop had no test exercising the quarantined-and-
// failing / expired-and-failing / unlisted-and-failing branches, so a swallow-everything mutant
// (M1) survived. These exercise runQuarantined directly with an injected failing/succeeding `run`,
// which is exactly the function the real loop now delegates to.
describe('runQuarantined', () => {
  const now = new Date('2026-11-27T00:00:00.000Z')
  const fail = () => {
    throw new Error('boom')
  }

  it('swallows (reports, does not throw) a failing run for a selftest with an ACTIVE entry', () => {
    const onQuarantined = vi.fn()
    const result = runQuarantined(VALID.selftest, [VALID], now, fail, onQuarantined)
    expect(result).toBeUndefined()
    expect(onQuarantined).toHaveBeenCalledTimes(1)
    expect(onQuarantined.mock.calls[0]![0]).toContain('QUARANTINED')
  })

  it('rethrows a failing run for a selftest whose entry has EXPIRED (blocks again automatically)', () => {
    const expired: QuarantineEntry = { ...VALID, expiry: '2026-11-25T00:00:00.000Z' }
    const onQuarantined = vi.fn()
    expect(() => runQuarantined(expired.selftest, [expired], now, fail, onQuarantined)).toThrow(/boom/)
    expect(onQuarantined).not.toHaveBeenCalled()
  })

  // This is the mutation-killer for M1 (swallow-all): with NO entry at all for this selftest, a
  // failing run must still throw. A swallow-everything implementation stays green on every OTHER
  // test in this file (none of them name an unlisted, failing selftest) but goes red here.
  it('rethrows a failing run for a selftest with NO quarantine entry at all (kills swallow-all mutants)', () => {
    const onQuarantined = vi.fn()
    expect(() => runQuarantined('not-quarantined-anywhere', [VALID], now, fail, onQuarantined)).toThrow(/boom/)
    expect(onQuarantined).not.toHaveBeenCalled()
  })

  it('returns the run() output unchanged on success, regardless of quarantine status', () => {
    const onQuarantined = vi.fn()
    expect(runQuarantined(VALID.selftest, [VALID], now, () => 'ok output', onQuarantined)).toBe('ok output')
    expect(onQuarantined).not.toHaveBeenCalled()
  })

  // CYBERSEC NO-GO 39413 F-3: AlwaysFatalSelftestError (the dirty-tree guard / missing-summary
  // check) must never be swallowed, even for an actively-quarantined selftest.
  it('always rethrows AlwaysFatalSelftestError, even for an actively-quarantined selftest', () => {
    const onQuarantined = vi.fn()
    const throwFatal = () => {
      throw new AlwaysFatalSelftestError('tree is dirty')
    }
    expect(() => runQuarantined(VALID.selftest, [VALID], now, throwFatal, onQuarantined)).toThrow(/tree is dirty/)
    expect(onQuarantined).not.toHaveBeenCalled()
  })
})
