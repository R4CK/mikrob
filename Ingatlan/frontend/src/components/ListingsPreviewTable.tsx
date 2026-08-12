import type { Listing } from '../types.js'
import { formatHuf, formatMFtPerM2, formatPct } from '../format.js'

const MEDIAN_PILL_LABEL: Record<NonNullable<Listing['median_rel']>, string> = {
  belul: '⬤ belül',
  folott: '↑ fölött',
  alatt: '↓ alatt',
}

export function ListingsPreviewTable({ listings, onViewAll }: { listings: Listing[]; onViewAll: () => void }) {
  const preview = listings.slice(0, 8)

  return (
    <div>
      <table className="listings">
        <thead>
          <tr>
            <th>Cím</th>
            <th>Típus</th>
            <th>Alapterület</th>
            <th>Ár</th>
            <th>nm²-ár</th>
            <th>Δ ár</th>
            <th>Mediánsáv</th>
          </tr>
        </thead>
        <tbody>
          {preview.map((l) => (
            <tr key={l.id} className={l.median_rel === 'belul' ? 'in-band' : undefined}>
              <td>
                <a href={l.url} target="_blank" rel="noreferrer">
                  {l.cim ?? l.id}
                </a>
              </td>
              <td>
                <span className={`type-chip ${l.tipus}`}>{l.tipus === 'haz' ? 'ház' : 'lakás'}</span>
              </td>
              <td>{l.alapterulet_m2 ?? '—'} m²</td>
              <td>{formatHuf(l.ar)}</td>
              <td>{formatMFtPerM2(l.nm2_ar)}</td>
              <td>
                {l.delta_pct !== null && (
                  <span className={`delta ${l.delta_pct <= 0 ? 'good' : 'warn'}`}>{formatPct(l.delta_pct)}</span>
                )}
              </td>
              <td>{l.median_rel && <span className={`median-pill ${l.median_rel}`}>{MEDIAN_PILL_LABEL[l.median_rel]}</span>}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {listings.length > preview.length && (
        <button type="button" onClick={onViewAll} style={{ marginTop: 8 }}>
          Összes ({listings.length}) →
        </button>
      )}
    </div>
  )
}
