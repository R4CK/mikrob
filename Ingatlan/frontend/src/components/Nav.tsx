export type ViewId = 'piac' | 'hirdetesek' | 'naplo'

export interface NavProps {
  active: ViewId
  onChange: (view: ViewId) => void
  aktivDb: number | null
}

const ITEMS: Array<{ id: ViewId; icon: string; label: string }> = [
  { id: 'piac', icon: '📊', label: 'Piac' },
  { id: 'hirdetesek', icon: '🏘️', label: 'Hirdetések' },
  { id: 'naplo', icon: '📋', label: 'Napló' },
]

// One component for both the desktop sidebar and the mobile bottom tab bar (DESIGN-IA.md section
// 8) -- the CSS media query changes the LAYOUT, not the markup, so there is no duplicate nav tree
// to keep in sync.
export function Nav({ active, onChange, aktivDb }: NavProps) {
  return (
    <nav className="nav" aria-label="Fő navigáció">
      {ITEMS.map((item) => (
        <button
          key={item.id}
          type="button"
          className={`nav-item${item.id === active ? ' active' : ''}`}
          onClick={() => onChange(item.id)}
          aria-current={item.id === active ? 'page' : undefined}
        >
          <span aria-hidden="true">{item.icon}</span>
          {item.label}
          {item.id === 'hirdetesek' && aktivDb !== null && <span className="badge">{aktivDb}</span>}
        </button>
      ))}
    </nav>
  )
}
