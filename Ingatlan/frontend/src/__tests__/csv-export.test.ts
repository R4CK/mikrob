import { describe, it, expect } from 'vitest'
import { listingsToCsv } from '../csv-export.js'
import type { Listing } from '../types.js'

const listing = (overrides: Partial<Listing> = {}): Listing => ({
  id: 'x',
  url: 'https://ingatlan.com/x',
  tipus: 'lakas',
  cim: 'Teszt utca 1.',
  alapterulet_m2: 65,
  ar: 80_000_000,
  nm2_ar: 1_230_769,
  delta_pct: -2.5,
  median_rel: 'belul',
  ar_history: [],
  elso_eszlelt_at: '2026-01-01T00:00:00.000Z',
  ...overrides,
})

describe('listingsToCsv', () => {
  it('produces a header row plus one row per listing', () => {
    const csv = listingsToCsv([listing(), listing({ id: 'y' })])
    const lines = csv.split('\r\n')
    expect(lines[0]).toBe('Cím,Típus,Alapterület (m2),Ár (Ft),nm2 ár (Ft),Delta ár (%),Mediánsáv')
    expect(lines).toHaveLength(3)
  })

  it('an address containing a comma is quoted, not split into an extra column', () => {
    const csv = listingsToCsv([listing({ cim: 'Kossuth utca 4, fszt 2' })])
    const dataLine = csv.split('\r\n')[1]
    expect(dataLine.startsWith('"Kossuth utca 4, fszt 2",')).toBe(true)
  })

  it('an embedded quote is escaped by doubling', () => {
    const csv = listingsToCsv([listing({ cim: 'A "Kertváros" lakópark' })])
    expect(csv).toContain('"A ""Kertváros"" lakópark"')
  })

  it('a listing with no cím falls back to its id', () => {
    const csv = listingsToCsv([listing({ cim: null, id: 'abc123' })])
    expect(csv.split('\r\n')[1].startsWith('abc123,')).toBe(true)
  })

  it('null delta_pct and median_rel render as empty fields, not "null"', () => {
    const csv = listingsToCsv([listing({ delta_pct: null, median_rel: null })])
    const cells = csv.split('\r\n')[1].split(',')
    expect(cells[5]).toBe('')
    expect(cells[6]).toBe('')
  })

  it('an empty listing array produces just the header', () => {
    expect(listingsToCsv([])).toBe('Cím,Típus,Alapterület (m2),Ár (Ft),nm2 ár (Ft),Delta ár (%),Mediánsáv')
  })

  // CSV/formula-injection (OWASP, Cybersec finding on card 1f51f050 @ 917fd71): a cím starting
  // with =, +, -, or @ must NOT be exported as a live formula.
  it('a cím starting with "=" is neutralized, not exported as a live formula', () => {
    const csv = listingsToCsv([listing({ cim: '=2+2' })])
    const cell = csv.split('\r\n')[1].split(',')[0]
    expect(cell).toBe("'=2+2")
    expect(cell.startsWith('=')).toBe(false)
  })

  it.each(['+36301234567', '-2. emelet', '@lakópark'])('a cím starting with "%s"-like prefix is neutralized', (cim) => {
    const csv = listingsToCsv([listing({ cim })])
    const cell = csv.split('\r\n')[1].split(',')[0]
    expect(cell.startsWith("'")).toBe(true)
    expect(cell.slice(1)).toBe(cim)
  })

  it('a normal cím with no leading special character is left unprefixed', () => {
    const csv = listingsToCsv([listing({ cim: 'Teszt utca 1.' })])
    expect(csv.split('\r\n')[1].startsWith('Teszt utca 1.,')).toBe(true)
  })

  // Regression: the formula-injection guard must apply ONLY to cím (free text from a third party),
  // not to our own numeric columns -- Δ ár is legitimately negative on every price DROP (the common,
  // good case), and "-3.5" also matches the "starts with -" trigger. An earlier version of this fix
  // applied the guard everywhere and silently turned every price-drop row's Δ ár into quoted text.
  it('a negative Δ ár (price dropped) is exported as a plain number, NOT apostrophe-prefixed', () => {
    const csv = listingsToCsv([listing({ delta_pct: -3.5294117647058822 })])
    const cells = csv.split('\r\n')[1].split(',')
    expect(cells[5]).toBe('-3.5294117647058822')
  })
})
