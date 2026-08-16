// === "Last updated" sidebar badge ===
// app.js modularisation slice 42.
// Sourced from GET /api/status's lastUpdate field: {timestamp, toSha, version, source}.
// Globals from app.js: t (i18n runtime), window.fetch (patched by auth IIFE)
// app-last-update.js loads AFTER app.js, so the auth IIFE has already patched fetch.
// Exposed globally: renderLastUpdateBadge(), refreshLastUpdateBadge()

function renderLastUpdateBadge(lu) {
  const textEl = document.getElementById('sidebarUpdateText')
  const wrapEl = document.getElementById('sidebarUpdateBadge')
  if (!textEl) return
  if (!lu || !lu.timestamp) {
    textEl.textContent = t('lastUpdate.unknown')
    if (wrapEl) wrapEl.title = ''
    return
  }
  let local
  try {
    local = new Date(lu.timestamp).toLocaleString([], {
      timeZone: 'Europe/Budapest', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit',
    })
  } catch {
    textEl.textContent = t('lastUpdate.unknown')
    if (wrapEl) wrapEl.title = ''
    return
  }
  // source distinguishes a REAL recorded update (store/.update-history) from the built-commit
  // fallback (dist/.built-commit mtime -- just "when was this build produced", which a rebuild
  // with no version change also touches). Worded differently so the weaker signal never reads
  // as a confirmed update.
  const key = lu.source === 'update-history'
    ? (lu.version ? 'lastUpdate.updated' : 'lastUpdate.updatedNoVersion')
    : (lu.version ? 'lastUpdate.build' : 'lastUpdate.buildNoVersion')
  textEl.textContent = t(key, { time: local, version: lu.version || '' })
  if (wrapEl) {
    wrapEl.title = lu.toSha ? t('lastUpdate.shaTitle', { sha: lu.toSha.slice(0, 12) }) : ''
  }
}

async function refreshLastUpdateBadge() {
  if (!document.getElementById('sidebarUpdateText')) return
  try {
    const res = await fetch('/api/status')
    const data = await res.json()
    renderLastUpdateBadge(data.lastUpdate)
  } catch {
    renderLastUpdateBadge(null)
  }
}

// init-time call: moved here from app.js (slice 42).
// Must run AFTER the auth IIFE patches window.fetch -- which is guaranteed because
// app-last-update.js loads after app.js completes (all of app.js, including the IIFE, runs first).
// card f597369b: was previously just after the auth IIFE in app.js for the same reason.
try {
  refreshLastUpdateBadge()
} catch {
  // Non-fatal: the badge is cosmetic, failure must never block anything else on the page.
}
