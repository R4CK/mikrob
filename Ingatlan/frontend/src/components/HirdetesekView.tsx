import { useMemo, useState } from 'react'
import type { Listing } from '../types.js'
import { formatHuf, formatMFtPerM2, formatPct } from '../format.js'
import { listingsToCsv, downloadCsv } from '../csv-export.js'
import { ListingDetailPanel } from './ListingDetailPanel.js'
import { LoadingState, EmptyState, ScraperErrorState, OfflineState } from './StatePanel.js'
import { useApiData } from '../hooks/useApiData.js'
import { fetchListings } from '../api-client.js'

type FilterId = 'mind' | 'haz' | 'lakas' | 'mediansav'
type SortCol = 'ar' | 'nm2_ar' | 'alapterulet_m2' | 'delta_pct'
type SortDir = 'asc' | 'desc'
interface SortConfig { col: SortCol; dir: SortDir }

const FILTERS: Array<{ id: FilterId; label: string }> = [
  { id: 'mind', label: 'Mind' },
  { id: 'haz', label: 'Ház' },
  { id: 'lakas', label: 'Lakás' },
  { id: 'mediansav', label: '⬤ Mediánsávban' },
]

const MEDIAN_PILL_LABEL: Record<NonNullable<Listing['median_rel']>, string> = {
  belul: '⬤ belül',
  folott: '↑ fölött',
  alatt: '↓ alatt',
}

function applyFilter(listings: Listing[], filter: FilterId): Listing[] {
  if (filter === 'haz') return listings.filter((l) => l.tipus === 'haz')
  if (filter === 'lakas') return listings.filter((l) => l.tipus === 'lakas')
  if (filter === 'mediansav') return listings.filter((l) => l.median_rel === 'belul')
  return listings
}

export function applySort(listings: Listing[], sort: SortConfig | null): Listing[] {
  if (!sort) return listings
  const { col, dir } = sort
  return [...listings].sort((a, b) => {
    const av = a[col] ?? (dir === 'asc' ? Infinity : -Infinity)
    const bv = b[col] ?? (dir === 'asc' ? Infinity : -Infinity)
    return dir === 'asc' ? (av as number) - (bv as number) : (bv as number) - (av as number)
  })
}

function SortableTh({
  col, label, sort, onSort,
}: { col: SortCol; label: string; sort: SortConfig | null; onSort: (col: SortCol) => void }) {
  const active = sort?.col === col
  const indicator = active ? (sort!.dir === 'asc' ? ' ▲' : ' ▼') : ''
  return (
    <th
      className={`sortable-th${active ? ' sorted' : ''}`}
      onClick={() => onSort(col)}
      aria-sort={active ? (sort!.dir === 'asc' ? 'ascending' : 'descending') : 'none'}
    >
      {label}{indicator}
    </th>
  )
}

export function HirdetesekView() {
  const listings = useApiData(fetchListings)
  const [filter, setFilter] = useState<FilterId>('mind')
  const [sort, setSort] = useState<SortConfig | null>(null)
  const [selectedId, setSelectedId] = useState<string | null>(null)

  function handleSort(col: SortCol) {
    setSort((prev) =>
      prev?.col === col
        ? { col, dir: prev.dir === 'asc' ? 'desc' : 'asc' }
        : { col, dir: 'asc' },
    )
  }

  const filtered = useMemo(
    () =>
      listings.state.status === 'data'
        ? applySort(applyFilter(listings.state.value, filter), sort)
        : [],
    [listings.state, filter, sort],
  )
  const selected = listings.state.status === 'data' ? listings.state.value.find((l) => l.id === selectedId) ?? null : null

  if (listings.state.status === 'loading') return <LoadingState />
  if (listings.state.status === 'error') {
    if (listings.state.error.status === 0) return <OfflineState onRefresh={listings.reload} />
    return (
      <ScraperErrorState
        message="Hiba történt a hirdetések betöltésekor. Ellenőrizd a naplót."
        onRefresh={listings.reload}
      />
    )
  }
  if (listings.state.value.length === 0) return <EmptyState onRefresh={listings.reload} />

  return (
    <div className="hirdetesek-view">
      <div className="hirdetesek-toolbar">
        <div className="filter-bar">
          {FILTERS.map((f) => (
            <button
              key={f.id}
              type="button"
              className={`filter-chip${filter === f.id ? ' active' : ''}`}
              onClick={() => setFilter(f.id)}
              aria-pressed={filter === f.id}
            >
              {f.label}
            </button>
          ))}
        </div>
        <button type="button" className="csv-btn" onClick={() => downloadCsv('hirdetesek.csv', listingsToCsv(filtered))}>
          ⬇ CSV export
        </button>
      </div>

      <div className="table-scroll">
        <table className="listings">
          <thead>
            <tr>
              <th>Cím</th>
              <th>Típus</th>
              <SortableTh col="alapterulet_m2" label="Alapterület" sort={sort} onSort={handleSort} />
              <SortableTh col="ar" label="Ár" sort={sort} onSort={handleSort} />
              <SortableTh col="nm2_ar" label="nm²-ár" sort={sort} onSort={handleSort} />
              <SortableTh col="delta_pct" label="Δ ár" sort={sort} onSort={handleSort} />
              <th>Mediánsáv</th>
            </tr>
          </thead>
          <tbody>
            {filtered.map((l) => (
              <tr
                key={l.id}
                className={l.median_rel === 'belul' ? 'in-band listing-row' : 'listing-row'}
                onClick={() => setSelectedId(l.id)}
                tabIndex={0}
                role="button"
                aria-label={`Részletek: ${l.cim ?? l.id}`}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' || e.key === ' ') setSelectedId(l.id)
                }}
              >
                <td className="listing-cim" title={l.cim ?? l.id}>
                  {l.cim ?? l.id}
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
      </div>
      <p className="listings-count">
        {filtered.length === 0 ? 'Nincs a szűrésnek megfelelő hirdetés.' : `${filtered.length} hirdetés`}
      </p>

      {selected && <ListingDetailPanel listing={selected} onClose={() => setSelectedId(null)} />}
    </div>
  )
}
