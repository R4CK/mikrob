import { describe, it, expect } from 'vitest'
import { formatMFtPerM2, formatHuf, formatPct, freshnessLevel } from '../format.js'

// Hungarian Intl formatting has two easy-to-miss traps, both verified directly against Node's
// actual output before writing these expectations (not assumed): the decimal separator is a
// COMMA, and the thousands separator is a NON-BREAKING SPACE (U+00A0), not a plain space --
// using a literal regular space in an expectation would silently never match.
const NBSP = '\u00A0' // non-breaking space, explicit escape (not a literal char) to avoid editor mangling

describe('formatMFtPerM2', () => {
  it('formats a HUF/m2 value as M Ft with a comma decimal, up to 2 places', () => {
    expect(formatMFtPerM2(1_360_000)).toBe('1,36 M Ft')
  })
  it('returns an em-dash for null (no data)', () => {
    expect(formatMFtPerM2(null)).toBe('—')
  })
  it('handles zero without treating it as null', () => {
    expect(formatMFtPerM2(0)).toBe('0 M Ft')
  })
})

describe('formatHuf', () => {
  it('formats with a NON-BREAKING-SPACE thousands separator and an "Ft" suffix', () => {
    expect(formatHuf(80_000_000)).toBe(`80${NBSP}000${NBSP}000 Ft`)
  })
  it('rounds a fractional value', () => {
    expect(formatHuf(1234.6)).toBe('1235 Ft')
  })
})

describe('formatPct', () => {
  it('adds a + sign for a positive change (comma decimal)', () => {
    expect(formatPct(3.2)).toBe('+3,2%')
  })
  it('keeps the - sign for a negative change (no double sign)', () => {
    expect(formatPct(-1.5)).toBe('-1,5%')
  })
  it('has no sign for exactly zero', () => {
    expect(formatPct(0)).toBe('0%')
  })
  it('returns an em-dash for null', () => {
    expect(formatPct(null)).toBe('—')
  })
})

describe('freshnessLevel', () => {
  const NOW = new Date('2026-08-12T12:00:00Z').getTime()
  const now = () => NOW

  it('green when under 26 hours old', () => {
    const ts = new Date(NOW - 10 * 60 * 60 * 1000).toISOString() // 10h ago
    expect(freshnessLevel(ts, now)).toBe('green')
  })
  it('yellow between 26 and 48 hours', () => {
    const ts = new Date(NOW - 30 * 60 * 60 * 1000).toISOString() // 30h ago
    expect(freshnessLevel(ts, now)).toBe('yellow')
  })
  it('red over 48 hours', () => {
    const ts = new Date(NOW - 60 * 60 * 60 * 1000).toISOString() // 60h ago
    expect(freshnessLevel(ts, now)).toBe('red')
  })
  it('boundary: exactly 26h is yellow (< 26h is the green cutoff)', () => {
    const ts = new Date(NOW - 26 * 60 * 60 * 1000).toISOString()
    expect(freshnessLevel(ts, now)).toBe('yellow')
  })
  it('boundary: exactly 48h is still yellow (> 48h is the red cutoff)', () => {
    const ts = new Date(NOW - 48 * 60 * 60 * 1000).toISOString()
    expect(freshnessLevel(ts, now)).toBe('yellow')
  })
  it('unknown when there is no timestamp at all (never scraped)', () => {
    expect(freshnessLevel(null, now)).toBe('unknown')
  })
})
