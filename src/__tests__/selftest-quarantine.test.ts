// Card 1ce518d9: unit coverage for the quarantine list's own validation and active-set logic.
// Integration with the real it.each loop (does a quarantined failure actually not throw, does an
// expired one throw again) is covered in store-selftests-all-run.test.ts itself, against the real
// discovery output -- these tests are scoped to parseQuarantineEntries/isActive/activeQuarantineNames
// in isolation, each with a positive AND a negative case so a mutant that inverts a comparison or
// drops a check has something to fail on.
import { describe, it, expect } from 'vitest'
import { parseQuarantineEntries, isActive, activeQuarantineNames, type QuarantineEntry } from '../selftest-quarantine.js'

const VALID: QuarantineEntry = {
  selftest: 'wsl-cleanup',
  owner: 'backend2',
  card: 'a1c38d36',
  added_at: '2026-11-26T00:00:00.000Z',
  expiry: '2026-11-30T00:00:00.000Z',
}

describe('parseQuarantineEntries', () => {
  it('accepts a well-formed entry', () => {
    expect(parseQuarantineEntries({ entries: [VALID] })).toEqual([VALID])
  })

  it('rejects a payload with no entries array', () => {
    expect(() => parseQuarantineEntries({})).toThrow(/entries/)
    expect(() => parseQuarantineEntries({ entries: 'nope' })).toThrow(/entries/)
  })

  it('accepts an empty list (the default, safe shape)', () => {
    expect(parseQuarantineEntries({ entries: [] })).toEqual([])
  })

  for (const field of ['selftest', 'owner', 'card', 'added_at', 'expiry'] as const) {
    it(`rejects an entry missing "${field}"`, () => {
      const { [field]: _omit, ...rest } = VALID
      expect(() => parseQuarantineEntries({ entries: [rest] })).toThrow(new RegExp(field))
    })

    it(`rejects an entry with "${field}" as an empty string`, () => {
      expect(() => parseQuarantineEntries({ entries: [{ ...VALID, [field]: '' }] })).toThrow(new RegExp(field))
    })
  }

  it('rejects a 4th entry', () => {
    const three = [0, 1, 2].map((i) => ({ ...VALID, selftest: `s${i}` }))
    expect(parseQuarantineEntries({ entries: three })).toHaveLength(3)
    const four = [0, 1, 2, 3].map((i) => ({ ...VALID, selftest: `s${i}` }))
    expect(() => parseQuarantineEntries({ entries: four })).toThrow(/max is 3/)
  })

  it('rejects an expiry more than 7 days after added_at', () => {
    expect(() =>
      parseQuarantineEntries({ entries: [{ ...VALID, added_at: '2026-11-26T00:00:00.000Z', expiry: '2026-12-04T00:00:00.000Z' }] }),
    ).toThrow(/7 days/)
  })

  it('accepts an expiry exactly 7 days after added_at', () => {
    expect(
      parseQuarantineEntries({ entries: [{ ...VALID, added_at: '2026-11-26T00:00:00.000Z', expiry: '2026-12-03T00:00:00.000Z' }] }),
    ).toHaveLength(1)
  })

  it('rejects an expiry at or before added_at', () => {
    expect(() => parseQuarantineEntries({ entries: [{ ...VALID, added_at: VALID.expiry, expiry: VALID.added_at }] })).toThrow(
      /after/,
    )
    expect(() => parseQuarantineEntries({ entries: [{ ...VALID, expiry: VALID.added_at }] })).toThrow(/after/)
  })

  it('rejects an unparseable date', () => {
    expect(() => parseQuarantineEntries({ entries: [{ ...VALID, expiry: 'not-a-date' }] })).toThrow(/valid date/)
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
