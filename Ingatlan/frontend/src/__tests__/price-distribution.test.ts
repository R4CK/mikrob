import { describe, it, expect } from 'vitest'
import { buildPriceDistribution } from '../price-distribution.js'

describe('buildPriceDistribution', () => {
  it('sorts listings into the 5 fixed price bands, ház/lakás counted separately', () => {
    const result = buildPriceDistribution([
      { tipus: 'haz', ar: 40_000_000 }, // < 50M
      { tipus: 'lakas', ar: 60_000_000 }, // 50-70M
      { tipus: 'haz', ar: 80_000_000 }, // 70-90M
      { tipus: 'lakas', ar: 100_000_000 }, // 90-110M
      { tipus: 'haz', ar: 115_000_000 }, // 110-120M
    ])
    expect(result.map((b) => b.label)).toEqual(['< 50M', '50-70M', '70-90M', '90-110M', '110-120M'])
    expect(result[0]).toEqual({ label: '< 50M', hazCount: 1, lakasCount: 0 })
    expect(result[1]).toEqual({ label: '50-70M', hazCount: 0, lakasCount: 1 })
    expect(result[4]).toEqual({ label: '110-120M', hazCount: 1, lakasCount: 0 })
  })

  it('a boundary price (exactly 50M) lands in the UPPER band, not the lower one', () => {
    const result = buildPriceDistribution([{ tipus: 'haz', ar: 50_000_000 }])
    expect(result[0].hazCount).toBe(0)
    expect(result[1].hazCount).toBe(1)
  })

  it('a price ABOVE 120M does not vanish -- it lands in the last band, not dropped', () => {
    const result = buildPriceDistribution([{ tipus: 'lakas', ar: 200_000_000 }])
    expect(result[4]).toEqual({ label: '110-120M', hazCount: 0, lakasCount: 1 })
  })

  it('multiple listings in the same band accumulate', () => {
    const result = buildPriceDistribution([
      { tipus: 'haz', ar: 40_000_000 },
      { tipus: 'haz', ar: 41_000_000 },
      { tipus: 'lakas', ar: 42_000_000 },
    ])
    expect(result[0]).toEqual({ label: '< 50M', hazCount: 2, lakasCount: 1 })
  })

  it('returns 5 zeroed bands for an empty listing set (not an empty array)', () => {
    const result = buildPriceDistribution([])
    expect(result).toHaveLength(5)
    expect(result.every((b) => b.hazCount === 0 && b.lakasCount === 0)).toBe(true)
  })
})
