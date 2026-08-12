import { useMemo } from 'react'
import { useApiData } from '../hooks/useApiData.js'
import { fetchMarketSummary, fetchTrend, fetchListings, ApiError } from '../api-client.js'
import { buildPriceDistribution } from '../price-distribution.js'
import { KpiStrip } from './KpiStrip.js'
import { TrendChart } from './TrendChart.js'
import { DistChart } from './DistChart.js'
import { MedianBandCards } from './MedianBandCards.js'
import { ListingsPreviewTable } from './ListingsPreviewTable.js'
import { LoadingState, EmptyState, ScraperErrorState, OfflineState } from './StatePanel.js'

export function PiacView({ onViewAllListings }: { onViewAllListings: () => void }) {
  const summary = useApiData(fetchMarketSummary)
  const trend = useApiData(fetchTrend)
  const listings = useApiData(fetchListings)

  const distribution = useMemo(
    () => (listings.state.status === 'data' ? buildPriceDistribution(listings.state.value) : []),
    [listings.state],
  )
  const mediansavDb = useMemo(
    () => (listings.state.status === 'data' ? listings.state.value.filter((l) => l.median_rel === 'belul').length : 0),
    [listings.state],
  )

  if (summary.state.status === 'loading' || trend.state.status === 'loading' || listings.state.status === 'loading') {
    return <LoadingState />
  }

  const firstError = [summary.state, trend.state, listings.state].find(
    (s): s is { status: 'error'; error: ApiError } => s.status === 'error',
  )
  if (firstError) {
    if (firstError.error.status === 0) {
      return <OfflineState onRefresh={() => { summary.reload(); trend.reload(); listings.reload() }} />
    }
    return (
      <ScraperErrorState
        message="Hiba történt az adatok betöltésekor. Ellenőrizd a naplót."
        onRefresh={() => { summary.reload(); trend.reload(); listings.reload() }}
      />
    )
  }

  // All three loaded successfully past this point (TypeScript can't narrow the union across 3
  // independent hooks, so a defensive re-check instead of a non-null assertion).
  if (summary.state.status !== 'data' || trend.state.status !== 'data' || listings.state.status !== 'data') {
    return <LoadingState />
  }

  if (summary.state.value.aktiv_db === 0) {
    return <EmptyState onRefresh={() => { summary.reload(); trend.reload(); listings.reload() }} />
  }

  return (
    <div>
      <KpiStrip
        hazMedianNm2={summary.state.value.haz_median_nm2}
        hazDeltaPct={summary.state.value.delta_haz_pct}
        lakasMedianNm2={summary.state.value.lakas_median_nm2}
        lakasDeltaPct={summary.state.value.delta_lakas_pct}
        aktivDb={summary.state.value.aktiv_db}
        mediansavDb={mediansavDb}
      />
      <div className="charts-row">
        <div className="chart-card">
          <TrendChart data={trend.state.value} />
        </div>
        <div className="chart-card">
          <DistChart data={distribution} />
        </div>
      </div>
      <MedianBandCards
        hazMedianNm2={summary.state.value.haz_median_nm2}
        hazBandCount={listings.state.value.filter((l) => l.tipus === 'haz' && l.median_rel === 'belul').length}
        lakasMedianNm2={summary.state.value.lakas_median_nm2}
        lakasBandCount={listings.state.value.filter((l) => l.tipus === 'lakas' && l.median_rel === 'belul').length}
      />
      <ListingsPreviewTable listings={listings.state.value} onViewAll={onViewAllListings} />
    </div>
  )
}
