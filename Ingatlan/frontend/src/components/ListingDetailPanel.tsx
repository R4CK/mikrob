import type { Listing } from '../types.js'
import { formatHuf, formatMFtPerM2, formatPct } from '../format.js'
import { PriceHistory } from './PriceHistory.js'

const MEDIAN_REL_LABEL: Record<NonNullable<Listing['median_rel']>, string> = {
  belul: '⬤ belül',
  folott: '↑ fölött',
  alatt: '↓ alatt',
}

export function ListingDetailPanel({ listing, onClose }: { listing: Listing; onClose: () => void }) {
  return (
    <>
      <div className="detail-overlay" onClick={onClose} aria-hidden="true" />
      <div className="detail-panel" role="dialog" aria-label={listing.cim ?? listing.id}>
        <div className="detail-panel-header">
          <h3 className="detail-panel-title">{listing.cim ?? listing.id}</h3>
          <button type="button" className="icon-button detail-panel-close" onClick={onClose} aria-label="Bezárás">
            ✕
          </button>
        </div>

        <dl className="detail-meta">
          <dt>Típus</dt>
          <dd>
            <span className={`type-chip ${listing.tipus}`}>{listing.tipus === 'haz' ? 'ház' : 'lakás'}</span>
          </dd>
          <dt>Alapterület</dt>
          <dd>{listing.alapterulet_m2 ?? '—'} m²</dd>
          <dt>Ár</dt>
          <dd>{formatHuf(listing.ar)}</dd>
          <dt>nm²-ár</dt>
          <dd>{formatMFtPerM2(listing.nm2_ar)}</dd>
          <dt>Δ ár</dt>
          <dd>
            {listing.delta_pct !== null ? (
              <span className={`delta ${listing.delta_pct <= 0 ? 'good' : 'warn'}`}>{formatPct(listing.delta_pct)}</span>
            ) : (
              '—'
            )}
          </dd>
          <dt>Mediánsáv</dt>
          <dd>{listing.median_rel ? MEDIAN_REL_LABEL[listing.median_rel] : '—'}</dd>
        </dl>

        <div className="detail-chart-section">
          <h3>Árelőzmény</h3>
          <PriceHistory data={listing.ar_history} />
        </div>

        <a href={listing.url} target="_blank" rel="noreferrer" className="detail-link-btn">
          Megnyitás ingatlan.com-on →
        </a>
      </div>
    </>
  )
}
