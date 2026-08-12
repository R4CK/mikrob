import { formatMFtPerM2 } from '../format.js'

export interface MedianBandCardsProps {
  hazMedianNm2: number | null
  hazBandCount: number
  lakasMedianNm2: number | null
  lakasBandCount: number
  bandPct?: number
}

function BandCard({ label, median, count, bandPct }: { label: string; median: number | null; count: number; bandPct: number }) {
  if (median === null) {
    return (
      <div className="median-band-card">
        <strong>{label}</strong>
        <div>—</div>
      </div>
    )
  }
  const lo = median * (1 - bandPct)
  const hi = median * (1 + bandPct)
  return (
    <div className="median-band-card">
      <strong>{label}</strong>
      <div>
        {formatMFtPerM2(lo)} – {formatMFtPerM2(hi)} (±{Math.round(bandPct * 100)}%, medián: {formatMFtPerM2(median)})
      </div>
      <div>{count} db a sávon belül</div>
    </div>
  )
}

export function MedianBandCards({ hazMedianNm2, hazBandCount, lakasMedianNm2, lakasBandCount, bandPct = 0.05 }: MedianBandCardsProps) {
  return (
    <div className="median-band-cards">
      <BandCard label="Ház" median={hazMedianNm2} count={hazBandCount} bandPct={bandPct} />
      <BandCard label="Lakás" median={lakasMedianNm2} count={lakasBandCount} bandPct={bandPct} />
    </div>
  )
}
