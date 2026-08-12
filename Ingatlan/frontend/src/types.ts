// Mirrors the backend's wire contract exactly (Ingatlan/src/webapp/build-*.ts). Raw HUF
// throughout -- see build-market-summary.ts's own comment for why the API does not pre-divide
// into millions; this file's format.ts does that conversion for display.

export interface MarketSummary {
  haz_median_nm2: number | null
  lakas_median_nm2: number | null
  haz_avg_nm2: number | null
  lakas_avg_nm2: number | null
  haz_min_nm2: number | null
  lakas_min_nm2: number | null
  haz_max_nm2: number | null
  lakas_max_nm2: number | null
  aktiv_db: number
  utolso_frissites: string | null
  delta_haz_pct: number | null
  delta_lakas_pct: number | null
}

export interface TrendPoint {
  datum: string
  haz_nm2: number | null
  lakas_nm2: number | null
}

export type MedianRel = 'belul' | 'folott' | 'alatt' | null

export interface ListingArHistoryPoint {
  datum: string
  ar: number
}

export interface Listing {
  id: string
  url: string
  tipus: 'haz' | 'lakas'
  cim: string | null
  alapterulet_m2: number | null
  ar: number
  nm2_ar: number
  delta_pct: number | null
  median_rel: MedianRel
  ar_history: ListingArHistoryPoint[]
  elso_eszlelt_at: string
}
