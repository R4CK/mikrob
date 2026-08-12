import { describe, it, expect } from 'vitest'
import { applySort } from '../components/HirdetesekView.js'
import type { Listing } from '../types.js'

function makeListing(id: string, overrides: Partial<Listing> = {}): Listing {
  return {
    id,
    cim: null,
    url: '',
    tipus: 'lakas',
    ar: 50_000_000,
    nm2_ar: 1_000_000,
    alapterulet_m2: null,
    delta_pct: null,
    median_rel: null,
    ar_history: [],
    elso_eszlelt_at: '',
    ...overrides,
  }
}

describe('applySort', () => {
  const listings = [
    makeListing('a', { ar: 80_000_000, nm2_ar: 1_000_000, alapterulet_m2: 80, delta_pct: -5 }),
    makeListing('b', { ar: 50_000_000, nm2_ar: 800_000, alapterulet_m2: 60, delta_pct: 2 }),
    makeListing('c', { ar: 120_000_000, nm2_ar: 1_500_000, alapterulet_m2: 100, delta_pct: -10 }),
  ]

  it('returns original order when sort is null', () => {
    const result = applySort(listings, null)
    expect(result.map((l) => l.id)).toEqual(['a', 'b', 'c'])
  })

  it('sorts by ar ascending', () => {
    const result = applySort(listings, { col: 'ar', dir: 'asc' })
    expect(result.map((l) => l.id)).toEqual(['b', 'a', 'c'])
  })

  it('sorts by ar descending', () => {
    const result = applySort(listings, { col: 'ar', dir: 'desc' })
    expect(result.map((l) => l.id)).toEqual(['c', 'a', 'b'])
  })

  it('sorts by nm2_ar ascending', () => {
    const result = applySort(listings, { col: 'nm2_ar', dir: 'asc' })
    expect(result.map((l) => l.id)).toEqual(['b', 'a', 'c'])
  })

  it('sorts by alapterulet_m2 descending', () => {
    const result = applySort(listings, { col: 'alapterulet_m2', dir: 'desc' })
    expect(result.map((l) => l.id)).toEqual(['c', 'a', 'b'])
  })

  it('sorts by delta_pct ascending (legjobb csökkentés elöl)', () => {
    const result = applySort(listings, { col: 'delta_pct', dir: 'asc' })
    expect(result.map((l) => l.id)).toEqual(['c', 'a', 'b'])
  })

  it('pushes null alapterulet to the end when sorting asc', () => {
    const withNull = [
      makeListing('x', { alapterulet_m2: 80 }),
      makeListing('y', { alapterulet_m2: null }),
      makeListing('z', { alapterulet_m2: 60 }),
    ]
    const result = applySort(withNull, { col: 'alapterulet_m2', dir: 'asc' })
    expect(result[result.length - 1].id).toBe('y')
  })

  it('pushes null alapterulet to the end when sorting desc (unknown data stays last)', () => {
    const withNull = [
      makeListing('x', { alapterulet_m2: 80 }),
      makeListing('y', { alapterulet_m2: null }),
      makeListing('z', { alapterulet_m2: 60 }),
    ]
    const result = applySort(withNull, { col: 'alapterulet_m2', dir: 'desc' })
    expect(result[result.length - 1].id).toBe('y')
  })

  it('does not mutate the input array', () => {
    const input = [...listings]
    applySort(input, { col: 'ar', dir: 'asc' })
    expect(input.map((l) => l.id)).toEqual(['a', 'b', 'c'])
  })
})
