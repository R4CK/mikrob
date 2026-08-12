import { median } from './stats.js'
import type { IngatlanTipus } from '../types.js'

const DAY_SECONDS = 86400

// One price_history row, joined with its listing's tipus -- the raw input to daily
// reconstruction. NOT the same shape as Snapshot (stats.ts): this carries every recorded
// price point over time, not just the current one.
export interface PricePoint {
  listingId: string
  tipus: IngatlanTipus
  eszleltAt: number
  nm2Ar: number
}

export interface DailyMedian {
  day: number // unix epoch, truncated to a UTC day boundary
  medianNm2Ar: number
  sampleCount: number // how many listings had a known price as of this day
}

// price_history only gets a new row on first sighting or an actual price change (db.ts
// recordSighting) -- so a stable listing has just ONE row for months. To get a real per-day
// market snapshot we carry each listing's last-known price FORWARD across days it didn't
// change, rather than only looking at rows recorded on that exact day (which would silently
// undercount/bias the series toward days with churn).
export function dailyMedianSeries(points: PricePoint[], tipus: IngatlanTipus | 'combined'): DailyMedian[] {
  const filtered = tipus === 'combined' ? points : points.filter((p) => p.tipus === tipus)
  if (filtered.length === 0) return []

  const byListing = new Map<string, PricePoint[]>()
  for (const p of filtered) {
    const arr = byListing.get(p.listingId) ?? []
    arr.push(p)
    byListing.set(p.listingId, arr)
  }
  for (const arr of byListing.values()) arr.sort((a, b) => a.eszleltAt - b.eszleltAt)

  const toDay = (t: number) => Math.floor(t / DAY_SECONDS) * DAY_SECONDS
  const firstDay = toDay(Math.min(...filtered.map((p) => p.eszleltAt)))
  const lastDay = toDay(Math.max(...filtered.map((p) => p.eszleltAt)))

  const nextIndex = new Map<string, number>()
  const currentPrice = new Map<string, number>()
  const series: DailyMedian[] = []

  for (let day = firstDay; day <= lastDay; day += DAY_SECONDS) {
    const dayEnd = day + DAY_SECONDS - 1
    for (const [listingId, arr] of byListing) {
      let i = nextIndex.get(listingId) ?? 0
      while (i < arr.length && arr[i].eszleltAt <= dayEnd) {
        currentPrice.set(listingId, arr[i].nm2Ar)
        i++
      }
      nextIndex.set(listingId, i)
    }
    if (currentPrice.size > 0) {
      series.push({ day, medianNm2Ar: median([...currentPrice.values()]), sampleCount: currentPrice.size })
    }
  }
  return series
}

interface LinearFit {
  slope: number
  intercept: number
}

// Ordinary least squares on (x, y) pairs. Degenerate (all-x-equal) input returns a flat fit
// at the mean y rather than dividing by zero.
export function linearRegression(pointsXY: Array<{ x: number; y: number }>): LinearFit {
  const n = pointsXY.length
  const sumX = pointsXY.reduce((s, p) => s + p.x, 0)
  const sumY = pointsXY.reduce((s, p) => s + p.y, 0)
  const sumXY = pointsXY.reduce((s, p) => s + p.x * p.y, 0)
  const sumXX = pointsXY.reduce((s, p) => s + p.x * p.x, 0)
  const denom = n * sumXX - sumX * sumX
  if (denom === 0) return { slope: 0, intercept: sumY / n }
  const slope = (n * sumXY - sumX * sumY) / denom
  return { slope, intercept: (sumY - slope * sumX) / n }
}

export type ForecastResult =
  | { status: 'insufficient-data'; daysOfHistory: number; minDaysRequired: number }
  | { status: 'ok'; daysOfHistory: number; slopePerDayNm2Ar: number; forecastNm2Ar: number; forecastDaysAhead: number }

// The card is explicit that this should degrade gracefully: "kezdetben csak keresztmetszeti
// statisztikat adjon, a trend akkor eleselodik ha mar van tortenet" -- so below minDaysRequired
// distinct daily samples, we say so plainly instead of extrapolating a line through noise.
export function forecastTrend(
  series: DailyMedian[],
  opts: { minDaysRequired: number; forecastDaysAhead: number },
): ForecastResult {
  if (series.length < opts.minDaysRequired) {
    return { status: 'insufficient-data', daysOfHistory: series.length, minDaysRequired: opts.minDaysRequired }
  }
  const baseDay = series[0].day
  const points = series.map((s) => ({ x: (s.day - baseDay) / DAY_SECONDS, y: s.medianNm2Ar }))
  const { slope, intercept } = linearRegression(points)
  const forecastX = points[points.length - 1].x + opts.forecastDaysAhead
  return {
    status: 'ok',
    daysOfHistory: series.length,
    slopePerDayNm2Ar: slope,
    forecastNm2Ar: slope * forecastX + intercept,
    forecastDaysAhead: opts.forecastDaysAhead,
  }
}
