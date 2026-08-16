// === Theme + Language toggle ===
// app.js modularisation slice 40.
// Globals from app.js: window.setLang (defined by i18n runtime IIFE at top of app.js)
// No globals exposed to other modules -- all state is in localStorage / window._lang.
// Loaded right after app.js; no dependency on app-elements.js or later modules.

const html = document.documentElement
const themeToggle = document.getElementById('themeToggle')
const savedTheme = localStorage.getItem('cc-theme')
if (savedTheme) {
  html.setAttribute('data-theme', savedTheme)
} else if (window.matchMedia('(prefers-color-scheme: dark)').matches) {
  html.setAttribute('data-theme', 'dark')
}
themeToggle.addEventListener('click', () => {
  const next = html.getAttribute('data-theme') === 'dark' ? 'light' : 'dark'
  html.setAttribute('data-theme', next)
  localStorage.setItem('cc-theme', next)
})

// Language toggle: wraps window.setLang (already defined by i18n runtime in app.js)
// so the button stays in sync when setLang is called from elsewhere (e.g. async settings load).
;(() => {
  const btn = document.getElementById('langToggle')
  if (!btn) return
  function syncLangBtn() {
    btn.textContent = (window._lang || 'hu').toUpperCase()
  }
  syncLangBtn()
  btn.addEventListener('click', () => {
    const next = (window._lang || 'hu') === 'hu' ? 'en' : 'hu'
    window.setLang(next)
    syncLangBtn()
  })
  // Keep button in sync when setLang is called from elsewhere (e.g. /api/settings async load).
  const _origSetLang = window.setLang
  window.setLang = function setLang(lang) {
    _origSetLang(lang)
    syncLangBtn()
  }
})()
