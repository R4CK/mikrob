import { formatMFtPerM2, formatPct } from '../format.js'

export interface KpiStripProps {
  hazMedianNm2: number | null
  hazDeltaPct: number | null
  lakasMedianNm2: number | null
  lakasDeltaPct: number | null
  aktivDb: number
  mediansavDb: number
}

function DeltaLabel({ pct }: { pct: number | null }) {
  if (pct === null) return null
  return <span className={`delta ${pct <= 0 ? 'good' : 'warn'}`}>{formatPct(pct)}</span>
}

// DESIGN-IA.md section 3.1's 4-cell KPI strip. Cell 3 shows the active-listing count WITHOUT a
// weekly-change figure -- the backend contract (build-market-summary.ts) does not carry a
// week-over-week delta for aktiv_db, and fabricating one here would be a fake number, not a
// simplification worth making silently.
export function KpiStrip({
  hazMedianNm2,
  hazDeltaPct,
  lakasMedianNm2,
  lakasDeltaPct,
  aktivDb,
  mediansavDb,
}: KpiStripProps) {
  return (
    <div className="kpi-strip">
      <div className="kpi-cell">
        <div className="label">Ház – medián nm²-ár</div>
        <div className="value">{formatMFtPerM2(hazMedianNm2)}</div>
        <DeltaLabel pct={hazDeltaPct} />
      </div>
      <div className="kpi-cell">
        <div className="label">Lakás – medián nm²-ár</div>
        <div className="value">{formatMFtPerM2(lakasMedianNm2)}</div>
        <DeltaLabel pct={lakasDeltaPct} />
      </div>
      <div className="kpi-cell">
        <div className="label">Aktív hirdetések</div>
        <div className="value">{aktivDb} db</div>
      </div>
      <div className="kpi-cell">
        <div className="label">Mediánsáv-egyezés (±5%)</div>
        <div className="value" style={{ color: 'var(--gold)' }}>
          {mediansavDb} db
        </div>
      </div>
    </div>
  )
}
