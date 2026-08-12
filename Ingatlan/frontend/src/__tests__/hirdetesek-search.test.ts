import { describe, it, expect } from 'vitest'
import { applySearch } from '../components/HirdetesekView.js'
import type { Listing } from '../types.js'

function makeListing(id: string, cim: string | null): Listing {
  return {
    id, cim, url: '', tipus: 'lakas',
    ar: 50_000_000, nm2_ar: 1_000_000,
    alapterulet_m2: null, delta_pct: null, median_rel: null,
    ar_history: [], elso_eszlelt_at: '',
  }
}

const listings = [
  makeListing('a', 'Budapest II. kerület, Hegyalja út 10.'),
  makeListing('b', 'Budapest XII. kerület, Alkotás utca 5.'),
  makeListing('c', 'Budapest II. kerület, Törökvész út 20.'),
  makeListing('d', null),
]

describe('applySearch', () => {
  it('returns all listings for empty query', () => {
    expect(applySearch(listings, '').length).toBe(4)
  })

  it('returns all listings for whitespace-only query', () => {
    expect(applySearch(listings, '   ').length).toBe(4)
  })

  it('filters by partial cím match (case-insensitive)', () => {
    const result = applySearch(listings, 'II. kerület')
    expect(result.map((l) => l.id)).toEqual(['a', 'c'])
  })

  it('is case-insensitive', () => {
    const result = applySearch(listings, 'ALKOTÁS')
    expect(result.map((l) => l.id)).toEqual(['b'])
  })

  it('matches against id when cim is null', () => {
    const result = applySearch(listings, 'd')
    expect(result.map((l) => l.id)).toContain('d')
  })

  it('returns empty array when no match', () => {
    expect(applySearch(listings, 'Debrecen').length).toBe(0)
  })

  it('does not mutate the input array', () => {
    const input = [...listings]
    applySearch(input, 'II.')
    expect(input.length).toBe(4)
  })
})
