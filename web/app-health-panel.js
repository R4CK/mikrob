// web/app-health-panel.js -- Side-effect health panel (card 2d9c0bb2, pair-BE 0a527826)
// Globals from app.js: t, escapeHtml
// Global banner at the top of <main>, same pattern as #branchDriftBanner/#authSetupBanner:
// visible on every page, not page-scoped (health is dashboard-wide). Shows ONLY the red
// (unhealthy) entries; a fully healthy state takes no space (panel stays hidden).
//
// Contract-first (card 0a527826 still planned at build time): proposed
//   GET /api/health/effects -> { effects: [{ kind, status: 'ok'|'red', consecutiveFailures,
//                                             lastError, lastCheckedAt }] }
// posted as a comment on 0a527826/2d9c0bb2 for backend to align on or correct.
const HEALTH_PANEL_POLL_MS = 30000
let _healthPanelTimer = null

function healthPanelKindLabel(kind) {
  const key = 'healthPanel.kind.' + kind
  const label = t(key)
  // Real t() echoes the lookup key itself on a miss (never an empty string) -- comparing
  // against the key, not truthiness, is the only reliable miss-detection (card ebe20efe).
  return label !== key ? label : kind
}

async function loadSideEffectHealth() {
  const panel = document.getElementById('sideEffectHealthPanel')
  const list = document.getElementById('sideEffectHealthList')
  if (!panel || !list) return
  try {
    const res = await fetch('/api/health/effects')
    if (res.status === 404) { panel.hidden = true; list.innerHTML = ''; return } // pair-BE not yet landed
    if (!res.ok) throw new Error('HTTP ' + res.status)
    const d = await res.json()
    const effects = Array.isArray(d.effects) ? d.effects : []
    const red = effects.filter((e) => e && e.status === 'red')
    if (red.length === 0) {
      panel.hidden = true
      list.innerHTML = ''
      return
    }
    list.innerHTML = red.map((e) => `
      <li class="side-effect-health-row">
        <span class="side-effect-health-kind">${escapeHtml(healthPanelKindLabel(e.kind))}</span>
        <span class="side-effect-health-error">${escapeHtml(e.lastError || t('healthPanel.no_detail'))}</span>
      </li>
    `).join('')
    panel.hidden = false
  } catch {
    // A failed HEALTH-CHECK READ is not evidence that a side-effect itself is unhealthy --
    // hide rather than show a scary banner for our own fetch error (rule 12, but also "healthy
    // state takes no space": a transient network blip must not look like a real incident).
    panel.hidden = true
    list.innerHTML = ''
  }
}

function startHealthPanelPoll() {
  stopHealthPanelPoll()
  void loadSideEffectHealth()
  _healthPanelTimer = setInterval(() => void loadSideEffectHealth(), HEALTH_PANEL_POLL_MS)
}

function stopHealthPanelPoll() {
  if (_healthPanelTimer) { clearInterval(_healthPanelTimer); _healthPanelTimer = null }
}

// Global, not tied to any single page's switchPage lifecycle -- starts once at load and keeps
// polling regardless of which page is active.
startHealthPanelPoll()
