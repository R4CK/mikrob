import { describe, it, expect } from 'vitest'
import { dailyMedianSeries, linearRegression, forecastTrend, type PricePoint, type DailyMedian } from '../trend.js'

const DAY = 86400

describe('dailyMedianSeries', () => {
  it('carries a listing\'s last-known price FORWARD across days it did not change', () => {
    // L1 (lakas): sighted day0 @1000, changes day5 @1100. L2 (haz): sighted day2 @2000, never changes.
    const points: PricePoint[] = [
      { listingId: 'L1', tipus: 'lakas', eszleltAt: 0, nm2Ar: 1000 },
      { listingId: 'L1', tipus: 'lakas', eszleltAt: 5 * DAY, nm2Ar: 1100 },
      { listingId: 'L2', tipus: 'haz', eszleltAt: 2 * DAY, nm2Ar: 2000 },
    ]

    const series = dailyMedianSeries(points, 'combined')

    expect(series).toEqual([
      { day: 0, medianNm2Ar: 1000, sampleCount: 1 },
      { day: 1 * DAY, medianNm2Ar: 1000, sampleCount: 1 },
      { day: 2 * DAY, medianNm2Ar: 1500, sampleCount: 2 }, // L2 enters: median(1000,2000)
      { day: 3 * DAY, medianNm2Ar: 1500, sampleCount: 2 },
      { day: 4 * DAY, medianNm2Ar: 1500, sampleCount: 2 },
      { day: 5 * DAY, medianNm2Ar: 1550, sampleCount: 2 }, // L1 changes: median(1100,2000)
    ])
  })

  it('filters by tipus -- excluded listings never enter the sample or affect the day range', () => {
    const points: PricePoint[] = [
      { listingId: 'L1', tipus: 'lakas', eszleltAt: 0, nm2Ar: 1000 },
      { listingId: 'L1', tipus: 'lakas', eszleltAt: 5 * DAY, nm2Ar: 1100 },
      { listingId: 'L2', tipus: 'haz', eszleltAt: 2 * DAY, nm2Ar: 2000 },
    ]

    const lakas = dailyMedianSeries(points, 'lakas')
    expect(lakas).toHaveLength(6)
    expect(lakas.every((d) => d.sampleCount === 1)).toBe(true)
    expect(lakas[5]).toEqual({ day: 5 * DAY, medianNm2Ar: 1100, sampleCount: 1 })

    const haz = dailyMedianSeries(points, 'haz')
    expect(haz).toEqual([{ day: 2 * DAY, medianNm2Ar: 2000, sampleCount: 1 }])
  })

  it('returns an empty series for no points', () => {
    expect(dailyMedianSeries([], 'combined')).toEqual([])
  })
})

describe('linearRegression', () => {
  it('fits an exact line through noiseless points', () => {
    const points = [0, 1, 2, 3, 4].map((x) => ({ x, y: 2 * x + 3 }))
    const { slope, intercept } = linearRegression(points)
    expect(slope).toBeCloseTo(2)
    expect(intercept).toBeCloseTo(3)
  })

  it('degenerate all-same-x input returns a flat fit at the mean y (no division by zero)', () => {
    const { slope, intercept } = linearRegression([{ x: 5, y: 10 }, { x: 5, y: 20 }])
    expect(slope).toBe(0)
    expect(intercept).toBe(15)
  })
})

describe('forecastTrend', () => {
  it('reports insufficient-data below the configured minimum, without attempting a fit', () => {
    const series: DailyMedian[] = [
      { day: 0, medianNm2Ar: 1000, sampleCount: 1 },
      { day: DAY, medianNm2Ar: 1010, sampleCount: 1 },
    ]
    const result = forecastTrend(series, { minDaysRequired: 14, forecastDaysAhead: 180 })
    expect(result).toEqual({ status: 'insufficient-data', daysOfHistory: 2, minDaysRequired: 14 })
  })

  it('forecasts forward along the fitted trend once enough days exist', () => {
    // Perfectly linear +10/day for 14 days: day0=1000 .. day13=1130.
    const series: DailyMedian[] = Array.from({ length: 14 }, (_, i) => ({
      day: i * DAY,
      medianNm2Ar: 1000 + i * 10,
      sampleCount: 3,
    }))
    const result = forecastTrend(series, { minDaysRequired: 14, forecastDaysAhead: 180 })
    expect(result.status).toBe('ok')
    if (result.status === 'ok') {
      expect(result.slopePerDayNm2Ar).toBeCloseTo(10)
      // day13 (x=13) + 180 days ahead = x=193 -> 1000 + 193*10 = 2930
      expect(result.forecastNm2Ar).toBeCloseTo(2930)
      expect(result.daysOfHistory).toBe(14)
    }
  })
})
