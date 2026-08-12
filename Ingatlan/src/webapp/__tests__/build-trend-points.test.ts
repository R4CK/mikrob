import { describe, it, expect } from 'vitest'
import { buildTrendPoints } from '../build-trend-points.js'
import type { PricePoint } from '../../analysis/trend.js'

const day = (y: number, m: number, d: number): number => Math.floor(Date.UTC(y, m - 1, d) / 1000)

describe('buildTrendPoints', () => {
  it('aggregates a single month into one point with both types', () => {
    const points: PricePoint[] = [
      { listingId: 'h1', tipus: 'haz', eszleltAt: day(2026, 1, 5), nm2Ar: 1000 },
      { listingId: 'l1', tipus: 'lakas', eszleltAt: day(2026, 1, 5), nm2Ar: 900 },
    ]
    expect(buildTrendPoints(points)).toEqual([{ datum: '2026-01', haz_nm2: 1000, lakas_nm2: 900 }])
  })

  it('produces one point per calendar month, sorted chronologically', () => {
    const points: PricePoint[] = [
      { listingId: 'h1', tipus: 'haz', eszleltAt: day(2026, 3, 1), nm2Ar: 1200 },
      { listingId: 'h1', tipus: 'haz', eszleltAt: day(2026, 1, 1), nm2Ar: 1000 },
      { listingId: 'h1', tipus: 'haz', eszleltAt: day(2026, 2, 1), nm2Ar: 1100 },
    ]
    expect(buildTrendPoints(points).map((p) => p.datum)).toEqual(['2026-01', '2026-02', '2026-03'])
  })

  it('a month with only ONE tipus reports null for the other', () => {
    const points: PricePoint[] = [{ listingId: 'h1', tipus: 'haz', eszleltAt: day(2026, 1, 1), nm2Ar: 1000 }]
    expect(buildTrendPoints(points)).toEqual([{ datum: '2026-01', haz_nm2: 1000, lakas_nm2: null }])
  })

  it('takes the MEDIAN of a month\'s daily medians, not the average or the last value', () => {
    // Three distinct days in January with medians 1000/2000/9000 -- median is 2000, not the
    // mean (4000) or the last day's value (9000).
    const points: PricePoint[] = [
      { listingId: 'h1', tipus: 'haz', eszleltAt: day(2026, 1, 1), nm2Ar: 1000 },
      { listingId: 'h1', tipus: 'haz', eszleltAt: day(2026, 1, 2), nm2Ar: 2000 },
      { listingId: 'h1', tipus: 'haz', eszleltAt: day(2026, 1, 3), nm2Ar: 9000 },
    ]
    expect(buildTrendPoints(points)[0].haz_nm2).toBe(2000)
  })

  it('caps to the most recent maxMonths, dropping OLDER months', () => {
    const points: PricePoint[] = [
      { listingId: 'h1', tipus: 'haz', eszleltAt: day(2026, 1, 1), nm2Ar: 1000 },
      { listingId: 'h1', tipus: 'haz', eszleltAt: day(2026, 2, 1), nm2Ar: 1100 },
      { listingId: 'h1', tipus: 'haz', eszleltAt: day(2026, 3, 1), nm2Ar: 1200 },
    ]
    expect(buildTrendPoints(points, 2).map((p) => p.datum)).toEqual(['2026-02', '2026-03'])
  })

  it('maxMonths=0 (or omitted default of 12) does not truncate a short series', () => {
    const points: PricePoint[] = [{ listingId: 'h1', tipus: 'haz', eszleltAt: day(2026, 1, 1), nm2Ar: 1000 }]
    expect(buildTrendPoints(points)).toHaveLength(1)
    expect(buildTrendPoints(points, 0)).toHaveLength(1)
  })

  it('returns an empty array for no price points', () => {
    expect(buildTrendPoints([])).toEqual([])
  })
})
