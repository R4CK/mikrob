// The 4 non-data states every view can be in (DESIGN-IA.md section 4). "Loading" is intentionally
// NOT here -- it renders inline per-view (a spinner over the existing layout), while these three
// replace the whole content area.
export function EmptyState({ onRefresh }: { onRefresh: () => void }) {
  return (
    <div className="state-panel">
      <span style={{ fontSize: '2rem' }}>📭</span>
      <p>Még nincs adat</p>
      <button type="button" onClick={onRefresh}>
        Azonnali frissítés indítása
      </button>
    </div>
  )
}

export function ScraperErrorState({ message, onRefresh }: { message: string; onRefresh: () => void }) {
  return (
    <div className="state-panel">
      <span style={{ fontSize: '2rem' }}>⚠️</span>
      <p>{message}</p>
      <button type="button" onClick={onRefresh}>
        Újrapróbálkozás
      </button>
    </div>
  )
}

export function OfflineState({ onRefresh }: { onRefresh: () => void }) {
  return (
    <div className="state-panel">
      <span style={{ fontSize: '2rem' }}>🔌</span>
      <p>Nincs kapcsolat a helyi API-val — ellenőrizd, fut-e a szerver</p>
      <button type="button" onClick={onRefresh}>
        Újrapróbálkozás
      </button>
    </div>
  )
}

export function LoadingState() {
  return (
    <div className="state-panel">
      <span style={{ fontSize: '2rem' }} aria-hidden="true">
        ⏳
      </span>
      <p>Betöltés…</p>
    </div>
  )
}
