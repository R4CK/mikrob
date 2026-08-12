import { describe, it, expect } from 'vitest'
import { buildListings } from '../build-listings.js'
import type { ListingWithHistory } from '../../query.js'
import type { GroupStats } from '../../analysis/stats.js'

const groupStats = (medianNm2Ar: number): GroupStats => ({
  count: 1,
  avgNm2Ar: medianNm2Ar,
  medianNm2Ar,
  minNm2Ar: medianNm2Ar,
  maxNm2Ar: medianNm2Ar,
})

const listing = (overrides: Partial<ListingWithHistory> = {}): ListingWithHistory => ({
  id: 'x',
  url: 'https://ingatlan.com/x',
  tipus: 'lakas',
  allapot: null,
  cim: null,
  alapteruletM2: 65,
  elsoEszleltAt: 1000,
  ar: 80_000_000,
  nm2Ar: 1000,
  arHistory: [{ ar: 80_000_000, nm2Ar: 1000, eszleltAt: 1000 }],
  ...overrides,
})

describe('buildListings', () => {
  it('maps the descriptive fields and current price through unchanged', () => {
    const [result] = buildListings(
      [listing({ id: 'a', cim: 'Budapest II. ker.', alapteruletM2: 70, ar: 90_000_000, nm2Ar: 1200 })],
      { haz: null, lakas: groupStats(1200) },
    )
    expect(result.id).toBe('a')
    expect(result.cim).toBe('Budapest II. ker.')
    expect(result.alapterulet_m2).toBe(70)
    expect(result.ar).toBe(90_000_000)
    expect(result.nm2_ar).toBe(1200)
    expect(result.elso_eszlelt_at).toBe(new Date(1000 * 1000).toISOString())
  })

  it('a single-sighting listing has delta_pct null (nothing to compare against)', () => {
    const [result] = buildListings([listing()], { haz: null, lakas: groupStats(1000) })
    expect(result.delta_pct).toBeNull()
  })

  it('delta_pct is the % change from the PREVIOUS price to the current one', () => {
    const l = listing({
      ar: 88_000_000,
      arHistory: [
        { ar: 80_000_000, nm2Ar: 1000, eszleltAt: 1000 },
        { ar: 88_000_000, nm2Ar: 1100, eszleltAt: 2000 },
      ],
    })
    const [result] = buildListings([l], { haz: null, lakas: groupStats(1100) })
    expect(result.delta_pct).toBeCloseTo(10) // 80M -> 88M = +10%
  })

  it('ar_history maps every recorded point to {datum, ar}, in order', () => {
    const l = listing({
      arHistory: [
        { ar: 80_000_000, nm2Ar: 1000, eszleltAt: 1000 },
        { ar: 78_000_000, nm2Ar: 975, eszleltAt: 2000 },
      ],
    })
    const [result] = buildListings([l], { haz: null, lakas: groupStats(1000) })
    expect(result.ar_history).toEqual([
      { datum: new Date(1000 * 1000).toISOString(), ar: 80_000_000 },
      { datum: new Date(2000 * 1000).toISOString(), ar: 78_000_000 },
    ])
  })

  describe('median_rel classification (default +-5% band)', () => {
    it('within the band -> "belul"', () => {
      const [result] = buildListings([listing({ nm2Ar: 1020 })], { haz: null, lakas: groupStats(1000) })
      expect(result.median_rel).toBe('belul')
    })
    it('above the band -> "folott"', () => {
      const [result] = buildListings([listing({ nm2Ar: 1200 })], { haz: null, lakas: groupStats(1000) })
      expect(result.median_rel).toBe('folott')
    })
    it('below the band -> "alatt"', () => {
      const [result] = buildListings([listing({ nm2Ar: 800 })], { haz: null, lakas: groupStats(1000) })
      expect(result.median_rel).toBe('alatt')
    })
    it('no group median yet -> null, not a guess', () => {
      const [result] = buildListings([listing({ tipus: 'haz' })], { haz: null, lakas: groupStats(1000) })
      expect(result.median_rel).toBeNull()
    })
    it('respects a custom bandPct', () => {
      const [result] = buildListings([listing({ nm2Ar: 1150 })], { haz: null, lakas: groupStats(1000) }, 0.2)
      expect(result.median_rel).toBe('belul') // within +-20%, outside +-5%
    })
  })

  it('maps multiple listings independently', () => {
    const results = buildListings(
      [listing({ id: 'a', tipus: 'haz' }), listing({ id: 'b', tipus: 'lakas' })],
      { haz: groupStats(1000), lakas: groupStats(1000) },
    )
    expect(results.map((r) => r.id)).toEqual(['a', 'b'])
  })
})
