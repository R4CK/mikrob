import { median } from '../analysis/stats.js'
import { dailyMedianSeries, type DailyMedian, type PricePoint } from '../analysis/trend.js'

// Wire contract for the "nm2-ar trend" chart (card 9ca81f45, Fron Ted's design). Raw HUF, NOT
// pre-divided into millions -- the rest of this backend (db.ts, ingest-validate.ts, analyze.ts)
// keeps ar/nm2Ar in raw HUF throughout, and the frontend already needs its own "M Ft" formatting
// step for the KPI strip regardless (Fron Ted's own analyze.ts CLI does this). One unit
// convention end-to-end avoids the unit-confusion class of bug a second, API-only convention
// would risk.
export interface TrendPoint {
  datum: string // YYYY-MM
  haz_nm2: number | null
  lakas_nm2: number | null
}

function monthKey(epochSeconds: number): string {
  const d = new Date(epochSeconds * 1000)
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`
}

// Downsamples a daily median series (trend.ts) into one point per calendar month -- the median
// of that month's daily medians, consistent with this project's median-first approach elsewhere.
function monthlyMedians(series: DailyMedian[]): Map<string, number> {
  const byMonth = new Map<string, number[]>()
  for (const point of series) {
    const key = monthKey(point.day)
    const arr = byMonth.get(key) ?? []
    arr.push(point.medianNm2Ar)
    byMonth.set(key, arr)
  }
  const result = new Map<string, number>()
  for (const [key, values] of byMonth) result.set(key, median(values))
  return result
}

// maxMonths caps the series to the most recent N months (the chart's own 12-month window,
// per Fron Ted's design) -- irrelevant while data is sparse, load-bearing once it is not.
export function buildTrendPoints(pricePoints: PricePoint[], maxMonths = 12): TrendPoint[] {
  const hazMonthly = monthlyMedians(dailyMedianSeries(pricePoints, 'haz'))
  const lakasMonthly = monthlyMedians(dailyMedianSeries(pricePoints, 'lakas'))
  const months = Array.from(new Set([...hazMonthly.keys(), ...lakasMonthly.keys()])).sort()
  const windowed = maxMonths > 0 ? months.slice(-maxMonths) : months
  return windowed.map((datum) => ({
    datum,
    haz_nm2: hazMonthly.get(datum) ?? null,
    lakas_nm2: lakasMonthly.get(datum) ?? null,
  }))
}
