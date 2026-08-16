// === Helpers: Toast, SVG icons, escapeHtml, STATUS_COMPONENT_LABELS ===
// app.js modularisation slice 41.
// Globals from app.js: t (window.t, i18n runtime)
// Globals from app-elements.js: toast (DOM ref -- used at call time, never parse time)
// Loaded after app-elements.js so that `toast` is already defined.
// Exposed globally: showToast(), pauseIcon(), playIcon(), trashIcon(),
//   escapeHtml(), STATUS_COMPONENT_LABELS

function showToast(msg, duration = 3000) {
  toast.textContent = msg
  toast.classList.add('visible')
  setTimeout(() => toast.classList.remove('visible'), duration)
}

function pauseIcon() {
  return '<svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="4" width="4" height="16" rx="1"/><rect x="14" y="4" width="4" height="16" rx="1"/></svg>'
}
function playIcon() {
  return '<svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><polygon points="5 3 19 12 5 21 5 3"/></svg>'
}
function trashIcon() {
  return '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 01-2 2H7a2 2 0 01-2-2V6m3 0V4a2 2 0 012-2h4a2 2 0 012 2v2"/></svg>'
}

function escapeHtml(str) {
  const d = document.createElement('div')
  d.textContent = str
  // textContent->innerHTML escapes & < > but NOT quotes. Encode quotes too so
  // the result is safe in ATTRIBUTE contexts as well as text nodes -- several
  // renderers interpolate escapeHtml() output into data-*/title/value="..."
  // attributes, where a surviving " would allow an attribute breakout.
  return d.innerHTML.replace(/"/g, '&quot;').replace(/'/g, '&#39;')
}

// Statuspage component status -> short label for non-operational states.
const STATUS_COMPONENT_LABELS = {
  operational: () => t('status.comp.operational'),
  degraded_performance: () => t('status.comp.degraded'),
  partial_outage: () => t('status.comp.partial_outage'),
  major_outage: () => t('status.comp.major_outage'),
  under_maintenance: () => t('status.comp.maintenance'),
}
