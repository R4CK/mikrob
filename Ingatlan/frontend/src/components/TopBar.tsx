import { freshnessLevel } from '../format.js'

export interface TopBarProps {
  utolsoFrissites: string | null
  theme: 'light' | 'dark'
  onToggleTheme: () => void
}

export function TopBar({ utolsoFrissites, theme, onToggleTheme }: TopBarProps) {
  const level = freshnessLevel(utolsoFrissites)
  const label = utolsoFrissites
    ? `Frissítve: ${new Date(utolsoFrissites).toLocaleString('hu-HU')}`
    : 'Még nincs adat'

  return (
    <header className="top-bar">
      <div className="brand">
        🏡 Ingatlan Elemző
        <small>BP II. ker. · 50m²+ / 120M</small>
      </div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 16 }}>
        <span className="freshness-label" title={label}>
          <span className={`freshness-dot ${level}`} />
          <span className="freshness-text">{label}</span>
        </span>
        <button
          type="button"
          className="icon-button"
          onClick={onToggleTheme}
          aria-label="Téma váltása"
          title="Téma váltása"
        >
          {theme === 'dark' ? '☀️' : '🌙'}
        </button>
        <span className="user-chip">
          <span className="user-name">Peti · </span>
          <a href="/logout">kijelentkezés</a>
        </span>
      </div>
    </header>
  )
}
