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
})
