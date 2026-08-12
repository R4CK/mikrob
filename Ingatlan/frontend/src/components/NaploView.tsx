import { useMemo, useState } from 'react'
import type { IngestLogEntry } from '../types.js'
import { LoadingState, EmptyState, ScraperErrorState, OfflineState } from './StatePanel.js'
import { useApiData } from '../hooks/useApiData.js'
import { fetchIngestLog } from '../api-client.js'

function NaploRow({ entry }: { entry: IngestLogEntry }) {
  const [expanded, setExpanded] = useState(false)
  const when = new Date(entry.ran_at).toLocaleString('hu-HU')

  return (
    <li className={`log-row${entry.ok ? '' : ' log-row-error'}`}>
      <div className="log-row-main">
        <span className={`log-dot ${entry.ok ? 'ok' : 'err'}`} aria-hidden="true" />
        <span className="log-time">{when}</span>
        {entry.ok ? (
          <span className="log-stats">
            <span className="log-stat">🏠 {entry.new_listings} új</span>
            <span className="log-stat">💶 {entry.price_changes} árváltozás</span>
            {entry.rejected_count > 0 && (
              <span className="log-stat log-stat-warn">⚠️ {entry.rejected_count} elutasítva</span>
            )}
          </span>
        ) : (
          <span className="log-stats">
            <span className="log-stat log-stat-warn">Hiba történt a futás során</span>
          </span>
        )}
        {!entry.ok && entry.error && (
          <button
            type="button"
            className="icon-button log-chevron"
            onClick={() => setExpanded((v) => !v)}
            aria-expanded={expanded}
            aria-label="Hibaüzenet megjelenítése"
          >
            {expanded ? '▲' : '▼'}
          </button>
        )}
      </div>
      {expanded && entry.error && <p className="log-error-detail">{entry.error}</p>}
    </li>
  )
}

export function NaploView() {
  const log = useApiData(fetchIngestLog)
  const errorCount = useMemo(
    () => (log.state.status === 'data' ? log.state.value.filter((e) => !e.ok).length : 0),
    [log.state],
  )

  if (log.state.status === 'loading') return <LoadingState />
  if (log.state.status === 'error') {
    if (log.state.error.status === 0) return <OfflineState onRefresh={log.reload} />
    return <ScraperErrorState message="Hiba történt a napló betöltésekor." onRefresh={log.reload} />
  }
  if (log.state.value.length === 0) return <EmptyState onRefresh={log.reload} />

  return (
    <div className="naplo-view">
      <div className="naplo-header">
        <h3 className="naplo-title">Napló</h3>
        <div className="naplo-summary">
          <span className="log-stat">{log.state.value.length} futás</span>
          {errorCount > 0 && <span className="log-stat log-stat-warn">{errorCount} hiba</span>}
        </div>
      </div>
      <ul className="log-list">
        {log.state.value.map((entry, i) => (
          // ran_at is not unique across rapid successive runs -- index is stable within one
          // already-fetched, never-reordered snapshot, which is all a list key needs here.
          <NaploRow key={`${entry.ran_at}-${i}`} entry={entry} />
        ))}
      </ul>
    </div>
  )
}
