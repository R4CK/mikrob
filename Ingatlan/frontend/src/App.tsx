import { useEffect, useState } from 'react'
import './styles.css'
import { TopBar } from './components/TopBar.js'
import { Nav, type ViewId } from './components/Nav.js'
import { PiacView } from './components/PiacView.js'
import { useApiData } from './hooks/useApiData.js'
import { fetchMarketSummary } from './api-client.js'

const THEME_STORAGE_KEY = 'ingatlan-theme'

function usePersistedTheme(): [ 'light' | 'dark', () => void ] {
  const [theme, setTheme] = useState<'light' | 'dark'>(() => {
    const stored = window.localStorage.getItem(THEME_STORAGE_KEY)
    return stored === 'light' || stored === 'dark' ? stored : 'dark'
  })
  useEffect(() => {
    document.documentElement.dataset.theme = theme
    window.localStorage.setItem(THEME_STORAGE_KEY, theme)
  }, [theme])
  const toggle = () => setTheme((t) => (t === 'dark' ? 'light' : 'dark'))
  return [theme, toggle]
}

// Hirdetések and Napló (card 1f51f050) are not built yet -- a clearly-labelled placeholder, not
// a silently broken tab, keeps the shell honest about what is and isn't wired.
function ComingSoon({ label }: { label: string }) {
  return (
    <div className="state-panel">
      <span style={{ fontSize: '2rem' }}>🚧</span>
      <p>{label} nézet hamarosan (kártya 1f51f050)</p>
    </div>
  )
}

export function App() {
  const [theme, toggleTheme] = usePersistedTheme()
  const [view, setView] = useState<ViewId>('piac')
  // The top bar's freshness indicator needs utolso_frissites regardless of which view is active
  // -- fetched once here, not duplicated inside PiacView's own summary fetch.
  const summary = useApiData(fetchMarketSummary)

  return (
    <div className="app-shell">
      <TopBar
        utolsoFrissites={summary.state.status === 'data' ? summary.state.value.utolso_frissites : null}
        theme={theme}
        onToggleTheme={toggleTheme}
      />
      <Nav
        active={view}
        onChange={setView}
        aktivDb={summary.state.status === 'data' ? summary.state.value.aktiv_db : null}
      />
      <main className="content">
        {view === 'piac' && <PiacView onViewAllListings={() => setView('hirdetesek')} />}
        {view === 'hirdetesek' && <ComingSoon label="Hirdetések" />}
        {view === 'naplo' && <ComingSoon label="Napló" />}
      </main>
    </div>
  )
}
