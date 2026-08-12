import { describe, it, expect } from 'vitest'
import { computeStats, median, groupedMarketStats, listingsWithinBand, type Snapshot } from '../stats.js'

describe('median', () => {
  it('returns the middle value for an odd-length array', () => {
    expect(median([3, 1, 2])).toBe(2)
  })
  it('averages the two middle values for an even-length array', () => {
    expect(median([1, 2, 3, 4])).toBe(2.5)
  })
  it('handles a single value', () => {
    expect(median([7])).toBe(7)
  })
})

describe('computeStats', () => {
  it('returns null for an empty group (not a zeroed-out fake stat)', () => {
    expect(computeStats([])).toBeNull()
  })
  it('computes count/avg/median/min/max', () => {
    expect(computeStats([100, 200, 300])).toEqual({
      count: 3,
      avgNm2Ar: 200,
      medianNm2Ar: 200,
      minNm2Ar: 100,
      maxNm2Ar: 300,
    })
  })
})

const snap = (overrides: Partial<Snapshot> = {}): Snapshot => ({
  id: 'x',
  url: 'https://ingatlan.com/x',
  tipus: 'lakas',
  nm2Ar: 1000,
  ...overrides,
})

describe('groupedMarketStats', () => {
  it('computes haz/lakas/combined independently', () => {
    const snapshots = [
      snap({ id: 'h1', tipus: 'haz', nm2Ar: 900 }),
      snap({ id: 'h2', tipus: 'haz', nm2Ar: 1100 }),
      snap({ id: 'l1', tipus: 'lakas', nm2Ar: 1000 }),
    ]
    const result = groupedMarketStats(snapshots)
    expect(result.haz).toEqual({ count: 2, avgNm2Ar: 1000, medianNm2Ar: 1000, minNm2Ar: 900, maxNm2Ar: 1100 })
    expect(result.lakas).toEqual({ count: 1, avgNm2Ar: 1000, medianNm2Ar: 1000, minNm2Ar: 1000, maxNm2Ar: 1000 })
    expect(result.combined!.count).toBe(3)
  })

  it('a group with no listings of that tipus is null, not zero', () => {
    const result = groupedMarketStats([snap({ tipus: 'lakas' })])
    expect(result.haz).toBeNull()
    expect(result.lakas).not.toBeNull()
  })
})

describe('listingsWithinBand', () => {
  it('keeps only listings within +-5% of the given median by default', () => {
    const snapshots = [
      snap({ id: 'a', nm2Ar: 950 }), // -5%, boundary -> inclusive
      snap({ id: 'b', nm2Ar: 1050 }), // +5%, boundary -> inclusive
      snap({ id: 'c', nm2Ar: 900 }), // -10%, outside
      snap({ id: 'd', nm2Ar: 1100 }), // +10%, outside
      snap({ id: 'e', nm2Ar: 1000 }), // exact median
    ]
    const result = listingsWithinBand(snapshots, 1000)
    expect(result.map((s) => s.id).sort()).toEqual(['a', 'b', 'e'])
  })

  it('supports a custom band percentage', () => {
    // 930: within +-10% of 1000 (900..1100) but outside +-5% (950..1050).
    const snapshots = [snap({ id: 'a', nm2Ar: 930 }), snap({ id: 'b', nm2Ar: 970 })]
    expect(listingsWithinBand(snapshots, 1000, 0.1).map((s) => s.id)).toEqual(['a', 'b'])
    expect(listingsWithinBand(snapshots, 1000, 0.05).map((s) => s.id)).toEqual(['b'])
  })
})
