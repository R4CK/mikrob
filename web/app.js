// === Avatar cache-busting epoch ===
// Avatar URLs used to carry ?t=Date.now() on every render, which defeated the
// browser cache and re-downloaded ~1MB per avatar on each rerender (brutal on
// slow remote links). Instead the URLs are stable (server sends max-age +
// ETag) until an avatar is actually changed in THIS session, which bumps the
// epoch and re-busts every avatar URL rendered afterwards.
let _avatarEpoch = 0
function bumpAvatarEpoch() { _avatarEpoch = Date.now() }
function avatarBust() { return _avatarEpoch ? `?t=${_avatarEpoch}` : '' }

// === i18n runtime ===
// Priority: localStorage['marveen.lang'] > DASHBOARD_LANG (server default, read
// from /api/settings on init) > 'hu' (hardcoded fallback).
// Rick's spec (kanban card 209696a9): t(key,params), window._i18n={hu,en},
// window._lang; {name} interpolation; EN-fallback then key; dev-mode warning.
;(() => {
  const LS_KEY = 'marveen.lang'
  const VALID = new Set(['hu', 'en'])

  // Brand tokens ({brand} = product/brand name, {bot} = main agent display
  // name, {agentId} = canonical slug) are filled from /api/marveen once it
  // resolves (see initSidebarBrand). Until then these defaults keep a stock
  // install byte-identical. Explicit params passed to t() still win over them.
  window._brandTokens = window._brandTokens || { brand: 'Marveen', bot: 'Marveen', agentId: 'marveen' }

  window.t = function t(key, params = {}) {
    const lang = window._lang || 'hu'
    const str =
      window._i18n?.[lang]?.[key] ??
      window._i18n?.['en']?.[key] ??
      key
    if (str === key && localStorage.getItem('marveen.dev') === '1') {
      console.warn('[i18n] missing key:', key)
    }
    const vals = { ...window._brandTokens, ...params }
    return str.replace(/\{(\w+)\}/g, (_, k) => (vals[k] != null ? vals[k] : `{${k}}`))
  }

  function applyLang(lang) {
    window._lang = VALID.has(lang) ? lang : 'hu'
  }

  // Initialise from localStorage; server default fetched async below.
  applyLang(localStorage.getItem(LS_KEY) || 'hu')

  // Fetch server default (DASHBOARD_LANG) and apply only if localStorage not
  // set. Deferred to a MICROTASK: this IIFE evaluates before the fetch-wrapper
  // IIFE installs the Bearer-injecting window.fetch, so an eager call here
  // went out with the native fetch, got 401 from the /api gate, and the
  // server default was silently dead code. Microtasks run after the whole
  // classic script has evaluated, when window.fetch is the wrapped version.
  queueMicrotask(() => {
    fetch('/api/settings')
      .then(r => r.ok ? r.json() : null)
      .then(data => {
        if (!data || localStorage.getItem(LS_KEY)) return
        const entry = (data.settings || []).find(s => s.key === 'DASHBOARD_LANG')
        if (!entry || !VALID.has(entry.value) || entry.value === window._lang) return
        // Apply WITHOUT persisting (localStorage must keep overriding the
        // server default), and re-run the render dance: the initial
        // DOMContentLoaded render almost always beats this response, so a
        // plain applyLang would leave the page painted in the old language.
        applyLang(entry.value)
        if (typeof renderNav === 'function') renderNav()
        if (typeof renderStaticI18n === 'function') renderStaticI18n()
        const activeLink = document.querySelector('.sb-link.active[data-page]')
        if (activeLink && typeof switchPage === 'function') switchPage(activeLink.dataset.page)
      })
      .catch(() => {})
  })

  window.setLang = function setLang(lang) {
    if (!VALID.has(lang)) return
    window._lang = lang
    localStorage.setItem(LS_KEY, lang)
    renderNav()
    // Static elements (kanban column titles, hints, empty states) are otherwise
    // only translated at DOMContentLoaded -- re-apply them on every switch so the
    // currently-open page updates live, not just after a manual reload.
    if (typeof renderStaticI18n === 'function') renderStaticI18n()
    // Re-render the active page by re-triggering the switchPage handler.
    const activeLink = document.querySelector('.sb-link.active[data-page]')
    if (activeLink) {
      const pageId = activeLink.dataset.page
      if (typeof switchPage === 'function') switchPage(pageId)
    }
  }
})()

// === Dashboard auth bootstrap ===
// Card 62631948/8ca8576: the server no longer prints a ?token= startup URL (that put a
// root-equivalent credential in the service manager's log). A ?token= URL is still ACCEPTED
// here for anyone holding an older link -- on first visit we pluck it out, store it in
// localStorage, strip it from the visible URL, and inject it into every /api/* fetch as a
// Bearer header. The normal path now is the paste overlay (see handleAuthFailure below),
// fed from `cat store/.dashboard-token`.

// The main (channels) agent's real id. The backend /api/marveen route returns
// the configured MAIN_AGENT_ID (NOT the literal "marveen") in window._marveen;
// use this everywhere an agent id is sent to /api/agents/... or compared to a
// fleet name, so the dashboard works on non-"marveen" installs. Falls back to
// "marveen" only before /api/marveen has resolved (or on a legacy backend).
function mainAgentId() {
  return window._marveen?.agentId || 'marveen'
}

// Agents currently being run as SUBAGENTS inside MikroB's session (published to
// store/active-subagents.json, served at /subagent-state.json). Their cards get
// a blue running-ring instead of green, so it is clear the work runs in MikroB's
// session, not a separate one. Refreshed on a light interval.
let activeSubagents = new Set()
async function refreshSubagents() {
  try {
    const r = await fetch('/subagent-state.json', { cache: 'no-store' })
    if (r.ok) {
      const arr = await r.json()
      activeSubagents = new Set(Array.isArray(arr) ? arr.map(String) : [])
    }
  } catch { /* keep last known */ }
}
refreshSubagents()
setInterval(refreshSubagents, 5000);

// === "Last updated" sidebar badge (card 77be6b51, pairing 0898db66) ========
// Sourced from GET /api/status's lastUpdate field: {timestamp, toSha, version, source}.
// Present in that response even when the status.claude.com proxy call fails (it's computed
// before that call, see src/web/routes/status.ts) -- so a flaky external status feed can never
// blank the badge. Fetched once on load: the underlying fact (when did THIS install last
// update) changes on the order of days, not something worth a poll interval for.
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
try {
  refreshLastUpdateBadge()
} catch {
  // A failure here (env-specific quirk, extension interference, etc.) must never
  // block the auth/fetch-wrapping IIFE below -- that would silently break login
  // for the whole page. The badge is cosmetic; the token flow is not.
}

(() => {
  const TOKEN_KEY = 'marveen-dashboard-token'
  const urlParams = new URLSearchParams(window.location.search)
  const urlToken = urlParams.get('token')
  // Keep the token in memory for the whole session in addition to localStorage.
  // Some iOS/Safari privacy modes purge or block localStorage (especially over
  // plain http / non-primary origins); an in-memory copy keeps the session
  // authenticated even when the persisted copy is unavailable.
  let sessionToken = urlToken || ''
  if (urlToken) {
    try { localStorage.setItem(TOKEN_KEY, urlToken) } catch { /* storage blocked */ }
    urlParams.delete('token')
    const clean = window.location.pathname + (urlParams.toString() ? '?' + urlParams : '') + window.location.hash
    window.history.replaceState({}, '', clean)
  } else {
    try { sessionToken = localStorage.getItem(TOKEN_KEY) || '' } catch { /* storage blocked */ }
  }

  const originalFetch = window.fetch.bind(window)
  window.fetch = async (input, init) => {
    const url = typeof input === 'string' ? input : (input instanceof Request ? input.url : String(input))
    // Only attach the token to same-origin API calls. Relative paths always
    // resolve to same-origin; absolute URLs must match the current origin.
    const isSameOriginApi =
      url.startsWith('/api/') ||
      (url.startsWith(window.location.origin + '/api/'))
    if (isSameOriginApi) {
      let token = sessionToken
      if (!token) { try { token = localStorage.getItem(TOKEN_KEY) } catch { token = '' } }
      if (token) {
        init = init || {}
        const headers = new Headers(init.headers || (input instanceof Request ? input.headers : undefined))
        headers.set('Authorization', 'Bearer ' + token)
        init.headers = headers
      }
    }
    const res = await originalFetch(input, init)
    if (res.status === 401 && isSameOriginApi) {
      // Token missing, wrong, or revoked. Wipe and prompt once per page load.
      // Keep a URL-provided session token so a transient 401 does not lock out
      // a session whose localStorage copy was purged.
      try { localStorage.removeItem(TOKEN_KEY) } catch { /* storage blocked */ }
      if (!urlToken) sessionToken = ''
      if (!window.__marveenAuthPrompted) {
        window.__marveenAuthPrompted = true
        handleAuthFailure()
      }
    }
    return res
  }

  // On a 401, ask the public status probe whether a username+password login is
  // available on this instance. If so, show the login overlay; otherwise fall
  // back to the existing token flows (PWA paste field or the console-URL alert).
  async function handleAuthFailure() {
    let status = null
    try {
      const r = await originalFetch('/api/auth/status')
      if (r.ok) status = await r.json()
    } catch { /* offline or probe failed -- fall through to token flows */ }
    if (status && status.login_available) {
      showLoginOverlay()
      return
    }
    // The paste field is the token login for EVERY browser now, not just an
    // installed PWA (card 62631948). It used to be standalone-only because a
    // normal browser could be sent the server's `?token=...` startup URL --
    // but that URL printed a root-equivalent credential into the service
    // manager's log, so the server stopped emitting it. The token now comes
    // from `store/.dashboard-token`, which is a paste, not a link, and the
    // old `alert()` pointing at the server log would send the user looking
    // for a line that no longer exists.
    showStandaloneTokenPrompt(TOKEN_KEY)
  }

  // Full-screen username+password login overlay. Posts to /api/auth/login; on
  // success the browser has the mv_session cookie and we reload authenticated.
  function showLoginOverlay() {
    if (document.getElementById('mv-login-overlay')) return
    const tr = (k, fallback) => (typeof window.t === 'function' ? window.t(k) : fallback) || fallback
    const overlay = document.createElement('div')
    overlay.id = 'mv-login-overlay'
    overlay.className = 'mv-auth-overlay'
    overlay.innerHTML =
      '<form class="mv-auth-card" id="mv-login-form">' +
        '<h2>' + tr('auth.login.title', 'Sign in') + '</h2>' +
        '<p class="mv-auth-desc">' + tr('auth.login.desc', 'Enter your dashboard username and password.') + '</p>' +
        '<input id="mv-login-user" type="text" autocomplete="username" autocapitalize="off" autocorrect="off" spellcheck="false" placeholder="' + tr('auth.login.username', 'Username') + '">' +
        '<input id="mv-login-pass" type="password" autocomplete="current-password" placeholder="' + tr('auth.login.password', 'Password') + '">' +
        '<button type="submit" id="mv-login-submit">' + tr('auth.login.submit', 'Sign in') + '</button>' +
        '<div class="mv-auth-err" id="mv-login-err"></div>' +
      '</form>'
    document.body.appendChild(overlay)
    const form = overlay.querySelector('#mv-login-form')
    const userEl = overlay.querySelector('#mv-login-user')
    const passEl = overlay.querySelector('#mv-login-pass')
    const errEl = overlay.querySelector('#mv-login-err')
    const submitEl = overlay.querySelector('#mv-login-submit')
    form.addEventListener('submit', async (e) => {
      e.preventDefault()
      errEl.textContent = ''
      const username = (userEl.value || '').trim()
      const password = passEl.value || ''
      if (!username || !password) { errEl.textContent = tr('auth.login.err_empty', 'Enter a username and password.'); return }
      submitEl.disabled = true
      try {
        const r = await originalFetch('/api/auth/login', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ username, password }),
        })
        if (r.ok) { window.location.reload(); return }
        if (r.status === 429) {
          let retry = 0
          try { retry = (await r.json()).retry_after_s || 0 } catch { /* ignore */ }
          errEl.textContent = tr('auth.login.err_throttled', 'Too many attempts. Try again later.') + (retry ? ' (' + retry + 's)' : '')
        } else {
          errEl.textContent = tr('auth.login.err_invalid', 'Invalid credentials.')
        }
      } catch {
        errEl.textContent = tr('auth.login.err_network', 'Network error.')
      } finally {
        submitEl.disabled = false
      }
    })
    setTimeout(() => userEl.focus(), 50)
  }

  // Full-screen, one-time token paste (see the 401 handler). The user pastes the
  // access token -- from `store/.dashboard-token` on the server host, or from the
  // dashboard Settings / mobile-login QR -- and it is saved to this browser's
  // localStorage, then the page reloads authenticated. Still accepts a full
  // `?token=...` URL for anyone holding an older link.
  function showStandaloneTokenPrompt(tokenKey) {
    if (document.getElementById('mv-token-overlay')) return
    // Lang files are not yet loaded here; use a local inline lookup so EN mode works.
    const _lang = localStorage.getItem('marveen.lang') || 'hu'
    const _pwa = {
      hu: {
        title: 'Hozzáférés szükséges',
        desc: 'Illeszd be a dashboard access tokent. A szerver gépén: cat store/.dashboard-token (vagy a Beállítások / mobil-login QR). A token szándékosan nem szerepel a szerver indítási kimenetében, mert azt a szolgáltatáskezelő naplózza.',
        btn: 'Mentés és újratöltés',
        empty_token: 'Üres token.'
      },
      en: {
        title: 'Access Required',
        desc: 'Paste the dashboard access token. On the server host: cat store/.dashboard-token (or use Settings / the mobile-login QR). The token is deliberately absent from the server startup output, because the service manager captures it.',
        btn: 'Save & Reload',
        empty_token: 'Empty token.'
      }
    }
    const _p = _pwa[_lang] || _pwa.hu
    const overlay = document.createElement('div')
    overlay.id = 'mv-token-overlay'
    overlay.style.cssText = 'position:fixed;inset:0;z-index:99999;background:#1a1917;color:#faf9f5;' +
      'display:flex;align-items:center;justify-content:center;padding:24px;' +
      'font-family:system-ui,-apple-system,sans-serif'
    overlay.innerHTML =
      '<div style="max-width:420px;width:100%;display:flex;flex-direction:column;gap:14px">' +
        '<h2 style="margin:0;font-size:18px;text-align:center">' + _p.title + '</h2>' +
        '<p style="margin:0;font-size:14px;opacity:0.8;line-height:1.5;text-align:center">' +
          _p.desc + '</p>' +
        '<textarea id="mv-token-input" rows="3" autocapitalize="off" autocorrect="off" spellcheck="false" ' +
          'style="width:100%;box-sizing:border-box;padding:10px;border-radius:8px;border:1px solid #555;' +
          'background:#0f0e0d;color:#faf9f5;font-size:14px;font-family:monospace" placeholder="token..."></textarea>' +
        '<button id="mv-token-save" style="padding:12px;min-height:44px;border:0;border-radius:8px;' +
          'background:#10b981;color:#fff;font-size:15px;font-weight:600">' + _p.btn + '</button>' +
        '<div id="mv-token-err" style="color:#f87171;font-size:13px;min-height:16px;text-align:center"></div>' +
      '</div>'
    document.body.appendChild(overlay)
    const input = overlay.querySelector('#mv-token-input')
    const errEl = overlay.querySelector('#mv-token-err')
    const submit = () => {
      const raw = (input.value || '').trim()
      if (!raw) { errEl.textContent = _p.empty_token; return }
      // Accept either a bare token or the whole startup URL (the user often
      // pastes the full https://host/?token=... link). Pull just the token out.
      let token = raw
      if (raw.includes('token=')) {
        let extracted = null
        try { extracted = new URL(raw).searchParams.get('token') } catch { /* not a full URL */ }
        if (!extracted) {
          // covers ?token=, &token=, and the hash form (/#...?token=...)
          const m = raw.match(/[?&#]token=([^&#\s]+)/)
          if (m) extracted = m[1]
        }
        if (extracted) { try { token = decodeURIComponent(extracted) } catch { token = extracted } }
      }
      token = token.trim()
      if (!token) { errEl.textContent = _p.empty_token; return }
      localStorage.setItem(tokenKey, token)
      window.location.reload()
    }
    overlay.querySelector('#mv-token-save').addEventListener('click', submit)
    setTimeout(() => input.focus(), 50)
  }
})()

// === Theme ===
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

// === Language toggle ===
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

// === Page switching ===
const navLinks = document.querySelectorAll('.sb-link[data-page], .nav-link[data-page]')
const pages = document.querySelectorAll('.page')

function confirmSettingsLeave() {
  if (settingsDirty.size === 0) return true
  return window.confirm(t('settings.unsaved_warning'))
}

function switchPage(pageId) {
  // 'team' is merged into 'agents'; any internal call still passing 'team' redirects.
  if (pageId === 'team') { _agentsActiveView = 'tree'; pageId = 'agents' }
  // Guard unsaved settings before leaving the settings page
  if (!document.getElementById('settingsPage').hidden && pageId !== 'settings' && !confirmSettingsLeave()) return
  pages.forEach((p) => (p.hidden = p.id !== pageId + 'Page'))
  navLinks.forEach((l) => l.classList.toggle('active', l.dataset.page === pageId))
  openSidebarGroupForPage(pageId)
  // Kanban needs full-width layout (overrides main's max-width: 1200px)
  document.querySelector('main').classList.toggle('kanban-active', pageId === 'kanban')
  // Activity page runs a live poll; stop it whenever we navigate away.
  if (pageId !== 'activity') stopActivityPoll()
  if (pageId === 'activity') startActivityPoll()
  // Agents page tints each Terminal button green while that agent is working;
  // same 3s poll + source as Activity. Stop it when we leave the page.
  if (pageId !== 'agents') stopAgentsBusyPoll()
  // Kanban auto-refresh: start on enter, stop on leave.
  if (pageId !== 'kanban') stopKanbanRefresh()
  // Overview's live utilization spectrum runs its own poll + rAF scroll loop; stop both on leave.
  if (pageId !== 'overview') stopOvwSpectrum()
  if (pageId === 'overview') loadOverview()
  if (pageId === 'kanban') { if (typeof _initGanttViewSwitcher === 'function') _initGanttViewSwitcher(); loadKanban(); startKanbanRefresh() }
  if (pageId === 'tasks') loadSchedules()
  if (pageId === 'agents') { loadAgents().then(() => _setAgentsView(_agentsActiveView || 'grid')); startAgentsBusyPoll() }
  if (pageId === 'memories') { loadMemAgents(); loadMemStats(); loadMemories() }
  if (pageId === 'skills') loadGlobalSkills()
  if (pageId !== 'localLlm') stopLocalLlmPoll()
  if (pageId === 'localLlm') loadLocalLlm()
  if (pageId === 'connectors') loadConnectors()
  if (pageId === 'migrate') loadMigrateAgents()
  if (pageId === 'docs') loadDocs()
  if (pageId === 'research') loadResearch()
  if (pageId === 'status') loadStatus()
  if (pageId === 'recall') loadRecallPage()
  if (pageId === 'bgTasks') loadBgTasksPage()
  if (pageId === 'vault') loadVaultPage()
  if (pageId === 'approvals') loadApprovalsPage()
  if (pageId === 'settings') loadSettings()
  if (pageId === 'updates') loadUpdates()
  if (pageId === 'repos') loadReposPage()
  // 'team' page is merged into 'agents' -- redirect for any lingering deep-links
  if (pageId === 'messages') loadMessagesPage()
  if (pageId === 'tokenUsage') loadTokenUsage()
  if (pageId === 'costs') loadCosts()
  if (pageId === 'ideas') loadIdeasPage()
  if (pageId === 'archived') loadArchivedPage()
  if (pageId === 'naplo') loadNaplo()
  if (pageId === 'federation') loadFederationPage()
}

// Mobile off-canvas sidebar toggle. No-op visual effect on desktop (the
// hamburger/backdrop are display:none there); on narrow screens it slides the
// sidebar in over a backdrop.
const sidebarEl = document.querySelector('.sidebar')
const sidebarBackdrop = document.getElementById('sidebarBackdrop')
const mobileMenuBtn = document.getElementById('mobileMenuBtn')
function setSidebarOpen(open) {
  if (sidebarEl) sidebarEl.classList.toggle('open', open)
  if (sidebarBackdrop) sidebarBackdrop.classList.toggle('open', open)
  if (mobileMenuBtn) mobileMenuBtn.setAttribute('aria-expanded', open ? 'true' : 'false')
}
if (mobileMenuBtn) mobileMenuBtn.addEventListener('click', () => setSidebarOpen(!sidebarEl.classList.contains('open')))
if (sidebarBackdrop) sidebarBackdrop.addEventListener('click', () => setSidebarOpen(false))

navLinks.forEach((link) => {
  link.addEventListener('click', (e) => {
    e.preventDefault()
    const pageId = link.dataset.page
    // Same hash won't fire 'hashchange', so re-render manually; otherwise let the
    // hashchange listener drive switchPage so the URL stays the single source of truth.
    if (location.hash.slice(1) === pageId) switchPage(pageId)
    else location.hash = pageId
    setSidebarOpen(false) // close the drawer after navigating on mobile
  })
})

// === Collapsible sidebar groups ===
// Open/closed state lives in localStorage (marveen.sidebarGroups) as a JSON
// array of open group keys. Missing or corrupt state means everything starts
// collapsed -- that is the designed default, not an error.
const SIDEBAR_GROUPS_LS_KEY = 'marveen.sidebarGroups'
// Declarative single source of truth for the group -> pages mapping. The markup
// order is only the default snapshot: at boot the static links are re-parented
// into their group containers per this map, so regrouping a page (say, moving
// naplo under system) or relabeling a group is a one-line change right here.
const SIDEBAR_GROUPS = [
  { key: 'team',        labelKey: 'nav.group.team',        pages: ['agents', 'activity', 'messages', 'tasks', 'bgTasks'] },
  { key: 'knowledge',   labelKey: 'nav.group.knowledge',   pages: ['memories', 'skills', 'research', 'ideas'] },
  { key: 'stats',       labelKey: 'nav.group.stats',       pages: ['costs', 'tokenUsage'] },
  { key: 'system',      labelKey: 'nav.group.system',      pages: ['status', 'naplo', 'updates', 'repos', 'settings', 'vault'] },
  { key: 'connections', labelKey: 'nav.group.connections', pages: ['connectors', 'federation', 'migrate'] },
]
const sidebarGroupEls = document.querySelectorAll('.sb-group[data-group]')
// data-page -> group key, derived from the map (not the DOM) so the map wins.
const PAGE_SIDEBAR_GROUP = {}
SIDEBAR_GROUPS.forEach((def) => def.pages.forEach((p) => { PAGE_SIDEBAR_GROUP[p] = def.key }))
// Re-parent the 23 static links to match the map. Moving an existing DOM node
// does not invalidate the navLinks refs captured by querySelectorAll at boot.
SIDEBAR_GROUPS.forEach((def) => {
  const group = document.querySelector(`.sb-group[data-group="${def.key}"]`)
  if (!group) return
  const label = group.querySelector('.sb-group-label')
  if (label) label.dataset.i18n = def.labelKey
  const items = group.querySelector('.sb-group-items')
  if (!items) return
  def.pages.forEach((p) => {
    const link = document.querySelector(`.sb-link[data-page="${p}"]`)
    if (link) items.appendChild(link)
  })
})

function loadSidebarGroupState() {
  try {
    const arr = JSON.parse(localStorage.getItem(SIDEBAR_GROUPS_LS_KEY))
    return Array.isArray(arr) ? arr.filter((k) => typeof k === 'string') : []
  } catch { return [] }
}

function setSidebarGroupOpen(groupEl, open, persist = true) {
  groupEl.classList.toggle('open', open)
  const btn = groupEl.querySelector('.sb-group-header')
  if (btn) btn.setAttribute('aria-expanded', open ? 'true' : 'false')
  if (persist) {
    const key = groupEl.dataset.group
    const state = loadSidebarGroupState().filter((k) => k !== key)
    if (open) state.push(key)
    try { localStorage.setItem(SIDEBAR_GROUPS_LS_KEY, JSON.stringify(state)) } catch {}
  }
}

// Called from switchPage: the active page's group must always be visible so the
// "where am I" highlight is never hidden inside a collapsed group.
function openSidebarGroupForPage(pageId) {
  const key = PAGE_SIDEBAR_GROUP[pageId]
  if (!key) return
  sidebarGroupEls.forEach((g) => {
    // persist=false: only user clicks may be remembered. Persisting the
    // auto-open would let everyday navigation accumulate all 5 groups as
    // saved-open and quietly bring back the flat 23-item menu.
    if (g.dataset.group === key && !g.classList.contains('open')) setSidebarGroupOpen(g, true, false)
  })
}

{
  const openKeys = loadSidebarGroupState()
  sidebarGroupEls.forEach((g) => setSidebarGroupOpen(g, openKeys.includes(g.dataset.group), false))
}
sidebarGroupEls.forEach((g) => {
  const btn = g.querySelector('.sb-group-header')
  if (btn) btn.addEventListener('click', () => setSidebarGroupOpen(g, !g.classList.contains('open')))
})


// ============================================================
// === i18n nav + static element rendering ===
// ============================================================

// Map: data-page value -> nav i18n key.
const NAV_I18N = {
  overview: 'nav.overview', kanban: 'nav.kanban', archived: 'nav.archived',
  agents: 'nav.agents', activity: 'nav.activity', team: 'nav.team',
  messages: 'nav.messages', tasks: 'nav.tasks', memories: 'nav.memories',
  recall: 'nav.recall', naplo: 'nav.recall', bgTasks: 'nav.bgTasks',
  skills: 'nav.skills', localLlm: 'nav.localLlm', connectors: 'nav.connectors', migrate: 'nav.migrate',
  approvals: 'nav.approvals',
  docs: 'nav.docs', research: 'nav.research', status: 'nav.status',
  settings: 'nav.settings', vault: 'nav.vault', tokenUsage: 'nav.tokenUsage',
  ideas: 'nav.ideas', federation: 'nav.federation', updates: 'nav.updates', costs: 'nav.costs',
}

function renderNav() {
  document.querySelectorAll('.sb-link[data-page] .sb-label').forEach((span) => {
    const page = span.closest('[data-page]')?.dataset?.page
    if (page && NAV_I18N[page]) span.textContent = t(NAV_I18N[page])
  })
}

// Map: element ID -> i18n key, for static HTML elements not handled by page render fns.
const STATIC_I18N_MAP = {
  // Kanban column headers
  'countPlanned':   null,  // dynamic count, skip
  // Overview
  'overviewTeamMeta': 'overview.card.team_meta',
  // Docs
  'docsContent': null,  // rendered by JS
}

// Simpler approach: update known static text nodes directly by selector.
// Page id -> { title key, subtitle key (or null) }
const PAGE_HEADER_I18N = {
  agentsPage:     { title: 'agents.page_title',     sub: 'agents.page_subtitle' },
  activityPage:   { title: 'activity.page_title',   sub: 'activity.page_subtitle' },
  tasksPage:      { title: 'tasks.page_title',       sub: 'tasks.page_subtitle' },
  skillsPage:     { title: 'skills.page_title',      sub: 'skills.page_subtitle' },
  localLlmPage:   { title: 'localLlm.page_title',    sub: 'localLlm.page_subtitle' },
  memoriesPage:   { title: 'memories.page_title',    sub: 'memories.page_subtitle' },
  recallPage:     { title: 'recall.page_title',      sub: 'recall.page_subtitle' },
  bgTasksPage:    { title: 'bgTasks.page_title',     sub: 'bgTasks.page_subtitle' },
  connectorsPage: { title: 'connectors.page_title',  sub: 'connectors.page_subtitle' },
  migratePage:    { title: 'migrate.page_title',     sub: 'migrate.page_subtitle' },
  docsPage:       { title: 'docs.page_title',        sub: 'docs.page_subtitle' },
  researchPage:   { title: 'research.page_title',    sub: 'research.page_subtitle' },
  statusPage:     { title: 'status.page_title',      sub: 'status.page_subtitle' },
  teamPage:       { title: 'team.page_title',        sub: 'team.page_subtitle' },
  messagesPage:   { title: 'messages.page_title',    sub: 'messages.page_subtitle' },
  settingsPage:   { title: 'settings.page_title',    sub: 'settings.page_subtitle' },
  ideasPage:      { title: 'ideas.page_title',       sub: 'ideas.page_subtitle' },
  vaultPage:      { title: 'vault.page_title',       sub: 'vault.page_subtitle' },
  tokenUsagePage: { title: 'tokenUsage.page_title',  sub: 'tokenUsage.page_subtitle' },
  updatesPage:    { title: 'updates.page_title',     sub: null },
  naploPage:      { title: 'naplo.page_title',       sub: 'naplo.page_subtitle' },
  costsPage:      { title: 'costs.page_title',       sub: 'costs.page_subtitle' },
  federationPage: { title: 'federation.page_title',  sub: 'federation.page_subtitle' },
  approvalsPage:  { title: 'approvals.page_title',   sub: 'approvals.page_subtitle' },
}

function renderStaticI18n() {
  // Page headers + subtitles
  for (const [pageId, keys] of Object.entries(PAGE_HEADER_I18N)) {
    const pageEl = document.getElementById(pageId)
    if (!pageEl) continue
    const h1 = pageEl.querySelector('.page-header h1')
    if (h1 && keys.title) h1.textContent = t(keys.title)
    const sub = pageEl.querySelector('.page-header .subtitle')
    if (sub && keys.sub) sub.textContent = t(keys.sub)
  }
  // Kanban column titles
  const colTitles = document.querySelectorAll('.kanban-col-title')
  const statusKeys = ['kanban.col.planned', 'kanban.col.in_progress', 'kanban.col.waiting', 'kanban.col.testing', 'kanban.col.done']
  const statuses = ['planned', 'in_progress', 'waiting', 'testing', 'done']
  colTitles.forEach((el) => {
    const status = el.closest('[data-status]')?.dataset?.status
    if (status) {
      const idx = statuses.indexOf(status)
      if (idx !== -1) el.textContent = t(statusKeys[idx])
    }
  })
  // Docs hints
  const docsHint = document.getElementById('docsContent')
  if (docsHint && docsHint.querySelector('p.muted')) {
    docsHint.querySelector('p.muted').textContent = t('docs.select_hint')
  }
  // Messages empty state
  const chatEmpty = document.querySelector('.chat-thread-empty p')
  if (chatEmpty) chatEmpty.textContent = t('messages.select_agent')
  // Team hint
  const teamHint = document.querySelector('#teamPage > p')
  if (teamHint) teamHint.textContent = t('team.hint')

  // Overview stat labels (siblings of statAgents, statTasks, statMemories, statSkills)
  const statLabelKeys = ['overview.stat.agents', 'overview.stat.tasks', 'overview.stat.memories', 'overview.stat.skills']
  const statValueIds = ['statAgents', 'statTasks', 'statMemories', 'statSkills']
  statValueIds.forEach((id, i) => {
    const valEl = document.getElementById(id)
    if (valEl) {
      const labelEl = valEl.parentElement?.querySelector('.overview-stat-label')
      if (labelEl) labelEl.textContent = t(statLabelKeys[i])
    }
  })

  // Overview card headers
  const overviewTeamH3 = document.querySelector('#overviewPage .overview-grid .overview-card:nth-child(1) h3')
  if (overviewTeamH3) overviewTeamH3.textContent = t('overview.card.team')
  const overviewTeamMeta = document.getElementById('overviewTeamMeta')
  if (overviewTeamMeta) overviewTeamMeta.textContent = t('overview.meta.live')
  const overviewActivityH3 = document.querySelector('#overviewPage .overview-grid .overview-card:nth-child(2) h3')
  if (overviewActivityH3) overviewActivityH3.textContent = t('overview.card.activity')
  // Kanban filter labels
  const kanbanProjectLabel = document.querySelector('label[for="kanbanProjectFilter"]')
  if (kanbanProjectLabel) kanbanProjectLabel.textContent = t('kanban.filter.project_label')
  const kanbanGroupLabel = document.querySelector('label[for="kanbanGroupBy"]')
  if (kanbanGroupLabel) kanbanGroupLabel.textContent = t('kanban.filter.group_label')

  // Kanban project filter "Mind" option (first option)
  const kanbanProjectFilter = document.getElementById('kanbanProjectFilter')
  if (kanbanProjectFilter?.options[0]) kanbanProjectFilter.options[0].text = t('kanban.filter.all_projects')

  // Kanban group-by options
  const kanbanGroupBy = document.getElementById('kanbanGroupBy')
  if (kanbanGroupBy) {
    const opts = kanbanGroupBy.options
    if (opts[0]) opts[0].text = t('kanban.filter.group_none')
    if (opts[1]) opts[1].text = t('kanban.filter.group_assignee')
    if (opts[2]) opts[2].text = t('kanban.filter.group_priority')
  }

  // Generic data-i18n sweep for static HTML elements
  document.querySelectorAll('[data-i18n]').forEach(el => {
    const val = t(el.dataset.i18n)
    if (el.children.length === 0) {
      el.textContent = val
    } else {
      const nodes = [...el.childNodes]
      for (let i = nodes.length - 1; i >= 0; i--) {
        if (nodes[i].nodeType === 3 && nodes[i].textContent.trim()) {
          nodes[i].textContent = ' ' + val
          break
        }
      }
    }
  })
  document.querySelectorAll('[data-i18n-placeholder]').forEach(el => {
    el.placeholder = t(el.dataset.i18nPlaceholder)
  })
  document.querySelectorAll('[data-i18n-title]').forEach(el => {
    el.title = t(el.dataset.i18nTitle)
  })
  document.querySelectorAll('[data-i18n-aria-label]').forEach(el => {
    el.setAttribute('aria-label', t(el.dataset.i18nAriaLabel))
  })
  // Elements whose translation contains inline markup (strong/code/a): set innerHTML.
  document.querySelectorAll('[data-i18n-html]').forEach(el => {
    el.innerHTML = t(el.dataset.i18nHtml)
  })
  if (typeof applyOnboardingProviderTab === 'function') applyOnboardingProviderTab()
}

// Initial render on page load.
document.addEventListener('DOMContentLoaded', () => {
  renderNav()
  renderStaticI18n()
}, { once: true })
// Fallback if DOMContentLoaded already fired (scripts deferred).
if (document.readyState !== 'loading') {
  renderNav()
  renderStaticI18n()
}

// ============================================================
// === Activity (live agent status) ===
// ============================================================

let activityTimer = null

const ACTIVITY_STATE_META = {
  working: { label: () => t('activity.state.working'), cls: 'act-working', tip: 'Élő állapot (a tmux pane tartalmából, 3 másodpercenként): éppen dolgozik / gondolkodik.' },
  idle: { label: () => t('activity.state.idle'), cls: 'act-idle', tip: 'Élő állapot (3 másodpercenként): fut, de épp nem csinál semmit.' },
  unknown: { label: () => t('activity.state.unknown'), cls: 'act-unknown', tip: 'Élő állapot: nem sikerült megállapítani a session pane tartalmából.' },
  error: { label: () => t('activity.state.error'), cls: 'act-error', tip: 'Élő állapot: hiba látszik az ágens session paneljén.' },
  stopped: { label: () => t('activity.state.stopped'), cls: 'act-stopped', tip: 'Élő állapot: az ágens session nem fut.' },
}

// === Kanban auto-refresh ===
let kanbanRefreshTimer = null

function startKanbanRefresh() {
  if (kanbanRefreshTimer) clearInterval(kanbanRefreshTimer)
  kanbanRefreshTimer = setInterval(loadKanban, 30000)
}

function stopKanbanRefresh() {
  if (kanbanRefreshTimer) {
    clearInterval(kanbanRefreshTimer)
    kanbanRefreshTimer = null
  }
}

document.addEventListener('visibilitychange', () => {
  if (document.hidden) {
    stopKanbanRefresh()
  } else if (!document.getElementById('kanbanPage').hidden) {
    loadKanban()
    startKanbanRefresh()
  }
})

function startActivityPoll() {
  loadActivity()
  if (activityTimer) clearInterval(activityTimer)
  activityTimer = setInterval(loadActivity, 3000)
}

function stopActivityPoll() {
  if (activityTimer) {
    clearInterval(activityTimer)
    activityTimer = null
  }
}

async function loadActivity() {
  try {
    const res = await fetch('/api/agents/activity')
    if (!res.ok) throw new Error('HTTP ' + res.status)
    const entries = await res.json()
    renderActivity(entries)
    const upd = document.getElementById('activityUpdated')
    if (upd) upd.textContent = t('activity.updated', { time: new Date().toLocaleTimeString('hu-HU') })
  } catch (e) {
    const list = document.getElementById('activityList')
    if (list) list.innerHTML = '<p class="activity-empty">' + t('activity.error_load') + ': ' + escapeHtml(String(e.message || e)) + '</p>'
  }
}

function renderActivity(entries) {
  const list = document.getElementById('activityList')
  if (!list) return
  if (!Array.isArray(entries) || entries.length === 0) {
    list.innerHTML = '<p class="activity-empty">' + t('activity.empty') + '</p>'
    return
  }
  list.innerHTML = entries.map((a) => {
    const metaRaw = ACTIVITY_STATE_META[a.state] || ACTIVITY_STATE_META.unknown
    const meta = { ...metaRaw, label: typeof metaRaw.label === 'function' ? metaRaw.label() : metaRaw.label }
    const tail = (a.tail || []).map((l) => escapeHtml(l)).join('\n')
    const mainBadge = a.isMain ? '<span class="act-main-badge">' + t('activity.badge.main') + '</span>' : ''
    // Permission-mode chip. Shown for every mode EXCEPT the ones that let the
    // agent work on its own -- inverted on purpose: an unfamiliar mode is
    // exactly the one worth surfacing, so a future Claude Code mode shows up
    // here instead of hiding behind a list nobody remembered to extend.
    // Without this an agent parked in an ask-first mode renders as plain
    // 'idle', which is how one sat unusable for hours on 2026-07-27.
    const AUTONOMOUS_MODES = ['bypass permissions', 'accept edits', 'auto mode']
    const modeChip = a.mode && !AUTONOMOUS_MODES.includes(a.mode)
      ? '<span class="act-mode-badge" title="' + escapeHtml(t('activity.tooltip.mode', { mode: a.mode })) + '">' + escapeHtml(a.mode) + '</span>'
      : ''
    const canOpen = !!a.running
    const termIcon = canOpen
      ? '<svg class="act-term-icon" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" title="' + t('activity.tooltip.terminal') + '"><polyline points="4 17 10 11 4 5"/><line x1="12" y1="19" x2="20" y2="19"/></svg>'
      : ''
    return (
      '<div class="activity-card ' + meta.cls + (canOpen ? ' act-clickable' : '') + (a.running ? ' agent-card-running' : '') + (activeSubagents.has(a.name) ? ' agent-card-subagent' : '') + '" data-agent="' + escapeHtml(a.name) + '">' +
        '<div class="activity-card-head">' +
          '<span class="activity-name">' + escapeHtml(a.name) + mainBadge + '</span>' +
          '<span style="display:flex;align-items:center;gap:8px">' +
            modeChip +
            termIcon +
            '<span class="activity-badge ' + meta.cls + '" title="' + escapeHtml(meta.tip || '') + '">' + meta.label + '</span>' +
          '</span>' +
        '</div>' +
        (tail
          ? '<pre class="activity-tail">' + tail + '</pre>'
          : '<p class="activity-tail-empty">' + (a.running ? 'nincs friss kimenet' : 'a session nem fut') + '</p>') +
      '</div>'
    )
  }).join('')
}

// Event delegation: clicking a running activity-card opens the terminal modal
;(() => {
  const actList = document.getElementById('activityList')
  if (actList) {
    actList.addEventListener('click', (e) => {
      const card = e.target.closest('.activity-card.act-clickable[data-agent]')
      if (card) openTerminalModal(card.dataset.agent)
    })
  }
})()


// ============================================================
// === Kanban ===
// ============================================================

let kanbanCards = []
let kanbanAssignees = []
let kanbanProjects = []
// Label registry (id/name/color), independent of which cards currently carry
// which labels -- card.labels (embedded by GET /api/kanban) holds that link.
let kanbanAllLabels = []
// Active label-filter ids -- the quick-filter chip row AND the per-card
// footer label pills both toggle this same set (two entry points, one
// filter dimension). OR-combined within itself (any active label matches),
// AND-combined with the existing project/assignee filters. Persisted in
// localStorage alongside the swimlane groupBy choice.
let kanbanLabelFilter = new Set()
// The kanban quick-filter chip row is generated from the LIVE fleet agent list
// (GET /api/agents) rather than from the kanban label registry, so EVERY created
// agent gets a chip -- including newly-created ones and agents that have no
// @<name> label yet (e.g. qa2, teszter). Populated in loadKanban().
let kanbanAgents = []
// Agents whose chip is active but which have no @<name> label to filter by are
// filtered by assignee instead (lower-cased agent name matched against
// card.assignee). Parallel OR-dimension to kanbanLabelFilter; the two combine as
// a single logical quick-filter (a card matches if it carries an active label OR
// its assignee is an active agent). Persisted alongside the label filter.
let kanbanAgentFilter = new Set()
let kanbanProjectFilter = ''
// Assignee filter for the kanban board. '' = show all. Set via the
// assignee dropdown / "Csak Gábor" toggle injected by setupAssigneeFilter().
// Matched case-insensitively against card.assignee so a casing mismatch
// (e.g. card "gorcsevivan" vs list "GorcsevIvan") still filters correctly.
let kanbanAssigneeFilter = ''
// Swimlane grouping: 'none' (flat board, default) | 'assignee' | 'priority'.
// The initial value is pulled from window._marveen.kanbanSwimlanes.defaultGroup
// the first time loadKanban() runs (see kanbanGroupByInitialized below), then
// fully user-controlled via the toolbar dropdown.
let kanbanGroupBy = 'none'
let kanbanGroupByInitialized = false
// Which swimlane keys (assignee name or priority value) are collapsed. Lives
// for the page session only -- intentionally not persisted across reloads.
const kanbanCollapsedLanes = new Set()
// Set of status column keys that are hidden from the board view.
// Empty = all columns visible. Persisted in localStorage.
let kanbanHiddenColumns = new Set()

const cardModalOverlay = document.getElementById('cardModalOverlay')
const cardDetailOverlay = document.getElementById('cardDetailOverlay')
const breakdownOverlay = document.getElementById('breakdownOverlay')
let breakdownCardId = null
let breakdownSubtasks = []
// Breakdown modal is shared between kanban-card breakdown and idea promote.
let breakdownMode = 'kanban' // 'kanban' | 'idea'
let breakdownIdeaId = null
const columns = document.querySelectorAll('.kanban-col-body')

// Modal wiring
document.getElementById('cardModalClose').addEventListener('click', () => closeModal(cardModalOverlay))
document.getElementById('cardDetailClose').addEventListener('click', () => closeModal(cardDetailOverlay))
cardModalOverlay.addEventListener('click', (e) => { if (e.target === cardModalOverlay) closeModal(cardModalOverlay) })
cardDetailOverlay.addEventListener('click', (e) => { if (e.target === cardDetailOverlay) closeModal(cardDetailOverlay) })

// Add card buttons per column
document.querySelectorAll('.kanban-add-btn').forEach((btn) => {
  btn.addEventListener('click', () => openNewCardModal(btn.dataset.status))
})

async function loadKanban() {
  try {
    // Always refresh the marveen config so values changed on the Settings page
    // (e.g. WIP limits) show up on the board on the next Kanban open, without a
    // hard reload. The full /api/marveen payload includes kanbanAging, kanbanWip,
    // kanbanSwimlanes and kanbanLabels, so the labels (from the labels feature)
    // stay populated too. Also covers opening the Kanban page first, before the
    // Agents page populated window._marveen.
    try {
      const mr = await fetch('/api/marveen')
      if (mr.ok) window._marveen = { ...(window._marveen || {}), ...(await mr.json()) }
    } catch { /* ignore -- aging/WIP/swimlanes/labels just won't render until _marveen loads */ }
    if (!kanbanGroupByInitialized) {
      kanbanGroupByInitialized = true
      // A user's own past choice (saved to localStorage) wins over the
      // server-configured default, so switching the grouping sticks across
      // page reloads instead of resetting every time.
      const stored = localStorage.getItem('marveen.kanbanGroupBy')
      const defaultGroup = window._marveen?.kanbanSwimlanes?.defaultGroup
      const initialGroup = (stored === 'assignee' || stored === 'priority' || stored === 'none')
        ? stored
        : (defaultGroup === 'assignee' || defaultGroup === 'priority' ? defaultGroup : 'none')
      if (initialGroup !== 'none') {
        kanbanGroupBy = initialGroup
        const sel = document.getElementById('kanbanGroupBy')
        if (sel) sel.value = initialGroup
      }
      // Active label-filter selection, restored the same way as the groupBy
      // choice -- a fresh page load should not lose the filters set up.
      try {
        const storedLabels = JSON.parse(localStorage.getItem('marveen.kanbanLabelFilter') || '[]')
        if (Array.isArray(storedLabels)) kanbanLabelFilter = new Set(storedLabels)
      } catch { /* ignore malformed storage */ }
      try {
        const storedAgents = JSON.parse(localStorage.getItem('marveen.kanbanAgentFilter') || '[]')
        if (Array.isArray(storedAgents)) kanbanAgentFilter = new Set(storedAgents)
      } catch { /* ignore malformed storage */ }
      try {
        const storedHiddenCols = JSON.parse(localStorage.getItem('marveen.kanbanHiddenColumns') || '[]')
        if (Array.isArray(storedHiddenCols)) kanbanHiddenColumns = new Set(storedHiddenCols)
      } catch { /* ignore malformed storage */ }
    }
    const [cardsRes, assigneesRes, projectsRes, labelsRes, agentsRes] = await Promise.all([
      fetch('/api/kanban'),
      fetch('/api/kanban/assignees'),
      fetch('/api/kanban-projects'),
      fetch('/api/kanban/labels'),
      fetch('/api/agents'),
    ])
    kanbanCards = await cardsRes.json()
    kanbanAssignees = await assigneesRes.json()
    kanbanProjects = await projectsRes.json()
    kanbanAllLabels = await labelsRes.json()
    // Live fleet agent list drives the quick-filter chip row (one chip per
    // agent, not per label). A failure here just leaves the previous list in
    // place -- the board still renders.
    try {
      if (agentsRes.ok) {
        const list = await agentsRes.json()
        if (Array.isArray(list)) kanbanAgents = list
      }
    } catch { /* keep previous kanbanAgents */ }
    populateProjectFilter()
    populatePriorityProjectFilter()
    populateProjectSuggestions()
    setupAssigneeFilter()
    renderKanban()
  } catch (err) {
    console.error('Kanban betöltés hiba:', err)
  }
}

document.getElementById('kanbanGroupBy').addEventListener('change', (e) => {
  kanbanGroupBy = e.target.value
  localStorage.setItem('marveen.kanbanGroupBy', kanbanGroupBy)
  renderKanban()
})

function populateProjectFilter() {
  const sel = document.getElementById('kanbanProjectFilter')
  const prev = sel.value
  sel.innerHTML = '<option value="">Mind</option>'
  for (const p of kanbanProjects) {
    const opt = document.createElement('option')
    opt.value = p
    opt.textContent = p
    if (p === prev) opt.selected = true
    sel.appendChild(opt)
  }
  if (prev && !kanbanProjects.includes(prev)) kanbanProjectFilter = ''
}

// Project-level dispatch priority dropdown (card e291e9c4, BE sibling 2d6587fe). Single-select in
// the UI: the API supports an ordered array (multiple projects) for a future need, but a dropdown
// is a single choice, which is what "legordulo menu" actually asked for -- the array with zero or
// one entries is the simplest form that fits both.
async function populatePriorityProjectFilter() {
  const sel = document.getElementById('kanbanPriorityProjectSelect')
  if (!sel) return
  sel.innerHTML = `<option value="">${t('kanban.filter.priority_default')}</option>`
  for (const p of kanbanProjects) {
    const opt = document.createElement('option')
    opt.value = p
    opt.textContent = p
    sel.appendChild(opt)
  }
  try {
    const res = await fetch('/api/config/project-priority')
    if (res.ok) {
      const data = await res.json()
      const current = Array.isArray(data.priority) ? data.priority[0] : undefined
      // The saved project may no longer exist (renamed/no cards left) -- fall back to the default
      // option rather than silently selecting nothing the dropdown never offered.
      sel.value = current && kanbanProjects.includes(current) ? current : ''
    }
  } catch { /* leave the default selection -- the board still works without this */ }
  // Baseline for the change handler's revert-on-failure below -- without this, the FIRST edit
  // after page load would revert to '' regardless of what was actually loaded above.
  sel.dataset.lastValue = sel.value
}

document.getElementById('kanbanPriorityProjectSelect').addEventListener('change', async (e) => {
  const sel = e.target
  const value = sel.value
  const prevValue = sel.dataset.lastValue || ''
  try {
    const res = await fetch('/api/config/project-priority', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ priority: value ? [value] : [] }),
    })
    if (!res.ok) throw new Error('save-failed')
    sel.dataset.lastValue = value
    showToast(value ? t('kanban.filter.priority_saved', { project: value }) : t('kanban.filter.priority_cleared'))
  } catch {
    // Revert the visible selection to what is actually saved -- a silently-failed PUT must not
    // leave the dropdown claiming a priority that was never persisted. Never surface the raw
    // server error text here (rule 12): the dropdown only ever offers real project names, so a
    // rejection means the save itself failed, not a user input mistake -- a generic, localized,
    // retry-pointing message is both honest and all that is actionable from here.
    sel.value = prevValue
    showToast(t('kanban.filter.priority_save_failed'))
  }
})

function renderKanbanColumnChips() {
  const container = document.getElementById('kanbanColumnChips')
  if (!container) return
  container.innerHTML = ''
  for (const def of KANBAN_STATUS_DEFS) {
    const hidden = kanbanHiddenColumns.has(def.status)
    const label = typeof def.title === 'function' ? def.title() : def.title
    const chip = document.createElement('span')
    chip.className = 'kanban-col-chip' + (hidden ? ' hidden' : '')
    chip.title = hidden ? t('kanban.filter.column_show') : t('kanban.filter.column_hide')
    chip.textContent = label
    chip.addEventListener('click', () => {
      if (kanbanHiddenColumns.has(def.status)) kanbanHiddenColumns.delete(def.status)
      else kanbanHiddenColumns.add(def.status)
      localStorage.setItem('marveen.kanbanHiddenColumns', JSON.stringify([...kanbanHiddenColumns]))
      renderKanban()
    })
    container.appendChild(chip)
  }
}

function populateProjectSuggestions() {
  const dl = document.getElementById('projectSuggestions')
  if (!dl) return
  dl.innerHTML = ''
  for (const p of kanbanProjects) {
    const opt = document.createElement('option')
    opt.value = p
    dl.appendChild(opt)
  }
}

document.getElementById('kanbanProjectFilter').addEventListener('change', (e) => {
  kanbanProjectFilter = e.target.value
  renderKanban()
})

// The kanban "owner" is the assignee whose type is 'owner' -- the person the
// board is primarily run for, on any deployment. Identified by type, never by
// a hard-coded display name, so the quick "show what's on me" view is generic.
// Returns null when no owner-type assignee exists (then the quick button is
// hidden and only the general per-assignee dropdown is shown).
function ownerAssigneeName() {
  const owner = kanbanAssignees.find((a) => a.type === 'owner')
  return owner ? owner.name : null
}

// Reflect the active state of the owner quick-toggle button (hidden when there
// is no owner-type assignee).
function syncOwnerFilterBtn() {
  const btn = document.getElementById('kanbanOwnerBtn')
  if (!btn) return
  const owner = ownerAssigneeName()
  if (!owner) { btn.style.display = 'none'; return }
  btn.style.display = ''
  const on = !!kanbanAssigneeFilter && kanbanAssigneeFilter.toLowerCase() === owner.toLowerCase()
  btn.style.background = on ? 'var(--accent)' : 'var(--bg)'
  btn.style.color = on ? '#081a2d' : 'var(--fg)'
  btn.setAttribute('aria-pressed', on ? 'true' : 'false')
}

// Inject the assignee filter (per-assignee dropdown + an owner "Rám vár" quick
// toggle) into the kanban toolbar. Built in JS rather than as static markup so
// the toolbar stays self-contained. Idempotent: the controls are created once;
// later calls only refresh the <option>s from the current assignee list.
function setupAssigneeFilter() {
  const projectSel = document.getElementById('kanbanProjectFilter')
  if (!projectSel) return
  const toolbar = projectSel.parentElement
  let sel = document.getElementById('kanbanAssigneeFilter')
  if (!sel) {
    const label = document.createElement('label')
    label.setAttribute('for', 'kanbanAssigneeFilter')
    label.textContent = t('kanban.filter.assignee_label')
    label.style.cssText = 'font-size:13px;color:var(--muted);white-space:nowrap;margin-left:8px;'

    sel = document.createElement('select')
    sel.id = 'kanbanAssigneeFilter'
    sel.style.cssText = 'font-size:13px;padding:4px 8px;border-radius:6px;border:1px solid var(--border);background:var(--bg);color:var(--fg);min-width:140px;'
    sel.addEventListener('change', (e) => {
      kanbanAssigneeFilter = e.target.value
      syncOwnerFilterBtn()
      renderKanban()
    })

    const ownerBtn = document.createElement('button')
    ownerBtn.id = 'kanbanOwnerBtn'
    ownerBtn.type = 'button'
    ownerBtn.textContent = t('kanban.filter.owner_btn')
    ownerBtn.title = t('kanban.owner_filter')
    ownerBtn.style.cssText = 'font-size:13px;padding:4px 10px;border-radius:6px;border:1px solid var(--border);background:var(--bg);color:var(--fg);cursor:pointer;'
    ownerBtn.addEventListener('click', () => {
      const owner = ownerAssigneeName()
      if (!owner) return
      const on = kanbanAssigneeFilter.toLowerCase() === owner.toLowerCase()
      kanbanAssigneeFilter = on ? '' : owner
      // Keep the dropdown in sync (only selectable if the owner is a known assignee).
      sel.value = kanbanAssignees.some((a) => a.name === kanbanAssigneeFilter) ? kanbanAssigneeFilter : ''
      syncOwnerFilterBtn()
      renderKanban()
    })

    toolbar.appendChild(label)
    toolbar.appendChild(sel)
    toolbar.appendChild(ownerBtn)
  }

  // (Re)populate options from the current assignee list, preserving selection.
  const prev = kanbanAssigneeFilter
  sel.innerHTML = '<option value="">Mind</option>'
  for (const a of kanbanAssignees) {
    const opt = document.createElement('option')
    opt.value = a.name
    // Show the persona displayName (id as fallback), matching #216; the
    // option value / filter key stays the agent id.
    opt.textContent = a.displayName || a.name
    if (a.name === prev) opt.selected = true
    sel.appendChild(opt)
  }
  // syncOwnerFilterBtn shows/hides the owner quick-button based on whether an
  // owner-type assignee exists in the freshly loaded list.
  syncOwnerFilterBtn()
}

// Project + assignee + label filters, independent of the priority quick-filter
// Project + assignee filters only -- the baseline the label quick-filter
// chip counts are computed against, independent of which labels are
// currently active, so a chip's count stays meaningful whether it's the one
// being toggled or not.
function kanbanCardMatchesBaseFilters(card) {
  if (kanbanProjectFilter && (card.project || '') !== kanbanProjectFilter) return false
  const assigneeFilter = kanbanAssigneeFilter.toLowerCase()
  if (assigneeFilter && String(card.assignee || '').trim().toLowerCase() !== assigneeFilter) return false
  return true
}

// The quick-filter dimension: a card matches when no quick-filter is active, or
// when it carries at least one active label OR its assignee is an active
// (label-less) agent. Label and agent selections OR together into one logical
// quick-filter so mixing a labelled agent (@backend) with a label-less one
// (qa2) shows the union.
function kanbanCardMatchesLabelFilter(card) {
  if (kanbanLabelFilter.size === 0 && kanbanAgentFilter.size === 0) return true
  const cardLabelIds = (card.labels || []).map((l) => l.id)
  if (cardLabelIds.some((id) => kanbanLabelFilter.has(id))) return true
  const asg = String(card.assignee || '').trim().toLowerCase()
  if (asg && kanbanAgentFilter.has(asg)) return true
  return false
}

// Shared by both the header quick-filter chips and the per-card footer label
// pills -- one filter dimension, two entry points into the same toggle.
function toggleKanbanLabelFilter(labelId) {
  if (kanbanLabelFilter.has(labelId)) kanbanLabelFilter.delete(labelId)
  else kanbanLabelFilter.add(labelId)
  persistKanbanFilters()
  renderKanban()
}

// Toggle a label-less agent's chip: filters by assignee (lower-cased agent
// name). Mirrors toggleKanbanLabelFilter but for the assignee OR-dimension.
function toggleKanbanAgentFilter(agentName) {
  const key = String(agentName || '').trim().toLowerCase()
  if (!key) return
  if (kanbanAgentFilter.has(key)) kanbanAgentFilter.delete(key)
  else kanbanAgentFilter.add(key)
  persistKanbanFilters()
  renderKanban()
}

function clearKanbanQuickFilters() {
  kanbanLabelFilter.clear()
  kanbanAgentFilter.clear()
  persistKanbanFilters()
  renderKanban()
}

function persistKanbanFilters() {
  localStorage.setItem('marveen.kanbanLabelFilter', JSON.stringify([...kanbanLabelFilter]))
  localStorage.setItem('marveen.kanbanAgentFilter', JSON.stringify([...kanbanAgentFilter]))
}

// Deterministic fallback colour for an agent that has no @<name> label (and so
// no assigned colour). Hashes the name into the configured label palette so the
// same agent always gets the same chip colour, and two label-less agents rarely
// collide. Falls back to a neutral slate if the palette is unavailable.
function agentChipFallbackColor(name) {
  const palette = window._marveen?.kanbanLabels?.colors
  if (!Array.isArray(palette) || palette.length === 0) return '#64748b'
  let hash = 0
  for (const ch of String(name)) hash = (hash + ch.charCodeAt(0)) % palette.length
  return palette[hash]
}

// Build the ordered chip descriptor list from the LIVE fleet agent list. The
// main agent (mikrob) is prepended -- /api/agents lists only sub-agents, but it
// carries its own @<name> label and belongs on the board like any other agent.
// Each descriptor resolves the agent's @<name> label (case-insensitive) to pick
// up its colour + id; a label-less agent keeps labelId=null and filters by
// assignee instead.
function buildKanbanAgentChips() {
  const chips = []
  const seen = new Set()
  const labelByName = new Map(
    (kanbanAllLabels || []).map((l) => [String(l.name || '').toLowerCase(), l])
  )
  const push = (name, displayName) => {
    const key = String(name || '').trim().toLowerCase()
    if (!key || seen.has(key)) return
    seen.add(key)
    const label = labelByName.get('@' + key) || null
    chips.push({
      name: key,
      displayName: displayName || name,
      label,
      color: label ? label.color : agentChipFallbackColor(key),
    })
  }
  // Main agent first.
  const mv = window._marveen
  if (mv && mv.agentId) push(mv.agentId, mv.name || mv.agentId)
  for (const a of kanbanAgents) push(a.name, a.displayName || a.name)
  return chips
}

// Quick-filter chip row: one chip per LIVE fleet agent (not per label), tinted
// with the agent's assigned colour (its @<name> label colour, or a stable
// palette fallback when it has no label). Clicking a labelled agent toggles the
// shared kanbanLabelFilter set the footer pills use; a label-less agent toggles
// the assignee-based kanbanAgentFilter -- both feed the same board filter.
function renderKanbanQuickFilters() {
  const row = document.getElementById('kanbanQuickFilters')
  if (!row) return
  row.innerHTML = ''
  for (const chip of buildKanbanAgentChips()) {
    const active = chip.label
      ? kanbanLabelFilter.has(chip.label.id)
      : kanbanAgentFilter.has(chip.name)
    const count = kanbanCards.filter((c) => {
      if (!kanbanCardMatchesBaseFilters(c)) return false
      if (chip.label) return (c.labels || []).some((l) => l.id === chip.label.id)
      return String(c.assignee || '').trim().toLowerCase() === chip.name
    }).length
    const el = document.createElement('span')
    el.className = 'kanban-quick-filter-chip' + (active ? ' active' : '')
    if (chip.label) el.dataset.labelId = chip.label.id
    el.dataset.agent = chip.name
    el.style.setProperty('--chip-color', chip.color)
    el.innerHTML = `@${escapeHtml(chip.displayName)} <span class="kanban-quick-filter-count">${count}</span>${active ? '<span class="kanban-quick-filter-clear">&times;</span>' : ''}`
    el.addEventListener('click', () =>
      chip.label ? toggleKanbanLabelFilter(chip.label.id) : toggleKanbanAgentFilter(chip.name)
    )
    row.appendChild(el)
  }
  if (kanbanLabelFilter.size > 0 || kanbanAgentFilter.size > 0) {
    const clearAll = document.createElement('button')
    clearAll.className = 'kanban-quick-filter-clear-all'
    clearAll.textContent = t('kanban.filter.clear')
    clearAll.addEventListener('click', clearKanbanQuickFilters)
    row.appendChild(clearAll)
  }
}

function renderKanban() {
  const cardById = new Map(kanbanCards.map(c => [c.id, c]))

  renderKanbanColumnChips()
  renderKanbanQuickFilters()

  // Determine which top-level cards are visible under current filters.
  const visibleCardIds = new Set()
  for (const card of kanbanCards) {
    if (!kanbanCardMatchesBaseFilters(card)) continue
    if (!kanbanCardMatchesLabelFilter(card)) continue
    visibleCardIds.add(card.id)
  }

  // A subtask is "embedded" when its parent is visible AND both share the same
  // column. Embedded subtasks are hidden as standalone cards and rendered
  // inside the parent card instead. Filter state of the subtask itself is
  // intentionally ignored so it always shows under its visible parent.
  const embeddedSubtaskIds = new Set()
  for (const card of kanbanCards) {
    if (!card.parent_id) continue
    const parent = cardById.get(card.parent_id)
    if (!parent || !visibleCardIds.has(parent.id)) continue
    if (parent.status === card.status) embeddedSubtaskIds.add(card.id)
  }

  const grouped = { planned: [], in_progress: [], waiting: [], testing: [], done: [] }
  for (const card of kanbanCards) {
    if (embeddedSubtaskIds.has(card.id)) continue
    if (!visibleCardIds.has(card.id)) continue
    if (grouped[card.status]) grouped[card.status].push(card)
  }

  // Update counts (embedded subtasks don't count as separate cards)
  document.getElementById('countPlanned').textContent = grouped.planned.length
  document.getElementById('countInProgress').textContent = grouped.in_progress.length
  document.getElementById('countTesting').textContent = grouped.testing.length
  document.getElementById('countWaiting').textContent = grouped.waiting.length
  document.getElementById('countDone').textContent = grouped.done.length

  const flatBoard = document.getElementById('kanbanBoard')
  const swimlaneBoard = document.getElementById('kanbanSwimlaneBoard')

  if (kanbanGroupBy === 'none') {
    swimlaneBoard.hidden = true
    flatBoard.hidden = false
    for (const [status, cards] of Object.entries(grouped)) {
      const col = document.querySelector(`#kanbanBoard .kanban-col-body[data-status="${status}"]`)
      col.innerHTML = ''
      cards.sort((a, b) => a.sort_order - b.sort_order)

      for (const card of cards) {
        const embeddedChildren = kanbanCards
          .filter(c => c.parent_id === card.id && embeddedSubtaskIds.has(c.id))
          .sort((a, b) => a.sort_order - b.sort_order)
        col.appendChild(createCardEl(card, embeddedChildren))
      }
    }
    // Hide/show flat-board columns based on visibility set
    const allColsHidden = KANBAN_STATUS_DEFS.every(d => kanbanHiddenColumns.has(d.status))
    for (const def of KANBAN_STATUS_DEFS) {
      const colEl = flatBoard.querySelector(`.kanban-col[data-status="${def.status}"]`)
      if (colEl) colEl.hidden = kanbanHiddenColumns.has(def.status)
    }
    // "All columns hidden" hint
    let allHiddenMsg = document.getElementById('kanbanAllHiddenMsg')
    if (allColsHidden) {
      if (!allHiddenMsg) {
        allHiddenMsg = document.createElement('p')
        allHiddenMsg.id = 'kanbanAllHiddenMsg'
        allHiddenMsg.style.cssText = 'color:var(--muted);font-size:13px;padding:24px 0;text-align:center;width:100%;'
        flatBoard.appendChild(allHiddenMsg)
      }
      allHiddenMsg.textContent = t('kanban.filter.all_cols_hidden')
    } else {
      allHiddenMsg?.remove()
    }
    // Badge: only count subtasks that are in a different column (not embedded here)
    updateSubtaskBadges(embeddedSubtaskIds)
    // WIP limit badges (count/limit + colour) on the flat board too -- previously
    // only the swimlane view updated these, so a configured limit never showed
    // on the default flat board.
    updateWipBadges(grouped)
  } else {
    flatBoard.hidden = true
    swimlaneBoard.hidden = false
    renderSwimlaneBoard(grouped, embeddedSubtaskIds)
  }
}

const KANBAN_STATUS_DEFS = [
  { status: 'planned', title: () => t('kanban.col.planned') },
  { status: 'in_progress', title: () => t('kanban.col.in_progress') },
  { status: 'waiting', title: () => t('kanban.col.waiting') },
  { status: 'testing', title: () => t('kanban.col.testing') },
  { status: 'done', title: () => t('kanban.col.done') },
]
const KANBAN_PRIORITY_LABELS = { urgent: () => t('kanban.priority.urgent'), high: () => t('kanban.priority.high'), normal: () => t('kanban.priority.normal'), low: () => t('kanban.priority.low') }
const KANBAN_PRIORITY_ORDER = ['urgent', 'high', 'normal', 'low']

// Which swimlane a card belongs to under the current grouping. Returns a
// stable string key: the matched assignee's canonical name, '__unassigned__'
// for cards with no/unmatched assignee, or the priority value.
function kanbanSwimlaneKeyFor(card) {
  if (kanbanGroupBy === 'priority') return card.priority || 'normal'
  const raw = card.assignee ? String(card.assignee).trim() : ''
  if (!raw) return '__unassigned__'
  const match = kanbanAssignees.find(a => a.name.toLowerCase() === raw.toLowerCase())
  return match ? match.name : raw
}

// Display metadata (label + avatar styling) for a swimlane key.
function kanbanSwimlaneMeta(key) {
  if (kanbanGroupBy === 'priority') {
    const _rawPL = KANBAN_PRIORITY_LABELS[key]; const label = _rawPL ? (typeof _rawPL === 'function' ? _rawPL() : _rawPL) : key
    return { label, avatarClass: `priority-${key}`, avatarChar: '' }
  }
  if (key === '__unassigned__') return { label: t('kanban.unassigned'), avatarClass: 'unknown', avatarChar: '?' }
  const match = kanbanAssignees.find(a => a.name === key)
  const label = match ? (match.displayName || match.name) : key
  return { label, avatarClass: match ? match.type : 'unknown', avatarChar: (label[0] || '?').toUpperCase() }
}

function renderSwimlaneBoard(grouped, embeddedSubtaskIds) {
  const board = document.getElementById('kanbanSwimlaneBoard')
  board.innerHTML = ''

  const presentKeys = new Set()
  for (const cards of Object.values(grouped)) {
    for (const c of cards) presentKeys.add(kanbanSwimlaneKeyFor(c))
  }

  const canonicalOrder = kanbanGroupBy === 'priority'
    ? KANBAN_PRIORITY_ORDER
    : [...kanbanAssignees.map(a => a.name), '__unassigned__']
  const orderedKeys = canonicalOrder.filter(k => presentKeys.has(k))
  const leftoverKeys = [...presentKeys].filter(k => !orderedKeys.includes(k)).sort((a, b) => a.localeCompare(b))
  const keys = [...orderedKeys, ...leftoverKeys]

  const separatorColor = window._marveen?.kanbanSwimlanes?.separatorColor

  for (const key of keys) {
    const meta = kanbanSwimlaneMeta(key)
    const collapsed = kanbanCollapsedLanes.has(key)

    const laneCardsByStatus = {}
    let totalCount = 0
    for (const def of KANBAN_STATUS_DEFS) {
      const cards = grouped[def.status].filter(c => kanbanSwimlaneKeyFor(c) === key)
      laneCardsByStatus[def.status] = cards
      if (!kanbanHiddenColumns.has(def.status)) totalCount += cards.length
    }

    const lane = document.createElement('div')
    lane.className = 'kanban-swimlane' + (collapsed ? ' collapsed' : '')
    lane.dataset.group = key
    if (separatorColor) lane.style.borderBottomColor = separatorColor

    const header = document.createElement('div')
    header.className = 'kanban-swimlane-header'
    header.innerHTML = `
      <span class="kanban-swimlane-avatar ${meta.avatarClass}">${escapeHtml(meta.avatarChar)}</span>
      <span class="kanban-swimlane-name">${escapeHtml(meta.label)}</span>
      <span class="kanban-swimlane-count">${totalCount}</span>
      <button class="kanban-swimlane-toggle" type="button" aria-expanded="${!collapsed}" title="${collapsed ? t('kanban.swimlane.expand') : t('kanban.swimlane.collapse')}">${collapsed ? '▶' : '▼'}</button>
    `
    header.querySelector('.kanban-swimlane-toggle').addEventListener('click', (e) => {
      e.stopPropagation()
      if (kanbanCollapsedLanes.has(key)) kanbanCollapsedLanes.delete(key)
      else kanbanCollapsedLanes.add(key)
      renderKanban()
    })
    lane.appendChild(header)

    const body = document.createElement('div')
    body.className = 'kanban-swimlane-body'
    for (const def of KANBAN_STATUS_DEFS) {
      if (kanbanHiddenColumns.has(def.status)) continue
      const col = document.createElement('div')
      col.className = 'kanban-swimlane-col'

      const colHeader = document.createElement('div')
      colHeader.className = 'kanban-swimlane-col-header'
      colHeader.textContent = typeof def.title === 'function' ? def.title() : def.title

      const colBody = document.createElement('div')
      colBody.className = 'kanban-col-body kanban-swimlane-col-body'
      colBody.dataset.status = def.status

      const cards = laneCardsByStatus[def.status].sort((a, b) => a.sort_order - b.sort_order)
      for (const card of cards) {
        const embeddedChildren = kanbanCards
          .filter(c => c.parent_id === card.id && embeddedSubtaskIds.has(c.id))
          .sort((a, b) => a.sort_order - b.sort_order)
        colBody.appendChild(createCardEl(card, embeddedChildren))
      }
      wireKanbanColumnDnD(colBody)

      col.appendChild(colHeader)
      col.appendChild(colBody)
      body.appendChild(col)
    }
    lane.appendChild(body)
    board.appendChild(lane)
  }

  updateSubtaskBadges(embeddedSubtaskIds)

  // WIP limit badges: update column-header count spans with "count/limit" when configured
  updateWipBadges(grouped)
}

// Map column status keys to their count-span IDs
const WIP_COUNT_IDS = {
  planned: 'countPlanned',
  in_progress: 'countInProgress',
  testing: 'countTesting',
  waiting: 'countWaiting',
  done: 'countDone',
}

function updateWipBadges(grouped) {
  const cfg = window._marveen?.kanbanWip
  for (const [status, cards] of Object.entries(grouped)) {
    const el = document.getElementById(WIP_COUNT_IDS[status])
    if (!el) continue
    const limit = cfg?.limits?.[status] || 0
    if (!limit) {
      // No limit configured: restore plain count and clear WIP styling
      el.textContent = cards.length
      delete el.dataset.wip
      el.style.color = ''
      el.style.borderColor = ''
      continue
    }
    const count = cards.length
    el.textContent = `${count}/${limit}`
    let state, color
    if (count > limit) {
      state = 'over'; color = cfg.overColor
    } else if (count === limit) {
      state = 'full'; color = cfg.fullColor
    } else if ((count / limit) * 100 >= cfg.warnPct) {
      state = 'warn'; color = cfg.warnColor
    } else {
      state = 'ok'; color = cfg.okColor
    }
    el.dataset.wip = state
    el.style.color = color
    el.style.borderColor = color
  }
}

function updateSubtaskBadges(embeddedSubtaskIds) {
  for (const el of document.querySelectorAll('.kanban-card[data-id]')) {
    const id = el.dataset.id
    const badge = el.querySelector('.kanban-subtask-badge')
    if (!badge) continue
    const nonEmbedded = kanbanCards.filter(c => c.parent_id === id && !embeddedSubtaskIds.has(c.id))
    if (nonEmbedded.length > 0) {
      badge.textContent = `${nonEmbedded.length} subtask`
      badge.style.display = ''
      badge.onclick = (e) => {
        e.stopPropagation()
        const card = kanbanCards.find(c => c.id === id)
        if (card) showCardDetail(card)
      }
    } else {
      badge.style.display = 'none'
    }
  }
}

function createCardEl(card, embeddedChildren = []) {
  const el = document.createElement('div')
  el.className = 'kanban-card'
  el.dataset.id = card.id
  el.dataset.priority = card.priority
  el.draggable = true

  // Assignee chip. Match the card's assignee against the known list
  // case-insensitively (a card stored as "gorcsevivan" must still match the
  // list entry "GorcsevIvan"). When the assignee is set but not in the list
  // at all, still render a fallback chip with the raw name + a neutral dot,
  // so a card never silently loses its assignee chip on a name mismatch.
  const rawAssignee = card.assignee ? String(card.assignee).trim() : ''
  const assignee = rawAssignee
    ? kanbanAssignees.find((a) => a.name.toLowerCase() === rawAssignee.toLowerCase())
    : null
  // Display the persona displayName (falling back to the id) per #216, while
  // keeping the robust match above and the raw-name fallback chip below.
  const assigneeLabel = assignee ? (assignee.displayName || assignee.name) : ''
  // Per-agent dot colour: agents all share the type-based green otherwise, which
  // makes them indistinguishable on the board. Derive a stable colour from the
  // agent name (owner/bot keep their semantic colour). Requested by Peti.
  const assigneeColor = (name) => {
    let h = 0
    for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) >>> 0
    return `hsl(${h % 360} 60% 45%)`
  }
  const agentDotStyle =
    assignee && assignee.type === 'agent' ? ` style="background:${assigneeColor(assignee.name)}"` : ''
  const assigneeHtml = assignee
    ? `<span class="kanban-card-assignee"><span class="assignee-dot ${assignee.type}"${agentDotStyle}>${escapeHtml(assigneeLabel[0])}</span>${escapeHtml(assigneeLabel)}</span>`
    : rawAssignee
      ? `<span class="kanban-card-assignee"><span class="assignee-dot unknown">${escapeHtml(rawAssignee[0])}</span>${escapeHtml(rawAssignee)}</span>`
      : ''

  let dueHtml = ''
  if (card.due_date) {
    const d = new Date(card.due_date * 1000)
    const now = new Date()
    const overdue = d < now && card.status !== 'done'
    const label = d.toLocaleDateString('hu-HU', { month: 'short', day: 'numeric' })
    dueHtml = `<span class="kanban-card-due ${overdue ? 'overdue' : ''}">${label}</span>`
  }

  const projectHtml = card.project
    ? `<span class="kanban-card-project">${escapeHtml(card.project)}</span>`
    : ''

  // Label footer pills: at most 3 shown + a "+N" overflow indicator. Each pill
  // (except the overflow one) toggles that label into the active label-filter
  // when clicked, mirroring the priority quick-filter chips above the board.
  let labelsHtml = ''
  if (Array.isArray(card.labels) && card.labels.length > 0) {
    const shown = card.labels.slice(0, 3)
    const overflow = card.labels.length - shown.length
    const pills = shown.map((l) =>
      `<span class="kanban-card-label-pill" data-label-id="${escapeHtml(l.id)}" style="--label-color:${escapeHtml(l.color)}" title="${t('kanban.label.filter_tooltip', { name: escapeHtml(l.name) })}">#${escapeHtml(l.name)}</span>`
    ).join('')
    const overflowHtml = overflow > 0
      ? `<span class="kanban-card-label-pill kanban-card-label-overflow" title="${t('kanban.label.overflow_tooltip', { n: overflow })}">+${overflow}</span>`
      : ''
    labelsHtml = `<div class="kanban-card-labels">${pills}${overflowHtml}</div>`
  }

  const seqHtml = card.seq != null
    ? `<span class="kanban-card-seq" style="font-family:monospace;font-size:11px;color:var(--muted);margin-right:5px">#${card.seq}</span>`
    : ''

  // WCAG AA priority badge (card e291e9c4): the border-left alone was the only signal and does
  // not read as text at all -- see the .priority-badge CSS comment for the measured contrast.
  const priorityLabel = KANBAN_PRIORITY_LABELS[card.priority]?.() ?? card.priority
  const priorityBadgeHtml = card.priority
    ? `<span class="priority-badge priority-${escapeHtml(card.priority)}">${escapeHtml(priorityLabel)}</span>`
    : ''

  // Card aging: left stripe + top-right badge based on hours since last update.
  // Skipped for done cards. Config thresholds and colours come from window._marveen.kanbanAging.
  let agingBadgeHtml = ''
  const agingCfg = window._marveen?.kanbanAging
  if (agingCfg && card.updated_at && card.status !== 'done') {
    const hoursOld = (Date.now() / 1000 - card.updated_at) / 3600
    let agingLevel = null
    let agingColor = null
    if (hoursOld >= agingCfg.criticalH) {
      agingLevel = 'critical'; agingColor = agingCfg.criticalColor
    } else if (hoursOld >= agingCfg.cautionH) {
      agingLevel = 'caution'; agingColor = agingCfg.cautionColor
    } else if (hoursOld >= agingCfg.warnH) {
      agingLevel = 'warn'; agingColor = agingCfg.warnColor
    }
    if (agingLevel) {
      const days = Math.floor(hoursOld / 24)
      const ageLabel = days >= 1 ? `${days}d` : `${Math.floor(hoursOld)}h`
      const exact = new Date(card.updated_at * 1000).toLocaleString('hu-HU')
      agingBadgeHtml = `<span class="kanban-card-aging-badge kanban-card-aging-${agingLevel}" style="color:${agingColor}" title="${t('kanban.aging.tooltip', { exact })}">⏳ ${ageLabel}</span>`
      el.dataset.aging = agingLevel
      el.style.setProperty('--card-aging-color', agingColor)
    }
  }

  // Embedded subtasks: rendered as mini-cards below a divider when the subtask
  // shares the same column as this parent card.
  let embeddedHtml = ''
  if (embeddedChildren.length > 0) {
    const items = embeddedChildren.map(c => {
      const rawCa = c.assignee ? String(c.assignee).trim() : ''
      const ca = rawCa ? kanbanAssignees.find(a => a.name.toLowerCase() === rawCa.toLowerCase()) : null
      const caLabel = ca ? (ca.displayName || ca.name) : rawCa
      const caHtml = caLabel ? `<span class="kanban-embedded-assignee">${escapeHtml(caLabel)}</span>` : ''
      const cSeq = c.seq != null ? `<span class="kanban-embedded-seq">#${c.seq}</span> ` : ''
      return `<div class="kanban-embedded-subtask" data-id="${escapeHtml(c.id)}">${cSeq}${escapeHtml(c.title)}${caHtml}</div>`
    }).join('')
    embeddedHtml = `<div class="kanban-embedded-subtasks">${items}</div>`
  }

  el.innerHTML = `
    ${projectHtml}
    <div class="kanban-card-title">${seqHtml}${escapeHtml(card.title)}</div>
    <div class="kanban-card-footer">${priorityBadgeHtml}${assigneeHtml}${dueHtml}</div>
    ${labelsHtml}
    <div class="kanban-card-actions">
      <button class="card-breakdown-btn" title="${t('kanban.btn.breakdown')}" aria-label="${t('kanban.btn.breakdown')}">⚡</button>
    </div>
    ${agingBadgeHtml}
    <div class="kanban-subtask-badge" style="display:none"></div>
    ${embeddedHtml}
  `

  // "AI szétbont" gomb – ne nyissa meg a detail modalt
  el.querySelector('.card-breakdown-btn').addEventListener('click', (e) => {
    e.stopPropagation()
    triggerBreakdown(card)
  })

  // Label pills -> toggle that label into the active filter (don't open detail)
  el.querySelectorAll('.kanban-card-label-pill[data-label-id]').forEach((pillEl) => {
    pillEl.addEventListener('click', (e) => {
      e.stopPropagation()
      toggleKanbanLabelFilter(pillEl.dataset.labelId)
    })
  })

  // Click on embedded subtask -> open that subtask's detail (don't bubble to parent)
  el.querySelectorAll('.kanban-embedded-subtask').forEach(subEl => {
    subEl.addEventListener('click', (e) => {
      e.stopPropagation()
      const child = kanbanCards.find(c => c.id === subEl.dataset.id)
      if (child) showCardDetail(child)
    })
  })

  // Drag events
  el.addEventListener('dragstart', (e) => {
    el.classList.add('dragging')
    e.dataTransfer.setData('text/plain', card.id)
    e.dataTransfer.effectAllowed = 'move'
  })
  el.addEventListener('dragend', () => el.classList.remove('dragging'))

  // Touch equivalent of the above -- see wireKanbanCardTouchDnD. Wired before
  // the click listener so its capture-phase guard can swallow the tap that
  // ends a drag.
  wireKanbanCardTouchDnD(el, card)

  // Click -> detail
  el.addEventListener('click', () => showCardDetail(card))

  return el
}

// === Drag & Drop ===
// Wires the drag/drop handlers for one column-body element. Used for the
// 4 static flat-board columns at load time, and again for every swimlane
// column-body created dynamically in renderSwimlaneBoard (those elements
// don't exist yet when this module first runs).
function wireKanbanColumnDnD(col) {
  col.addEventListener('dragover', (e) => {
    e.preventDefault()
    e.dataTransfer.dropEffect = 'move'
    col.classList.add('drag-over')

    // Insert indicator position
    const afterEl = getDragAfterElement(col, e.clientY)
    const dragging = document.querySelector('.kanban-card.dragging')
    if (!dragging) return
    if (afterEl) {
      col.insertBefore(dragging, afterEl)
    } else {
      col.appendChild(dragging)
    }
  })

  col.addEventListener('dragleave', (e) => {
    if (!col.contains(e.relatedTarget)) col.classList.remove('drag-over')
  })

  col.addEventListener('drop', async (e) => {
    e.preventDefault()
    col.classList.remove('drag-over')
    const cardId = e.dataTransfer.getData('text/plain')
    const newStatus = col.dataset.status

    // Calculate sort_order based on position
    const cards = [...col.querySelectorAll('.kanban-card')]
    const idx = cards.findIndex((c) => c.dataset.id === cardId)
    let sortOrder = idx

    try {
      await fetch(`/api/kanban/${encodeURIComponent(cardId)}/move`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status: newStatus, sort_order: sortOrder }),
      })
      loadKanban()
    } catch {
      showToast(t('kanban.toast.move_error'))
    }
  })
}
columns.forEach(wireKanbanColumnDnD)

// === Touch drag & drop (mobile) ===
// HTML5 drag & drop above never fires on a touch screen -- no dragstart, no
// drop -- so on a phone the board could only be read, never rearranged. This
// is a parallel touch path over the same /move call.
//
// Why touch events and not Pointer Events + touch-action: a card fills most of
// the column, so making it permanently untouchable for scrolling (touch-action:
// none) would break scrolling the board. Instead the gesture stays ambiguous
// until it resolves: a long press (250ms) means "drag", any earlier movement
// means "scroll" and hands the gesture straight back to the browser. Only once
// dragging is committed does touchmove call preventDefault() to hold the page
// still -- which is why that listener MUST be non-passive.
const TOUCH_DRAG_DELAY_MS = 250
const TOUCH_DRAG_SLOP_PX = 10
let touchDrag = null

function kanbanColBodyAt(x, y) {
  const el = document.elementFromPoint(x, y)
  return el ? el.closest('.kanban-col-body') : null
}

// On a phone the columns stack vertically, so the next column starts ~2000px
// below the fold -- dragging a card "one column over" would mean dragging it
// at an invisible target while the page auto-scrolls for several seconds.
// Instead, committing to a drag raises a fixed bar of status targets over the
// bottom of the screen: the same gesture, with somewhere to drop. Column
// hit-testing stays active for viewports where the target column IS visible.
const KANBAN_TOUCH_STATUSES = ['planned', 'in_progress', 'waiting', 'testing', 'done']

function buildTouchDropBar(currentStatus) {
  const bar = document.createElement('div')
  bar.className = 'kanban-touch-dropbar'
  for (const s of KANBAN_TOUCH_STATUSES) {
    const chip = document.createElement('div')
    chip.className = 'kanban-drop-target'
    chip.dataset.status = s
    if (s === currentStatus) chip.classList.add('is-current')
    chip.textContent = t(`kanban.status.${s}`)
    bar.appendChild(chip)
  }
  document.body.appendChild(bar)
  return bar
}

function kanbanDropTargetAt(x, y) {
  const el = document.elementFromPoint(x, y)
  return el ? el.closest('.kanban-drop-target') : null
}

function clearTouchDragHighlight() {
  document.querySelectorAll('.kanban-col-body.drag-over, .kanban-drop-target.drag-over')
    .forEach((c) => c.classList.remove('drag-over'))
}

function endTouchDrag() {
  if (!touchDrag) return
  clearTimeout(touchDrag.timer)
  touchDrag.ghost?.remove()
  touchDrag.dropBar?.remove()
  touchDrag.el.classList.remove('dragging')
  clearTouchDragHighlight()
  document.removeEventListener('touchmove', kanbanTouchMove)
  document.removeEventListener('touchend', kanbanTouchEnd)
  document.removeEventListener('touchcancel', endTouchDrag)
  touchDrag = null
}

// The ghost is deliberately NOT a full-size copy of the card: at full width it
// covered three of the five drop targets, so the user could not see what they
// were aiming at. It rides ABOVE the fingertip (see positionTouchGhost) for the
// same reason -- the target under the finger has to stay visible.
const TOUCH_GHOST_MAX_W = 200
const TOUCH_GHOST_LIFT = 28

function positionTouchGhost(x, y) {
  const g = touchDrag.ghost
  const gx = x - g.offsetWidth / 2
  const gy = y - g.offsetHeight - TOUCH_GHOST_LIFT
  g.style.transform = `translate(${Math.max(4, gx)}px, ${Math.max(4, gy)}px) rotate(2deg)`
}

function beginTouchDrag(x, y) {
  if (!touchDrag) return
  const el = touchDrag.el
  const box = el.getBoundingClientRect()
  const ghost = document.createElement('div')
  ghost.className = 'kanban-card kanban-card-ghost'
  ghost.textContent = touchDrag.card.title
  ghost.style.cssText = `position:fixed; left:0; top:0; width:${Math.min(box.width, TOUCH_GHOST_MAX_W)}px; pointer-events:none; z-index:9999; opacity:.95; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; box-shadow:0 8px 24px rgba(0,0,0,.35)`
  document.body.appendChild(ghost)
  touchDrag.ghost = ghost
  positionTouchGhost(x, y)
  touchDrag.active = true
  touchDrag.dropBar = buildTouchDropBar(touchDrag.card.status)
  el.classList.add('dragging')
  // Confirm the mode switch on devices that support it -- without a cursor,
  // the only other signal that a long press "took" is the ghost appearing.
  navigator.vibrate?.(10)
}

function kanbanTouchMove(e) {
  if (!touchDrag || e.touches.length !== 1) return
  const p = e.touches[0]
  if (!touchDrag.active) {
    // Still ambiguous: movement beyond the slop means the user is scrolling.
    if (Math.abs(p.clientX - touchDrag.startX) > TOUCH_DRAG_SLOP_PX ||
        Math.abs(p.clientY - touchDrag.startY) > TOUCH_DRAG_SLOP_PX) {
      endTouchDrag()
    }
    return
  }
  e.preventDefault()
  positionTouchGhost(p.clientX, p.clientY)
  clearTouchDragHighlight()
  // The drop bar sits above everything, so test it first -- a chip and a
  // column body can overlap on screen.
  const chip = kanbanDropTargetAt(p.clientX, p.clientY)
  if (chip) { chip.classList.add('drag-over'); return }
  const col = kanbanColBodyAt(p.clientX, p.clientY)
  if (col) col.classList.add('drag-over')
}

async function kanbanTouchEnd(e) {
  if (!touchDrag) return
  if (!touchDrag.active) { endTouchDrag(); return }
  const p = e.changedTouches[0]
  const chip = kanbanDropTargetAt(p.clientX, p.clientY)
  const col = chip ? null : kanbanColBodyAt(p.clientX, p.clientY)
  const cardId = touchDrag.card.id
  // The release that ends a drag would otherwise also register as a tap and
  // open the detail modal on top of the board the user just rearranged.
  touchDrag.el.dataset.suppressClick = '1'
  // Read the drop position BEFORE endTouchDrag drops the .dragging class --
  // getDragAfterElement excludes .dragging, which is what keeps the card from
  // counting itself when it is dropped back into its own column.
  let sortOrder = 0
  let newStatus = null
  if (chip) {
    // Dropped on the status bar: no position information, so append.
    newStatus = chip.dataset.status
    sortOrder = document.querySelectorAll(`.kanban-col-body[data-status="${newStatus}"] .kanban-card`).length
  } else if (col) {
    newStatus = col.dataset.status
    const after = getDragAfterElement(col, p.clientY)
    const others = [...col.querySelectorAll('.kanban-card:not(.dragging)')]
    sortOrder = after ? others.indexOf(after) : others.length
  }
  endTouchDrag()
  // Released outside any target: treat as a cancelled drag, not a move.
  // A drop inside a column always posts, even when the status is unchanged --
  // that is a reorder within the column, which is just as valid a move.
  if (!newStatus) return
  try {
    const r = await fetch(`/api/kanban/${encodeURIComponent(cardId)}/move`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status: newStatus, sort_order: sortOrder }),
    })
    if (!r.ok) throw new Error('move failed')
    loadKanban()
  } catch {
    showToast(t('kanban.toast.move_error'))
  }
}

function wireKanbanCardTouchDnD(el, card) {
  el.addEventListener('touchstart', (e) => {
    if (e.touches.length !== 1) return
    const p = e.touches[0]
    endTouchDrag()
    touchDrag = {
      card, el, ghost: null, active: false,
      startX: p.clientX, startY: p.clientY,
      timer: setTimeout(() => beginTouchDrag(p.clientX, p.clientY), TOUCH_DRAG_DELAY_MS),
    }
    document.addEventListener('touchmove', kanbanTouchMove, { passive: false })
    document.addEventListener('touchend', kanbanTouchEnd)
    document.addEventListener('touchcancel', endTouchDrag)
  }, { passive: true })

  // A long press that turned into a drag must not also open the detail modal
  // on release. The click listener in createCardEl fires after touchend, so
  // the guard flag is read there.
  el.addEventListener('click', (e) => {
    if (el.dataset.suppressClick === '1') {
      delete el.dataset.suppressClick
      e.stopImmediatePropagation()
      e.preventDefault()
    }
  }, true)
}

function getDragAfterElement(col, y) {
  const els = [...col.querySelectorAll('.kanban-card:not(.dragging)')]
  let closest = null
  let closestOffset = Number.NEGATIVE_INFINITY

  for (const el of els) {
    const box = el.getBoundingClientRect()
    const offset = y - box.top - box.height / 2
    if (offset < 0 && offset > closestOffset) {
      closestOffset = offset
      closest = el
    }
  }
  return closest
}

// === New card modal ===
function openNewCardModal(status) {
  document.getElementById('cardModalTitle').textContent = t('kanban.modal.title_new')
  document.getElementById('cardTitle').value = ''
  document.getElementById('cardDesc').value = ''
  document.getElementById('cardPriority').value = 'normal'
  document.getElementById('cardProject').value = ''
  document.getElementById('cardDue').value = ''
  document.getElementById('cardEditId').value = ''
  document.getElementById('cardEditStatus').value = status || 'planned'
  populateAssigneeSelect('cardAssignee')
  populateProjectSuggestions()
  openModal(cardModalOverlay)
  setTimeout(() => document.getElementById('cardTitle').focus(), 200)
}

function populateAssigneeSelect(selectId, selected) {
  const sel = document.getElementById(selectId)
  sel.innerHTML = '<option value="">-- Nincs --</option>'
  for (const a of kanbanAssignees) {
    const opt = document.createElement('option')
    opt.value = a.name
    opt.textContent = a.displayName || a.name
    if (selected && a.name === selected) opt.selected = true
    sel.appendChild(opt)
  }
}

// Save card (create or update)
document.getElementById('saveCardBtn').addEventListener('click', async () => {
  const title = document.getElementById('cardTitle').value.trim()
  if (!title) { document.getElementById('cardTitle').focus(); return }

  const data = {
    title,
    description: document.getElementById('cardDesc').value.trim() || null,
    assignee: document.getElementById('cardAssignee').value || null,
    priority: document.getElementById('cardPriority').value,
    project: document.getElementById('cardProject').value.trim() || null,
    due_date: document.getElementById('cardDue').value
      ? Math.floor(new Date(document.getElementById('cardDue').value).getTime() / 1000)
      : null,
  }

  const editId = document.getElementById('cardEditId').value

  try {
    if (editId) {
      const res = await fetch(`/api/kanban/${encodeURIComponent(editId)}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(data),
      })
      if (!res.ok) { const e = await res.json().catch(() => ({})); throw new Error(e.error || res.status) }
      showToast(t('kanban.toast.card_updated'))
    } else {
      data.status = document.getElementById('cardEditStatus').value
      const res = await fetch('/api/kanban', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(data),
      })
      if (!res.ok) { const e = await res.json().catch(() => ({})); throw new Error(e.error || res.status) }
      showToast(t('kanban.toast.card_created'))
    }
    closeModal(cardModalOverlay)
    loadKanban()
  } catch (err) {
    showToast(t('kanban.toast.save_error_msg', { msg: err.message }))
  }
})

// === Card labels (in the detail modal) ===
// Always re-fetches the card's own labels via the dedicated endpoint instead
// of trusting card.labels -- callers that pass a card object sourced from
// /api/kanban/:id/children (subtask list) don't have labels embedded, only
// the bulk board listing (/api/kanban) does.
async function renderCardLabelsSection(card) {
  const listEl = document.getElementById('cardLabelList')
  const addSelect = document.getElementById('cardLabelAdd')
  const newBtn = document.getElementById('cardLabelNewBtn')
  const newForm = document.getElementById('cardLabelNewForm')
  const newNameInput = document.getElementById('cardLabelNewName')
  const newColorsEl = document.getElementById('cardLabelNewColors')
  const newSaveBtn = document.getElementById('cardLabelNewSaveBtn')

  let attached = []
  try {
    attached = await (await fetch(`/api/kanban/${encodeURIComponent(card.id)}/labels`)).json()
  } catch { /* leave empty -- pill list just stays blank */ }

  listEl.innerHTML = ''
  for (const label of attached) {
    const pill = document.createElement('span')
    pill.className = 'label-pill'
    pill.style.setProperty('--label-color', label.color)
    pill.innerHTML = `#${escapeHtml(label.name)} <button class="label-pill-remove" title="${t('kanban.label.remove_btn')}" aria-label="${t('kanban.label.remove_btn')}">&times;</button>`
    pill.querySelector('.label-pill-remove').addEventListener('click', async () => {
      try {
        await fetch(`/api/kanban/${encodeURIComponent(card.id)}/labels/${encodeURIComponent(label.id)}`, { method: 'DELETE' })
        renderCardLabelsSection(card)
        loadKanban()
      } catch { showToast(t('kanban.toast.label_remove_error')) }
    })
    listEl.appendChild(pill)
  }

  const attachedIds = new Set(attached.map((l) => l.id))
  addSelect.innerHTML = `<option value="">-- ${t('kanban.label.add_placeholder')} --</option>`
  for (const label of kanbanAllLabels) {
    if (attachedIds.has(label.id)) continue
    const opt = document.createElement('option')
    opt.value = label.id
    opt.textContent = label.name
    addSelect.appendChild(opt)
  }
  addSelect.onchange = async () => {
    const labelId = addSelect.value
    if (!labelId) return
    try {
      await fetch(`/api/kanban/${encodeURIComponent(card.id)}/labels`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ labelId }),
      })
      renderCardLabelsSection(card)
      loadKanban()
    } catch { showToast(t('kanban.toast.label_add_error')) }
  }

  newForm.style.display = 'none'
  newBtn.onclick = () => {
    newForm.style.display = newForm.style.display === 'none' ? '' : 'none'
    newNameInput.value = ''
  }

  const palette = window._marveen?.kanbanLabels?.colors || ['#64748b']
  newColorsEl.innerHTML = ''
  let selectedColor = palette[0]
  palette.forEach((color, i) => {
    const sw = document.createElement('span')
    sw.className = 'label-color-swatch' + (i === 0 ? ' selected' : '')
    sw.style.background = color
    sw.addEventListener('click', () => {
      selectedColor = color
      newColorsEl.querySelectorAll('.label-color-swatch').forEach((s) => s.classList.remove('selected'))
      sw.classList.add('selected')
    })
    newColorsEl.appendChild(sw)
  })

  newSaveBtn.onclick = async () => {
    const name = newNameInput.value.trim()
    if (!name) { newNameInput.focus(); return }
    try {
      const r = await fetch('/api/kanban/labels', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, color: selectedColor }),
      })
      if (!r.ok) { showToast(t('kanban.toast.label_create_error')); return }
      const newLabel = await r.json()
      kanbanAllLabels.push(newLabel)
      await fetch(`/api/kanban/${encodeURIComponent(card.id)}/labels`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ labelId: newLabel.id }),
      })
      newForm.style.display = 'none'
      renderCardLabelsSection(card)
      loadKanban()
    } catch { showToast(t('kanban.toast.label_create_error')) }
  }
}

// === Card detail ===
async function showCardDetail(card) {
  // Running number (#N) in the title bar, plus the stable hex id in the meta.
  const seqPrefix = card.seq != null ? `#${card.seq} ` : ''
  document.getElementById('cardDetailTitle').textContent = `${seqPrefix}${card.title}`

  // Case-insensitive match; fall back to the raw stored name so a casing
  // mismatch (or an unregistered assignee) shows the actual name, not "nincs".
  const rawDetailAssignee = card.assignee ? String(card.assignee).trim() : ''
  const assignee = rawDetailAssignee
    ? kanbanAssignees.find((a) => a.name.toLowerCase() === rawDetailAssignee.toLowerCase())
    : null
  const assigneeDisplay = assignee ? (assignee.displayName || assignee.name) : (rawDetailAssignee || '-- nincs --')
  const priorityLabels = { low: t('kanban.priority.low'), normal: t('kanban.priority.normal'), high: t('kanban.priority.high'), urgent: t('kanban.priority.urgent') }
  const statusLabels = { planned: t('kanban.status.planned'), in_progress: t('kanban.status.in_progress'), testing: t('kanban.status.testing'), waiting: t('kanban.status.waiting'), done: t('kanban.status.done') }

  const meta = document.getElementById('cardDetailMeta')
  const idLabel = (card.seq != null ? `#${card.seq} · ` : '') + card.id
  meta.innerHTML = `
    <div class="meta-item">
      <span class="meta-label">${t('kanban.meta.id')}</span>
      <span class="meta-value" style="font-family:monospace" title="${t('kanban.meta.id_tooltip')}">${escapeHtml(idLabel)}</span>
    </div>
    <div class="meta-item">
      <span class="meta-label">${t('kanban.meta.status')}</span>
      <span class="meta-value meta-value-editable" id="metaStatusValue" data-card-id="${card.id}" title="${t('kanban.meta.edit_tooltip')}">${statusLabels[card.status] || card.status}</span>
    </div>
    <div class="meta-item">
      <span class="meta-label">${t('kanban.meta.assignee')}</span>
      <span class="meta-value meta-value-editable" id="metaAssigneeValue" data-card-id="${card.id}" title="${t('kanban.meta.edit_tooltip')}">${escapeHtml(assigneeDisplay)}</span>
    </div>
    <div class="meta-item">
      <span class="meta-label">${t('kanban.meta.priority')}</span>
      <span class="meta-value">${priorityLabels[card.priority]}</span>
    </div>
    <div class="meta-item">
      <span class="meta-label">${t('kanban.meta.project')}</span>
      <span class="meta-value">${card.project ? escapeHtml(card.project) : t('kanban.meta.none')}</span>
    </div>
    <div class="meta-item">
      <span class="meta-label">${t('kanban.meta.deadline')}</span>
      <span class="meta-value">${card.due_date ? new Date(card.due_date * 1000).toLocaleDateString(_lang === 'en' ? 'en-US' : 'hu-HU') : t('kanban.meta.none')}</span>
    </div>
  `

  // Inline edit for status on detail view. HTML5 drag & drop is the only way to
  // change a card's column, and it is dead on touch devices (no dragstart is
  // ever fired), so on a phone the board was effectively read-only. This is the
  // pointer-independent path: tap the card, pick the new status. Mirrors the
  // assignee editor below, but POSTs to /move rather than PUT -- /move is what
  // recomputes sort_order AND fires the in_progress agent dispatch, which a
  // plain PUT would silently skip.
  const statusValueEl = document.getElementById('metaStatusValue')
  statusValueEl.addEventListener('click', () => {
    if (statusValueEl.querySelector('select')) return
    const current = card.status
    const sel = document.createElement('select')
    sel.style.cssText = 'padding:2px 6px; border-radius:4px; border:1px solid var(--border); background:var(--bg-card); color:var(--text); font-size:inherit'
    for (const s of ['planned', 'in_progress', 'waiting', 'testing', 'done']) {
      const opt = document.createElement('option')
      opt.value = s
      opt.textContent = statusLabels[s] || s
      if (s === current) opt.selected = true
      sel.appendChild(opt)
    }
    statusValueEl.innerHTML = ''
    statusValueEl.appendChild(sel)
    sel.focus()
    const restore = (status) => { statusValueEl.textContent = statusLabels[status] || status }
    const save = async () => {
      const newVal = sel.value
      if (newVal === current) { restore(current); return }
      try {
        const r = await fetch(`/api/kanban/${encodeURIComponent(card.id)}/move`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ status: newVal, sort_order: 0 }),
        })
        if (!r.ok) throw new Error('move failed')
        card.status = newVal
        restore(newVal)
        showToast(t('kanban.toast.status_updated'))
        loadKanban && loadKanban()
      } catch {
        restore(current)
        showToast(t('kanban.toast.move_error'))
      }
    }
    sel.addEventListener('change', save)
    sel.addEventListener('blur', () => {
      if (statusValueEl.querySelector('select')) restore(card.status)
    })
  })

  // Inline edit for assignee on detail view
  const assigneeValueEl = document.getElementById('metaAssigneeValue')
  assigneeValueEl.addEventListener('click', () => {
    if (assigneeValueEl.querySelector('select')) return
    const current = card.assignee || ''
    const sel = document.createElement('select')
    sel.style.cssText = 'padding:2px 6px; border-radius:4px; border:1px solid var(--border); background:var(--bg-card); color:var(--text); font-size:inherit'
    sel.innerHTML = '<option value="">-- Nincs --</option>'
    for (const a of kanbanAssignees) {
      const opt = document.createElement('option')
      opt.value = a.name
      opt.textContent = a.displayName || a.name
      if (a.name === current) opt.selected = true
      sel.appendChild(opt)
    }
    assigneeValueEl.innerHTML = ''
    assigneeValueEl.appendChild(sel)
    sel.focus()
    const save = async () => {
      const newVal = sel.value || null
      if (newVal === current || (newVal === null && !current)) {
        assigneeValueEl.textContent = current ? current : '-- nincs --'
        return
      }
      try {
        const r = await fetch(`/api/kanban/${encodeURIComponent(card.id)}`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ ...card, assignee: newVal }),
        })
        if (!r.ok) throw new Error('PUT failed')
        card.assignee = newVal
        assigneeValueEl.textContent = newVal ? newVal : '-- nincs --'
        showToast(t('kanban.toast.assignee_updated'))
        loadKanban && loadKanban()
      } catch {
        assigneeValueEl.textContent = current ? current : '-- nincs --'
        showToast(t('kanban.toast.save_error'))
      }
    }
    sel.addEventListener('change', save)
    sel.addEventListener('blur', () => {
      if (assigneeValueEl.querySelector('select')) {
        assigneeValueEl.textContent = card.assignee ? card.assignee : '-- nincs --'
      }
    })
  })

  document.getElementById('cardDetailDesc').textContent = card.description || ''

  renderCardLabelsSection(card)

  // #115: Parent meta row — dropdown replaces the old read-only display; shown only when editable
  const parentMetaItem = document.getElementById('parentMetaItem')
  const parentSelect = document.getElementById('parentSelect')
  const canModifyParent = card.status === 'planned' || card.status === 'waiting'
  if (card.parent_id && canModifyParent) {
    // Build the parent-select dropdown: null option + all top-level non-done tasks
    parentSelect.innerHTML = `<option value="">${t('kanban.parent.empty')}</option>`
    const availableParents = kanbanCards.filter(c =>
      !c.parent_id && c.id !== card.id && !c.archived_at &&
      (c.status === 'planned' || c.status === 'in_progress' || c.status === 'testing' || c.status === 'waiting')
    )
    for (const p of availableParents) {
      const opt = document.createElement('option')
      opt.value = p.id
      const fullLabel = (p.seq != null ? `#${p.seq} ` : '') + p.title
      opt.title = fullLabel
      opt.textContent = fullLabel.length > 33 ? fullLabel.slice(0, 32) + '…' : fullLabel
      if (p.id === card.parent_id) opt.selected = true
      parentSelect.appendChild(opt)
    }
    parentSelect.onchange = async () => {
      const newParentId = parentSelect.value || null
      const label = newParentId ? t('kanban.toast.parent_updated') : t('kanban.toast.parent_unset')
      const r = await fetch(`/api/kanban/${encodeURIComponent(card.id)}`, {
        method: 'PUT', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...card, parent_id: newParentId }),
      })
      if (r.ok) { card.parent_id = newParentId; showToast(label); loadKanban(); showCardDetail(card) }
      else showToast(t('kanban.toast.save_error'))
    }
    parentMetaItem.style.display = ''
  } else {
    parentMetaItem.style.display = 'none'
  }

  // Load comments
  try {
    const res = await fetch(`/api/kanban/${encodeURIComponent(card.id)}/comments`)
    const comments = await res.json()
    const list = document.getElementById('commentsList')
    list.innerHTML = ''
    for (const c of comments) {
      const date = new Date(c.created_at * 1000).toLocaleString('hu-HU')
      const div = document.createElement('div')
      div.className = 'comment-item'
      div.innerHTML = `
        <div><span class="comment-author">${escapeHtml(c.author)}</span><span class="comment-date">${date}</span></div>
        <div class="comment-body">${escapeHtml(c.content)}</div>
      `
      list.appendChild(div)
    }
  } catch { /* ignore */ }

  // Author select for new comment. Default to the bot assignee resolved by
  // type (never a hard-coded display name -- BOT_NAME differs per deployment),
  // falling back to the first assignee. The old literal 'Marveen' never matched
  // on non-Marveen installs, so the select stayed on "-- Nincs --" and the
  // comment submit silently no-opped (addCommentBtn returns when !author).
  // (Resolution of the #254/#241 overlap: keep #241's type-resolved default
  // over #254's hard-coded "Gábor" -- same deployment-agnostic reasoning.)
  const defaultCommentAuthor =
    (kanbanAssignees.find((a) => a.type === 'owner') || kanbanAssignees[0] || {}).name || ''
  populateAssigneeSelect('commentAuthor', defaultCommentAuthor)

  // Add comment
  document.getElementById('addCommentBtn').onclick = async () => {
    const content = document.getElementById('commentContent').value.trim()
    const author = document.getElementById('commentAuthor').value
    if (!content) { document.getElementById('commentContent').focus(); return }
    if (!author) { showToast(t('kanban.toast.comment_no_author')); return }
    try {
      const res = await fetch(`/api/kanban/${encodeURIComponent(card.id)}/comments`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ author, content }),
      })
      // Without this check an HTTP error (e.g. 400) still cleared the textarea
      // and "refreshed", so the comment looked sent but was never saved.
      if (!res.ok) {
        let msg = `HTTP ${res.status}`
        try { msg = (await res.json()).error || msg } catch {}
        showToast(t('kanban.toast.comment_failed', { msg }))
        return
      }
      document.getElementById('commentContent').value = ''
      showCardDetail(card) // refresh
    } catch {
      showToast(t('kanban.toast.comment_error'))
    }
  }

  // Edit button
  document.getElementById('cardEditBtn').onclick = () => {
    closeModal(cardDetailOverlay)
    document.getElementById('cardModalTitle').textContent = t('kanban.modal.title_edit')
    document.getElementById('cardTitle').value = card.title
    document.getElementById('cardDesc').value = card.description || ''
    document.getElementById('cardPriority').value = card.priority
    document.getElementById('cardProject').value = card.project || ''
    document.getElementById('cardDue').value = card.due_date
      ? new Date(card.due_date * 1000).toISOString().split('T')[0]
      : ''
    document.getElementById('cardEditId').value = card.id
    document.getElementById('cardEditStatus').value = card.status
    populateAssigneeSelect('cardAssignee', card.assignee)
    populateProjectSuggestions()
    openModal(cardModalOverlay)
  }

  // Archive
  document.getElementById('cardArchiveBtn').onclick = async () => {
    try {
      await fetch(`/api/kanban/${encodeURIComponent(card.id)}/archive`, { method: 'POST' })
      closeModal(cardDetailOverlay)
      showToast(t('kanban.toast.card_archived'))
      loadKanban()
    } catch {
      showToast(t('kanban.toast.archive_error'))
    }
  }

  // Delete
  document.getElementById('cardDeleteBtn').onclick = async () => {
    if (!confirm(t('kanban.confirm.delete'))) return
    try {
      await fetch(`/api/kanban/${encodeURIComponent(card.id)}`, { method: 'DELETE' })
      closeModal(cardDetailOverlay)
      showToast(t('kanban.toast.card_deleted'))
      loadKanban()
    } catch {
      showToast(t('common.error_delete'))
    }
  }

  // Load children (subtasks) — only top-level tasks have children (no subtask of subtask)
  try {
    const childRes = await fetch(`/api/kanban/${encodeURIComponent(card.id)}/children`)
    const children = await childRes.json()
    const section = document.getElementById('cardChildrenSection')
    const list = document.getElementById('cardChildrenList')
    const addSubtaskSection = document.getElementById('cardAddSubtaskSection')
    const isTask = !card.parent_id

    // #113: Show add-subtask form only for top-level tasks that are not done
    if (isTask && card.status !== 'done') {
      addSubtaskSection.style.display = ''
      const titleInput = document.getElementById('newSubtaskTitle')
      titleInput.value = ''
      document.getElementById('addSubtaskBtn').onclick = async () => {
        const title = titleInput.value.trim()
        if (!title) { titleInput.focus(); return }
        try {
          const r = await fetch('/api/kanban', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ title, parent_id: card.id, status: card.status, priority: card.priority, project: card.project || null, assignee: null }),
          })
          if (!r.ok) { showToast(t('kanban.toast.subtask_error')); return }
          showToast(t('kanban.toast.subtask_created'))
          loadKanban()
          showCardDetail(card)
        } catch { showToast(t('kanban.toast.subtask_error')) }
      }
    } else {
      addSubtaskSection.style.display = 'none'
    }

    const statusLabelsShort = { planned: t('kanban.status.planned'), in_progress: t('kanban.status.in_progress'), testing: t('kanban.status.testing'), waiting: t('kanban.status.waiting_short'), done: t('kanban.status.done') }
    if (children.length > 0 || isTask) {
      section.style.display = ''
      list.innerHTML = ''
      // #114: Delete button per subtask — only shown when the parent card is not done
      const canDeleteChild = card.status !== 'done'
      for (const ch of children) {
        const div = document.createElement('div')
        div.className = 'comment-item'
        div.style.cssText = 'cursor:pointer; display:flex; justify-content:space-between; align-items:center; gap:8px'
        const info = document.createElement('div')
        info.style.flex = '1'
        info.innerHTML = `<div><strong>${escapeHtml(ch.title)}</strong> <span style="color:var(--text-muted)">[${statusLabelsShort[ch.status] || ch.status}]</span></div>
          <div style="font-size:0.85em;color:var(--text-muted)">${ch.assignee ? escapeHtml(ch.assignee) : ''}${ch.description ? ' -- ' + escapeHtml(ch.description).slice(0, 80) : ''}</div>`
        info.onclick = () => { closeModal(cardDetailOverlay); showCardDetail(ch) }
        div.appendChild(info)
        if (canDeleteChild) {
          const delBtn = document.createElement('button')
          delBtn.className = 'btn-danger btn-compact'
          delBtn.style.flexShrink = '0'
          delBtn.textContent = t('kanban.modal.delete_btn')
          delBtn.onclick = async (e) => {
            e.stopPropagation()
            if (!confirm(t('kanban.confirm.delete_subtask', { title: ch.title }))) return
            try {
              const r = await fetch(`/api/kanban/${encodeURIComponent(ch.id)}`, { method: 'DELETE' })
              if (!r.ok) { showToast(t('common.error_delete')); return }
              showToast(t('kanban.toast.subtask_deleted'))
              loadKanban()
              showCardDetail(card)
            } catch { showToast(t('common.error_delete')) }
          }
          div.appendChild(delBtn)
        }
        list.appendChild(div)
      }
    } else {
      section.style.display = 'none'
    }
  } catch {
    document.getElementById('cardChildrenSection').style.display = 'none'
    document.getElementById('cardAddSubtaskSection').style.display = 'none'
  }

  // Breakdown button
  document.getElementById('cardBreakdownBtn').onclick = async () => {
    const btn = document.getElementById('cardBreakdownBtn')
    btn.disabled = true
    btn.textContent = t('kanban.breakdown.generating')
    try {
      const res = await fetch(`/api/kanban/${encodeURIComponent(card.id)}/breakdown`, { method: 'POST' })
      const data = await res.json()
      if (!res.ok) { showToast(data.error || 'Hiba'); btn.disabled = false; btn.textContent = 'Breakdown'; return }
      breakdownMode = 'kanban'
      breakdownCardId = card.id
      breakdownSubtasks = data.subtasks
      showBreakdownModal(data.subtasks, card)
      const dodSec = document.getElementById('breakdownDoDSection')
      if (dodSec) dodSec.style.display = 'none'
    } catch (err) {
      showToast('Breakdown hiba')
    } finally {
      btn.disabled = false
      btn.textContent = 'Breakdown'
    }
  }

  openModal(cardDetailOverlay)
  // Inline diff-comment section (card c12abc67, pair-BE 906c130f).
  void loadCardDiffComments(card.id)
}

// Inline diff-comment view (card c12abc67). API: GET /api/kanban/:id/diff-comments
// Returns { diffs: [{sha, file, hunks: [{header, lines: [{type, number, content, comments: [{id, author, text}]}]}] }] }
// 404 → section stays hidden (pair-BE 906c130f not yet built -- contract-first graceful fallback).
async function loadCardDiffComments(cardId) {
  const section = document.getElementById('cardDiffSection')
  const body = document.getElementById('cardDiffBody')
  if (!section || !body) return
  section.hidden = true
  body.innerHTML = `<p class="diff-loading">${escapeHtml(t('common.loading'))}</p>`
  const token = localStorage.getItem('marveen-dashboard-token') || ''
  try {
    const r = await fetch(`/api/kanban/${encodeURIComponent(cardId)}/diff-comments`, {
      headers: { 'Authorization': 'Bearer ' + token },
    })
    if (r.status === 404) { section.hidden = true; return }
    if (!r.ok) throw new Error('HTTP ' + r.status)
    const d = await r.json()
    const diffs = Array.isArray(d.diffs) ? d.diffs : []
    if (!diffs.length) {
      body.innerHTML = `<p class="diff-empty">${escapeHtml(t('kanban.diff.empty'))}</p>`
      section.hidden = false
      wireCardDiffToggle(body)
      return
    }
    body.innerHTML = diffs.map((fileDiff) => renderDiffFile(cardId, fileDiff)).join('')
    section.hidden = false
    wireCardDiffToggle(body)
    wireDiffInteractions(cardId, body)
  } catch {
    body.innerHTML = `<p class="diff-error">${escapeHtml(t('kanban.diff.error'))}</p>`
    section.hidden = false
  }
}

function renderDiffFile(cardId, fileDiff) {
  const sha = escapeHtml(fileDiff.sha || '')
  const fileName = escapeHtml(fileDiff.file || '')
  const hunks = Array.isArray(fileDiff.hunks) ? fileDiff.hunks : []
  const linesHtml = hunks.map((hunk) => {
    const headerHtml = hunk.header
      ? `<div class="diff-hunk-header">${escapeHtml(hunk.header)}</div>`
      : ''
    const lines = Array.isArray(hunk.lines) ? hunk.lines : []
    const linesHtml = lines.map((ln) => {
      const typeClass = ln.type === 'added' ? 'diff-line-add' : ln.type === 'removed' ? 'diff-line-remove' : 'diff-line-context'
      const prefix = ln.type === 'added' ? '+' : ln.type === 'removed' ? '-' : ' '
      const comments = Array.isArray(ln.comments) ? ln.comments : []
      const commentsHtml = comments.length
        ? `<div class="diff-inline-comments">${comments.map((c) =>
            `<div class="diff-inline-comment" data-comment-id="${escapeHtml(String(c.id))}">
              <span class="diff-comment-author">${escapeHtml(c.author || '?')}</span>
              <span class="diff-comment-text">${escapeHtml(c.text || '')}</span>
              <button class="diff-comment-delete btn-danger btn-compact" data-comment-id="${escapeHtml(String(c.id))}" data-line="${escapeHtml(String(ln.number || 0))}" title="${escapeHtml(t('kanban.diff.delete_btn'))}">&times;</button>
            </div>`
          ).join('')}</div>`
        : ''
      const addFormHtml = `<div class="diff-add-form" hidden data-line="${escapeHtml(String(ln.number || 0))}" data-sha="${sha}" data-file="${fileName}">
  <textarea placeholder="${escapeHtml(t('kanban.diff.add_comment_ph'))}" rows="2"></textarea>
  <div class="diff-add-form-actions">
    <button class="btn-primary btn-compact diff-submit-btn" data-i18n="kanban.diff.add_btn">${escapeHtml(t('kanban.diff.add_btn'))}</button>
    <button class="btn-secondary btn-compact diff-cancel-btn" data-i18n="kanban.diff.cancel_btn">${escapeHtml(t('kanban.diff.cancel_btn'))}</button>
  </div>
</div>`
      return `<div class="diff-line ${typeClass}" data-line="${escapeHtml(String(ln.number || 0))}">
  <span class="diff-line-num">${escapeHtml(String(ln.number || ''))}</span>
  <span class="diff-line-content">${prefix}${escapeHtml(ln.content || '')}</span>
  <button class="diff-add-comment-btn" data-line="${escapeHtml(String(ln.number || 0))}" aria-label="${escapeHtml(t('kanban.diff.add_comment_ph'))}">+</button>
</div>${commentsHtml}${addFormHtml}`
    }).join('')
    return headerHtml + linesHtml
  }).join('')
  return `<div class="diff-file">
  <div class="diff-file-header">
    <span class="diff-file-name">${fileName}</span>
    <span class="diff-file-sha">${sha}</span>
  </div>
  <div class="diff-table">${linesHtml}</div>
</div>`
}

function wireCardDiffToggle(body) {
  const toggle = document.getElementById('cardDiffToggle')
  if (!toggle) return
  toggle.addEventListener('click', () => {
    const expanded = toggle.getAttribute('aria-expanded') !== 'false'
    toggle.setAttribute('aria-expanded', String(!expanded))
    toggle.textContent = !expanded ? t('kanban.diff.collapse') : t('kanban.diff.expand')
    body.hidden = !expanded
  })
}

function wireDiffInteractions(cardId, container) {
  // "+" buttons toggle the add-comment form for a given line
  container.querySelectorAll('.diff-add-comment-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      const line = btn.dataset.line
      const form = container.querySelector(`.diff-add-form[data-line="${line}"]`)
      if (!form) return
      const wasHidden = form.hidden
      // Close all other forms first
      container.querySelectorAll('.diff-add-form').forEach((f) => { f.hidden = true })
      form.hidden = !wasHidden
      if (!form.hidden) form.querySelector('textarea')?.focus()
    })
  })
  // Cancel buttons
  container.querySelectorAll('.diff-cancel-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      const form = btn.closest('.diff-add-form')
      if (form) { form.hidden = true; const ta = form.querySelector('textarea'); if (ta) ta.value = '' }
    })
  })
  // Submit buttons
  container.querySelectorAll('.diff-submit-btn').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const form = btn.closest('.diff-add-form')
      if (!form) return
      const text = form.querySelector('textarea')?.value?.trim() || ''
      if (!text) return
      const line = parseInt(form.dataset.line || '0', 10)
      const sha = form.dataset.sha || ''
      const file = form.dataset.file || ''
      btn.disabled = true
      try {
        await addDiffComment(cardId, sha, file, line, text)
        void loadCardDiffComments(cardId)
      } catch {
        showToast(t('kanban.diff.error'))
        btn.disabled = false
      }
    })
  })
  // Delete buttons
  container.querySelectorAll('.diff-comment-delete').forEach((btn) => {
    btn.addEventListener('click', async () => {
      if (!confirm(t('kanban.diff.delete_confirm'))) return
      const commentId = btn.dataset.commentId
      if (!commentId) return
      const token = localStorage.getItem('marveen-dashboard-token') || ''
      try {
        await fetch(`/api/kanban/${encodeURIComponent(cardId)}/diff-comments/${encodeURIComponent(commentId)}`, {
          method: 'DELETE',
          headers: { 'Authorization': 'Bearer ' + token },
        })
        void loadCardDiffComments(cardId)
      } catch {
        showToast(t('kanban.diff.error'))
      }
    })
  })
}

async function addDiffComment(cardId, sha, file, line, text) {
  const token = localStorage.getItem('marveen-dashboard-token') || ''
  const r = await fetch(`/api/kanban/${encodeURIComponent(cardId)}/diff-comments`, {
    method: 'POST',
    headers: { 'Authorization': 'Bearer ' + token, 'Content-Type': 'application/json' },
    body: JSON.stringify({ sha, file, line, text, author: 'dashboard' }),
  })
  if (!r.ok) throw new Error('HTTP ' + r.status)
}

async function triggerBreakdown(card) {
  const btn = document.querySelector(`.kanban-card[data-id="${card.id}"] .card-breakdown-btn`)
  if (btn) { btn.disabled = true; btn.textContent = '...' }
  try {
    const res = await fetch(`/api/kanban/${encodeURIComponent(card.id)}/breakdown`, { method: 'POST' })
    const data = await res.json()
    if (!res.ok) { showToast(data.error || 'Breakdown hiba'); return }
    breakdownMode = 'kanban'
    breakdownCardId = card.id
    breakdownSubtasks = data.subtasks
    showBreakdownModal(data.subtasks, card)
  } catch {
    showToast('Breakdown hiba')
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = '⚡' }
  }
}

function showBreakdownModal(subtasks, parentCard) {
  document.getElementById('breakdownProvider').textContent = t('kanban.breakdown.parent_label', { title: escapeHtml(parentCard.title) })
  const list = document.getElementById('breakdownList')
  list.innerHTML = ''

  const priorityLabels = { low: t('kanban.priority.low'), normal: t('kanban.priority.normal'), high: t('kanban.priority.high'), urgent: t('kanban.priority.urgent') }
  const assigneeOptions = kanbanAssignees
    .map((a) => `<option value="${escapeHtml(a.name)}">${escapeHtml(a.displayName || a.name)}</option>`)
    .join('')

  subtasks.forEach((st, i) => {
    const div = document.createElement('div')
    div.className = 'comment-item breakdown-subtask-item'
    div.dataset.idx = i
    div.style.borderLeft = '3px solid var(--accent)'
    div.innerHTML = `
      <div style="display:flex; justify-content:space-between; align-items:center; gap:8px; margin-bottom:8px">
        <label style="font-size:0.8em; color:var(--text-muted); white-space:nowrap">${i + 1}.</label>
        <input type="text" class="breakdown-title-input" value="${escapeHtml(st.title)}"
          style="flex:1; padding:5px 8px; border-radius:6px; border:1px solid var(--border); background:var(--bg-card); color:var(--text); font-size:0.9em">
        <label style="font-size:0.8em; white-space:nowrap">
          <input type="checkbox" class="breakdown-check" data-idx="${i}" checked> Bele
        </label>
      </div>
      <div style="display:flex; gap:8px; align-items:center; flex-wrap:wrap">
        <select class="breakdown-assignee-select" style="padding:4px 8px; border-radius:6px; border:1px solid var(--border); background:var(--bg-card); color:var(--text); font-size:0.85em">
          <option value="">-- nincs --</option>
          ${assigneeOptions}
        </select>
        <span class="priority-badge priority-${st.priority}">${priorityLabels[st.priority] || st.priority}</span>
      </div>
    `
    // Set assignee select value after insert
    const sel = div.querySelector('.breakdown-assignee-select')
    if (st.assignee) sel.value = st.assignee
    list.appendChild(div)
  })
  openModal(breakdownOverlay)
}

document.getElementById('breakdownAcceptBtn').addEventListener('click', async () => {
  const items = document.querySelectorAll('.breakdown-subtask-item')
  const accepted = []
  items.forEach((item) => {
    const idx = parseInt(item.dataset.idx, 10)
    const checked = item.querySelector('.breakdown-check')?.checked
    if (!checked) return
    const title = item.querySelector('.breakdown-title-input')?.value.trim() || breakdownSubtasks[idx]?.title
    const assignee = item.querySelector('.breakdown-assignee-select')?.value || breakdownSubtasks[idx]?.assignee
    const priority = breakdownSubtasks[idx]?.priority || 'normal'
    const description = breakdownSubtasks[idx]?.description || ''
    accepted.push({ title, assignee, priority, description })
  })
  if (accepted.length === 0) { showToast(t('kanban.breakdown.select_one')); return }
  try {
    if (breakdownMode === 'idea') {
      const successCriteria = document.getElementById('breakdownSuccessCriteria')?.value.trim() || undefined
      const res = await fetch(`/api/ideas/${encodeURIComponent(breakdownIdeaId)}/promote-breakdown`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ subtasks: accepted, success_criteria: successCriteria }),
      })
      const data = await res.json()
      if (!res.ok) { showToast(data.error || 'Hiba'); return }
      closeModal(breakdownOverlay)
      showToast(t('kanban.breakdown.promoted', { count: data.child_count }))
      loadIdeasPage()
      return
    }
    const res = await fetch(`/api/kanban/${encodeURIComponent(breakdownCardId)}/breakdown/accept`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ subtasks: accepted }),
    })
    const data = await res.json()
    if (!res.ok) { showToast(data.error || 'Hiba'); return }
    closeModal(breakdownOverlay)
    closeModal(cardDetailOverlay)
    showToast(t('kanban.breakdown.created_count', { count: data.created.length }))
    loadKanban()
  } catch {
    showToast(t('common.error_save'))
  }
})

document.getElementById('breakdownRejectBtn').addEventListener('click', () => {
  closeModal(breakdownOverlay)
  showToast(t('kanban.toast.breakdown_rejected'))
})

document.getElementById('breakdownClose').addEventListener('click', () => closeModal(breakdownOverlay))

// === Elements: Agents ===
const agentsGrid = document.getElementById('agentsGrid')
const addBtn = document.getElementById('addAgentBtn')
const agentWizardOverlay = document.getElementById('agentWizardOverlay')
const agentDetailOverlay = document.getElementById('agentDetailOverlay')
const skillModalOverlay = document.getElementById('skillModalOverlay')
const llmQueueDetailOverlay = document.getElementById('llmQueueDetailOverlay')
const agentName = document.getElementById('agentName')
const agentDesc = document.getElementById('agentDesc')
const agentModel = document.getElementById('agentModel')
const toast = document.getElementById('toast')

const AVATARS = [
  '01_robot.png', '02_wizard_girl.png', '03_knight.png', '04_ninja.png',
  '05_pirate.png', '06_scientist_girl.png', '07_astronaut.png', '08_viking.png',
  '09_cowgirl.png', '10_detective.png', '11_chef.png', '12_witch.png',
  '13_samurai.png', '14_fairy_girl.png', '15_firefighter.png', '16_punk_girl.png',
  '17_explorer.png', '18_dj.png', '19_princess.png', '20_alien.png'
]

let selectedAvatar = null
let selectedAvatarFile = null // custom upload chosen in the create wizard (deferred until the agent exists)
let agents = []
let currentAgent = null
// API-safe agent id for the currently open detail modal. Sub-agents key off
// their name; the main agent's detail object carries name:'marveen' for legacy
// UI checks but its real agent-dir id is agentId (MAIN_AGENT_ID, e.g.
// 'gorcsevivan') -- the /api/agents/<id>/skills endpoints need that real id.
function agentApiName() {
  return currentAgent ? (currentAgent.agentId || currentAgent.name) : ''
}
let wizardStep = 1
let generatedClaudeMd = ''
let generatedSoulMd = ''
let wizardCreatedName = ''
// Set from the POST /api/agents response when the backend fell back to a template
// because personality generation failed. It answers 200 in that case (the agent
// EXISTS and works), so `res.ok` alone cannot tell the operator anything -- without
// reading this field the wizard would look exactly like a full success.
let wizardPersonalityPending = null

// === Modal helpers ===
function openModal(overlay) {
  overlay.classList.add('active')
  document.body.style.overflow = 'hidden'
}
function closeModal(overlay) {
  overlay.classList.remove('active')
  document.body.style.overflow = ''
  // Skill modal is used by two distinct callers (Agent detail + Skills
  // page). Reset the scope on every close path -- explicit button,
  // click-outside, Esc, programmatic -- so the next opener cannot
  // inherit a stale 'global' flag from an earlier Skills-page open.
  if (overlay && overlay.id === 'skillModalOverlay') skillModalScope = null
}

// Wizard open
addBtn.addEventListener('click', () => {
  resetWizard()
  openModal(agentWizardOverlay)
  setTimeout(() => agentName.focus(), 200)
})

// Close buttons
document.getElementById('wizardClose').addEventListener('click', () => closeModal(agentWizardOverlay))
document.getElementById('agentDetailClose').addEventListener('click', () => closeModal(agentDetailOverlay))
document.getElementById('skillModalClose').addEventListener('click', () => closeModal(skillModalOverlay))
document.getElementById('llmQueueDetailClose').addEventListener('click', () => closeModal(llmQueueDetailOverlay))

// Click-outside-to-close
agentWizardOverlay.addEventListener('click', (e) => { if (e.target === agentWizardOverlay) closeModal(agentWizardOverlay) })
agentDetailOverlay.addEventListener('click', (e) => { if (e.target === agentDetailOverlay) closeModal(agentDetailOverlay) })
skillModalOverlay.addEventListener('click', (e) => { if (e.target === skillModalOverlay) closeModal(skillModalOverlay) })
llmQueueDetailOverlay.addEventListener('click', (e) => { if (e.target === llmQueueDetailOverlay) closeModal(llmQueueDetailOverlay) })

// Close all modals on Escape
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    document.querySelectorAll('.modal-overlay.active').forEach((o) => closeModal(o))
  }
})

// === Avatar Gallery ===
function populateAvatarGrid() {
  const grid = document.getElementById('avatarGrid')
  grid.innerHTML = ''
  for (const avatar of AVATARS) {
    const item = document.createElement('div')
    item.className = 'avatar-grid-item'
    item.dataset.avatar = avatar
    item.innerHTML = `<img src="/avatars/${avatar}" alt="${avatar.replace(/^\d+_/, '').replace('.png', '')}">`
    item.addEventListener('click', () => {
      grid.querySelectorAll('.avatar-grid-item').forEach(i => i.classList.remove('selected'))
      item.classList.add('selected')
      selectedAvatar = avatar
      // Gallery pick and custom upload are mutually exclusive.
      selectedAvatarFile = null
      resetCreateAvatarUpload()
    })
    grid.appendChild(item)
  }
}

// === Wizard logic ===
let cachedProfiles = null
async function loadProfiles() {
  if (cachedProfiles) return cachedProfiles
  try {
    const res = await fetch('/api/profiles')
    if (res.ok) cachedProfiles = await res.json()
  } catch {}
  return cachedProfiles || []
}

function populateProfileSelect(selectEl, descEl, selected) {
  loadProfiles().then((profiles) => {
    selectEl.innerHTML = ''
    for (const p of profiles) {
      const opt = document.createElement('option')
      opt.value = p.id
      const tag = p.permissionMode === 'strict' ? ` (${t('agents.strict_mode')})` : ''
      opt.textContent = `${p.label}${tag}`
      if (p.id === selected) opt.selected = true
      selectEl.appendChild(opt)
    }
    const updateDesc = () => {
      const p = profiles.find(x => x.id === selectEl.value)
      descEl.textContent = p ? p.description : ''
    }
    selectEl.onchange = updateDesc
    updateDesc()
  })
}

// Populate the per-agent Claude subscription plan dropdown from the named
// registry (/api/claude-plans). The empty value means "no named plan" -> the
// agent keeps its raw config-dir / host default. The description line shows the
// plan type + config dir and flags a Channels-forbidden plan so the operator
// sees the guardrail context before saving.
function populatePlanSelect(selectEl, descEl, selected) {
  if (!selectEl) return
  fetch('/api/claude-plans')
    .then(res => (res.ok ? res.json() : []))
    .catch(() => [])
    .then((plans) => {
      const known = plans.some(p => p.id === selected)
      const opts = [`<option value="">${escapeHtml(t('agents.settings.plan_default'))}</option>`]
      for (const p of plans) {
        opts.push(`<option value="${escapeHtml(p.id)}">${escapeHtml(p.label)}</option>`)
      }
      // Preserve an already-assigned plan id that is NOT in the loaded registry
      // (registry edited/renamed, OR /api/claude-plans transiently failed and
      // returned []). Without this the dropdown would resolve to '' and a save
      // would silently wipe the real assignment.
      if (selected && !known) {
        opts.push(`<option value="${escapeHtml(selected)}">${escapeHtml(selected)}${escapeHtml(t('agents.settings.plan_not_found_suffix'))}</option>`)
      }
      selectEl.innerHTML = opts.join('')
      selectEl.value = selected || ''
      const updateDesc = () => {
        if (!descEl) return
        const val = selectEl.value
        if (!val) {
          descEl.textContent = t('agents.settings.plan_default_desc')
          return
        }
        const p = plans.find(x => x.id === val)
        if (!p) {
          descEl.textContent = t('agents.settings.plan_unresolved_desc', { id: val })
          return
        }
        const warn = p.channelsAllowed ? '' : t('agents.settings.plan_no_channels')
        descEl.textContent = `${p.planType} · ${p.configDir}${warn}`
      }
      selectEl.onchange = updateDesc
      updateDesc()
    })
}

// Paints (or clears) the step-3 notice from wizardPersonalityPending. Called from
// resetWizard() too, so a later successful run can never inherit a stale banner.
function renderWizardPendingBanner() {
  const banner = document.getElementById('wizardPendingBanner')
  if (!banner) return
  if (!wizardPersonalityPending) {
    banner.hidden = true
    return
  }
  document.getElementById('wizardPendingTitle').textContent = t('agents.wizard.pending_title')
  document.getElementById('wizardPendingBody').textContent = t('agents.wizard.pending_body')
  const detailEl = document.getElementById('wizardPendingDetail')
  const detail = wizardPersonalityPending.detail
  // The cause is shown, but only when the server actually sent one: an empty
  // string here would render "A hiba oka: " with nothing after it, which reads
  // like the UI lost something.
  if (detail) {
    detailEl.textContent = t('agents.wizard.pending_detail', { detail })
    detailEl.hidden = false
  } else {
    detailEl.textContent = ''
    detailEl.hidden = true
  }
  banner.hidden = false
}

function resetWizard() {
  wizardStep = 1
  agentName.value = ''
  agentDesc.value = ''
  agentModel.value = 'inherit'
  loadAvailableModels()
  selectedAvatar = null
  selectedAvatarFile = null
  document.querySelectorAll('#avatarGrid .avatar-grid-item').forEach(i => i.classList.remove('selected'))
  resetCreateAvatarUpload()
  generatedClaudeMd = ''
  generatedSoulMd = ''
  wizardCreatedName = ''
  wizardPersonalityPending = null
  renderWizardPendingBanner()
  document.getElementById('wizardClaudeMd').value = ''
  document.getElementById('wizardSoulMd').value = ''
  populateProfileSelect(
    document.getElementById('agentProfile'),
    document.getElementById('agentProfileDesc'),
    'default',
  )
  updateWizardUI()
}

function updateWizardUI() {
  // Steps indicator
  document.querySelectorAll('#wizardSteps .wizard-step').forEach((s) => {
    const step = parseInt(s.dataset.step)
    s.classList.toggle('active', step === wizardStep)
    s.classList.toggle('done', step < wizardStep)
  })
  // Panels
  document.getElementById('wizardStep1').hidden = wizardStep !== 1
  document.getElementById('wizardStep2').hidden = wizardStep !== 2
  document.getElementById('wizardStep3').hidden = wizardStep !== 3
}

// Step 1 -> Step 2 (generate)
document.getElementById('wizardNextBtn').addEventListener('click', async () => {
  const name = agentName.value.trim()
  const desc = agentDesc.value.trim()
  if (!name) { agentName.focus(); return }
  if (!desc) { agentDesc.focus(); return }

  wizardStep = 2
  updateWizardUI()

  const statusEl = document.getElementById('wizardGenStatus')
  statusEl.textContent = t('agents.claude_md_generating')

  try {
    // Create agent via API (returns generated content)
    const res = await fetch('/api/agents', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name,
        description: desc,
        model: agentModel.value,
        profile: document.getElementById('agentProfile').value,
      }),
    })

    if (!res.ok) {
      const err = await res.json()
      throw new Error(err.error || 'Ismeretlen hiba')
    }

    const result = await res.json()
    // Backend sanitizes the name (lowercase ASCII, NFD-stripped accents).
    // Use the sanitized form for every follow-up request so accented input
    // like "étrendíró" still resolves to the real agent dir "etrendiro".
    const createdName = result.name || name
    wizardCreatedName = createdName
    // 200 + personalityPending means the agent was created but its personality
    // came from a template. Captured here and painted when step 3 opens, where
    // the operator both sees the placeholder text and can rewrite it.
    wizardPersonalityPending = result.personalityPending
      ? { detail: result.detail || '', warning: result.warning || '' }
      : null
    statusEl.textContent = t('agents.soul_md_generating')

    // Fetch full agent details to get generated content
    const detailRes = await fetch(`/api/agents/${encodeURIComponent(createdName)}`)
    if (detailRes.ok) {
      const detail = await detailRes.json()
      generatedClaudeMd = detail.claudeMd || detail.content || ''
      generatedSoulMd = detail.soulMd || ''
    }

    statusEl.textContent = t('kanban.breakdown.running')

    // Apply the chosen avatar. Custom upload wins over a gallery pick; both go
    // to the same endpoint (FormData for a file, JSON for a gallery name).
    if (selectedAvatarFile) {
      const form = new FormData()
      form.append('avatar', selectedAvatarFile, selectedAvatarFile.name)
      await fetch(`/api/agents/${encodeURIComponent(createdName)}/avatar`, {
        method: 'POST',
        body: form,
      })
    } else if (selectedAvatar) {
      await fetch(`/api/agents/${encodeURIComponent(createdName)}/avatar`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ galleryAvatar: selectedAvatar }),
      })
    }

    // Auto-advance to step 3
    setTimeout(() => {
      wizardStep = 3
      document.getElementById('wizardClaudeMd').value = generatedClaudeMd
      document.getElementById('wizardSoulMd').value = generatedSoulMd
      renderWizardPendingBanner()
      updateWizardUI()
    }, 600)
  } catch (err) {
    showToast(`Hiba: ${err.message}`)
    wizardStep = 1
    updateWizardUI()
  }
})

// Step 3 -> back to step 1
document.getElementById('wizardBackBtn').addEventListener('click', () => {
  wizardStep = 1
  updateWizardUI()
})

// Step 3 -> Create (finalize with edits)
document.getElementById('wizardCreateBtn').addEventListener('click', async () => {
  // Use the backend-sanitized name stored in wizardCreatedName, not the raw
  // input field -- accents in the input would miss the real agent dir.
  const name = wizardCreatedName || agentName.value.trim()
  const claudeMd = document.getElementById('wizardClaudeMd').value
  const soulMd = document.getElementById('wizardSoulMd').value
  const createBtn = document.getElementById('wizardCreateBtn')

  createBtn.disabled = true
  createBtn.querySelector('.btn-text').hidden = true
  createBtn.querySelector('.btn-loading').hidden = false

  try {
    // Update with edited content
    const res = await fetch(`/api/agents/${encodeURIComponent(name)}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ claudeMd, soulMd }),
    })

    if (!res.ok) {
      const err = await res.json()
      throw new Error(err.error || 'Ismeretlen hiba')
    }

    closeModal(agentWizardOverlay)
    showToast('Ugynok letrehozva. Kosd be a csatornat a parosatashoz.')
    await loadAgents()
    // Drop the operator straight into the Telegram tab of the new agent so
    // the pairing step is in front of them -- easy to miss otherwise.
    try {
      await openAgentDetail(name)
      switchAgentTab('channel')
    } catch { /* detail open failed, list refresh already happened */ }
  } catch (err) {
    showToast(`Hiba: ${err.message}`)
  } finally {
    createBtn.disabled = false
    createBtn.querySelector('.btn-text').hidden = false
    createBtn.querySelector('.btn-loading').hidden = true
  }
})

// === Toast ===
function showToast(msg, duration = 3000) {
  toast.textContent = msg
  toast.classList.add('visible')
  setTimeout(() => toast.classList.remove('visible'), duration)
}

// === Agents API ===
async function loadAgents() {
  try {
    // The federation status fetch is deliberately failure-proof (.catch ->
    // null): it must NEVER take down the Agents page -- including on an
    // older backend where the route 404s.
    const [agentsRes, marveenRes, fedStatus] = await Promise.all([
      fetch('/api/agents'),
      fetch('/api/marveen'),
      fetch('/api/federation/status').then((r) => (r.ok ? r.json() : null)).catch(() => null),
    ])
    agents = await agentsRes.json()
    if (fedStatus && Array.isArray(fedStatus.peers)) federatedPeerStatus = fedStatus.peers
    if (marveenRes.ok) {
      window._marveen = await marveenRes.json()
      // A backend CHANNEL_PROVIDER-éhez igazitsuk a kliens-default-ot,
      // hogy ne 'telegram' jelenjen meg amikor a backend discord-on van.
      if (window._marveen?.channelProvider) {
        currentChannelProvider = window._marveen.channelProvider
        const sel = document.getElementById('chProviderSelect')
        if (sel) sel.value = currentChannelProvider
        if (typeof updateProviderUI === 'function') updateProviderUI()
      }
    }
    renderAgents()
  } catch (err) {
    console.error('Betöltés hiba:', err)
  }
}

// Format a context-token count for display (e.g. 699884 -> "≈700k token").
function formatContextTokens(n) {
  if (typeof n !== 'number' || !isFinite(n) || n <= 0) return '-'
  if (n < 1000) return `${n} token`
  const k = n / 1000
  return `≈${k < 10 ? k.toFixed(1) : Math.round(k)}k token`
}

// Populate the auto-restart controls + context display from an agent payload.
// Works for sub-agents (agent.name) and the main session (agent.autoRestartId).
function setupAutoRestartUI(agent) {
  const ctxEl = document.getElementById('agentDetailContext')
  if (ctxEl) ctxEl.textContent = formatContextTokens(agent && agent.contextTokens)

  const ar = (agent && agent.autoRestart) || { enabled: false, mode: 'continue', dailyTime: null, intervalHours: null }
  const enabled = document.getElementById('arEnabled')
  const mode = document.getElementById('arMode')
  const schedKind = document.getElementById('arSchedKind')
  const dailyWrap = document.getElementById('arDailyWrap')
  const dailyTime = document.getElementById('arDailyTime')
  const intervalWrap = document.getElementById('arIntervalWrap')
  const intervalHours = document.getElementById('arIntervalHours')
  if (!enabled || !mode || !schedKind) return

  enabled.checked = ar.enabled === true
  mode.value = ar.mode === 'fresh' ? 'fresh' : 'continue'
  if (ar.intervalHours) {
    schedKind.value = 'interval'
    intervalHours.value = ar.intervalHours
  } else {
    schedKind.value = 'daily'
    if (ar.dailyTime) dailyTime.value = ar.dailyTime
  }
  const syncSched = () => {
    const isInterval = schedKind.value === 'interval'
    intervalWrap.hidden = !isInterval
    dailyWrap.hidden = isInterval
  }
  syncSched()
  // Attach the show/hide listener once.
  if (schedKind.dataset.wired !== '1') {
    schedKind.addEventListener('change', syncSched)
    schedKind.dataset.wired = '1'
  }
}

async function openMarveenDetail() {
  const m = window._marveen
  if (!m) return

  // Reuse the agent detail modal for Marveen
  currentAgent = { ...m, name: mainAgentId(), claudeMd: '', soulMd: '', mcpJson: '', skills: [] }
  setupAutoRestartUI(currentAgent)

  const displayName = m.name || 'Marveen'
  document.getElementById('agentDetailTitle').textContent = displayName
  const avatar = document.getElementById('agentDetailAvatar')
  avatar.className = 'detail-avatar gradient-1'
  avatar.innerHTML = `<img src="/api/marveen/avatar${avatarBust()}" alt="${escapeHtml(displayName)}">`
  document.getElementById('agentDetailName').textContent = displayName
  document.getElementById('agentDetailDesc').textContent = m.description || ''
  document.getElementById('agentDetailModel').textContent = m.model || '-'
  document.getElementById('agentDetailChStatus').innerHTML = `<span class="tg-status"><span class="tg-dot connected"></span>${t('agents.channel.connected')}</span>`
  // Populate the Skills tab for the main agent too: the endpoint returns the
  // global ~/.claude/skills under its real id (agentId), which every agent
  // inherits. Previously this was hard-set to '-' and loadSkills was never
  // called, so the main agent's Skills tab always looked empty.
  loadSkills(agentApiName())

  // Process control for Marveen - always running, no start/stop
  document.getElementById('processDot').className = 'process-dot running'
  document.getElementById('processLabel').textContent = t('agents.status.running')
  document.getElementById('processUptime').textContent = `tmux: ${m.tmuxSession || '-'}`
  document.getElementById('agentStartBtn').hidden = true
  document.getElementById('agentStopBtn').hidden = true
  // Sync the settings tab model select with Marveen's actual model so it
  // doesn't carry over the previously opened sub-agent's selection.
  const marveenModelSelect = document.getElementById('editAgentModel')
  if (marveenModelSelect) {
    // The main agent's real model (e.g. 'claude-opus-4-8') may not match any
    // static option verbatim (the option is 'claude-opus-4-8[1m]'), so a plain
    // .value assignment finds no match and the select silently displays the
    // first option (Fable 5), misrepresenting what the agent actually runs.
    // Inject the real id as an option so the (read-only) select shows the truth
    // -- same trick as the sub-agent panel's dynamic-model-opt.
    const mv = m.activeModel || m.model || ''
    Array.from(marveenModelSelect.querySelectorAll('option.dynamic-model-opt')).forEach(o => o.remove())
    if (mv && !Array.from(marveenModelSelect.options).some(o => o.value === mv)) {
      const opt = document.createElement('option')
      opt.value = mv
      opt.className = 'dynamic-model-opt'
      opt.textContent = mv
      marveenModelSelect.appendChild(opt)
    }
    marveenModelSelect.value = mv
  }
  // Populate the model dropdown groups (auto/manual) AND surface the OpenRouter
  // curation button -- this is the main agent, the only place curation lives.
  loadAvailableModels()
  // Surface the "channels restart" button -- destructive, but mobile-safe
  // when the Telegram plugin wedges and you're away from a terminal.
  document.getElementById('marveenRestartBtn').hidden = false

  // Settings tab - load real CLAUDE.md / SOUL.md / .mcp.json (read-only).
  // Editing the main agent's identity files via the dashboard is intentionally
  // not allowed: a leaked dashboard token would otherwise let a remote user
  // rewrite the live agent's instructions. Edit via filesystem or by asking
  // Marveen on Telegram instead.
  let mFull = m
  try {
    const claudeRes = await fetch('/api/marveen')
    if (claudeRes.ok) {
      mFull = await claudeRes.json()
      document.getElementById('editClaudeMd').value = mFull.claudeMd || ''
      document.getElementById('editSoulMd').value = mFull.soulMd || ''
      document.getElementById('editMcpJson').value = mFull.mcpJson || ''
    }
  } catch {}
  applyMarveenReadonlyMode(true)

  // Telegram tab -- without this the tab stays in the default "not connected"
  // view even though the bot is running and receiving messages.
  updateChannelTab({
    name: mainAgentId(),
    hasTelegram: mFull.hasTelegram !== undefined ? mFull.hasTelegram : true,
    hasDiscord: mFull.hasDiscord,
    hasSlack: mFull.hasSlack,
    telegramBotUsername: mFull.telegramBotUsername,
    running: true,
  })

  // Delete button - hide for Marveen
  document.getElementById('deleteAgentBtn').style.display = 'none'

  document.getElementById('detailAvatarGallery').hidden = true
  switchAgentTab('overview')
  openModal(agentDetailOverlay)
}

// `readOnly` is really "this modal is showing the MAIN agent" -- it is called
// with true from openMarveenDetail and false from openAgentDetail, which makes
// it the one hook both open-paths share. Anything that must differ for the main
// agent belongs here; putting it in openAgentDetail alone silently no-ops for
// the main agent, whose panel never runs that function.
function applyMarveenReadonlyMode(readOnly) {
  // The Team tab describes a SUB-agent's place in the hierarchy: role
  // (leader | member), who it reports to, who it delegates to. None of it
  // applies to the main agent, which has no team record and cannot have one.
  // Its role is 'main', a tier ABOVE leader, and it is an implicit trusted peer
  // of every agent (see isTrustedPeer), so there is nothing to configure. Shown
  // anyway, the tab printed the literal fallback "member" and invited the
  // operator to promote the main agent to 'leader' -- a demotion, and one that
  // cannot be saved either way: the PUT targets /api/agents/<main>/team, which
  // 404s because no agents/<main>/ directory exists. Hide the whole tab, same
  // reasoning as claudePlanGroup.
  const teamTabBtn = document.querySelector('#agentTabNav .tab-btn[data-tab="team"]')
  if (teamTabBtn) teamTabBtn.hidden = readOnly
  const textareaIds = ['editClaudeMd', 'editSoulMd', 'editMcpJson']
  // saveModelBtn stays VISIBLE but disabled for Marveen, so the settings tab
  // doesn't look like the row is missing -- the other save buttons (tied to
  // readonly textareas) are hidden because the textareas are also hidden by
  // the readonly note flow.
  const hideButtonIds = ['saveClaudeMdBtn', 'saveSoulMdBtn', 'saveMcpJsonBtn', 'saveAuthModeBtn']
  const disableButtonIds = ['saveModelBtn']
  for (const id of textareaIds) {
    const el = document.getElementById(id)
    if (!el) continue
    if (readOnly) el.setAttribute('readonly', 'readonly')
    else el.removeAttribute('readonly')
  }
  const modelSelect = document.getElementById('editAgentModel')
  if (modelSelect) modelSelect.disabled = readOnly
  for (const id of hideButtonIds) {
    const btn = document.getElementById(id)
    if (btn) btn.hidden = readOnly
  }
  for (const id of disableButtonIds) {
    const btn = document.getElementById(id)
    if (btn) { btn.hidden = false; btn.disabled = readOnly }
  }
  const authModeGroup = document.getElementById('authModeGroup')
  if (authModeGroup) authModeGroup.hidden = readOnly
  const memoryIsolationGroup = document.getElementById('memoryIsolationGroup')
  if (memoryIsolationGroup) memoryIsolationGroup.hidden = readOnly
  const note = document.getElementById('marveenReadonlyNote')
  if (note) note.hidden = !readOnly
}


function getAvatarGradient(name) {
  const hash = name.split('').reduce((a, c) => a + c.charCodeAt(0), 0)
  return 'gradient-' + ((hash % 3) + 1)
}

// Tooltip text for the "Fut" / "Leállva" footer indicator (process state).
function processTip(isRunning) {
  return isRunning
    ? t('agents.running_tip')
    : t('agents.stopped_tip')
}

// Tooltip text for the "Online" / "Offline" footer indicator (channel state).
function channelTip(isConnected) {
  return isConnected
    ? t('agents.online_tip')
    : t('agents.offline_tip')
}

// Build the copy-paste tmux attach command for an agent live session. A local
// agent session runs on the orchestrator host (a direct `tmux attach`); a remote
// agent session runs on its configured remoteHost, reached over ssh. Only
// meaningful for running agents.
function tmuxAttachCommand(agent) {
  const session = agent.session || ('agent-' + agent.name)
  const direct = 'tmux attach -t ' + session
  const remoteHost = agent.remoteHost || null
  return remoteHost ? 'ssh ' + remoteHost + " -t '" + direct + "'" : direct
}

// Append a single "copy tmux attach command" button to a running agent card.
// Clicks copy to clipboard and never bubble to the card open-detail handler.
function attachTmuxCopyButtons(card, agent) {
  const cmd = tmuxAttachCommand(agent)
  const row = document.createElement('div')
  row.className = 'agent-tmux-cmds'
  const btn = document.createElement('button')
  btn.type = 'button'
  btn.className = 'tmux-copy-btn'
  btn.setAttribute('aria-label', t('agents.tmux_copy_aria'))
  btn.title = cmd
  btn.innerHTML = '<span class="tmux-copy-ico">⧉</span>tmux'
  btn.addEventListener('click', (e) => {
    e.stopPropagation()
    navigator.clipboard.writeText(cmd).then(() => {
      const orig = btn.innerHTML
      btn.classList.add('copied')
      btn.innerHTML = '<span class="tmux-copy-ico">✓</span>' + t('agents.tmux_copied')
      setTimeout(() => { btn.innerHTML = orig; btn.classList.remove('copied') }, 1400)
    }).catch(() => showToast(t('agents.tmux_copy_failed')))
  })
  row.appendChild(btn)
  card.appendChild(row)
}

// Per-agent live HUD shell (kanban f07c5b7c): context-pct bar (filled by
// refreshAgentHud() below from GET /api/context-guard) + a static active-model
// line (from the already-fetched agents list, no extra request) + active-tool
// and running-sub-agent (filled from GET /api/agent-hud, card e9504aba). The
// tool/sub-agent rows start hidden and only appear once the poll has a value --
// an idle agent (activeTool===null) legitimately shows neither, that is real
// data, not a missing slot.
function agentHudBlockHtml(hudKey, activeModel) {
  const modelLine = activeModel
    ? `<div class="agent-hud-row agent-hud-model">${escapeHtml(t('agents.hud.active_model', { model: activeModel }))}</div>`
    : ''
  return `
    <div class="agent-hud" data-hud-agent="${escapeHtml(hudKey)}">
      <div class="agent-hud-row agent-hud-row--pct">
        <span class="agent-hud-label">${t('agents.hud.context_label')}</span>
        <div class="agent-hud-bar"><div class="agent-hud-bar-fill" style="width:0%"></div></div>
        <span class="agent-hud-pct">-</span>
      </div>
      <div class="agent-hud-disabled-label" hidden>${t('agents.hud.context_disabled')}</div>
      ${modelLine}
      <div class="agent-hud-row agent-hud-tool-row" hidden></div>
      <div class="agent-hud-row agent-hud-subagent-row" hidden></div>
      <span class="agent-hud-truncated" hidden role="img" aria-label="${escapeHtml(t('agents.hud.truncated'))}" title="${escapeHtml(t('agents.hud.truncated'))}">&#9888;</span>
      <div class="agent-hud-stale" hidden></div>
    </div>
  `
}

function renderAgents() {
  agentsGrid.querySelectorAll('.agent-card:not(.add-card)').forEach((el) => el.remove())

  // Marveen card (always first)
  if (window._marveen) {
    const m = window._marveen
    const displayName = m.name || 'Marveen'
    // The model is no longer hardcoded: /api/marveen reports the configured
    // model (readActiveModelFromProjectDir). Mirror the sub-agent card, which
    // uses the model value as both the badge label and class. Fall back to
    // 'opus' only before /api/marveen has resolved (or on a legacy backend).
    const mainModelLabel = m.model || 'opus'
    const mainModelClass = m.model || 'opus'
    const mCard = document.createElement('div')
    mCard.className = 'agent-card marveen-card agent-card-running'
    mCard.innerHTML = `
      <div class="agent-card-top">
        <div class="agent-avatar gradient-1"><img src="/api/marveen/avatar${avatarBust()}" alt="${escapeHtml(displayName)}"></div>
        <div class="agent-card-info">
          <div class="agent-name">${escapeHtml(displayName)} <span class="marveen-badge">${t('agents.main_badge')}</span></div>
          <div class="agent-desc">${escapeHtml(m.description || '')}</div>
        </div>
      </div>
      <div class="agent-card-footer">
        <span class="agent-model-badge ${escapeHtml(mainModelClass)}">${escapeHtml(mainModelLabel)}</span>
        <span class="process-indicator" title="${t('agents.marveen_process_tip')}"><span class="process-dot running"></span>${t('agents.status.running')}</span>
        <span class="tg-status" title="${t('agents.marveen_channel_tip')}"><span class="tg-dot connected"></span>${t('agents.status.online')}</span>
      </div>
      ${agentHudBlockHtml(mainAgentId(), null)}
      <div class="agent-card-actions">
        <button class="btn-secondary btn-compact agent-conversation-btn" title="${t('agents.btn.conversation')}">
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>
          ${t('agents.btn.conversation')}
        </button>
        <button class="btn-secondary btn-compact agent-terminal-btn" title="Terminal">
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="4 17 10 11 4 5"/><line x1="12" y1="19" x2="20" y2="19"/></svg>
          Terminal
        </button>
      </div>
    `
    mCard.querySelector('.agent-terminal-btn')?.addEventListener('click', (e) => {
      e.stopPropagation(); openTerminalModal(mainAgentId())
    })
    mCard.querySelector('.agent-conversation-btn')?.addEventListener('click', (e) => {
      e.stopPropagation(); openConversationModal(mainAgentId(), t('agents.marveen_boss'))
    })
    mCard.addEventListener('click', () => openMarveenDetail())
    agentsGrid.insertBefore(mCard, addBtn)
  }

  for (const agent of agents) {
    // agent.name is the sanitized id (API/filesystem); displayName keeps the
    // original accented/cased input the user typed.
    const label = agent.displayName || agent.name
    const card = document.createElement('div')
    card.className = 'agent-card'
    card.dataset.name = agent.name
    const initial = label.charAt(0).toUpperCase()
    const gradientClass = getAvatarGradient(agent.name)
    const avatarHtml = (agent.hasImage || agent.hasAvatar)
      ? `<img src="/api/agents/${encodeURIComponent(agent.name)}/avatar${avatarBust()}" alt="${escapeHtml(label)}">`
      : initial

    const modelClass = agent.model && agent.model !== 'inherit' ? agent.model : ''
    const modelLabel = agent.model || 'inherit'
    const chConnected = agentIsConnected(agent)
    const chDotClass = chConnected ? 'connected' : 'disconnected'
    const chLabel = chConnected ? t('agents.status.online') : t('agents.status.offline')
    const isRunning = agent.running || false
    const runDotClass = isRunning ? 'running' : 'stopped'
    const runLabel = isRunning ? t('agents.status.running') : t('agents.status.stopped')
    // Animated border for agents that are actively running (Peti). The class
    // drives the CSS @keyframes in style.css (.agent-card-running).
    if (isRunning) card.classList.add('agent-card-running')

    card.innerHTML = `
      <div class="agent-card-top">
        <div class="agent-avatar ${gradientClass}">${avatarHtml}</div>
        <div class="agent-card-info">
          <div class="agent-name">${escapeHtml(label)}</div>
          <div class="agent-desc">${escapeHtml(agent.description || '')}</div>
        </div>
      </div>
      <div class="agent-card-footer">
        <span class="agent-model-badge ${escapeHtml(modelClass)}">${escapeHtml(modelLabel)}</span>
        <span class="process-indicator" title="${escapeHtml(processTip(isRunning))}"><span class="process-dot ${runDotClass}"></span>${runLabel}</span>
        <span class="tg-status" title="${escapeHtml(channelTip(chConnected))}"><span class="tg-dot ${chDotClass}"></span>${chLabel}</span>
      </div>
      ${isRunning ? agentHudBlockHtml(agent.name, agent.activeModel) : ''}
      ${agent.needsReauth ? `
        <div class="agent-reauth-banner">
          <span class="agent-reauth-reason">${escapeHtml(agent.reauthReason || t('agents.reauth.reason'))}</span>
          <button class="btn-danger btn-compact agent-login-btn" data-phase="start">${t('agents.btn.login')}</button>
        </div>` : ''}
      <div class="agent-card-actions">
        <button class="btn-secondary btn-compact agent-conversation-btn" title="${t('agents.btn.conversation')}">
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>
          ${t('agents.btn.conversation')}
        </button>
        <button class="btn-secondary btn-compact agent-terminal-btn" title="Terminal">
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="4 17 10 11 4 5"/><line x1="12" y1="19" x2="20" y2="19"/></svg>
          Terminal
        </button>
      </div>
    `
    // Login button handler (start → confirm flow)
    card.querySelectorAll('.agent-login-btn').forEach(btn => {
      btn.addEventListener('click', (e) => { e.stopPropagation(); handleAgentLogin(agent.name, btn) })
    })
    // Terminal button
    card.querySelector('.agent-terminal-btn')?.addEventListener('click', (e) => {
      e.stopPropagation(); openTerminalModal(agent.name)
    })
    // Conversation (readable transcript) button
    card.querySelector('.agent-conversation-btn')?.addEventListener('click', (e) => {
      e.stopPropagation(); openConversationModal(agent.name, label)
    })
    card.addEventListener('click', () => openAgentDetail(agent.name))
    // Only running agents have a live session to look at, so only they get the
    // copy-the-tmux-command buttons.
    if (isRunning) attachTmuxCopyButtons(card, agent)
    agentsGrid.insertBefore(card, addBtn)
  }
  renderFederatedAgentCards(agentsGrid, addBtn)
  // Re-apply the live busy tint right after a re-render (renderAgents rebuilds
  // the cards from scratch, dropping the class), so it never blinks off while
  // the page is open.
  if (agentsBusyTimer) refreshAgentTerminalBusy()
}

// === Agents: live "working" tint on Terminal buttons ===
// Reuse the Activity page's data source (/api/agents/activity, same 3s poll,
// same working/idle state derived from the tmux pane) to turn an agent card's
// Terminal button green while that agent is actively working, and clear it when
// it goes idle or stops. No new backend -- just a second consumer of the same
// endpoint. The main (Marveen) card matches on mainAgentId(); sub-agent cards
// match on their data-name.
let agentsBusyTimer = null
function startAgentsBusyPoll() {
  refreshAgentTerminalBusy()
  refreshAgentHud()
  if (agentsBusyTimer) clearInterval(agentsBusyTimer)
  agentsBusyTimer = setInterval(() => { refreshAgentTerminalBusy(); refreshAgentHud() }, 3000)
}
function stopAgentsBusyPoll() {
  if (agentsBusyTimer) { clearInterval(agentsBusyTimer); agentsBusyTimer = null }
}
async function refreshAgentTerminalBusy() {
  if (!agentsGrid) return
  let entries
  try {
    const res = await fetch('/api/agents/activity')
    if (!res.ok) return
    entries = await res.json()
  } catch { return }
  if (!Array.isArray(entries)) return
  const stateByName = new Map(entries.map((e) => [e.name, e.state]))
  const mainId = mainAgentId()
  agentsGrid.querySelectorAll('.agent-card:not(.add-card)').forEach((card) => {
    const btn = card.querySelector('.agent-terminal-btn')
    if (!btn) return
    const id = card.classList.contains('marveen-card') ? mainId : card.dataset.name
    const working = !!id && stateByName.get(id) === 'working'
    btn.classList.toggle('agent-terminal-btn--busy', working)
  })
}

// Live context-pct fill for the per-agent HUD (kanban f07c5b7c). Reads the
// existing GET /api/context-guard (already computed for the context-guard
// feature, no new backend work) and paints only the bar/label -- the shell
// was already created by agentHudBlockHtml() in renderAgents(). A stale
// fetch (network blip or a poll that returns late) never blanks the bar: it
// keeps the last good value and surfaces a discreet "updated Xs ago" note
// instead of a raw error (rule 12).
const agentHudLastGoodAt = new Map()
async function fetchJsonOrNull(url) {
  try {
    const res = await fetch(url)
    if (!res.ok) return null
    return await res.json()
  } catch { return null }
}

async function refreshAgentHud() {
  if (!agentsGrid) return
  const [guardData, hudData] = await Promise.all([
    fetchJsonOrNull('/api/context-guard'),
    fetchJsonOrNull('/api/agent-hud'),
  ])
  // A poll tick with BOTH endpoints unreachable is a network blip, not new
  // data -- bail out and let the existing DOM (+ staleness note below) speak
  // for itself instead of wiping every card back to "-".
  if (!guardData && !hudData) return
  const guardList = Array.isArray(guardData?.agents) ? guardData.agents : []
  const hudList = Array.isArray(hudData?.agents) ? hudData.agents : []
  const now = Date.now()
  const guardByAgent = new Map(guardList.map((e) => [e.agent, e]))
  const hudByAgent = new Map(hudList.map((e) => [e.agent, e]))
  agentsGrid.querySelectorAll('[data-hud-agent]').forEach((hud) => {
    const key = hud.dataset.hudAgent
    const guardEntry = guardByAgent.get(key)
    const hudEntry = hudByAgent.get(key)
    if (!guardEntry && !hudEntry) return
    agentHudLastGoodAt.set(key, now)
    if (guardEntry) {
      const pctRow = hud.querySelector('.agent-hud-row--pct')
      const disabledLabel = hud.querySelector('.agent-hud-disabled-label')
      const fill = hud.querySelector('.agent-hud-bar-fill')
      const pctText = hud.querySelector('.agent-hud-pct')
      if (guardEntry.enabled && typeof guardEntry.pct === 'number') {
        if (pctRow) pctRow.hidden = false
        if (disabledLabel) disabledLabel.hidden = true
        const pct = Math.max(0, Math.min(100, Math.round(guardEntry.pct)))
        if (fill) {
          fill.style.width = `${pct}%`
          fill.classList.toggle('agent-hud-bar-fill--mid', pct >= 70 && pct < 90)
          fill.classList.toggle('agent-hud-bar-fill--danger', pct >= 90)
        }
        if (pctText) pctText.textContent = `${pct}%`
      } else {
        if (pctRow) pctRow.hidden = true
        if (disabledLabel) disabledLabel.hidden = false
      }
    }
    if (hudEntry) {
      // SECURITY: only the tool NAME and a sub-agent COUNT ever reach the DOM --
      // never entry.contextTokens/activeModel duplicates (pct/model already come
      // from their own sources above) and never anything transcript-shaped.
      const toolRow = hud.querySelector('.agent-hud-tool-row')
      if (toolRow) {
        if (typeof hudEntry.activeTool === 'string' && hudEntry.activeTool) {
          toolRow.hidden = false
          toolRow.textContent = t('agents.hud.active_tool', { tool: hudEntry.activeTool })
        } else {
          toolRow.hidden = true
        }
      }
      const subagentRow = hud.querySelector('.agent-hud-subagent-row')
      if (subagentRow) {
        const n = hudEntry.runningSubAgents
        if (typeof n === 'number' && n > 0) {
          subagentRow.hidden = false
          subagentRow.textContent = t('agents.hud.subagent_running', { n })
        } else {
          subagentRow.hidden = true
        }
      }
      // The tail-scan bound was hit: activeTool/runningSubAgents came from only
      // PART of the transcript. Per BE's contract, an in-flight call is always
      // recent enough to survive the bound -- but a reader must still be able to
      // tell "confirmed idle" from "scan was cut short", not silently treat both
      // as the same empty state.
      const truncatedEl = hud.querySelector('.agent-hud-truncated')
      if (truncatedEl) truncatedEl.hidden = !hudEntry.truncated
    }
    const staleEl = hud.querySelector('.agent-hud-stale')
    if (staleEl) {
      const lastGood = agentHudLastGoodAt.get(key)
      const ageSec = lastGood ? Math.round((now - lastGood) / 1000) : null
      if (ageSec != null && ageSec >= 15) {
        staleEl.hidden = false
        staleEl.textContent = t('agents.hud.stale', { sec: ageSec })
      } else {
        staleEl.hidden = true
      }
    }
  })
}

// Federated (remote-system) agents from the manifest-poller cache. Kept in a
// SEPARATE array from `agents`: that global feeds the team editor and the
// create-wizard, where qualified ids would be selectable-and-invalid.
// "remote" already means SSH agents in this codebase -- these are FEDERATED.
let federatedPeerStatus = []

// System/plumbing agent names never shown as message targets.
const FEDERATED_HIDDEN_AGENTS = new Set(['heartbeat', 'telegram-coordinator', 'channel-coordinator'])

function federatedAgentEntries() {
  const out = []
  for (const peer of federatedPeerStatus) {
    const manifest = peer && peer.manifest
    if (!manifest || !Array.isArray(manifest.agents)) continue
    for (const a of manifest.agents) {
      if (!a || typeof a.id !== 'string' || FEDERATED_HIDDEN_AGENTS.has(a.id.split('/').pop())) continue
      out.push({ peer: peer.id, peerState: peer.state, qualified: `${peer.id}/${a.id}`, displayName: a.displayName || a.id, model: a.model || '' })
    }
  }
  return out
}

function renderFederatedAgentCards(agentsGrid, addBtn) {
  for (const fa of federatedAgentEntries()) {
    const card = document.createElement('div')
    card.className = 'agent-card federated-agent-card'
    const reachable = fa.peerState === 'ok'
    // SECURITY: every manifest-derived string is peer-controlled. Text nodes
    // go through escapeHtml; NOTHING peer-controlled may land in an attribute
    // (escapeHtml does not encode quotes). The model badge is a plain text
    // span WITHOUT a model-derived class.
    const gradientClass = 'gradient-' + ((fa.qualified.charCodeAt(0) % 3) + 1)
    card.innerHTML = `
      <div class="agent-card-top">
        <div class="agent-avatar ${gradientClass}">${escapeHtml(fa.displayName.charAt(0).toUpperCase())}</div>
        <div class="agent-card-info">
          <div class="agent-name">${escapeHtml(fa.displayName)} <span class="federated-badge">${t('federation.badge', { peer: fa.peer })}</span></div>
          <div class="agent-desc">${escapeHtml(fa.qualified)}</div>
        </div>
      </div>
      <div class="agent-card-footer">
        <span class="agent-model-badge">${escapeHtml(fa.model)}</span>
        <span class="tg-status"><span class="tg-dot ${reachable ? 'connected' : 'disconnected'}"></span> ${reachable ? t('federation.peer_state.ok') : t('federation.peer_state.' + (fa.peerState || 'unknown'))}</span>
      </div>
      <div class="agent-card-actions">
        <button class="btn-secondary btn-compact federated-message-btn">${t('federation.btn.message')}</button>
      </div>`
    card.querySelector('.federated-message-btn').addEventListener('click', (e) => {
      e.stopPropagation()
      openFederatedThread(fa.qualified)
    })
    agentsGrid.insertBefore(card, addBtn)
  }
}

function openFederatedThread(qualifiedId) {
  chatSelectedAgent = qualifiedId
  if (location.hash === '#messages') switchPage('messages')
  else location.hash = 'messages'
}

// === Agent Detail ===
async function openAgentDetail(agentName) {
  if (agentName === mainAgentId()) {
    return openMarveenDetail()
  }

  try {
    const res = await fetch(`/api/agents/${encodeURIComponent(agentName)}`)
    if (!res.ok) throw new Error('Not found')
    currentAgent = await res.json()
  } catch (err) {
    showToast(t('agents.toast.load_failed'))
    return
  }

  const detailLabel = currentAgent.displayName || currentAgent.name

  // Title
  document.getElementById('agentDetailTitle').textContent = detailLabel

  // Overview tab
  const initial = detailLabel.charAt(0).toUpperCase()
  const gradientClass = getAvatarGradient(currentAgent.name)
  const avatar = document.getElementById('agentDetailAvatar')
  avatar.className = 'detail-avatar ' + gradientClass
  avatar.innerHTML = (currentAgent.hasImage || currentAgent.hasAvatar)
    ? `<img src="/api/agents/${encodeURIComponent(currentAgent.name)}/avatar" alt="${escapeHtml(detailLabel)}">`
    : initial
  document.getElementById('agentDetailName').textContent = detailLabel
  document.getElementById('agentDetailDesc').textContent = currentAgent.description || ''
  document.getElementById('agentDetailModel').textContent = currentAgent.activeModel || currentAgent.model || 'inherit'
  document.getElementById('agentDetailModelRestarting').hidden = true

  const chConnected = agentIsConnected(currentAgent)
  document.getElementById('agentDetailChStatus').innerHTML = `<span class="tg-status"><span class="tg-dot ${chConnected ? 'connected' : 'disconnected'}"></span>${chConnected ? t('agents.channel.connected') : t('agents.channel.disconnected')}</span>`

  // Settings tab - load Ollama + DeepSeek models then set value
  loadAvailableModels()
  loadOllamaModels().then(() => {
    const sel = document.getElementById('editAgentModel')
    const mv = currentAgent.activeModel || currentAgent.model || 'claude-opus-4-8[1m]'
    // The model <select> is one shared element reused per agent. A manual
    // OpenRouter id (or openrouter-auto:tier) may not be among the static/auto
    // options, so setting .value would silently show nothing. Inject THIS
    // agent's model as a selectable option (cleaning any stale injected ones
    // first) so every agent always displays its own model, per-agent.
    Array.from(sel.querySelectorAll('option.dynamic-model-opt')).forEach(o => o.remove())
    if (!Array.from(sel.options).some(o => o.value === mv)) {
      const opt = document.createElement('option')
      opt.value = mv
      opt.className = 'dynamic-model-opt'
      opt.textContent = mv.startsWith('openrouter-auto:') ? `🔀 ${mv}` : `🔀 ${mv}`
      sel.appendChild(opt)
    }
    sel.value = mv
  })
  populateProfileSelect(
    document.getElementById('editAgentProfile'),
    document.getElementById('editAgentProfileDesc'),
    currentAgent.securityProfile || 'default',
  )
  // The main agent's Claude login is managed via channels.sh, not the per-agent
  // config path, so plan selection does not apply to it. Hide the whole group.
  const planGroup = document.getElementById('claudePlanGroup')
  if (planGroup) planGroup.hidden = currentAgent.role === 'main'
  populatePlanSelect(
    document.getElementById('editAgentPlan'),
    document.getElementById('editAgentPlanDesc'),
    currentAgent.claudePlan || '',
  )
  renderTeamEditor(currentAgent, agents)
  updateAuthModeUI(currentAgent.authMode || 'shared', currentAgent.hasApiKey || false)
  const memIsoToggle = document.getElementById('memoryIsolationToggle')
  if (memIsoToggle) memIsoToggle.checked = currentAgent.memoryIsolation === true
  loadVoiceConfig(currentAgent.name)
  document.getElementById('editClaudeMd').value = currentAgent.claudeMd || currentAgent.content || ''
  document.getElementById('editSoulMd').value = currentAgent.soulMd || ''
  document.getElementById('editMcpJson').value = currentAgent.mcpJson || ''

  // Auto-restart settings + live context size
  setupAutoRestartUI(currentAgent)

  // Telegram tab
  updateChannelTab(currentAgent)

  // Skills tab
  await loadSkills(currentAgent.name)

  // Process control
  updateProcessControl(currentAgent)

  // Channels restart button is Marveen-only -- hide on normal agents.
  document.getElementById('marveenRestartBtn').hidden = true

  // Restore editable Settings (Marveen detail flips this to read-only).
  applyMarveenReadonlyMode(false)

  // Delete button (restore visibility for normal agents)
  document.getElementById('deleteAgentBtn').style.display = ''
  document.getElementById('deleteAgentBtn').onclick = async () => {
    if (!confirm(t('agents.confirm.delete', { name: currentAgent.name }))) return
    try {
      await fetch(`/api/agents/${encodeURIComponent(currentAgent.name)}`, { method: 'DELETE' })
      closeModal(agentDetailOverlay)
      showToast(t('agents.toast.deleted'))
      loadAgents()
    } catch (err) {
      showToast(t('common.error_delete'))
    }
  }

  // Export button: download a portable .tar.gz bundle of this agent. Offers to
  // include channel tokens (off by default -- the safe-to-share variant).
  // The download goes through the auth-wrapped fetch (the global fetch shim
  // injects the Bearer header) and is turned into a Blob download, rather than
  // a plain navigation -- a window.location download cannot carry the
  // Authorization header and the API would 401 it.
  document.getElementById('exportAgentBtn').onclick = async () => {
    if (!currentAgent) return
    const withSecrets = confirm(
      'Belevegyük a titkokat (channel bot token, párosítási állapot)?\n\n' +
      'OK = igen, csak saját gépek közötti átvitelhez.\n' +
      'Mégse = nem, biztonságosan megosztható (csak identitás + viselkedés).'
    )
    const name = currentAgent.name
    const url = `/api/agents/${encodeURIComponent(name)}/export${withSecrets ? '?secrets=1' : ''}`
    try {
      const res = await fetch(url)
      if (!res.ok) {
        const data = await res.json().catch(() => ({}))
        showToast(data.error || 'Hiba az exportálás során')
        return
      }
      const blob = await res.blob()
      const objectUrl = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = objectUrl
      a.download = `marveen-agent-${name}.tar.gz`
      document.body.appendChild(a)
      a.click()
      a.remove()
      URL.revokeObjectURL(objectUrl)
      showToast(`Ügynök exportálva${withSecrets ? ' (titkokkal)' : ''}`)
    } catch {
      showToast('Hiba az exportálás során')
    }
  }

  // Reset to first tab, hide avatar gallery
  document.getElementById('detailAvatarGallery').hidden = true
  switchAgentTab('overview')
  openModal(agentDetailOverlay)
}

// === Detail avatar gallery ===
function populateDetailAvatarGrid() {
  const grid = document.getElementById('detailAvatarGrid')
  grid.innerHTML = ''
  for (const avatar of AVATARS) {
    const item = document.createElement('div')
    item.className = 'avatar-grid-item'
    item.dataset.avatar = avatar
    item.innerHTML = `<img src="/avatars/${avatar}" alt="${avatar.replace(/^\d+_/, '').replace('.png', '')}">`
    item.addEventListener('click', async () => {
      if (!currentAgent) return
      grid.querySelectorAll('.avatar-grid-item').forEach(i => i.classList.remove('selected'))
      item.classList.add('selected')
      try {
        const res = await fetch(`/api/agents/${encodeURIComponent(currentAgent.name)}/avatar`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ galleryAvatar: avatar }),
        })
        if (!res.ok) throw new Error()
        showToast(t('agents.toast.avatar_updated'))
        bumpAvatarEpoch()
        // Update the detail avatar display
        document.getElementById('agentDetailAvatar').innerHTML = `<img src="/api/agents/${encodeURIComponent(currentAgent.name)}/avatar${avatarBust()}" alt="">`
        document.getElementById('detailAvatarGallery').hidden = true
        loadAgents()
      } catch {
        showToast(t('agents.toast.avatar_error'))
      }
    })
    grid.appendChild(item)
  }
}

document.getElementById('avatarChangeBtn').addEventListener('click', () => {
  const gallery = document.getElementById('detailAvatarGallery')
  gallery.hidden = !gallery.hidden
  if (!gallery.hidden) {
    const isMarveen = currentAgent && currentAgent.role === 'main'
    const avatarEndpoint = isMarveen ? '/api/marveen/avatar' : `/api/agents/${encodeURIComponent(currentAgent.name)}/avatar`

    const grid = document.getElementById('detailAvatarGrid')
    grid.innerHTML = ''
    for (const avatar of AVATARS) {
      const item = document.createElement('div')
      item.className = 'avatar-grid-item'
      item.innerHTML = `<img src="/avatars/${avatar}" alt="${avatar.replace(/^\d+_/, '').replace('.png', '')}">`
      item.addEventListener('click', async () => {
        try {
          const res = await fetch(avatarEndpoint, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ galleryAvatar: avatar }),
          })
          if (!res.ok) throw new Error()
          showToast(t('agents.toast.avatar_updated'))
          bumpAvatarEpoch()
          const imgUrl = isMarveen ? `/api/marveen/avatar${avatarBust()}` : `/api/agents/${encodeURIComponent(currentAgent.name)}/avatar${avatarBust()}`
          document.getElementById('agentDetailAvatar').innerHTML = `<img src="${imgUrl}" alt="">`
          gallery.hidden = true
          loadAgents()
        } catch {
          showToast(t('agents.toast.avatar_error'))
        }
      })
      grid.appendChild(item)
    }
  }
})

// === Avatar file upload ===
;(() => {
  const zone = document.getElementById('avatarUploadZone')
  const fileInput = document.getElementById('avatarFileInput')
  const content = document.getElementById('avatarUploadContent')
  const preview = document.getElementById('avatarUploadPreview')
  const previewImg = document.getElementById('avatarPreviewImg')
  const clearBtn = document.getElementById('avatarPreviewClear')
  const MAX_SIZE = 1024 * 1024

  zone.addEventListener('click', (e) => {
    if (e.target === clearBtn || clearBtn.contains(e.target)) return
    fileInput.click()
  })
  zone.addEventListener('dragover', (e) => { e.preventDefault(); zone.classList.add('drag-over') })
  zone.addEventListener('dragleave', () => zone.classList.remove('drag-over'))
  zone.addEventListener('drop', (e) => {
    e.preventDefault()
    zone.classList.remove('drag-over')
    const file = e.dataTransfer.files[0]
    if (file) handleAvatarFile(file)
  })
  fileInput.addEventListener('change', () => {
    if (fileInput.files[0]) handleAvatarFile(fileInput.files[0])
  })
  clearBtn.addEventListener('click', (e) => {
    e.stopPropagation()
    resetAvatarUpload()
  })

  function resetAvatarUpload() {
    fileInput.value = ''
    content.hidden = false
    preview.hidden = true
  }

  async function handleAvatarFile(file) {
    if (!file.type.match(/^image\/(png|jpe?g|webp)$/)) {
      showToast(t('agents.toast.avatar_format'))
      return
    }
    if (file.size > MAX_SIZE) {
      showToast(t('agents.toast.avatar_size'))
      return
    }
    previewImg.src = URL.createObjectURL(file)
    content.hidden = true
    preview.hidden = false
    await uploadAvatarFile(file)
  }

  async function uploadAvatarFile(file) {
    if (!currentAgent) return
    const isMarveen = currentAgent.role === 'main'
    const endpoint = isMarveen ? '/api/marveen/avatar' : `/api/agents/${encodeURIComponent(currentAgent.name)}/avatar`
    const form = new FormData()
    form.append('avatar', file, file.name)
    try {
      const res = await fetch(endpoint, { method: 'POST', body: form })
      if (!res.ok) throw new Error()
      showToast(t('agents.toast.avatar_uploaded'))
      bumpAvatarEpoch()
      const imgUrl = isMarveen ? `/api/marveen/avatar${avatarBust()}` : `/api/agents/${encodeURIComponent(currentAgent.name)}/avatar${avatarBust()}`
      document.getElementById('agentDetailAvatar').innerHTML = `<img src="${imgUrl}" alt="">`
      document.getElementById('detailAvatarGallery').hidden = true
      resetAvatarUpload()
      loadAgents()
    } catch {
      showToast(t('common.error_save'))
      resetAvatarUpload()
    }
  }
})()

// === Create-wizard avatar upload ===
// Mirrors the detail-modal uploader, but the agent does not exist yet, so the
// file is held in `selectedAvatarFile` and POSTed after creation (see the
// wizard create flow). Hoisted so populateAvatarGrid()/resetWizard() can reset.
function resetCreateAvatarUpload() {
  const fileInput = document.getElementById('createAvatarFileInput')
  const content = document.getElementById('createAvatarUploadContent')
  const preview = document.getElementById('createAvatarUploadPreview')
  if (!fileInput || !content || !preview) return
  fileInput.value = ''
  content.hidden = false
  preview.hidden = true
}
;(() => {
  const zone = document.getElementById('createAvatarUploadZone')
  if (!zone) return
  const fileInput = document.getElementById('createAvatarFileInput')
  const content = document.getElementById('createAvatarUploadContent')
  const preview = document.getElementById('createAvatarUploadPreview')
  const previewImg = document.getElementById('createAvatarPreviewImg')
  const clearBtn = document.getElementById('createAvatarPreviewClear')
  const MAX_SIZE = 1024 * 1024

  zone.addEventListener('click', (e) => {
    if (e.target === clearBtn || clearBtn.contains(e.target)) return
    fileInput.click()
  })
  zone.addEventListener('dragover', (e) => { e.preventDefault(); zone.classList.add('drag-over') })
  zone.addEventListener('dragleave', () => zone.classList.remove('drag-over'))
  zone.addEventListener('drop', (e) => {
    e.preventDefault()
    zone.classList.remove('drag-over')
    const file = e.dataTransfer.files[0]
    if (file) handleCreateAvatarFile(file)
  })
  fileInput.addEventListener('change', () => {
    if (fileInput.files[0]) handleCreateAvatarFile(fileInput.files[0])
  })
  clearBtn.addEventListener('click', (e) => {
    e.stopPropagation()
    selectedAvatarFile = null
    resetCreateAvatarUpload()
  })

  function handleCreateAvatarFile(file) {
    if (!file.type.match(/^image\/(png|jpe?g|webp)$/)) {
      showToast(t('agents.toast.avatar_format'))
      return
    }
    if (file.size > MAX_SIZE) {
      showToast(t('agents.toast.avatar_size'))
      return
    }
    // Custom upload and gallery pick are mutually exclusive.
    selectedAvatar = null
    document.querySelectorAll('#avatarGrid .avatar-grid-item').forEach(i => i.classList.remove('selected'))
    selectedAvatarFile = file
    previewImg.src = URL.createObjectURL(file)
    content.hidden = true
    preview.hidden = false
  }
})()

// === Process control ===
function updateProcessControl(agent) {
  const running = agent.running || false
  const dot = document.getElementById('processDot')
  const label = document.getElementById('processLabel')
  const uptime = document.getElementById('processUptime')
  const startBtn = document.getElementById('agentStartBtn')
  const stopBtn = document.getElementById('agentStopBtn')

  dot.className = 'process-dot ' + (running ? 'running' : 'stopped')
  label.textContent = running ? t('agents.status.running') : t('agents.status.stopped')
  startBtn.hidden = running
  stopBtn.hidden = !running

  if (running && agent.session) {
    uptime.textContent = `tmux: ${agent.session}`
  } else {
    uptime.textContent = ''
  }
}

document.getElementById('marveenRestartBtn').addEventListener('click', async () => {
  if (!confirm(t('agents.confirm.hard_restart'))) return
  const btn = document.getElementById('marveenRestartBtn')
  btn.disabled = true
  try {
    const res = await fetch('/api/marveen/restart', { method: 'POST' })
    if (!res.ok) {
      const err = await res.json().catch(() => ({}))
      throw new Error(err.error || t('agents.toast.restart_failed'))
    }
    showToast(t('agents.toast.marveen_restarted'))
  } catch (err) {
    showToast(`Hiba: ${err.message}`)
  } finally {
    btn.disabled = false
  }
})

document.getElementById('agentStartBtn').addEventListener('click', async () => {
  if (!currentAgent) return
  const btn = document.getElementById('agentStartBtn')
  btn.disabled = true
  btn.querySelector('.btn-text').hidden = true
  btn.querySelector('.btn-loading').hidden = false

  try {
    const res = await fetch(`/api/agents/${encodeURIComponent(currentAgent.name)}/start`, { method: 'POST' })
    if (!res.ok) {
      const err = await res.json()
      throw new Error(err.error || t('agents.toast.start_failed'))
    }
    showToast(t('agents.toast.started'))
    // Refresh
    const detailRes = await fetch(`/api/agents/${encodeURIComponent(currentAgent.name)}`)
    if (detailRes.ok) {
      currentAgent = await detailRes.json()
      updateProcessControl(currentAgent)
    }
    loadAgents()
  } catch (err) {
    showToast(`Hiba: ${err.message}`)
  } finally {
    btn.disabled = false
    btn.querySelector('.btn-text').hidden = false
    btn.querySelector('.btn-loading').hidden = true
  }
})

document.getElementById('agentStopBtn').addEventListener('click', async () => {
  if (!currentAgent) return
  if (!confirm(t('agents.confirm.stop'))) return

  try {
    const res = await fetch(`/api/agents/${encodeURIComponent(currentAgent.name)}/stop`, { method: 'POST' })
    if (!res.ok) {
      const err = await res.json()
      throw new Error(err.error || t('agents.toast.stop_failed'))
    }
    showToast(t('agents.toast.stopped'))
    const detailRes = await fetch(`/api/agents/${encodeURIComponent(currentAgent.name)}`)
    if (detailRes.ok) {
      currentAgent = await detailRes.json()
      updateProcessControl(currentAgent)
    }
    loadAgents()
  } catch (err) {
    showToast(`Hiba: ${err.message}`)
  }
})

// === Tab switching ===
document.getElementById('agentTabNav').addEventListener('click', (e) => {
  const btn = e.target.closest('.tab-btn')
  if (!btn) return
  switchAgentTab(btn.dataset.tab)
})

let currentChannelProvider = 'telegram'
// Az induláskor a backend CHANNEL_PROVIDER-jét lekérjük, és a dropdown +
// state default-ot ahhoz igazitjuk -- igy ha a backend discord-on van,
// a UI nem hardcode-olt 'telegram'-mal indul barmelyik oldalra is navigal a user.
;(async function initChannelProviderDefault() {
  try {
    const res = await fetch('/api/marveen')
    if (!res.ok) return
    const data = await res.json()
    if (!data.channelProvider || data.channelProvider === currentChannelProvider) return
    currentChannelProvider = data.channelProvider
    const sel = document.getElementById('chProviderSelect')
    if (sel) sel.value = currentChannelProvider
    if (typeof updateProviderUI === 'function') updateProviderUI()
  } catch { /* ignore -- a kepernyo default-on marad */ }
})()
let channelAutoPollTimer = null
function startChannelAutoPoll() {
  if (channelAutoPollTimer) return
  channelAutoPollTimer = setInterval(() => {
    if (!currentAgent) return
    if (document.getElementById('tabChannel').hidden) return
    refreshPendingPairings()
    refreshAllowedList()
    refreshInvites()
    refreshChannelRequests()
  }, 4000)
}
function stopChannelAutoPoll() {
  if (channelAutoPollTimer) { clearInterval(channelAutoPollTimer); channelAutoPollTimer = null }
}

function channelApiBase() {
  return `/api/agents/${encodeURIComponent(currentAgent.name)}/channels/${currentChannelProvider}`
}

function switchAgentTab(tab) {
  document.querySelectorAll('#agentTabNav .tab-btn').forEach((b) => b.classList.toggle('active', b.dataset.tab === tab))
  document.getElementById('tabOverview').hidden = tab !== 'overview'
  document.getElementById('tabSettings').hidden = tab !== 'settings'
  document.getElementById('tabChannel').hidden = tab !== 'channel'
  document.getElementById('tabSkills').hidden = tab !== 'skills'
  document.getElementById('tabTeam').hidden = tab !== 'team'
  if (tab === 'channel') startChannelAutoPoll()
  else stopChannelAutoPoll()
}

// === Settings save buttons ===
async function loadOllamaModels() {
  const group = document.getElementById('ollamaModelGroup')
  if (!group) return
  group.innerHTML = ''
  try {
    const res = await fetch('/api/ollama/models')
    const models = await res.json()
    for (const m of models) {
      const opt = document.createElement('option')
      opt.value = m.name
      opt.textContent = `${m.name} (${m.size})`
      group.appendChild(opt)
    }
  } catch { /* Ollama not available */ }
}

// Populates the DeepSeek optgroups in both the wizard and the agent edit
// panel. Backend gates the list behind a vault entry, so an empty array
// here means the operator has not configured an API key yet -- in that
// case we hide the optgroup and surface a hint pointing to the Vault page.
async function loadAvailableModels() {
  try {
    const res = await fetch('/api/models/available')
    if (!res.ok) return
    const data = await res.json()
    const deepseekModels = Array.isArray(data.deepseek) ? data.deepseek : []
    const editGroup = document.getElementById('deepseekModelGroup')
    const wizardGroup = document.getElementById('agentModelDeepseekGroup')
    const hint = document.getElementById('deepseekHint')
    for (const group of [editGroup, wizardGroup]) {
      if (!group) continue
      group.innerHTML = ''
      if (deepseekModels.length === 0) {
        group.style.display = 'none'
        continue
      }
      group.style.display = ''
      for (const m of deepseekModels) {
        const opt = document.createElement('option')
        opt.value = m.id
        opt.textContent = m.label
        group.appendChild(opt)
      }
    }
    if (hint) hint.style.display = deepseekModels.length === 0 ? 'block' : 'none'

    // OpenRouter: two optgroups per select (Auto = weekly-fresh tier
    // recommendation, value `openrouter-auto:<tier>`; Manual = the 2 concrete
    // ids per tier). Backend gates the whole block behind the vault key, so a
    // null payload means OpenRouter is not connected -> keep the groups hidden.
    const or = data.openrouter
    const orTiers = or && Array.isArray(or.tiers) ? or.tiers : []
    // Auto = one entry per tier in the dropdown (weekly-fresh recommendation).
    const autoGroups = [document.getElementById('openrouterAutoGroup'), document.getElementById('agentModelOpenrouterAutoGroup')]
    for (const g of autoGroups) {
      if (!g) continue
      g.innerHTML = ''
      if (orTiers.length === 0) { g.style.display = 'none'; continue }
      g.style.display = ''
      for (const t of orTiers) {
        const opt = document.createElement('option')
        opt.value = t.autoId
        opt.textContent = `${t.label} - auto (${t.auto})`
        g.appendChild(opt)
      }
    }
    // Manual = the user-curated list -> "OpenRouter - kézi" optgroup in every
    // select. Curated once (main agent's browse popup, checkboxes); assignable
    // per agent here. Empty list -> group hidden.
    const orManual = Array.isArray(data.openrouterManual) ? data.openrouterManual : []
    openrouterCurated = new Set(orManual.map(m => m.id))
    const manualGroups = [document.getElementById('openrouterManualGroup'), document.getElementById('agentModelOpenrouterManualGroup')]
    for (const g of manualGroups) {
      if (!g) continue
      g.innerHTML = ''
      if (orManual.length === 0) { g.style.display = 'none'; continue }
      g.style.display = ''
      for (const m of orManual) {
        const opt = document.createElement('option')
        opt.value = m.id
        opt.textContent = `🔀 ${m.name || m.id}`
        g.appendChild(opt)
      }
    }
    // Browse popup = the curation UI (tick/untick which manual models exist).
    // MAIN AGENT ONLY -- sub-agents just pick from the curated dropdown above.
    // Keep the name checks for compatibility with legacy /api/marveen payloads
    // that predate the explicit role field.
    const mid = (typeof mainAgentId === 'function') ? mainAgentId() : ''
    const isMainAgent = !!currentAgent && (
      currentAgent.role === 'main' ||
      currentAgent.name === mid ||
      currentAgent.agentId === mid
    )
    const orBtn = document.getElementById('openrouterBrowseBtn')
    if (orBtn) orBtn.style.display = (data.openrouterConfigured && isMainAgent) ? '' : 'none'
  } catch { /* dashboard not available */ }
}

// --- OpenRouter manual-list curation (tick models into the shared dropdown) ---
let openrouterAllModels = null
let openrouterCurated = new Set()  // ids currently in the curated manual list

async function openOpenrouterModal() {
  const modal = document.getElementById('openrouterModal')
  const listEl = document.getElementById('openrouterModalList')
  const agentEl = document.getElementById('openrouterModalAgent')
  const searchEl = document.getElementById('openrouterModalSearch')
  const freeEl = document.getElementById('openrouterModalFreeOnly')
  if (!modal || !listEl) return
  // The modal markup lives inside the (hidden) connectors page; reparent it to
  // <body> so it renders full-viewport regardless of which tab is active.
  if (modal.parentElement !== document.body) document.body.appendChild(modal)
  if (agentEl) agentEl.textContent = (currentAgent && (currentAgent.displayName || currentAgent.name)) || 'ágens'
  // Two competing .modal-overlay CSS rules: one hides via [hidden], the other
  // via opacity/visibility (toggled by .active). Set both so the modal shows
  // regardless of which rule wins the cascade.
  modal.hidden = false
  modal.classList.add('active')
  listEl.innerHTML = '<div style="padding:14px;color:var(--text-muted);font-size:13px">Modellek betöltése…</div>'
  if (searchEl) searchEl.value = ''
  if (freeEl) freeEl.checked = false
  try {
    // Load the full model list (cached) and the current curated set in parallel
    // so the checkboxes render already ticked for the manual models in the list.
    const [allRes, curRes] = await Promise.all([
      openrouterAllModels ? Promise.resolve(null) : fetch('/api/openrouter/models'),
      fetch('/api/openrouter/manual'),
    ])
    if (allRes) {
      if (!allRes.ok) throw new Error('fetch failed')
      const data = await allRes.json()
      openrouterAllModels = Array.isArray(data.models) ? data.models : []
    }
    if (curRes && curRes.ok) {
      const cur = await curRes.json()
      openrouterCurated = new Set((Array.isArray(cur.models) ? cur.models : []).map(m => m.id))
    }
    renderOpenrouterList()
  } catch {
    listEl.innerHTML = '<div style="padding:14px;color:var(--danger,#dc2626);font-size:13px">Nem sikerült betölteni az OpenRouter modelleket.</div>'
  }
}

function renderOpenrouterList() {
  const listEl = document.getElementById('openrouterModalList')
  const countEl = document.getElementById('openrouterModalCount')
  const q = (document.getElementById('openrouterModalSearch')?.value || '').toLowerCase().trim()
  const freeOnly = !!document.getElementById('openrouterModalFreeOnly')?.checked
  if (!listEl || !openrouterAllModels) return
  const rows = openrouterAllModels.filter(m => {
    if (freeOnly && !m.free) return false
    if (!q) return true
    return (m.id + ' ' + m.name).toLowerCase().includes(q)
  })
  // Ticked (curated) models float to the top so the current selection is visible.
  rows.sort((a, b) => {
    const ca = openrouterCurated.has(a.id), cb = openrouterCurated.has(b.id)
    if (ca !== cb) return ca ? -1 : 1
    return a.id.localeCompare(b.id)
  })
  if (countEl) countEl.textContent = `${rows.length} modell · ${openrouterCurated.size} kézi listán`
  listEl.innerHTML = ''
  for (const m of rows.slice(0, 400)) {
    const checked = openrouterCurated.has(m.id)
    const row = document.createElement('label')
    row.className = 'openrouter-model-row'
    row.style.cssText = 'display:flex;align-items:flex-start;gap:10px;padding:8px 10px;border-bottom:1px solid var(--border);cursor:pointer;font-size:13px'
    const price = m.free ? '<span style="color:var(--success,#16a34a);font-weight:600">ingyenes</span>'
      : `$${m.promptPrice.toFixed(2)}/$${m.completionPrice.toFixed(2)} /M`
    const ctx = m.contextLength ? ` · ${Math.round(m.contextLength / 1000)}k ctx` : ''
    const cb = document.createElement('input')
    cb.type = 'checkbox'
    cb.checked = checked
    cb.style.cssText = 'margin-top:3px;flex:0 0 auto'
    cb.addEventListener('change', () => toggleCuratedModel(m.id, m.name, cb.checked))
    const info = document.createElement('div')
    info.style.cssText = 'flex:1 1 auto;min-width:0'
    info.innerHTML = `<div style="font-weight:600">${escapeHtml(m.name)}</div>`
      + `<div style="color:var(--text-muted);font-size:11.5px"><code>${escapeHtml(m.id)}</code> · ${price}${ctx}</div>`
    row.appendChild(cb)
    row.appendChild(info)
    row.addEventListener('mouseenter', () => { row.style.background = 'var(--surface-hover, #f1f5f9)' })
    row.addEventListener('mouseleave', () => { row.style.background = '' })
    listEl.appendChild(row)
  }
  if (rows.length === 0) listEl.innerHTML = '<div style="padding:14px;color:var(--text-muted);font-size:13px">Nincs találat.</div>'
}

// Tick/untick a model into the curated manual list. Persists server-side, then
// refreshes the shared dropdown so the "kézi" optgroup reflects the change.
async function toggleCuratedModel(id, name, checked) {
  // Optimistic local update so the checkbox + counter feel instant.
  if (checked) openrouterCurated.add(id); else openrouterCurated.delete(id)
  const countEl = document.getElementById('openrouterModalCount')
  if (countEl) {
    const total = countEl.textContent.split('·')[0].trim()
    countEl.textContent = `${total} · ${openrouterCurated.size} kézi listán`
  }
  try {
    const res = await fetch('/api/openrouter/manual', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id, name, checked }),
    })
    if (!res.ok) throw new Error('save failed')
    const data = await res.json()
    openrouterCurated = new Set((Array.isArray(data.models) ? data.models : []).map(m => m.id))
    // Repopulate the dropdown "kézi" optgroups without disturbing selections.
    loadAvailableModels()
  } catch {
    // Roll back the optimistic change on failure.
    if (checked) openrouterCurated.delete(id); else openrouterCurated.add(id)
    renderOpenrouterList()
  }
}

function closeOpenrouterModal() {
  const modal = document.getElementById('openrouterModal')
  if (modal) { modal.hidden = true; modal.classList.remove('active') }
}

document.getElementById('openrouterBrowseBtn')?.addEventListener('click', openOpenrouterModal)
document.getElementById('openrouterModalClose')?.addEventListener('click', closeOpenrouterModal)
document.getElementById('openrouterModalCancel')?.addEventListener('click', closeOpenrouterModal)
document.getElementById('openrouterModalSearch')?.addEventListener('input', renderOpenrouterList)
document.getElementById('openrouterModalFreeOnly')?.addEventListener('change', renderOpenrouterList)

let modelRestartPollTimer = null
let modelRestartPollName = null

function stopModelRestartPolling() {
  if (modelRestartPollTimer) { clearInterval(modelRestartPollTimer); modelRestartPollTimer = null }
  modelRestartPollName = null
}

function startModelRestartPolling(name, expectedModel, triggeredAt) {
  stopModelRestartPolling()
  modelRestartPollName = name
  const badge = document.getElementById('agentDetailModelRestarting')
  const display = document.getElementById('agentDetailModel')
  const processLabel = document.getElementById('processLabel')
  const processDot = document.getElementById('processDot')
  const deadline = Date.now() + 60000
  modelRestartPollTimer = setInterval(async () => {
    if (modelRestartPollName !== name || !currentAgent || currentAgent.name !== name) {
      stopModelRestartPolling(); return
    }
    if (Date.now() > deadline) {
      stopModelRestartPolling()
      badge.hidden = true
      if (currentAgent) updateProcessControl(currentAgent)
      showToast(t('agents.toast.restart_state_error'))
      return
    }
    try {
      const r = await fetch(`/api/agents/${encodeURIComponent(name)}`)
      if (!r.ok) return
      const data = await r.json()
      // The new tmux session's creation timestamp is the reliable "restart
      // complete" signal. Claude Code writes the "model" field into the
      // session jsonl only when it answers a message, so activeModel may
      // stay null/old until the agent receives its first prompt -- waiting
      // for that match would time out on idle agents. The configured model
      // is what the agent was just started with via --model.
      const restarted = data.runningSince && data.runningSince >= triggeredAt
      if (restarted) {
        const displayModel = data.activeModel || data.model
        if (currentAgent && currentAgent.name === name) {
          currentAgent.activeModel = data.activeModel
          currentAgent.runningSince = data.runningSince
          currentAgent.model = data.model
          currentAgent.running = !!data.running
          currentAgent.session = data.session
          display.textContent = displayModel
        }
        badge.hidden = true
        processDot.className = 'process-dot running'
        processLabel.textContent = t('agents.status.running')
        stopModelRestartPolling()
        const liveMatched = data.activeModel === expectedModel
        showToast(liveMatched
          ? t('agents.model.toast_active', { model: displayModel })
          : t('agents.model.toast_restarted', { model: displayModel }))
      }
    } catch { /* network blip, keep polling */ }
  }, 2000)
}

document.getElementById('saveModelBtn').addEventListener('click', async () => {
  if (!currentAgent || currentAgent.role === 'main') return
  const newModel = document.getElementById('editAgentModel').value
  const name = currentAgent.name
  try {
    const res = await fetch(`/api/agents/${encodeURIComponent(name)}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: newModel }),
    })
    if (!res.ok) throw new Error()
    currentAgent.model = newModel
    const triggeredAt = Math.floor(Date.now() / 1000)
    document.getElementById('agentDetailModelRestarting').hidden = false
    document.getElementById('processLabel').textContent = t('agents.process_label')
    document.getElementById('processDot').className = 'process-dot restarting'
    showToast(t('agents.toast.model_save_restart'))
    loadAgents()
    const restartRes = await fetch(`/api/agents/${encodeURIComponent(name)}/restart`, { method: 'POST' })
    if (!restartRes.ok) {
      document.getElementById('agentDetailModelRestarting').hidden = true
      if (currentAgent) updateProcessControl(currentAgent)
      showToast(t('agents.restart_failed'))
      return
    }
    startModelRestartPolling(name, newModel, triggeredAt)
  } catch { showToast(t('common.error_save')) }
})

document.getElementById('modelSuggestBtn').addEventListener('click', async () => {
  if (!currentAgent) return
  const resultDiv = document.getElementById('modelSuggestionResult')
  resultDiv.style.display = 'block'
  resultDiv.textContent = t('agents.model.analyzing')
  try {
    const res = await fetch('/api/agents/model-suggest', { method: 'POST' })
    if (!res.ok) throw new Error()
    const { results } = await res.json()
    const entry = results.find(r => r.agent === currentAgent.name)
    if (!entry) {
      resultDiv.textContent = t('agents.model.no_data')
      return
    }
    resultDiv.style.color = entry.changeAdvised ? 'var(--warning, #e6a817)' : 'var(--success)'
    resultDiv.style.whiteSpace = 'pre-wrap'
    resultDiv.style.fontFamily = 'monospace'
    resultDiv.style.fontSize = '12px'
    resultDiv.textContent = entry.reason
  } catch { resultDiv.textContent = t('agents.model.error') }
})

document.getElementById('analyzeAllModelsBtn').addEventListener('click', async () => {
  const panel = document.getElementById('agentsModelAnalysis')
  panel.style.display = 'block'
  panel.innerHTML = '<p style="color:var(--text-muted);font-size:13px">' + t('agents.model.analyzing_all') + '</p>'
  try {
    const res = await fetch('/api/agents/model-suggest', { method: 'POST' })
    if (!res.ok) throw new Error()
    const { results } = await res.json()
    const changes = results.filter(r => r.changeAdvised)
    const ok = results.filter(r => !r.changeAdvised)
    let html = '<div style="font-size:13px;padding:12px 14px;background:var(--surface-hover);border-radius:8px;border:1px solid var(--border)">'
    html += `<p style="margin:0 0 8px;font-weight:600">${t('agents.model.title', { n: results.length })}</p>`
    if (changes.length === 0) {
      html += '<p style="color:var(--success);margin:0">' + t('agents.model.all_ok') + '</p>'
    } else {
      html += `<p style="color:var(--warning, #e6a817);margin:0 0 8px">${t('agents.model.changes_n', { n: changes.length })}</p>`
      html += '<ul style="margin:0 0 10px;padding-left:18px">'
      for (const r of changes) {
        const safeReason = r.reason.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')
        html += `<li style="margin-bottom:6px"><strong>${r.agent}</strong>: ${r.currentModel} &rarr; ${r.suggestedModel}`
        html += ` <details style="display:inline-block;vertical-align:top;margin-left:4px"><summary style="cursor:pointer;font-size:11px;color:var(--text-muted)">${t('agents.model.details')}</summary>`
        html += `<pre style="white-space:pre-wrap;font-size:11px;margin:4px 0 0;background:var(--surface);padding:6px 8px;border-radius:4px;color:var(--text-muted)">${safeReason}</pre></details></li>`
      }
      html += '</ul>'
      if (ok.length > 0) {
        html += `<p style="color:var(--text-muted);margin:0;font-size:12px">${t('agents.model.ok_agents', { list: ok.map(r => r.agent).join(', ') })}</p>`
      }
      html += `<button class="btn-secondary btn-compact" id="createModelChangeCardsBtn" style="margin-top:10px">${t('agents.model.create_cards_btn')}</button>`
    }
    html += '</div>'
    panel.innerHTML = html
    const createBtn = document.getElementById('createModelChangeCardsBtn')
    if (createBtn) {
      createBtn.addEventListener('click', async () => {
        if (!confirm(t('agents.model.cards_confirm', { n: changes.length }))) return
        createBtn.disabled = true
        createBtn.textContent = t('agents.model.creating_cards')
        let created = 0
        for (const r of changes) {
          try {
            await fetch('/api/kanban', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                title: t('agents.model.card_title', { agent: r.agent }),
                description: t('agents.model.card_desc', { current: r.currentModel, suggested: r.suggestedModel, reason: r.reason }),
                assignee: 'marveen',
                priority: 'normal',
                status: 'planned',
              }),
            })
            created++
          } catch { /* skip failed card */ }
        }
        showToast(t('agents.model.cards_created', { n: created }))
        createBtn.textContent = t('agents.model.cards_created', { n: created })
      })
    }
  } catch { panel.innerHTML = '<p style="color:var(--error);font-size:13px">' + t('agents.model.error') + '</p>' }
})

// === Export ALL agents + Agent import + Voice config -- see web/app-agent-bundle.js ===
// (Moved to app-agent-bundle.js as part of modularisation, slice 23/N.
//  app-agent-bundle.js is loaded AFTER this file in index.html.
//  loadVoiceConfig() is only called from openAgentDetail, never at init time.)
/* STUB -- content removed */
// ============================================================
// === Auth Mode + Channel tab -- see web/app-auth-channel.js ===
// ============================================================
// (Moved to app-auth-channel.js as part of modularisation, slice 21/N.
//  app-auth-channel.js is loaded AFTER this file in index.html.
//  All callers in app.js (updateAuthModeUI, agentIsConnected, updateChannelTab,
//  updateProviderUI, refreshPendingPairings) are inside function bodies.
//  currentChannelProvider is declared in app.js (Tab switching section, L4355).)
/* STUB -- content removed */
// === Skills (Agent Detail tab) -- see web/app-skills-detail.js ===
// (Moved to app-skills-detail.js as part of modularisation, slice 22/N.
//  app-skills-detail.js is loaded AFTER this file in index.html.
//  loadSkills() is only called from loadAgents/openAgentDetail, never at init time.)
/* STUB -- content removed */
// ============================================================
// === Schedules -- see web/app-schedules.js ===
// ============================================================
// (Moved to app-schedules.js as part of modularisation, card 0159301d / slice 11/N.
//  app-schedules.js is loaded AFTER this file in index.html.
//  loadSchedules() is only called from switchPage, never at init time.)
/* STUB -- content removed */

// (Prompt expand + Save schedule handler also in app-schedules.js, same card.)
/* STUB -- content removed */

// ============================================================
// === Memories + Daily Log -- see web/app-memories.js ===
// ============================================================
// (Moved to app-memories.js as part of modularisation, card 1ba4997b / slice 3/N.
//  app-memories.js is loaded BEFORE this file in index.html so that
//  loadMemAgents() is available when the init section calls it at startup.)

// === SVG icons ===
function pauseIcon() {
  return '<svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="4" width="4" height="16" rx="1"/><rect x="14" y="4" width="4" height="16" rx="1"/></svg>'
}
function playIcon() {
  return '<svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><polygon points="5 3 19 12 5 21 5 3"/></svg>'
}
function trashIcon() {
  return '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 01-2 2H7a2 2 0 01-2-2V6m3 0V4a2 2 0 012-2h4a2 2 0 012 2v2"/></svg>'
}

// ============================================================
// === Connectors ===
// ============================================================

const connectorGrid = document.getElementById('connectorGrid')
const connectorStats = document.getElementById('connectorStats')
const connectorModalOverlay = document.getElementById('connectorModalOverlay')
const connectorDetailOverlay = document.getElementById('connectorDetailOverlay')
const catalogInstallOverlay = document.getElementById('catalogInstallOverlay')
let connectors = []
let catalogItems = []
let catalogFilter = 'all'
let catalogInstallTarget = null

// Connector tab switching
document.querySelectorAll('.connector-tab').forEach(tab => {
  tab.addEventListener('click', () => {
    document.querySelectorAll('.connector-tab').forEach(t => t.classList.remove('active'))
    tab.classList.add('active')
    const tabId = tab.dataset.ctab
    document.getElementById('connectorInstalledTab').hidden = tabId !== 'installed'
    document.getElementById('connectorGalleryTab').hidden = tabId !== 'gallery'
    if (tabId === 'gallery') loadCatalog()
  })
})

// Refresh button: triggers the server-side `claude mcp list` refresh.
// Deliberately manual because every refresh spawns stdio / plugin MCPs
// for a health check and can race the live Telegram bot. Button is
// shared by both the Installed and Gallery tabs.
document.getElementById('connectorRefreshBtn').addEventListener('click', async () => {
  const btn = document.getElementById('connectorRefreshBtn')
  btn.disabled = true
  try {
    const res = await fetch('/api/connectors/refresh', { method: 'POST' })
    const data = await res.json().catch(() => ({}))
    if (!res.ok || !data.ok) {
      showToast(t('updates.error', {msg: data.error || 'HTTP ' + res.status}))
    } else {
      showToast(t('connectors.toast.mcp_refreshed', { n: data.count || 0 }))
    }
    await loadConnectors()
    // Reload catalog only if the Gallery tab is currently active so we
    // do not fight for the catalog grid while the user is on Installed.
    if (!document.getElementById('connectorGalleryTab').hidden) {
      await loadCatalog()
    }
  } catch (err) {
    showToast(t('updates.toast.error', {msg: err.message || err}))
  } finally {
    btn.disabled = false
  }
})

// Catalog filter buttons
document.querySelectorAll('.catalog-filter-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.catalog-filter-btn').forEach(b => b.classList.remove('active'))
    btn.classList.add('active')
    catalogFilter = btn.dataset.cat
    renderCatalog()
  })
})

// Catalog install modal
document.getElementById('catalogInstallClose').addEventListener('click', () => closeModal(catalogInstallOverlay))
catalogInstallOverlay.addEventListener('click', (e) => { if (e.target === catalogInstallOverlay) closeModal(catalogInstallOverlay) })

async function loadCatalog() {
  const grid = document.getElementById('catalogGrid')
  grid.innerHTML = `<div class="connector-loading"><span class="spinner"></span> ${t('connectors.catalog_loading')}</div>`
  try {
    const res = await fetch('/api/mcp-catalog')
    catalogItems = await res.json()
    renderCatalog()
  } catch (err) {
    console.error('Catalog load error:', err)
    grid.innerHTML = `<div class="connector-loading">${t('connectors.catalog_error')}</div>`
  }
}

function renderCatalog() {
  const grid = document.getElementById('catalogGrid')
  grid.innerHTML = ''
  const filtered = catalogFilter === 'all' ? catalogItems : catalogItems.filter(i => i.category === catalogFilter)
  if (filtered.length === 0) {
    grid.innerHTML = `<div class="connector-loading">${t('connectors.catalog_empty')}</div>`
    return
  }
  for (const item of filtered) {
    const card = document.createElement('div')
    card.className = 'catalog-card'
    const authHint = item.authType === 'oauth' && item.authNote ? `<span class="catalog-auth-hint">${escapeHtml(item.authNote)}</span>` : ''
    card.innerHTML = `
      <div class="catalog-card-header">
        <div class="catalog-card-icon">${item.icon || '?'}</div>
        <div class="catalog-card-info">
          <div class="catalog-card-name">
            ${escapeHtml(item.name)}
            <span class="catalog-card-type ${item.type}">${item.type}</span>
            ${item.infoUrl ? `<a href="${escapeHtml(item.infoUrl)}" target="_blank" rel="noopener" class="catalog-card-link" title="${t('connectors.tooltip.docs')}" onclick="event.stopPropagation()">&#x2197;</a>` : ''}
          </div>
          <div class="catalog-card-desc">${escapeHtml(item.description)}</div>
        </div>
      </div>
      <div class="catalog-card-footer">
        ${item.installed
          ? `<span class="catalog-install-btn installed" title="${item.configMatch ? t('connectors.tooltip.installed_mcp') : t('connectors.tooltip.installed_src', { src: escapeHtml(item.installedSource || '') })}">Telepítve &#10003;${item.configMatch ? ' (.mcp.json)' : item.installedSource === 'claude.ai' ? ' (claude.ai)' : item.installedSource === 'plugin' ? ' (plugin)' : ''}</span>${(item.installedSource === 'claude.ai' || item.configMatch) ? '' : `<a class="catalog-uninstall-link" data-id="${item.id}">Eltávolítás</a>`}`
          : `<button class="catalog-install-btn install" data-id="${item.id}">${t('connectors.catalog.install_btn')}</button>${authHint}`
        }
      </div>
    `
    // Install button
    const installBtn = card.querySelector('.catalog-install-btn.install')
    if (installBtn) {
      installBtn.addEventListener('click', (e) => {
        e.stopPropagation()
        openCatalogInstall(item)
      })
    }
    // Uninstall link
    const uninstallLink = card.querySelector('.catalog-uninstall-link')
    if (uninstallLink) {
      uninstallLink.addEventListener('click', (e) => {
        e.stopPropagation()
        catalogUninstall(item)
      })
    }
    grid.appendChild(card)
  }
}

function openCatalogInstall(item) {
  catalogInstallTarget = item
  document.getElementById('catalogInstallTitle').textContent = t('connectors.catalog.install_title', { icon: item.icon, name: item.name })
  document.getElementById('catalogInstallDesc').textContent = item.description

  const envContainer = document.getElementById('catalogInstallEnvFields')
  envContainer.innerHTML = ''
  const noteEl = document.getElementById('catalogInstallNote')
  noteEl.hidden = true

  if (item.authType === 'apikey') {
    // Show env key input fields
    const envKeys = Object.keys(item.env || {})
    for (const key of envKeys) {
      const div = document.createElement('div')
      div.className = 'catalog-env-group'
      div.innerHTML = `
        <label>${escapeHtml(key)}</label>
        <input type="text" data-env-key="${escapeHtml(key)}" placeholder="${t('connectors.catalog.env_placeholder', { key: escapeHtml(key) })}">
      `
      envContainer.appendChild(div)
    }
    if (item.authNote) {
      noteEl.textContent = item.authNote
      noteEl.hidden = false
    }
  } else if (item.authType === 'oauth') {
    if (item.authNote) {
      noteEl.textContent = item.authNote
      noteEl.hidden = false
    }
  }
  // authType === 'none' -> no extra fields

  openModal(catalogInstallOverlay)
}

document.getElementById('catalogInstallBtn').addEventListener('click', async () => {
  if (!catalogInstallTarget) return
  const item = catalogInstallTarget
  const btn = document.getElementById('catalogInstallBtn')

  // Collect env values
  const envData = {}
  const envInputs = document.querySelectorAll('#catalogInstallEnvFields input[data-env-key]')
  for (const input of envInputs) {
    const key = input.dataset.envKey
    const val = input.value.trim()
    if (!val) {
      input.focus()
      showToast(t('connectors.toast.required_field', { key }))
      return
    }
    envData[key] = val
  }

  btn.disabled = true
  btn.querySelector('.btn-text').hidden = true
  btn.querySelector('.btn-loading').hidden = false

  try {
    const res = await fetch(`/api/mcp-catalog/${encodeURIComponent(item.id)}/install`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ env: envData }),
    })
    const data = await res.json()
    if (!res.ok) throw new Error(data.error || 'Hiba')
    closeModal(catalogInstallOverlay)
    showToast(data.message || t('connectors.toast.installed'))
    // Reload both views
    loadCatalog()
    loadConnectors()
  } catch (err) {
    showToast(`Hiba: ${err.message}`)
  } finally {
    btn.disabled = false
    btn.querySelector('.btn-text').hidden = false
    btn.querySelector('.btn-loading').hidden = true
  }
})

async function catalogUninstall(item) {
  if (!confirm(t('connectors.confirm.remove', { name: item.name }))) return
  try {
    const res = await fetch(`/api/mcp-catalog/${encodeURIComponent(item.id)}/uninstall`, { method: 'DELETE' })
    const data = await res.json()
    if (!res.ok) throw new Error(data.error || 'Hiba')
    showToast(data.message || t('connectors.toast.removed'))
    loadCatalog()
    loadConnectors()
  } catch (err) {
    showToast(`Hiba: ${err.message}`)
  }
}

// Modal wiring
document.getElementById('addConnectorBtn').addEventListener('click', () => {
  document.getElementById('connectorName').value = ''
  document.getElementById('connectorUrl').value = ''
  document.getElementById('connectorCmd').value = ''
  document.getElementById('connectorArgs').value = ''
  document.getElementById('connectorType').value = 'stdio'
  document.getElementById('connectorScope').value = 'user'
  document.getElementById('connectorUrlGroup').hidden = true
  document.getElementById('connectorCmdGroup').hidden = false
  document.getElementById('connectorArgsGroup').hidden = false
  document.getElementById('connectorEnvGroup').hidden = false
  document.getElementById('connectorEnvList').innerHTML = ''
  document.getElementById('connectorAssignGroup').hidden = true
  loadNewConnectorAgents()
  openModal(connectorModalOverlay)
})
document.getElementById('connectorModalClose').addEventListener('click', () => closeModal(connectorModalOverlay))
document.getElementById('connectorDetailClose').addEventListener('click', () => closeModal(connectorDetailOverlay))
connectorModalOverlay.addEventListener('click', (e) => { if (e.target === connectorModalOverlay) closeModal(connectorModalOverlay) })
connectorDetailOverlay.addEventListener('click', (e) => { if (e.target === connectorDetailOverlay) closeModal(connectorDetailOverlay) })

// Type toggle
document.getElementById('connectorType').addEventListener('change', () => {
  const isStdio = document.getElementById('connectorType').value === 'stdio'
  document.getElementById('connectorUrlGroup').hidden = isStdio
  document.getElementById('connectorCmdGroup').hidden = !isStdio
  document.getElementById('connectorArgsGroup').hidden = !isStdio
  document.getElementById('connectorEnvGroup').hidden = !isStdio
})

// Scope toggle: hide agent assignment for global scope
document.getElementById('connectorScope').addEventListener('change', () => {
  const isProject = document.getElementById('connectorScope').value === 'project'
  document.getElementById('connectorAssignGroup').hidden = !isProject
})

// Default TRUE: if we never successfully read /api/connectors/status
// (endpoint missing on older backends, network error, non-2xx response)
// the safe assumption is that the cache has not populated yet. That
// way an empty list renders as "warming" rather than the misleading
// "no connectors" the F2 round-3 fix was meant to eliminate.
let connectorCacheWarming = true
let connectorCacheError = ''

async function loadConnectors() {
  connectorGrid.innerHTML = `<div class="connector-loading"><span class="spinner"></span> ${t('connectors.loading')}</div>`
  connectorStats.innerHTML = ''
  // Reset pessimistic state at the top of every load. Only an authoritative
  // positive signal (status endpoint reports cacheLastRefreshed > 0) flips
  // it to false, so a later status-fetch failure cannot leave a stale
  // `false` that regresses into "no connectors" again.
  connectorCacheWarming = true
  connectorCacheError = ''
  try {
    // Fetch both in parallel: the list itself and a lightweight status
    // readout that tells us whether the server-side cache has ever run.
    // Without the status, a cold-start hit on the page would render
    // "Nincsenek MCP connectorok" -- contradicting the info-box that
    // says "A lista a dashboard indulasakor toltodik be".
    const [listRes, statusRes] = await Promise.all([
      fetch('/api/connectors'),
      fetch('/api/connectors/status').catch(() => null),
    ])
    connectors = await listRes.json()
    if (statusRes && statusRes.ok) {
      const s = await statusRes.json().catch(() => ({}))
      if (s && s.cacheLastRefreshed > 0) connectorCacheWarming = false
      if (s && s.cacheError) connectorCacheError = String(s.cacheError)
    }
    renderConnectors()
    loadExternalPaths()
    loadGitHubRepos()
    loadVault()
  } catch (err) {
    console.error('Connector betöltés hiba:', err)
    connectorGrid.innerHTML = `<div class="connector-loading">${t('connectors.load_error')}</div>`
  }
}

// Built-in MCPs: features that live inside the Claude Code binary or
// app rather than as a registered MCP server. They cannot be detected
// via `claude mcp list`, so the "Aktív / Kikapcsolva" label used to
// always read "Kikapcsolva" regardless of the real state. Replace the
// misleading state badge with a "Részletek" button that opens a modal
// carrying the real enable instructions (which previously hid inside
// a `title` tooltip the user had to hover to discover).
const BUILTIN_MCPS = [
  {
    name: 'computer-use',
    label: 'Computer Use',
    desc: () => t('connectors.builtin.computer_use'),
    get detailHtml() { return t('connectors.builtin.computer_use_html') },
  },
  {
    name: 'chrome',
    label: 'Claude in Chrome',
    desc: () => t('connectors.builtin.chrome'),
    get detailHtml() { return t('connectors.builtin.chrome_html') },
  },
]

function openBuiltinDetail(item) {
  const overlay = document.getElementById('builtinDetailOverlay')
  if (!overlay) return
  document.getElementById('builtinDetailTitle').textContent = item.label
  document.getElementById('builtinDetailDesc').textContent = typeof item.desc === 'function' ? item.desc() : item.desc
  // Static strings only. Never interpolate user or server input here
  // without passing it through escapeHtml first -- detailHtml is a
  // raw HTML sink.
  document.getElementById('builtinDetailBody').innerHTML = item.detailHtml
  openModal(overlay)
  // Move focus into the dialog so keyboard users land inside the new
  // surface instead of keeping the Részletek button focused behind
  // the overlay. Same pattern the other modals in this file skip, but
  // cheap to add for accessibility.
  const closeBtn = document.getElementById('builtinDetailClose')
  if (closeBtn) setTimeout(() => closeBtn.focus(), 50)
}

// Wire close paths for the built-in detail modal once per load. Guarded
// so a future refactor that moves the script tag above the modal HTML
// (e.g. deferred <head> load) does not fire a silent null-ref here.
function wireBuiltinDetailModal() {
  const overlay = document.getElementById('builtinDetailOverlay')
  const closeBtn = document.getElementById('builtinDetailClose')
  if (!overlay || !closeBtn) return
  closeBtn.addEventListener('click', () => closeModal(overlay))
  overlay.addEventListener('click', (e) => {
    if (e.target === overlay) closeModal(overlay)
  })
}
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', wireBuiltinDetailModal, { once: true })
} else {
  wireBuiltinDetailModal()
}

function renderConnectors() {
  // Detach panels that live inside connectorGrid before innerHTML wipes them
  const _extPathsPanel = document.getElementById('externalPathsSection')
  if (_extPathsPanel) _extPathsPanel.remove()

  // Stats
  if (connectors.length === 0 && connectorCacheWarming) {
    connectorStats.innerHTML = ''
  } else {
    const connected = connectors.filter(c => c.status === 'connected').length
    // 'configured' = declared in a .mcp.json (not health-checked, the backend
    // never spawns them). These are known-good, not broken -- surface them in a
    // positive count so file-defined servers (e.g. gmail-egov) do not look
    // un-ready just because they never went through the claude mcp list cache.
    const configured = connectors.filter(c => c.status === 'configured').length
    const needsAuth = connectors.filter(c => c.status === 'needs_auth').length
    const failed = connectors.filter(c => c.status === 'failed').length
    connectorStats.innerHTML = `
      <div class="stat-card"><div class="stat-value">${connectors.length}</div><div class="stat-label">${t('connectors.stat.total')}</div></div>
      <div class="stat-card"><div class="stat-value" style="color:var(--success)">${connected}</div><div class="stat-label">${t('connectors.stat.active')}</div></div>
      ${configured ? `<div class="stat-card"><div class="stat-value" style="color:var(--info)">${configured}</div><div class="stat-label">${t('connectors.stat.configured')}</div></div>` : ''}
      ${needsAuth ? `<div class="stat-card"><div class="stat-value" style="color:var(--accent)">${needsAuth}</div><div class="stat-label">${t('connectors.stat.needs_auth')}</div></div>` : ''}
      ${failed ? `<div class="stat-card"><div class="stat-value" style="color:var(--danger)">${failed}</div><div class="stat-label">${t('connectors.stat.failed')}</div></div>` : ''}
    `
  }

  connectorGrid.innerHTML = ''
  const hasClaudeAiEntries = connectors.some(c => c.source === 'claude.ai')
  if (connectors.length > 0 && !connectorCacheWarming && connectorCacheError && hasClaudeAiEntries) {
    const banner = document.createElement('div')
    banner.className = 'connector-stale-banner'
    banner.innerHTML = t('connectors.stale_banner', { msg: escapeHtml(connectorCacheError) })
    connectorGrid.appendChild(banner)
  }
  if (connectors.length === 0 && !BUILTIN_MCPS.length) {
    if (connectorCacheWarming && connectorCacheError) {
      connectorGrid.innerHTML = `<div class="connector-loading">${t('connectors.mcp_load_failed', { msg: escapeHtml(connectorCacheError) })}</div>`
    } else if (connectorCacheWarming) {
      connectorGrid.innerHTML = `<div class="connector-loading">${t('connectors.mcp_not_loaded')}</div>`
    } else {
      connectorGrid.innerHTML = `<div class="connector-loading">${t('connectors.no_mcps')}</div>`
    }
    return
  }

  // Group by scope
  const groups = new Map()
  for (const c of connectors) {
    const scope = c.scope || 'global'
    if (!groups.has(scope)) groups.set(scope, [])
    groups.get(scope).push(c)
  }

  const globalScopes = ['global', 'plugin']
  const agentScopes = []
  const internalProjectScopes = []
  const externalProjectScopes = []
  for (const scope of groups.keys()) {
    if (scope.startsWith('agent:')) agentScopes.push(scope)
    else if (scope.startsWith('project:external/')) externalProjectScopes.push(scope)
    else if (scope.startsWith('project:')) internalProjectScopes.push(scope)
    else if (!globalScopes.includes(scope)) globalScopes.push(scope)
  }
  agentScopes.sort()
  internalProjectScopes.sort()
  externalProjectScopes.sort()

  const sourceLabels = {
    'claude.ai': 'claude.ai',
    'plugin': 'plugin',
    'local-user': 'local (user)',
    'local-project': 'local (project)',
    'local': 'local',
    'agent': 'agent',
    'agent-project': 'project',
    'external-project': 'external',
  }

  function renderCard(c, container) {
    const card = document.createElement('div')
    card.className = 'connector-card'
    const sourceTag = c.source ? `<span class="connector-source-badge">${escapeHtml(sourceLabels[c.source] || c.source)}</span>` : ''
    const readOnly = c.source === 'claude.ai'
    if (readOnly) card.classList.add('connector-card-readonly')
    const readonlyHint = readOnly ? `<div class="connector-readonly-hint">${t('connectors.readonly_hint')}</div>` : ''
    card.innerHTML = `
      <div class="connector-status-dot ${c.status}"></div>
      <div class="connector-info">
        <div class="connector-name">${escapeHtml(c.name)} ${sourceTag}</div>
        <div class="connector-endpoint">${escapeHtml(c.endpoint || '')}</div>
        ${readonlyHint}
      </div>
      <span class="connector-type-badge ${c.type}">${c.type}</span>
    `
    if (!readOnly) card.addEventListener('click', () => openConnectorDetail(c))
    container.appendChild(card)
  }

  function renderCollapsible(label, icon, items, container) {
    const section = document.createElement('div')
    section.className = 'connector-scope-section'
    const header = document.createElement('div')
    header.className = 'connector-scope-header collapsible'
    header.innerHTML = `<span class="connector-scope-toggle">▶</span> ${icon} ${escapeHtml(label)} <span class="connector-scope-count">${items.length}</span>`
    header.addEventListener('click', () => {
      const grid = section.querySelector('.connector-scope-grid')
      const toggle = header.querySelector('.connector-scope-toggle')
      if (grid.hidden) { grid.hidden = false; toggle.textContent = '▼' }
      else { grid.hidden = true; toggle.textContent = '▶' }
    })
    section.appendChild(header)
    const grid = document.createElement('div')
    grid.className = 'connector-scope-grid'
    grid.hidden = true
    for (const c of items) renderCard(c, grid)
    section.appendChild(grid)
    container.appendChild(section)
  }

  // === Claude globális ===
  const globalHeading = document.createElement('div')
  globalHeading.className = 'connector-group-heading'
  globalHeading.textContent = t('connectors.heading.global')
  connectorGrid.appendChild(globalHeading)

  const builtinGrid = document.createElement('div')
  builtinGrid.className = 'connector-builtin-grid'
  for (const b of BUILTIN_MCPS) {
    const div = document.createElement('div')
    div.className = 'connector-builtin'
    div.innerHTML = `
      <div class="connector-status-dot unknown" title="${t('connectors.tooltip.auto_detect')}"></div>
      <div class="connector-builtin-name">${escapeHtml(b.label)}<br><span style="font-size:11px;color:var(--text-muted);font-weight:400">${escapeHtml(typeof b.desc === 'function' ? b.desc() : b.desc)}</span></div>
      <button type="button" class="connector-builtin-action btn-link" data-builtin="${escapeHtml(b.name)}">${t('connectors.builtin.details')}</button>
    `
    const btn = div.querySelector('button[data-builtin]')
    if (btn) btn.addEventListener('click', () => openBuiltinDetail(b))
    builtinGrid.appendChild(div)
  }
  connectorGrid.appendChild(builtinGrid)

  const globalGrid = document.createElement('div')
  globalGrid.className = 'connector-scope-grid'
  for (const scope of globalScopes) {
    for (const c of (groups.get(scope) || [])) renderCard(c, globalGrid)
  }
  if (globalGrid.children.length > 0) connectorGrid.appendChild(globalGrid)

  // === Ügynökök ===
  if (agentScopes.length > 0) {
    const agentHeading = document.createElement('div')
    agentHeading.className = 'connector-group-heading'
    agentHeading.textContent = t('connectors.heading.agents')
    connectorGrid.appendChild(agentHeading)

    for (const ag of agentScopes) {
      const agentName = ag.slice('agent:'.length)
      renderCollapsible(agentName, '🤖', groups.get(ag), connectorGrid)
    }
  }

  // === Projektek (belső) ===
  if (internalProjectScopes.length > 0) {
    const projectHeading = document.createElement('div')
    projectHeading.className = 'connector-group-heading'
    projectHeading.textContent = t('connectors.heading.projects')
    connectorGrid.appendChild(projectHeading)

    for (const ps of internalProjectScopes) {
      const parts = ps.slice('project:'.length).split('/')
      const projLabel = parts[parts.length - 1]
      renderCollapsible(projLabel, '📁', groups.get(ps), connectorGrid)
    }
  }

  // === Külső projektek ===
  if (externalProjectScopes.length > 0 || _extPathsPanel) {
    const extHeading = document.createElement('div')
    extHeading.className = 'connector-group-heading'
    extHeading.textContent = t('connectors.heading.external')
    connectorGrid.appendChild(extHeading)

    if (_extPathsPanel) connectorGrid.appendChild(_extPathsPanel)

    for (const ps of externalProjectScopes) {
      const projLabel = ps.slice('project:external/'.length)
      renderCollapsible(projLabel, '📂', groups.get(ps), connectorGrid)
    }
  }
}

// --- GitHub repo management ---
async function loadGitHubRepos() {
  try {
    const res = await fetch('/api/connectors/github-repos')
    const data = await res.json()
    const repos = data.repos || []
    document.getElementById('githubRepoCount').textContent = String(repos.length)
    const list = document.getElementById('githubRepoList')
    list.innerHTML = ''
    for (const r of repos) {
      const item = document.createElement('div')
      item.className = 'connector-external-item github-repo-item'
      const date = new Date(r.installedAt).toLocaleDateString('hu-HU')
      item.innerHTML = `<div class="github-repo-info"><span class="github-repo-name">${escapeHtml(r.name.replace('--', '/'))}</span><span class="github-repo-date">${date}</span></div><div class="github-repo-actions"><button class="github-repo-update" title="Frissites">&#x21bb;</button><button class="github-repo-delete" title="Torles">&times;</button></div>`
      item.querySelector('.github-repo-update').addEventListener('click', async (e) => {
        const btn = e.currentTarget
        btn.disabled = true
        btn.textContent = '...'
        try {
          const res = await fetch(`/api/connectors/github-repos/${encodeURIComponent(r.name)}`, { method: 'PATCH' })
          const data = await res.json()
          if (data.error) { alert(data.error); return }
          loadConnectors()
        } finally { btn.disabled = false; btn.innerHTML = '&#x21bb;' }
      })
      item.querySelector('.github-repo-delete').addEventListener('click', async () => {
        if (!confirm(`Torlod: ${r.name.replace('--', '/')}?`)) return
        await fetch(`/api/connectors/github-repos/${encodeURIComponent(r.name)}`, { method: 'DELETE' })
        loadGitHubRepos()
        loadExternalPaths()
        loadConnectors()
      })
      list.appendChild(item)
    }
  } catch { /* ignore */ }
}

;(function wireGitHubRepos() {
  const toggle = document.getElementById('githubReposToggle')
  const body = document.getElementById('githubReposBody')
  if (!toggle || !body) return
  toggle.addEventListener('click', () => {
    const arrow = toggle.querySelector('.connector-scope-toggle')
    if (body.hidden) { body.hidden = false; arrow.textContent = '▼' }
    else { body.hidden = true; arrow.textContent = '▶' }
  })
  const addBtn = document.getElementById('githubRepoAddBtn')
  const input = document.getElementById('githubRepoInput')
  const status = document.getElementById('githubRepoStatus')
  addBtn.addEventListener('click', async () => {
    const val = input.value.trim()
    if (!val) return
    addBtn.disabled = true
    addBtn.textContent = 'Telepites...'
    status.hidden = false
    status.className = 'github-repo-status loading'
    status.textContent = t('connectors.cloning')
    try {
      const res = await fetch('/api/connectors/github-repos', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url: val }),
      })
      const data = await res.json()
      if (data.error) {
        status.className = 'github-repo-status error'
        status.textContent = data.error
        return
      }
      if (data.requiredEnvVars && data.requiredEnvVars.length > 0) {
        status.className = 'github-repo-status loading'
        status.textContent = t('connectors.api_keys_needed')
        const envValues = await showEnvVarModal(data.requiredEnvVars)
        if (envValues && Object.keys(envValues).length > 0) {
          let vaultAllOk = true
          for (const [key, value] of Object.entries(envValues)) {
            const r = await fetch('/api/vault', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ id: `github-env-${data.repo.name}-${key}`, label: `${key} (${data.repo.name.replace('--', '/')})`, value }),
            })
            if (!r.ok) vaultAllOk = false
          }
          if (vaultAllOk) {
            status.className = 'github-repo-status success'
            status.textContent = 'Telepitve, kulcsok mentve a Vault-ba!'
          } else {
            status.className = 'github-repo-status error'
            status.textContent = 'Telepitve, de néhány kulcs mentése sikertelen. Add meg újra a Vault-ban.'
          }
          loadVault()
        } else {
          status.className = 'github-repo-status success'
          status.textContent = 'Telepitve (kulcsok kihagyva)'
        }
      } else {
        status.className = 'github-repo-status success'
        status.textContent = 'Telepitve!'
      }
      input.value = ''
      loadGitHubRepos()
      loadExternalPaths()
      loadConnectors()
      setTimeout(() => { status.hidden = true }, 4000)
    } catch (err) {
      status.className = 'github-repo-status error'
      status.textContent = 'Hiba: ' + err.message
    } finally {
      addBtn.disabled = false
      addBtn.textContent = 'Telepites'
    }
  })
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter') addBtn.click() })
})()

// --- Beépített repók (dedicated dashboard page, card 000ec0d0 / epic b48fc58c) ---
// Reuses the existing, real GET/POST/PATCH/DELETE /api/connectors/github-repos
// endpoints (same backend as the Connectors-page sub-section above). Update-
// availability DETECTION -- knowing in advance whether a repo actually has new
// upstream commits -- is separate backend work (card a5c13533, not yet built).
// The Update button here always attempts a pull and is honestly labelled as
// such (see the info-box in index.html); it never claims a repo "is up to
// date" or "has an update available" without real data behind that claim.
let _reposCache = []

async function loadReposPage() {
  const loadingEl = document.getElementById('reposLoading')
  const gridEl = document.getElementById('reposGrid')
  const emptyEl = document.getElementById('reposEmpty')
  const errorEl = document.getElementById('reposErrorState')
  loadingEl.hidden = false
  gridEl.hidden = true
  emptyEl.hidden = true
  errorEl.hidden = true
  try {
    // The page lists EVERY built-in repo: (1) repos manually added via the box below
    // (/api/connectors/github-repos), AND (2) the repos ADOPTED during earlier development
    // -- vendored skills + pipx tools/MCPs recorded in store/watched-repos.json, exposed by
    // /api/integrated-repos. Before, the page only read (1), so the adopted skills/tools
    // (caveman, crafter-intent-layer, mattpocock-productivity, code-review-graph, graphify)
    // were invisible even though they are integrated. Merge both sources here.
    const [manualRes, adoptedRes] = await Promise.all([
      fetch('/api/connectors/github-repos'),
      fetch('/api/integrated-repos'),
    ])
    if (!manualRes.ok) throw new Error('HTTP ' + manualRes.status)
    const manualData = await manualRes.json()
    const manual = (manualData.repos || []).map((r) => ({ ...r, adopted: false }))
    // Adopted repos are managed OUTSIDE the dashboard (pipx-pinned / vendored), so they are
    // read-only here: no clone-based update/delete. Normalize to the card shape.
    let adopted = []
    if (adoptedRes.ok) {
      const adoptedData = await adoptedRes.json()
      adopted = (adoptedData.repos || []).map((r) => ({
        name: r.name,
        url: r.repo,
        description: r.description || '',
        // Real install date = adoptedAt (registry reviewed_at); vendoredDate is the upstream
        // COMMIT date (wrong meaning) and is null for pipx installs -> only a last-resort fallback.
        installedAt: r.adoptedAt || r.vendoredDate || null,
        kind: r.kind,
        behind: r.behind || 0,
        reviewRequired: !!r.reviewRequired,
        adoption: r.adoption || '',
        pinnedVersion: r.pinnedVersion || null,
        installed: r.installed !== false,
        adopted: true,
      }))
    }
    _reposCache = [...adopted, ...manual]
    document.getElementById('reposStatTotal').textContent = String(_reposCache.length)
    renderReposGrid(_reposCache)
  } catch (err) {
    loadingEl.hidden = true
    errorEl.hidden = false
    document.getElementById('reposErrorMsg').textContent =
      t('repos.load_error') + (err && err.message ? ` (${err.message})` : '')
  }
}

function renderReposGrid(repos) {
  const loadingEl = document.getElementById('reposLoading')
  const gridEl = document.getElementById('reposGrid')
  const emptyEl = document.getElementById('reposEmpty')
  loadingEl.hidden = true
  gridEl.innerHTML = ''
  if (repos.length === 0) {
    gridEl.hidden = true
    emptyEl.hidden = false
    return
  }
  emptyEl.hidden = true
  gridEl.hidden = false
  const dateLocale = window._lang === 'en' ? 'en-US' : 'hu-HU'
  for (const r of repos) {
    const card = document.createElement('div')
    card.className = 'repo-card'
    const date = r.installedAt ? new Date(r.installedAt).toLocaleDateString(dateLocale) : '—'
    const displayName = escapeHtml((r.name || '').replace('--', '/'))
    const url = escapeHtml(r.url || '')
    // Hover/tap info tooltip (Peti 2026-07-31): what the repo is / what it solves + how it is
    // integrated. Shown on hover (desktop) AND focus/tap (mobile+keyboard, rule 13 touch-friendly).
    const descText = escapeHtml(r.description || '')
    let integ
    if (r.adopted) {
      if (r.adoption === 'pipx') integ = `pipx${r.pinnedVersion ? ' · v' + escapeHtml(r.pinnedVersion) : ''}`
      else if (r.adoption === 'rules-folded') integ = 'CLAUDE.md (' + t('repos.integ.folded') + ')'
      else integ = t('repos.integ.vendored') // vendored clone, daily sync, outside repo
    } else {
      integ = t('repos.integ.manual') // added from the dashboard
    }
    const kindTxt = r.kind ? ' · ' + escapeHtml(r.kind) : ''
    const instTxt = r.installed !== false ? ' · ✓ ' + escapeHtml(t('repos.installed')) : ''
    const tooltip = descText || integ
      ? `<div class="repo-card-info" tabindex="0" role="button" aria-label="${escapeHtml(t('repos.tooltip.aria'))}"><svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><line x1="12" y1="16" x2="12" y2="12"/><line x1="12" y1="8" x2="12.01" y2="8"/></svg><span class="repo-card-tooltip" role="tooltip">${descText ? `<span class="tt-desc">${descText}</span>` : ''}<span class="tt-how"><strong>${escapeHtml(t('repos.tooltip.how'))}:</strong> ${integ}${kindTxt}${instTxt}</span></span></div>`
      : ''
    const header = `<div class="repo-card-header"><div class="repo-card-icon"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M9 19c-5 1.5-5-2.5-7-3m14 6v-3.87a3.37 3.37 0 0 0-.94-2.61c3.14-.35 6.44-1.54 6.44-7A5.44 5.44 0 0 0 20 4.77 5.07 5.07 0 0 0 19.91 1S18.73.65 16 2.48a13.38 13.38 0 0 0-7 0C6.27.65 5.09 1 5.09 1A5.07 5.07 0 0 0 5 4.77a5.44 5.44 0 0 0-1.5 3.78c0 5.42 3.3 6.61 6.44 7A3.37 3.37 0 0 0 9 18.13V22"/></svg></div><div class="repo-card-title"><div class="repo-card-name">${displayName}</div><a class="repo-card-source" href="${url}" target="_blank" rel="noopener noreferrer">${url}</a></div>${tooltip}</div>`
    if (r.adopted) {
      // Adopted (vendored skill / pipx tool or MCP) -- managed outside the dashboard, so it is
      // READ-ONLY here: a kind badge instead of update/delete. `kind` (skill/mcp/external) is a
      // technical identifier, exempt from i18n. "behind" surfaces when upstream has moved ahead.
      const kind = escapeHtml(r.kind || 'external')
      // Upstream moved ahead (Peti 2026-07-31): highlight the whole card + a warning message,
      // not just a small badge, so an available update is impossible to miss.
      if (r.behind > 0) card.classList.add('repo-card-outdated')
      const behind = r.behind > 0
        ? `<span class="repo-card-badge repo-card-badge-warn">↑ ${r.behind} ${escapeHtml(t('repos.update_available_badge'))}</span>`
        : ''
      const warnRow = r.behind > 0
        ? `<div class="repo-card-warning" role="status">⚠ ${escapeHtml(t('repos.update_available_msg', { n: String(r.behind) }))}${r.reviewRequired ? ' ' + escapeHtml(t('repos.update_review_required')) : ''}</div>`
        : ''
      // Installed indicator: a pipx/version adoption (e.g. graphify, code-review-graph) has NO
      // git clone yet IS installed -- show the pinned version so it does not read as "missing".
      const ver = r.pinnedVersion ? ` ${escapeHtml(r.pinnedVersion)}` : ''
      const installBadge = r.installed
        ? `<span class="repo-card-badge repo-card-badge-ok" title="${escapeHtml(t('repos.installed_title'))}">✓ ${escapeHtml(t('repos.installed'))}${r.adoption === 'pipx' ? ` (pipx${ver})` : ''}</span>`
        : `<span class="repo-card-badge" title="${escapeHtml(t('repos.not_installed_title'))}">${escapeHtml(t('repos.not_installed'))}</span>`
      card.innerHTML = header +
        `<div class="repo-card-meta"><span class="repo-card-badge repo-card-badge-kind">${kind}</span>${installBadge}<span class="repo-card-badge">${escapeHtml(t('repos.badge.adopted'))}</span>${behind}<span class="repo-card-date">${escapeHtml(t('repos.installed_at'))}: ${date}</span></div>${warnRow}`
      gridEl.appendChild(card)
      continue
    }
    card.innerHTML = header + `<div class="repo-card-meta"><span class="repo-card-badge" title="${escapeHtml(t('repos.detect_pending_title'))}">${escapeHtml(t('repos.badge.pending_check'))}</span><span class="repo-card-date">${escapeHtml(t('repos.installed_at'))}: ${date}</span></div><div class="repo-card-actions"><button type="button" class="btn-secondary btn-compact repo-card-update" data-name="${escapeHtml(r.name)}"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="23 4 23 10 17 10"/><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"/></svg><span>${escapeHtml(t('repos.btn.update'))}</span></button><button type="button" class="btn-secondary btn-compact repo-card-delete" data-name="${escapeHtml(r.name)}"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 01-2 2H7a2 2 0 01-2-2V6m3 0V4a2 2 0 012-2h4a2 2 0 012 2v2"/></svg><span>${escapeHtml(t('repos.btn.delete'))}</span></button></div>`
    gridEl.appendChild(card)
  }
  gridEl.querySelectorAll('.repo-card-update').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const name = btn.getAttribute('data-name')
      btn.disabled = true
      const label = btn.querySelector('span')
      const prevText = label.textContent
      label.textContent = t('repos.updating')
      try {
        const res = await fetch(`/api/connectors/github-repos/${encodeURIComponent(name)}`, { method: 'PATCH' })
        const data = await res.json().catch(() => ({}))
        if (data.reviewRequired) {
          // Flagged executable (type=code) adoption: the backend refused a blind
          // one-click update on principle (card 3f576e55) -- this is a distinct,
          // expected state, not a failure, so it gets its own message rather than
          // the generic "update failed" wrapper.
          showToast(data.error || t('repos.review_required'), 6000)
        } else if (!res.ok || data.error) {
          showToast(t('repos.update_error') + (data.error ? `: ${data.error}` : ''))
        } else {
          showToast(data.depsChanged ? t('repos.update_success_deps') : t('repos.update_success'))
          loadReposPage()
        }
      } catch (err) {
        showToast(t('repos.update_error') + ': ' + err.message)
      } finally {
        btn.disabled = false
        label.textContent = prevText
      }
    })
  })
  gridEl.querySelectorAll('.repo-card-delete').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const name = btn.getAttribute('data-name')
      const displayName = name.replace('--', '/')
      if (!confirm(t('repos.confirm_delete', { name: displayName }))) return
      btn.disabled = true
      try {
        const res = await fetch(`/api/connectors/github-repos/${encodeURIComponent(name)}`, { method: 'DELETE' })
        if (!res.ok) { showToast(t('repos.delete_error')); btn.disabled = false; return }
        loadReposPage()
        loadConnectors()
      } catch (err) {
        showToast(t('repos.delete_error') + ': ' + err.message)
        btn.disabled = false
      }
    })
  })
}

;(function wireReposPage() {
  const refreshBtn = document.getElementById('reposRefreshBtn')
  const retryBtn = document.getElementById('reposRetryBtn')
  const addBtn = document.getElementById('reposAddBtn')
  const input = document.getElementById('reposAddInput')
  const status = document.getElementById('reposAddStatus')
  if (!refreshBtn || !addBtn || !input) return
  refreshBtn.addEventListener('click', () => loadReposPage())
  if (retryBtn) retryBtn.addEventListener('click', () => loadReposPage())
  addBtn.addEventListener('click', async () => {
    const val = input.value.trim()
    if (!val) return
    addBtn.disabled = true
    addBtn.textContent = t('repos.adding')
    status.hidden = false
    status.className = 'repos-add-status loading'
    status.textContent = t('repos.cloning')
    try {
      const res = await fetch('/api/connectors/github-repos', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url: val }),
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok || data.error) {
        status.className = 'repos-add-status error'
        status.textContent = data.error || t('repos.add_error')
        return
      }
      status.className = 'repos-add-status success'
      status.textContent = data.depsChanged ? t('repos.add_success_deps') : t('repos.add_success')
      input.value = ''
      loadReposPage()
      loadConnectors()
      setTimeout(() => { status.hidden = true }, data.depsChanged ? 7000 : 4000)
    } catch (err) {
      status.className = 'repos-add-status error'
      status.textContent = t('repos.add_error') + ': ' + err.message
    } finally {
      addBtn.disabled = false
      addBtn.textContent = t('repos.add_btn')
    }
  })
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter') addBtn.click() })
})()

// --- Vault management ---
async function loadVault() {
  try {
    const res = await fetch('/api/vault')
    const data = await res.json()
    const secrets = data.secrets || []
    document.getElementById('vaultCount').textContent = String(secrets.length)
    const list = document.getElementById('vaultList')
    list.innerHTML = ''
    for (const s of secrets) {
      const item = document.createElement('div')
      item.className = 'connector-external-item'
      const date = new Date(s.updatedAt).toLocaleDateString('hu-HU')
      item.innerHTML = `<div class="github-repo-info"><span class="github-repo-name">${escapeHtml(s.label)}</span><span class="github-repo-date">${escapeHtml(s.id)} &middot; ${date}</span></div><button title="Torles" style="background:none;border:none;color:var(--danger);cursor:pointer;font-size:14px;padding:2px 6px">&times;</button>`
      item.querySelector('button').addEventListener('click', async () => {
        if (!confirm(`Torlod: ${s.label}?`)) return
        const res = await fetch(`/api/vault/${encodeURIComponent(s.id)}`, { method: 'DELETE' })
        if (!res.ok) { showToast('Törlés sikertelen'); return }
        loadVault()
      })
      list.appendChild(item)
    }
  } catch { /* ignore */ }
}

;(function wireVault() {
  const toggle = document.getElementById('vaultToggle')
  const body = document.getElementById('vaultBody')
  if (!toggle || !body) return
  toggle.addEventListener('click', () => {
    const arrow = toggle.querySelector('.connector-scope-toggle')
    if (body.hidden) { body.hidden = false; arrow.textContent = '▼' }
    else { body.hidden = true; arrow.textContent = '▶' }
  })
  const addBtn = document.getElementById('vaultAddBtn')
  const idInput = document.getElementById('vaultIdInput')
  const valInput = document.getElementById('vaultValueInput')
  addBtn.addEventListener('click', async () => {
    const id = idInput.value.trim()
    const val = valInput.value
    if (!id || !val) return
    const res = await fetch('/api/vault', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id, label: id, value: val }),
    })
    if (!res.ok) {
      const e = await res.json().catch(() => ({}))
      showToast('Mentés sikertelen: ' + (e.error || res.status))
      return
    }
    idInput.value = ''
    valInput.value = ''
    loadVault()
  })
  valInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') addBtn.click() })
})()

// --- Env var modal for GitHub repo install ---
let _envVarResolve = null
function showEnvVarModal(envVars) {
  return new Promise((resolve) => {
    _envVarResolve = resolve
    const modal = document.getElementById('envVarModal')
    const fields = document.getElementById('envVarFields')
    fields.innerHTML = ''
    for (const v of envVars) {
      const row = document.createElement('div')
      row.className = 'env-var-row'
      row.innerHTML = `<label class="env-var-label">${escapeHtml(v)}</label><input type="password" class="input env-var-input" data-key="${escapeHtml(v)}" placeholder="Ertek...">`
      fields.appendChild(row)
    }
    modal.hidden = false
  })
}

;(function wireEnvVarModal() {
  const modal = document.getElementById('envVarModal')
  if (!modal) return
  document.getElementById('envVarModalClose').addEventListener('click', () => {
    modal.hidden = true
    if (_envVarResolve) { _envVarResolve(null); _envVarResolve = null }
  })
  document.getElementById('envVarSkipBtn').addEventListener('click', () => {
    modal.hidden = true
    if (_envVarResolve) { _envVarResolve(null); _envVarResolve = null }
  })
  document.getElementById('envVarSaveBtn').addEventListener('click', () => {
    const inputs = document.querySelectorAll('#envVarFields .env-var-input')
    const env = {}
    for (const inp of inputs) {
      const key = inp.getAttribute('data-key')
      const val = inp.value.trim()
      if (key && val) env[key] = val
    }
    modal.hidden = true
    if (_envVarResolve) { _envVarResolve(env); _envVarResolve = null }
  })
})()

// --- SSH Vault ---
let _sshServers = []
let _sshKeys = []
let _sshView = 'table'
let _sshEditingId = null

async function loadSshServers() {
  try {
    const res = await fetch('/api/vault/ssh-servers')
    const data = await res.json()
    _sshServers = data.servers || []
    renderSshServers()
  } catch { /* ignore */ }
}

async function loadSshKeys() {
  try {
    const res = await fetch('/api/vault/ssh-keys')
    if (!res.ok) return
    const data = await res.json()
    _sshKeys = data.keys || []
    renderSshKeys()
    _refreshKeySelects()
  } catch { /* ignore */ }
}

function renderSshKeys() {
  const tbody = document.getElementById('sshKeysTableBody')
  const keysView = document.getElementById('sshKeysView')
  const emptyEl = document.getElementById('sshKeysEmpty')
  if (!tbody) return
  if (_sshKeys.length === 0) {
    keysView.hidden = true
    emptyEl.hidden = false
    return
  }
  keysView.hidden = false
  emptyEl.hidden = true
  tbody.innerHTML = _sshKeys.map(k => `
    <tr>
      <td class="ssh-table-name">${escapeHtml(k.label || k.id)}</td>
      <td class="ssh-table-mono">${escapeHtml(k.username || '')}</td>
      <td class="ssh-table-mono">${escapeHtml(k.keyType || 'ed25519')}</td>
      <td class="ssh-table-mono" style="font-size:11px">${k.fingerprint ? escapeHtml(k.fingerprint.slice(0,28)) + '…' : ''}</td>
      <td class="ssh-table-mono">${k.createdAt ? new Date(k.createdAt).toLocaleDateString('hu-HU') : ''}</td>
      <td><div class="ssh-table-actions">
        <button class="btn-secondary btn-compact ssh-key-copy-btn" data-id="${escapeHtml(k.id)}" title="Publikus kulcs másolása">
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>
        </button>
        <button class="btn-secondary btn-compact ssh-key-delete-btn" data-id="${escapeHtml(k.id)}" title="Törlés">
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/><path d="M10 11v6"/><path d="M14 11v6"/></svg>
        </button>
      </div></td>
    </tr>
  `).join('')
  tbody.querySelectorAll('.ssh-key-copy-btn').forEach(btn => {
    btn.addEventListener('click', async () => {
      const key = _sshKeys.find(k => k.id === btn.dataset.id)
      if (!key) return
      try {
        const res = await fetch(`/api/vault/ssh-keys/${encodeURIComponent(btn.dataset.id)}/public-key`)
        if (res.ok) {
          const data = await res.json()
          await navigator.clipboard.writeText(data.publicKey || '')
          btn.textContent = '✓'
          setTimeout(() => { btn.innerHTML = '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>' }, 1500)
        }
      } catch { /* ignore */ }
    })
  })
  tbody.querySelectorAll('.ssh-key-delete-btn').forEach(btn => {
    btn.addEventListener('click', async () => {
      if (!confirm('Biztosan törlöd ezt a kulcsot?')) return
      await fetch(`/api/vault/ssh-keys/${encodeURIComponent(btn.dataset.id)}`, { method: 'DELETE' })
      await loadSshKeys()
    })
  })
}

function _refreshKeySelects() {
  const opts = ['<option value="">-- Nincs kulcs --</option>',
    ..._sshKeys.map(k => `<option value="${escapeHtml(k.id)}">${escapeHtml(k.label || k.id)} (${escapeHtml(k.username || '')})</option>`)
  ].join('')
  document.querySelectorAll('.ssh-key-select').forEach(sel => {
    const prev = sel.value
    sel.innerHTML = opts
    sel.value = prev
  })
}

function _sshKeyBadge(status) {
  const labels = { ok: 'OK', missing: 'Hiányzó', expired: 'Lejárt' }
  const icons = {
    ok: '<svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="20 6 9 17 4 12"/></svg>',
    missing: '<svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>',
    expired: '<svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>',
  }
  return `<span class="ssh-key-badge ${status}">${icons[status] || ''} ${labels[status] || status}</span>`
}

function _sshKeyAssignSelect(s) {
  const currentKeyId = s.sshKeyId || s.assignedKeyId || s.vaultKeyId || ''
  const opts = ['<option value="">-- Nincs kulcs --</option>',
    ..._sshKeys.map(k => {
      const sel = (currentKeyId && currentKeyId === k.id) ? ' selected' : ''
      return `<option value="${escapeHtml(k.id)}"${sel}>${escapeHtml(k.label || k.id)}</option>`
    })
  ].join('')
  return `<select class="ssh-key-assign ssh-key-select" data-id="${escapeHtml(s.id)}" title="Kulcs hozzárendelése">${opts}</select>`
}

function _sshInfoBtn(s) {
  return `<button class="ssh-info-btn" data-id="${escapeHtml(s.id)}" data-user="${escapeHtml(s.user)}" title="Telepítési útmutató">i</button>`
}

function renderSshServers() {
  const cardsEl = document.getElementById('sshCardsView')
  const tableView = document.getElementById('sshTableView')
  const tableBody = document.getElementById('sshTableBody')
  const emptyEl = document.getElementById('sshEmpty')
  if (!cardsEl || !tableBody || !emptyEl) return

  // Sync view state with _sshView
  const isTable = _sshView === 'table'
  cardsEl.hidden = isTable
  if (tableView) tableView.hidden = !isTable
  document.getElementById('sshViewCards')?.classList.toggle('active', !isTable)
  document.getElementById('sshViewTable')?.classList.toggle('active', isTable)

  if (_sshServers.length === 0) {
    cardsEl.innerHTML = ''
    tableBody.innerHTML = ''
    emptyEl.hidden = false
    return
  }
  emptyEl.hidden = true

  // Cards
  cardsEl.innerHTML = _sshServers.map(s => `
    <div class="ssh-card" data-id="${escapeHtml(s.id)}">
      <div class="ssh-card-head">
        <div class="ssh-card-icon">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="2" y="2" width="20" height="8" rx="2" ry="2"/><rect x="2" y="14" width="20" height="8" rx="2" ry="2"/><line x1="6" y1="6" x2="6.01" y2="6"/><line x1="6" y1="18" x2="6.01" y2="18"/></svg>
        </div>
        <div class="ssh-card-title">
          <div class="ssh-card-name">${escapeHtml(s.name)}</div>
          ${s.desc ? `<div class="ssh-card-desc">${escapeHtml(s.desc)}</div>` : ''}
        </div>
      </div>
      <div class="ssh-card-meta">
        <div class="ssh-card-row">
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><line x1="2" y1="12" x2="22" y2="12"/><path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"/></svg>
          <span>${escapeHtml(s.host)}</span>
        </div>
        <div class="ssh-card-row">
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/></svg>
          <span>${escapeHtml(s.user)}${s.port !== 22 ? ` :${s.port}` : ''}</span>
        </div>
        ${s.fingerprint ? `<div class="ssh-card-row"><svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/></svg><span>${escapeHtml(s.keyType || '')} ${escapeHtml(s.fingerprint.slice(0,24))}…</span></div>` : ''}
      </div>
      <div class="ssh-card-footer">
        <div style="display:flex;align-items:center;gap:4px;width:100%">
          ${_sshKeyAssignSelect(s)}
          <div class="ssh-card-actions">
            <button class="btn-secondary btn-compact ssh-edit-btn" data-id="${escapeHtml(s.id)}" title="Szerkesztés">
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M11 4H4a2 2 0 00-2 2v14a2 2 0 002 2h14a2 2 0 002-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 013 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>
            </button>
            <button class="btn-secondary btn-compact ssh-delete-btn" data-id="${escapeHtml(s.id)}" title="Törlés">
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 01-2 2H7a2 2 0 01-2-2V6m3 0V4a2 2 0 012-2h4a2 2 0 012 2v2"/></svg>
            </button>
          </div>
        </div>
      </div>
    </div>
  `).join('')

  // Table
  tableBody.innerHTML = _sshServers.map(s => `
    <tr data-id="${escapeHtml(s.id)}">
      <td class="ssh-table-name">${escapeHtml(s.name)}</td>
      <td class="ssh-table-mono">${escapeHtml(s.host)}</td>
      <td class="ssh-table-mono">${escapeHtml(s.user)}</td>
      <td class="ssh-table-mono">${s.port}</td>
      <td>${_sshKeyAssignSelect(s)}</td>
      <td style="color:var(--text-muted)">${escapeHtml(s.desc || '')}</td>
      <td><div class="ssh-table-actions">
        <button class="btn-secondary btn-compact ssh-edit-btn" data-id="${escapeHtml(s.id)}" title="Szerkesztés">
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M11 4H4a2 2 0 00-2 2v14a2 2 0 002 2h14a2 2 0 002-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 013 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>
        </button>
        <button class="btn-secondary btn-compact ssh-delete-btn" data-id="${escapeHtml(s.id)}" title="Törlés">
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 01-2 2H7a2 2 0 01-2-2V6m3 0V4a2 2 0 012-2h4a2 2 0 012 2v2"/></svg>
        </button>
      </div></td>
    </tr>
  `).join('')

  // Delete handlers
  document.querySelectorAll('.ssh-delete-btn').forEach(btn => {
    btn.addEventListener('click', async () => {
      const id = btn.getAttribute('data-id')
      if (!confirm(`Törlöd: ${id}?`)) return
      try {
        await fetch(`/api/vault/ssh-servers/${encodeURIComponent(id)}`, { method: 'DELETE' })
        await loadSshServers()
      } catch { showToast('Törlés sikertelen') }
    })
  })

  // Edit handlers -- open the add-server panel pre-filled, switch it to edit mode
  document.querySelectorAll('.ssh-edit-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const id = btn.getAttribute('data-id')
      const server = _sshServers.find(s => s.id === id)
      if (!server) return
      _sshEditingId = id

      document.getElementById('sshNameInput').value = server.name || ''
      document.getElementById('sshHostInput').value = server.host || ''
      document.getElementById('sshUserInput').value = server.user || ''
      document.getElementById('sshPortInput').value = server.port || 22
      document.getElementById('sshDescInput').value = server.desc || ''
      const keySel = document.getElementById('sshKeySelectInput')
      if (keySel) keySel.value = server.sshKeyId || server.assignedKeyId || server.vaultKeyId || ''

      const titleEl = document.getElementById('sshAddPanelTitle')
      if (titleEl) titleEl.textContent = `Szerver szerkesztése – ${server.name}`

      const panel = document.getElementById('sshAddPanel')
      panel.hidden = false
      document.getElementById('sshNameInput').focus()
    })
  })

  // Key assign select handlers
  document.querySelectorAll('.ssh-key-assign').forEach(sel => {
    sel.addEventListener('change', async () => {
      const id = sel.getAttribute('data-id')
      const sshKeyId = sel.value || null
      try {
        await fetch(`/api/vault/ssh-servers/${encodeURIComponent(id)}`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ sshKeyId }),
        })
        await loadSshServers()
      } catch { /* ignore */ }
    })
  })

}

// --- SSH Keygen modal (standalone key creation for Kulcstároló) ---
let _sshKeygenCallback = null  // called with new key after successful generation

function openSshKeygenModal(callback) {
  const overlay = document.getElementById('sshKeygenOverlay')
  document.getElementById('sshKeygenLabelInput').value = ''
  document.getElementById('sshKeygenUserInput').value = ''
  document.getElementById('sshKeygenSpinner').hidden = true
  document.getElementById('sshKeygenResult').hidden = true
  document.getElementById('sshKeygenFooter').hidden = false
  document.getElementById('sshKeygenForm').hidden = false
  document.getElementById('sshKeygenPubkeyBox').value = ''
  _sshKeygenCallback = callback || null
  openModal(overlay)
  document.getElementById('sshKeygenLabelInput').focus()
}

;(function wireSshKeygenModal() {
  const overlay = document.getElementById('sshKeygenOverlay')
  const closeBtn = document.getElementById('sshKeygenClose')
  const submitBtn = document.getElementById('sshKeygenSubmitBtn')
  const copyBtn = document.getElementById('sshKeygenCopyBtn')
  if (!overlay) return

  overlay.addEventListener('click', e => { if (e.target === overlay) closeModal(overlay) })
  closeBtn.addEventListener('click', () => closeModal(overlay))

  submitBtn.addEventListener('click', async () => {
    const label = document.getElementById('sshKeygenLabelInput').value.trim()
    const username = document.getElementById('sshKeygenUserInput').value.trim()
    if (!label || !username) { showToast('Cimke és felhasználónév megadása kötelező'); return }

    document.getElementById('sshKeygenForm').hidden = true
    document.getElementById('sshKeygenSpinner').hidden = false
    document.getElementById('sshKeygenResult').hidden = true
    document.getElementById('sshKeygenFooter').hidden = true

    try {
      const res = await fetch('/api/vault/ssh-keys', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ label, username }),
      })
      const data = await res.json()
      if (!res.ok) { showToast(data.error || 'Generálás sikertelen'); resetKeygenForm(); return }

      const pubkey = data.publicKey || (data.key && data.key.publicKey) || ''
      document.getElementById('sshKeygenPubkeyBox').value = pubkey
      document.getElementById('sshKeygenSpinner').hidden = true
      document.getElementById('sshKeygenResult').hidden = false

      await loadSshKeys()
      if (_sshKeygenCallback) _sshKeygenCallback(data.key || data)
    } catch { showToast('Hálózati hiba'); resetKeygenForm() }
  })

  copyBtn?.addEventListener('click', () => {
    const val = document.getElementById('sshKeygenPubkeyBox').value
    navigator.clipboard.writeText(val).then(() => {
      copyBtn.textContent = 'Másolva!'
      setTimeout(() => { copyBtn.innerHTML = '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg> Másolás' }, 2000)
    }).catch(() => {})
  })

  function resetKeygenForm() {
    document.getElementById('sshKeygenForm').hidden = false
    document.getElementById('sshKeygenSpinner').hidden = true
    document.getElementById('sshKeygenResult').hidden = true
    document.getElementById('sshKeygenFooter').hidden = false
  }
})()

// --- SSH Info modal ---
let _sshInfoServerId = null

async function _sshInfoLoadKey(keyId, serverUser) {
  const installSection = document.getElementById('sshInfoInstallSection')
  const noKeyEl = document.getElementById('sshInfoNoKey')
  if (!keyId) {
    installSection.hidden = true
    noKeyEl.hidden = false
    return
  }
  installSection.hidden = false
  noKeyEl.hidden = true

  let pubkey = ''
  try {
    const res = await fetch(`/api/vault/ssh-keys/${encodeURIComponent(keyId)}/public-key`)
    if (res.ok) { const d = await res.json(); pubkey = d.publicKey || '' }
  } catch {}

  const targetUser = serverUser || 'root'
  document.getElementById('sshInfoUser').textContent = targetUser

  // root always exists -- only show the "create user" step for a real,
  // non-root target user (e.g. a fresh server that needs the account first).
  const step0 = document.getElementById('sshInfoStep0')
  if (targetUser === 'root') {
    step0.hidden = true
  } else {
    step0.hidden = false
    document.getElementById('sshInfoCmd0').textContent = `useradd -m -s /bin/bash ${targetUser}`
  }

  const cmd2text = pubkey
    ? `echo "${pubkey}" >> ~/.ssh/authorized_keys`
    : `echo "<publikus kulcs ide>" >> ~/.ssh/authorized_keys`
  document.getElementById('sshInfoCmd2').textContent = cmd2text
  document.getElementById('sshInfoPubkey').textContent = pubkey || '(kulcs nem elérhető)'

  const overlay = document.getElementById('sshInfoOverlay')
  overlay.querySelectorAll('.ssh-code-copy').forEach(btn => {
    const clone = btn.cloneNode(true)
    btn.parentNode.replaceChild(clone, btn)
    clone.addEventListener('click', () => {
      const text = document.getElementById(clone.getAttribute('data-target'))?.textContent || ''
      navigator.clipboard.writeText(text).then(() => {
        clone.classList.add('copied')
        setTimeout(() => clone.classList.remove('copied'), 2000)
      }).catch(() => {})
    })
  })
}

function _sshInfoLoadServer(serverId) {
  _sshInfoServerId = serverId
  const server = _sshServers.find(s => s.id === serverId)

  document.getElementById('sshInfoServerName').textContent = server ? server.name : (serverId || '')

  const keySel = document.getElementById('sshInfoKeySelect')
  keySel.innerHTML = ['<option value="">-- Nincs kulcs --</option>',
    ..._sshKeys.map(k => `<option value="${escapeHtml(k.id)}">${escapeHtml(k.label || k.id)} (${escapeHtml(k.username || '')})</option>`)
  ].join('')
  const assignedKeyId = (server && (server.sshKeyId || server.assignedKeyId || server.vaultKeyId)) || ''
  keySel.value = assignedKeyId
  return { server, assignedKeyId }
}

function openSshInfoModal(preselectedServerId, { keyOnly = false } = {}) {
  const overlay = document.getElementById('sshInfoOverlay')
  const serverSection = overlay.querySelector('.ssh-info-server-section')

  if (keyOnly) {
    // Key-only mode: hide server selector, reset server context
    serverSection.hidden = true
    _sshInfoServerId = null
    document.getElementById('sshInfoServerName').textContent = 'Új szerver'

    // Populate key selector without a pre-selected key
    const keySel = document.getElementById('sshInfoKeySelect')
    keySel.innerHTML = ['<option value="">-- Válassz kulcsot --</option>',
      ..._sshKeys.map(k => `<option value="${escapeHtml(k.id)}">${escapeHtml(k.label || k.id)} (${escapeHtml(k.username || '')})</option>`)
    ].join('')
    // Pre-select whatever is chosen in the form's key dropdown
    const formKeyId = document.getElementById('sshKeySelectInput')?.value || ''
    keySel.value = formKeyId

    // Use the username typed into the new-server form, not a hardcoded root
    const formUser = document.getElementById('sshUserInput')?.value.trim() || 'root'

    openModal(overlay)
    _sshInfoLoadKey(formKeyId, formUser)
  } else {
    // Normal mode: show server selector, pick first server by default
    serverSection.hidden = false
    const serverSel = document.getElementById('sshInfoServerSelect')
    serverSel.innerHTML = ['<option value="">-- Válassz szervert --</option>',
      ..._sshServers.map(s => `<option value="${escapeHtml(s.id)}">${escapeHtml(s.name)} (${escapeHtml(s.host)})</option>`)
    ].join('')

    const firstId = preselectedServerId || (_sshServers[0] && _sshServers[0].id) || ''
    serverSel.value = firstId

    const { server, assignedKeyId } = _sshInfoLoadServer(firstId)
    const targetUser = (server && server.user) || 'root'

    openModal(overlay)
    _sshInfoLoadKey(assignedKeyId, targetUser)
  }
}

;(function wireSshInfoModal() {
  const overlay = document.getElementById('sshInfoOverlay')
  const closeBtn = document.getElementById('sshInfoClose')
  const serverSel = document.getElementById('sshInfoServerSelect')
  const keySel = document.getElementById('sshInfoKeySelect')
  if (!overlay) return

  overlay.addEventListener('click', e => { if (e.target === overlay) closeModal(overlay) })
  closeBtn.addEventListener('click', () => closeModal(overlay))

  serverSel?.addEventListener('change', () => {
    const { server, assignedKeyId } = _sshInfoLoadServer(serverSel.value)
    _sshInfoLoadKey(assignedKeyId, (server && server.user) || 'root')
  })

  keySel?.addEventListener('change', async () => {
    const keyId = keySel.value || null
    // Key-only mode (new-server flow) has no _sshInfoServerId -- read the
    // username from the new-server form instead of falling back to root.
    const targetUser = _sshInfoServerId
      ? ((_sshServers.find(s => s.id === _sshInfoServerId) || {}).user || 'root')
      : (document.getElementById('sshUserInput')?.value.trim() || 'root')

    if (_sshInfoServerId) {
      try {
        await fetch(`/api/vault/ssh-servers/${encodeURIComponent(_sshInfoServerId)}`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ sshKeyId: keyId }),
        })
        await loadSshServers()
      } catch { /* ignore */ }
    }
    await _sshInfoLoadKey(keyId, targetUser)
  })
})()

;(function wireSshSection() {
  const newBtn = document.getElementById('sshNewBtn')
  const panel = document.getElementById('sshAddPanel')
  const closeBtn = document.getElementById('sshAddPanelClose')
  const addBtn = document.getElementById('sshAddBtn')
  const cardViewBtn = document.getElementById('sshViewCards')
  const tableViewBtn = document.getElementById('sshViewTable')
  const cardsView = document.getElementById('sshCardsView')
  const tableView = document.getElementById('sshTableView')

  if (!newBtn) return

  function resetSshAddForm() {
    _sshEditingId = null
    const titleEl = document.getElementById('sshAddPanelTitle')
    if (titleEl) titleEl.textContent = 'Szerver hozzáadása'
    document.getElementById('sshNameInput').value = ''
    document.getElementById('sshHostInput').value = ''
    document.getElementById('sshUserInput').value = ''
    document.getElementById('sshPortInput').value = '22'
    document.getElementById('sshDescInput').value = ''
    if (document.getElementById('sshKeySelectInput')) document.getElementById('sshKeySelectInput').value = ''
  }

  newBtn.addEventListener('click', () => {
    if (panel.hidden) resetSshAddForm()
    panel.hidden = !panel.hidden
    if (!panel.hidden) document.getElementById('sshNameInput').focus()
  })
  closeBtn?.addEventListener('click', () => { panel.hidden = true; resetSshAddForm() })

  // (i) install guide button inside the "new server" form -- key-only mode
  document.getElementById('sshKeyInstallFromFormBtn')?.addEventListener('click', () => {
    openSshInfoModal(null, { keyOnly: true })
  })

  // "+ Új kulcs" button inside the "new server" form
  document.getElementById('sshKeyNewFromFormBtn')?.addEventListener('click', () => {
    openSshKeygenModal(newKey => {
      // After key created, select it in the form dropdown
      if (newKey && newKey.id) {
        const sel = document.getElementById('sshKeySelectInput')
        if (sel) sel.value = newKey.id
      }
    })
  })

  addBtn?.addEventListener('click', async () => {
    const name = document.getElementById('sshNameInput').value.trim()
    const host = document.getElementById('sshHostInput').value.trim()
    const user = document.getElementById('sshUserInput').value.trim()
    const port = parseInt(document.getElementById('sshPortInput').value, 10) || 22
    const desc = document.getElementById('sshDescInput').value.trim()
    const sshKeyId = document.getElementById('sshKeySelectInput')?.value || null
    if (!name || !host || !user) { showToast('Név, IP és felhasználó megadása kötelező'); return }
    const isEdit = !!_sshEditingId
    try {
      const res = await fetch(
        isEdit ? `/api/vault/ssh-servers/${encodeURIComponent(_sshEditingId)}` : '/api/vault/ssh-servers',
        {
          method: isEdit ? 'PUT' : 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name, host, user, port, desc, sshKeyId: sshKeyId || undefined }),
        }
      )
      if (!res.ok) {
        const err = await res.json().catch(() => ({}))
        showToast(err.error || 'Hiba a mentéskor'); return
      }
      resetSshAddForm()
      panel.hidden = true
      await loadSshServers()
      showToast(isEdit ? 'Szerver frissítve' : 'Szerver hozzáadva')
    } catch { showToast('Hálózati hiba') }
  })

  cardViewBtn?.addEventListener('click', () => {
    _sshView = 'cards'
    cardViewBtn.classList.add('active')
    tableViewBtn.classList.remove('active')
    cardsView.hidden = false
    tableView.hidden = true
  })

  tableViewBtn?.addEventListener('click', () => {
    _sshView = 'table'
    tableViewBtn.classList.add('active')
    cardViewBtn.classList.remove('active')
    cardsView.hidden = true
    tableView.hidden = false
  })

  // Kulcstároló "Új kulcs generálása" button
  document.getElementById('sshKeyNewBtn')?.addEventListener('click', () => {
    openSshKeygenModal()
  })

  // Global (i) info button in section header
  document.getElementById('sshInfoGlobalBtn')?.addEventListener('click', () => {
    openSshInfoModal()
  })
})()

// --- Vault Page ---
let _vaultSecrets = []

let _vaultBindings = []

async function loadVaultPage() {
  try {
    const [secretsRes, bindingsRes] = await Promise.all([
      fetch('/api/vault'),
      fetch('/api/vault/bindings'),
    ])
    const secretsData = await secretsRes.json()
    const bindingsData = await bindingsRes.json()
    _vaultSecrets = secretsData.secrets || []
    _vaultBindings = bindingsData.bindings || []
    document.getElementById('vaultStatTotal').textContent = String(_vaultSecrets.length)
    document.getElementById('vaultStatBindings').textContent = String(_vaultBindings.length)
    renderVaultGrid(_vaultSecrets)
    await Promise.all([loadSshKeys(), loadSshServers()])
  } catch { /* ignore */ }
}

function renderVaultGrid(secrets) {
  const list = document.getElementById('vaultPageList')
  const empty = document.getElementById('vaultPageEmpty')
  list.innerHTML = ''
  if (secrets.length === 0) { empty.hidden = false; return }
  empty.hidden = true
  for (const s of secrets) {
    const card = document.createElement('div')
    card.className = 'vault-card'
    const date = new Date(s.updatedAt).toLocaleDateString('hu-HU')
    const bindingCount = _vaultBindings.filter(b => b.vaultSecretId === s.id).length
    const bindingBadge = bindingCount > 0 ? `<span class="vault-binding-badge" title="${bindingCount} kotes">${bindingCount} kotes</span>` : ''
    card.innerHTML = `<div class="vault-card-header"><div class="vault-card-icon"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="11" width="18" height="11" rx="2" ry="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg></div><div class="vault-card-title"><div class="vault-card-id">${escapeHtml(s.id)} ${bindingBadge}</div>${s.label !== s.id ? `<div class="vault-card-label">${escapeHtml(s.label)}</div>` : ''}</div><div class="vault-card-meta">${date}</div></div><div class="vault-card-actions"><button class="btn-secondary btn-compact vault-card-reveal" data-id="${escapeHtml(s.id)}"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>${t('vault.btn.show')}</button><button class="btn-secondary btn-compact vault-card-edit" data-id="${escapeHtml(s.id)}" data-label="${escapeHtml(s.label)}"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M11 4H4a2 2 0 00-2 2v14a2 2 0 002 2h14a2 2 0 002-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 013 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>${t('vault.btn.edit')}</button><button class="btn-secondary btn-compact vault-card-delete" data-id="${escapeHtml(s.id)}"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 01-2 2H7a2 2 0 01-2-2V6m3 0V4a2 2 0 012-2h4a2 2 0 012 2v2"/></svg>${t('vault.btn.delete')}</button></div>`
    list.appendChild(card)
  }
  list.querySelectorAll('.vault-card-reveal').forEach(btn => {
    btn.addEventListener('click', async () => {
      const id = btn.getAttribute('data-id')
      const card = btn.closest('.vault-card')
      const existing = card.querySelector('.vault-card-value')
      if (existing) { existing.remove(); btn.innerHTML = `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg> ${t('vault.btn.show')}`; return }
      const res = await fetch(`/api/vault/${encodeURIComponent(id)}`)
      const data = await res.json()
      if (data.value) {
        const valEl = document.createElement('div')
        valEl.className = 'vault-card-value'
        valEl.textContent = data.value
        card.appendChild(valEl)
        btn.innerHTML = `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M17.94 17.94A10.07 10.07 0 0112 20c-7 0-11-8-11-8a18.45 18.45 0 015.06-5.94M9.9 4.24A9.12 9.12 0 0112 4c7 0 11 8 11 8a18.5 18.5 0 01-2.16 3.19m-6.72-1.07a3 3 0 11-4.24-4.24"/><line x1="1" y1="1" x2="23" y2="23"/></svg> ${t('vault.btn.hide')}`
      }
    })
  })
  list.querySelectorAll('.vault-card-edit').forEach(btn => {
    btn.addEventListener('click', async () => {
      const id = btn.getAttribute('data-id')
      const label = btn.getAttribute('data-label')
      const card = btn.closest('.vault-card')
      const existing = card.querySelector('.vault-card-edit-form')
      if (existing) { existing.remove(); return }
      card.querySelector('.vault-card-value')?.remove()
      const res = await fetch(`/api/vault/${encodeURIComponent(id)}`)
      const data = await res.json()
      if (!data.value) return
      const form = document.createElement('div')
      form.className = 'vault-card-edit-form'
      form.innerHTML = `<input type="password" class="input vault-edit-value" value="${escapeHtml(data.value)}" style="font-size:13px;margin-bottom:6px"><button class="btn-primary btn-compact vault-edit-save">${t('vault.btn.save')}</button> <button class="btn-secondary btn-compact vault-edit-cancel">${t('vault.btn.cancel')}</button>`
      card.appendChild(form)
      const input = form.querySelector('.vault-edit-value')
      input.focus()
      input.select()
      form.querySelector('.vault-edit-cancel').addEventListener('click', () => form.remove())
      form.querySelector('.vault-edit-save').addEventListener('click', async () => {
        const newVal = input.value
        if (!newVal) return
        const saveBtn = form.querySelector('.vault-edit-save')
        saveBtn.disabled = true
        saveBtn.textContent = '...'
        const res = await fetch('/api/vault', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ id, label, value: newVal }),
        })
        if (!res.ok) {
          const e = await res.json().catch(() => ({}))
          showToast('Frissítés sikertelen: ' + (e.error || res.status))
          saveBtn.disabled = false
          saveBtn.textContent = 'Mentés'
          return
        }
        form.remove()
        showToast('Kulcs frissitve es szinkronizalva')
        loadVaultPage()
        loadVault()
      })
      input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') form.querySelector('.vault-edit-save').click()
        if (e.key === 'Escape') form.remove()
      })
    })
  })
  list.querySelectorAll('.vault-card-delete').forEach(btn => {
    btn.addEventListener('click', async () => {
      const id = btn.getAttribute('data-id')
      if (!confirm(`Torlod: ${id}?`)) return
      const res = await fetch(`/api/vault/${encodeURIComponent(id)}`, { method: 'DELETE' })
      if (!res.ok) { showToast('Törlés sikertelen'); return }
      loadVaultPage()
      loadVault()
    })
  })
}

;(function wireVaultPage() {
  const newBtn = document.getElementById('vaultPageNewBtn')
  const panel = document.getElementById('vaultAddPanel')
  const closeBtn = document.getElementById('vaultAddPanelClose')
  const addBtn = document.getElementById('vaultPageAddBtn')
  if (!newBtn || !panel) return

  newBtn.addEventListener('click', () => {
    panel.hidden = !panel.hidden
    if (!panel.hidden) document.getElementById('vaultPageIdInput').focus()
  })
  closeBtn?.addEventListener('click', () => { panel.hidden = true })

  addBtn.addEventListener('click', async () => {
    const id = document.getElementById('vaultPageIdInput').value.trim()
    const label = document.getElementById('vaultPageLabelInput').value.trim() || id
    const value = document.getElementById('vaultPageValueInput').value
    if (!id || !value) return
    addBtn.disabled = true
    await fetch('/api/vault', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id, label, value }),
    })
    document.getElementById('vaultPageIdInput').value = ''
    document.getElementById('vaultPageLabelInput').value = ''
    document.getElementById('vaultPageValueInput').value = ''
    addBtn.disabled = false
    panel.hidden = true
    loadVaultPage()
    loadVault()
  })
  document.getElementById('vaultPageValueInput')?.addEventListener('keydown', (e) => { if (e.key === 'Enter') addBtn.click() })

  document.getElementById('vaultSearchInput')?.addEventListener('input', (e) => {
    const q = e.target.value.toLowerCase().trim()
    if (!q) { renderVaultGrid(_vaultSecrets); return }
    renderVaultGrid(_vaultSecrets.filter(s => s.id.toLowerCase().includes(q) || s.label.toLowerCase().includes(q)))
  })
})()

// --- Vault Binding modal ---
;(function wireVaultBind() {
  const bindBtn = document.getElementById('vaultBindBtn')
  const overlay = document.getElementById('vaultBindOverlay')
  const closeBtn = document.getElementById('vaultBindClose')
  const saveBtn = document.getElementById('vaultBindSaveBtn')
  const secretSelect = document.getElementById('vaultBindSecret')
  const serverSelect = document.getElementById('vaultBindServer')
  const envVarInput = document.getElementById('vaultBindEnvVar')
  const statusEl = document.getElementById('vaultBindStatus')
  if (!bindBtn || !overlay) return

  overlay.addEventListener('click', (e) => { if (e.target === overlay) closeModal(overlay) })
  closeBtn.addEventListener('click', () => { closeModal(overlay) })

  bindBtn.addEventListener('click', async () => {
    try {
      statusEl.hidden = true
      envVarInput.value = ''

      const [secretsRes, connectorsRes] = await Promise.all([
        fetch('/api/vault'),
        fetch('/api/connectors'),
      ])
      const secrets = (await secretsRes.json()).secrets || []
      const connectors = await connectorsRes.json()

      secretSelect.innerHTML = ''
      for (const s of secrets) {
        const opt = document.createElement('option')
        opt.value = s.id
        opt.textContent = s.label !== s.id ? `${s.id} (${s.label})` : s.id
        secretSelect.appendChild(opt)
      }
      if (secrets.length === 0) {
        const opt = document.createElement('option')
        opt.textContent = '-- Nincs vault kulcs --'
        opt.disabled = true
        secretSelect.appendChild(opt)
      }

      const mcpConnectors = connectors.filter(c => c.source !== 'plugin' && c.source !== 'claude.ai')
      serverSelect.innerHTML = ''
      for (const c of mcpConnectors) {
        const opt = document.createElement('option')
        opt.value = c.name
        opt.textContent = c.scope !== 'global' ? `${c.name} (${c.scope})` : c.name
        serverSelect.appendChild(opt)
      }
      if (mcpConnectors.length === 0) {
        const opt = document.createElement('option')
        opt.textContent = '-- Nincs MCP szerver --'
        opt.disabled = true
        serverSelect.appendChild(opt)
      }

      openModal(overlay)
    } catch (err) {
      console.error('Vault bind modal error:', err)
      showToast('Hiba a hozzarendeles betoltesekor: ' + err.message)
    }
  })

  saveBtn.addEventListener('click', async () => {
    const vaultSecretId = secretSelect.value
    const serverName = serverSelect.value
    const envVar = envVarInput.value.trim()
    if (!vaultSecretId || !serverName || !envVar) {
      statusEl.textContent = 'Minden mezo kitoltese kotelezo'
      statusEl.className = 'vault-bind-status error'
      statusEl.hidden = false
      return
    }

    saveBtn.disabled = true
    saveBtn.textContent = t('connectors.save_btn')
    try {
      const res = await fetch('/api/vault/bindings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ vaultSecretId, envVar, serverName }),
      })
      const data = await res.json()
      if (data.ok) {
        statusEl.textContent = `Hozzarendelve! ${data.synced || 0} fajl frissitve.`
        statusEl.className = 'vault-bind-status success'
        statusEl.hidden = false
        loadVaultPage()
        loadVault()
        setTimeout(() => { closeModal(overlay) }, 1500)
      } else {
        statusEl.textContent = data.error || 'Hiba tortent'
        statusEl.className = 'vault-bind-status error'
        statusEl.hidden = false
      }
    } catch (err) {
      statusEl.textContent = 'Halozati hiba'
      statusEl.className = 'vault-bind-status error'
      statusEl.hidden = false
    } finally {
      saveBtn.disabled = false
      saveBtn.textContent = 'Hozzarendeles'
    }
  })
})()

// --- Vault Scan & Import ---
;(function wireVaultScan() {
  const scanBtn = document.getElementById('vaultScanBtn')
  const syncBtn = document.getElementById('vaultSyncBtn')
  const overlay = document.getElementById('vaultScanOverlay')
  const closeBtn = document.getElementById('vaultScanClose')
  const importBtn = document.getElementById('vaultScanImportBtn')
  if (!scanBtn || !overlay) return

  scanBtn.addEventListener('click', async () => {
    scanBtn.disabled = true
    scanBtn.textContent = 'Kereses...'
    try {
      const res = await fetch('/api/vault/scan')
      const data = await res.json()
      const findings = data.findings || []
      renderScanResults(findings)
      openModal(overlay)
    } finally {
      scanBtn.disabled = false
      scanBtn.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg> Scan &amp; Import'
    }
  })

  closeBtn?.addEventListener('click', () => { closeModal(overlay) })
  overlay.addEventListener('click', (e) => { if (e.target === overlay) closeModal(overlay) })

  syncBtn?.addEventListener('click', async () => {
    syncBtn.disabled = true
    syncBtn.textContent = 'Szinkron...'
    try {
      const res = await fetch('/api/vault/sync', { method: 'POST' })
      const data = await res.json()
      if (data.updated > 0) {
        showToast(`${data.updated} .mcp.json frissitve`)
      } else {
        showToast('Nincs szinkronizalando kotes')
      }
      if (data.errors?.length) {
        showToast('Hibak: ' + data.errors.join(', '))
      }
    } finally {
      syncBtn.disabled = false
      syncBtn.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="23 4 23 10 17 10"/><polyline points="1 20 1 14 7 14"/><path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15"/></svg> Szinkron'
    }
  })

  function renderScanResults(findings) {
    const results = document.getElementById('vaultScanResults')
    const empty = document.getElementById('vaultScanEmpty')
    const footer = document.getElementById('vaultScanFooter')
    results.innerHTML = ''

    const actionable = findings.filter(f => !f.alreadyInVault)
    if (actionable.length === 0) {
      empty.hidden = false
      footer.hidden = true
      if (findings.length > 0) {
        empty.textContent = `${findings.length} erzekeny ertek talalva, de mind mar a Vault-ban van.`
      }
      return
    }
    empty.hidden = true
    footer.hidden = false

    const grouped = new Map()
    for (const f of actionable) {
      const key = `${f.serverName}|${f.envVar}`
      if (!grouped.has(key)) grouped.set(key, { ...f, allTargets: [] })
      grouped.get(key).allTargets.push({ mcpFilePath: f.mcpFilePath, serverName: f.serverName })
    }

    for (const [key, f] of grouped) {
      const row = document.createElement('div')
      row.className = 'vault-scan-row'
      row.innerHTML = `
        <label class="vault-scan-check">
          <input type="checkbox" checked data-key="${escapeHtml(key)}">
        </label>
        <div class="vault-scan-info">
          <div class="vault-scan-server">${escapeHtml(f.serverName)}</div>
          <div class="vault-scan-env">${escapeHtml(f.envVar)} = <code>${escapeHtml(f.maskedValue)}</code></div>
          <div class="vault-scan-targets">${f.allTargets.length} fajlban</div>
        </div>
        <div class="vault-scan-id">
          <input type="text" class="input vault-scan-vault-id" value="${escapeHtml(f.suggestedVaultId)}" data-key="${escapeHtml(key)}" style="font-size:12px;width:180px">
        </div>
      `
      results.appendChild(row)
    }
  }

  importBtn?.addEventListener('click', async () => {
    const results = document.getElementById('vaultScanResults')
    const rows = results.querySelectorAll('.vault-scan-row')
    const imports = []

    const scanRes = await fetch('/api/vault/scan')
    const scanData = await scanRes.json()
    const allFindings = scanData.findings || []

    for (const row of rows) {
      const cb = row.querySelector('input[type="checkbox"]')
      if (!cb?.checked) continue
      const key = cb.getAttribute('data-key')
      const [serverName, envVar] = key.split('|')
      const vaultIdInput = row.querySelector('.vault-scan-vault-id')
      const vaultId = vaultIdInput?.value?.trim() || key

      const matchingFindings = allFindings.filter(
        f => f.serverName === serverName && f.envVar === envVar && !f.alreadyInVault,
      )
      if (matchingFindings.length === 0) continue

      imports.push({
        serverName,
        envVar,
        vaultId,
        label: `${envVar} (${serverName})`,
        createBinding: true,
        targets: matchingFindings.map(f => ({ mcpFilePath: f.mcpFilePath, serverName: f.serverName })),
      })
    }

    if (imports.length === 0) { showToast('Nincs kivalasztott elem'); return }

    importBtn.disabled = true
    importBtn.textContent = 'Importalas...'

    try {
      const res = await fetch('/api/vault/import', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ imports }),
      })
      const data = await res.json()
      if (data.imported > 0) {
        showToast(`${data.imported} kulcs importalva, ${data.bound} kotes letrehozva`)
      }
      if (data.errors?.length) {
        showToast('Hibak: ' + data.errors.join(', '))
      }
    } finally {
      importBtn.disabled = false
      importBtn.textContent = 'Kivalasztottak importalasa'
    }
    closeModal(overlay)
    loadVaultPage()
    loadVault()
  })
})()

// --- External project paths management ---
async function loadExternalPaths() {
  try {
    const res = await fetch('/api/connectors/external-paths')
    const data = await res.json()
    const paths = data.paths || []
    document.getElementById('externalPathCount').textContent = String(paths.length)
    const list = document.getElementById('externalPathList')
    list.innerHTML = ''
    for (const p of paths) {
      const item = document.createElement('div')
      item.className = 'connector-external-item'
      item.innerHTML = `<span>${escapeHtml(p)}</span><button title="Torles">&times;</button>`
      item.querySelector('button').addEventListener('click', async () => {
        await fetch('/api/connectors/external-paths', {
          method: 'DELETE',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ path: p }),
        })
        loadExternalPaths()
        loadConnectors()
      })
      list.appendChild(item)
    }
  } catch { /* ignore */ }
}

;(function wireExternalPaths() {
  const toggle = document.getElementById('externalPathsToggle')
  const body = document.getElementById('externalPathsBody')
  if (!toggle || !body) return
  toggle.addEventListener('click', () => {
    const arrow = toggle.querySelector('.connector-scope-toggle')
    if (body.hidden) { body.hidden = false; arrow.textContent = '▼' }
    else { body.hidden = true; arrow.textContent = '▶' }
  })
  const addBtn = document.getElementById('externalPathAddBtn')
  const input = document.getElementById('externalPathInput')
  addBtn.addEventListener('click', async () => {
    const val = input.value.trim()
    if (!val) return
    const res = await fetch('/api/connectors/external-paths', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: val }),
    })
    const data = await res.json()
    if (data.error) { alert(data.error); return }
    input.value = ''
    loadExternalPaths()
    loadConnectors()
  })
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter') addBtn.click() })
})()

async function openConnectorDetail(connector) {
  document.getElementById('connectorDetailTitle').textContent = connector.name

  // Fetch detailed info
  try {
    const res = await fetch(`/api/connectors/${encodeURIComponent(connector.name)}`)
    const detail = await res.json()

    const statusLabels = { connected: t('connectors.status.connected'), needs_auth: t('connectors.status.needs_auth'), failed: t('connectors.status.failed'), unknown: t('connectors.status.unknown') }
    const statusColors = { connected: 'var(--success)', needs_auth: 'var(--accent)', failed: 'var(--danger)', unknown: 'var(--text-muted)' }

    document.getElementById('connectorDetailInfo').innerHTML = `
      <div class="connector-detail-row">
        <span class="meta-label">Statusz</span>
        <span class="meta-value" style="color:${statusColors[detail.status] || ''}">${statusLabels[detail.status] || detail.status}</span>
      </div>
      <div class="connector-detail-row">
        <span class="meta-label">Hatokor</span>
        <span class="meta-value">${escapeHtml(detail.scope || '-')}</span>
      </div>
      ${detail.type ? `<div class="connector-detail-row"><span class="meta-label">Tipus</span><span class="meta-value">${escapeHtml(detail.type)}</span></div>` : ''}
      ${detail.command ? `<div class="connector-detail-row"><span class="meta-label">Parancs</span><span class="meta-value" style="font-family:monospace;font-size:12px">${escapeHtml(detail.command)} ${escapeHtml(detail.args || '')}</span></div>` : ''}
      ${Object.keys(detail.env || {}).length ? `<div class="connector-detail-row"><span class="meta-label">Env</span><span class="meta-value" style="font-family:monospace;font-size:11px">${Object.entries(detail.env).map(([k,v]) => `${k}=${v}`).join(', ')}</span></div>` : ''}
    `
  } catch {
    document.getElementById('connectorDetailInfo').innerHTML = `<p>${t('connectors.detail_error')}</p>`
  }

  try {
    const [agentsRes, connectorsRes] = await Promise.all([
      fetch('/api/schedules/agents'),
      fetch('/api/connectors'),
    ])
    const allAgents = await agentsRes.json()
    const allConnectors = await connectorsRes.json()
    const assignedAgents = new Set()
    for (const c of allConnectors) {
      if (c.name === connector.name && c.source === 'agent') {
        assignedAgents.add(c.scope.replace('agent:', ''))
      }
    }
    const mainAgent = allAgents.find(a => a.name === mainAgentId())
    const subAgents = allAgents.filter(a => a.name !== mainAgentId())

    const listEl = document.getElementById('connectorAgentList')
    listEl.innerHTML = ''
    if (mainAgent) {
      const item = document.createElement('div')
      item.className = 'connector-agent-item connector-agent-auto'
      item.innerHTML = `
        <input type="checkbox" checked disabled title="${t('connectors.tooltip.global')}">
        <label>${escapeHtml(mainAgent.label || mainAgent.name)} <span class="tag-auto">automatikus</span></label>
      `
      listEl.appendChild(item)
    }
    for (const agent of subAgents) {
      const isAssigned = assignedAgents.has(agent.name)
      const item = document.createElement('div')
      item.className = 'connector-agent-item'
      item.innerHTML = `
        <input type="checkbox" id="assign-${agent.name}" value="${agent.name}" ${isAssigned ? 'checked' : ''}>
        <label for="assign-${agent.name}">${escapeHtml(agent.label || agent.name)}</label>
      `
      listEl.appendChild(item)
    }
    if (subAgents.length === 0 && !mainAgent) {
      listEl.innerHTML = `<p style="color:var(--text-muted);font-size:13px">${t('connectors.no_agents')}</p>`
    }
  } catch {
    document.getElementById('connectorAgentList').innerHTML = ''
  }

  // Delete button
  document.getElementById('connectorDeleteBtn').onclick = async () => {
    if (!confirm(`Biztosan torlod: ${connector.name}?`)) return
    try {
      await fetch(`/api/connectors/${encodeURIComponent(connector.name)}`, { method: 'DELETE' })
      closeModal(connectorDetailOverlay)
      showToast(t('connectors.toast.deleted'))
      loadConnectors()
    } catch {
      showToast(t('common.error_delete'))
    }
  }

  // Assign button
  document.getElementById('connectorAssignBtn').onclick = async () => {
    const checked = [...document.querySelectorAll('#connectorAgentList input:checked:not(:disabled)')].map(i => i.value)
    const allVisible = [...document.querySelectorAll('#connectorAgentList input:not(:disabled)')].map(i => i.value)
    try {
      await fetch(`/api/connectors/${encodeURIComponent(connector.name)}/assign`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ agents: checked, allAgents: allVisible }),
      })
      showToast(t('connectors.toast.assignment_updated'))
      closeModal(connectorDetailOverlay)
      loadConnectors()
    } catch {
      showToast(t('connectors.toast.assignment_error'))
    }
  }

  openModal(connectorDetailOverlay)
}

// ENV row management for new connector form
document.getElementById('connectorEnvAddBtn').addEventListener('click', () => {
  const list = document.getElementById('connectorEnvList')
  const row = document.createElement('div')
  row.className = 'connector-env-row'
  row.innerHTML = `
    <input type="text" class="input env-key" placeholder="KULCS" style="flex:1">
    <span style="color:var(--text-muted)">=</span>
    <input type="text" class="input env-val" placeholder="${t('connectors.env_val_placeholder')}" style="flex:2">
    <button type="button" class="btn-link" style="color:var(--danger);padding:2px 6px">&times;</button>
  `
  row.querySelector('button').addEventListener('click', () => row.remove())
  list.appendChild(row)
})

async function loadNewConnectorAgents() {
  try {
    const res = await fetch('/api/schedules/agents')
    const agents = await res.json()
    const list = document.getElementById('connectorNewAssignList')
    list.innerHTML = ''
    for (const agent of agents) {
      const item = document.createElement('div')
      item.className = 'connector-agent-item'
      item.innerHTML = `
        <input type="checkbox" id="new-assign-${agent.name}" value="${agent.name}">
        <label for="new-assign-${agent.name}">${escapeHtml(agent.label || agent.name)}</label>
      `
      list.appendChild(item)
    }
  } catch { /* ignore */ }
}

// Save new connector
document.getElementById('saveConnectorBtn').addEventListener('click', async () => {
  const name = document.getElementById('connectorName').value.trim()
  const type = document.getElementById('connectorType').value
  const scope = document.getElementById('connectorScope').value

  if (!name) { document.getElementById('connectorName').focus(); return }

  const data = { name, type, scope }
  if (type === 'http' || type === 'sse') {
    data.url = document.getElementById('connectorUrl').value.trim()
    if (!data.url) { document.getElementById('connectorUrl').focus(); return }
  } else {
    data.command = document.getElementById('connectorCmd').value.trim()
    data.args = document.getElementById('connectorArgs').value.trim()
    if (!data.command) { document.getElementById('connectorCmd').focus(); return }
    const envRows = document.querySelectorAll('#connectorEnvList .connector-env-row')
    if (envRows.length > 0) {
      const env = {}
      for (const row of envRows) {
        const k = row.querySelector('.env-key').value.trim()
        const v = row.querySelector('.env-val').value.trim()
        if (k) env[k] = v
      }
      if (Object.keys(env).length > 0) data.env = env
    }
  }

  const btn = document.getElementById('saveConnectorBtn')
  btn.disabled = true
  btn.querySelector('.btn-text').hidden = true
  btn.querySelector('.btn-loading').hidden = false

  try {
    const res = await fetch('/api/connectors', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data),
    })
    if (!res.ok) {
      const err = await res.json()
      throw new Error(err.error || 'Hiba')
    }
    const result = await res.json()
    const savedName = result.name || name

    const checkedAgents = Array.from(document.querySelectorAll('#connectorNewAssignList input[type=checkbox]:checked')).map(cb => cb.value)
    const allAgents = Array.from(document.querySelectorAll('#connectorNewAssignList input[type=checkbox]')).map(cb => cb.value)
    if (checkedAgents.length > 0) {
      await fetch(`/api/connectors/${encodeURIComponent(savedName)}/assign`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ agents: checkedAgents, allAgents }),
      }).catch(() => {})
    }

    closeModal(connectorModalOverlay)
    if (result.nameChanged) {
      showToast(t('connectors.toast.added', { name: savedName }))
    } else {
      showToast(t('connectors.toast.created'))
    }
    loadConnectors()
  } catch (err) {
    showToast(`Hiba: ${err.message}`)
  } finally {
    btn.disabled = false
    btn.querySelector('.btn-text').hidden = false
    btn.querySelector('.btn-loading').hidden = true
  }
})

// === Helpers ===
function escapeHtml(str) {
  const d = document.createElement('div')
  d.textContent = str
  // textContent->innerHTML escapes & < > but NOT quotes. Encode quotes too so
  // the result is safe in ATTRIBUTE contexts as well as text nodes -- several
  // renderers interpolate escapeHtml() output into data-*/title/value="..."
  // attributes, where a surviving " would allow an attribute breakout.
  return d.innerHTML.replace(/"/g, '&quot;').replace(/'/g, '&#39;')
}

// ============================================================
// === Status ===
// ============================================================

// Statuspage component status -> short label for non-operational states.
const STATUS_COMPONENT_LABELS = {
  operational: () => t('status.comp.operational'),
  degraded_performance: () => t('status.comp.degraded'),
  partial_outage: () => t('status.comp.partial_outage'),
  major_outage: () => t('status.comp.major_outage'),
  under_maintenance: () => t('status.comp.maintenance'),
}

// ============================================================
// === Local LLM (Ollama offload) page -- see web/app-local-llm.js ===
// ============================================================
// (Moved to app-local-llm.js as part of modularisation, card c4325698 / b33fc5f7.
//  app-local-llm.js is loaded after this file in index.html.)

// ============================================================
// === CostOps + Memory Import + Koltöztetes + Fleet Migration -- see web/app-import-migration.js ===
// ============================================================
// (Moved to app-import-migration.js as part of modularisation, slice 19/N.
//  app-import-migration.js is loaded AFTER this file in index.html.)
/* STUB -- content removed */
// ============================================================
// === Skills Page -- see web/app-skills.js ===
// ============================================================
// (Moved to app-skills.js as part of modularisation, card 7a2a7ef3 / slice 10/N.
//  app-skills.js is loaded AFTER this file in index.html.
//  loadGlobalSkills() is only called from switchPage, never at init time.)
/* STUB -- content removed */

// === Team org-chart + Agents view toggle + message log helpers -- see web/app-agents-team.js ===
// (Moved to app-agents-team.js as part of modularisation, slice 20/N.
//  app-agents-team.js is loaded AFTER this file in index.html.
//  All references from app.js (loadTeamGraph, _setAgentsView, _agentsActiveView, MSG_STATUS_META,
//  resolveOwnerName) are inside function bodies and resolved at call time.)
/* STUB -- content removed */

// === Messages page -- see web/app-messages.js ===
// (Moved to app-messages.js as part of modularisation, card 7ee1e236 / slice 9/N.
//  app-messages.js is loaded AFTER this file in index.html.
//  loadMessagesPage() is only called from switchPage, never at init time.)
/* STUB -- content removed */

// === Overview page + live local-LLM utilization spectrum -- see web/app-overview.js ===
// (Moved to app-overview.js as part of modularisation, slice 16/N.
//  app-overview.js is loaded AFTER this file in index.html and self-initialises.)
/* STUB -- content removed */

// ============================================================
// === Updates page helpers -- see web/app-updates.js ===
// ============================================================
// (escapeHtmlUpdates, renderUpdatesBadge, renderBranchNotice,
//  renderDiagnoseOffer, runDiagnose, runUpdate, pollUpdateOutcome,
//  wireBranchDriftBanner, pollUpdatesBadge, updatesCheckBtn/ApplyBtn listeners --
//  all moved to app-updates.js as part of modularisation slice 25.)
/* STUB -- most helpers removed */

// renderUpdatesVersion() stays: upstream function, fork-updates.js calls it.
// Moving it to a module would reopen three-way divergence on upstream merges.
// (fork-overlay-seam.test.ts pins this invariant.)
function renderUpdatesVersion(data) {
  const sub = document.getElementById('updatesSubtitle')
  if (!sub) return
  const ver = (data && typeof data.version === 'string') ? data.version.trim() : ''
  const sha = ((data && data.current) || '').slice(0, 7)
  const parts = []
  if (ver) parts.push('v' + escapeHtmlUpdates(ver))
  if (sha) parts.push(`<code>${escapeHtmlUpdates(sha)}</code>`)
  if (parts.length === 0) {
    // No version AND no SHA (no git checkout and unreadable package.json): fall
    // back to the localized brand subtitle. Set as text (not innerHTML) so no
    // stale markup lingers, and keep it localized on every render.
    sub.textContent = t('updates.brand_subtitle')
    return
  }
  sub.innerHTML = `${t('updates.current_label')} ${parts.join(' · ')}`
}

// loadUpdates() stays: fork-overlay seam (fork-updates.js overrides it at runtime).
// handleRepoInstallClick / runRepoInstall / runRepoInstallWithStash: fork-only,
// kept here per fork-updates.js comment ("deliberately stays in app.js").
async function loadUpdates() {
  const summary = document.getElementById('updatesSummary')
  const list = document.getElementById('updatesCommitList')
  const applyBtn = document.getElementById('updatesApplyBtn')
  summary.textContent = t('updates.checking')
  summary.className = 'updates-summary'
  list.innerHTML = ''
  try {
    const res = await fetch('/api/updates')
    if (!res.ok) throw new Error('HTTP ' + res.status)
    const data = await res.json()
    window._updatesStatus = data
    renderUpdatesBadge(data)
    renderUpdatesVersion(data)
    updateBranchDriftUI(data)
    renderBranchNotice(data)
    if (data.error) {
      summary.className = 'updates-summary error'
      summary.innerHTML = `<strong>${t('updates.check_failed')}:</strong> ${escapeHtmlUpdates(data.error)}`
      applyBtn.hidden = true
    } else if (data.behind === 0) {
      summary.className = 'updates-summary up-to-date'
      summary.innerHTML = `<strong>${t('updates.up_to_date_html')}</strong>. ${t('updates.no_changes')}`
      applyBtn.hidden = true
    } else {
      summary.className = 'updates-summary behind'
      const versions = (data.releases || []).filter((r) => r.version)
      if (versions.length > 0) {
        // Version-centric: "N uj verzio elerheto (v1.21.0)".
        summary.innerHTML = `<strong>${t('updates.versions_available', { n: versions.length })}</strong> <code>${escapeHtmlUpdates(versions[0].version)}</code>`
      } else {
        // Pre-release: unreleased commits but no new version tag yet.
        summary.innerHTML = `<strong>${t('updates.changes_available')}</strong> ${t('updates.available_on', { remote: `<code>${escapeHtmlUpdates(data.remote)}</code>` })}`
      }
      applyBtn.hidden = false
    }
    const commitCard = (c) => `
        <div class="updates-commit">
          <div class="updates-commit-head">
            <span>${escapeHtmlUpdates(c.short)} · ${escapeHtmlUpdates(c.author)}</span>
            <span>${escapeHtmlUpdates((c.date || '').slice(0, 10))}</span>
          </div>
          <div class="updates-commit-msg">${escapeHtmlUpdates(c.message)}</div>
        </div>`
    if (data.releases && data.releases.length) {
      // Version-centric: the human-language summary per version is the primary
      // content; the raw commit list (SHAs, conventional-commit prefixes, author
      // names) is tucked behind a collapsed "details" so it is never the first
      // thing the operator sees.
      list.innerHTML = data.releases.map((rel) => {
        const isUpcoming = !rel.version
        const label = isUpcoming ? t('updates.group.upcoming') : escapeHtmlUpdates(rel.version)
        const human = rel.summary
          ? escapeHtmlUpdates(rel.summary)
          : (isUpcoming ? t('updates.upcoming_note') : '')
        return `
        <div class="updates-version">
          <div class="updates-version-tag">${label}</div>
          ${human ? `<div class="updates-version-summary">${human}</div>` : ''}
          <details class="updates-version-details">
            <summary>${t('updates.details', { n: rel.commits.length })}</summary>
            <div class="updates-commit-list">${rel.commits.map(commitCard).join('')}</div>
          </details>
        </div>`
      }).join('')
    } else if (data.commits && data.commits.length) {
      list.innerHTML = data.commits.map(commitCard).join('')
    } else if (data.behind === 0) {
      list.innerHTML = `<p style="color:var(--text-muted);font-size:13px">${t('updates.no_changes')}</p>`
    }
  } catch (err) {
    summary.className = 'updates-summary error'
    summary.textContent = 'Hiba: ' + (err.message || err)
    applyBtn.hidden = true
  }
  renderDiagnoseOffer()
}

async function handleRepoInstallClick(btn) {
  const repoKey = btn.dataset.repo
  const confirmKey = repoKey === 'upstream'
    ? 'updates.confirm.install_upstream'
    : 'updates.confirm.install_fork'
  if (!confirm(t(confirmKey))) return
  await runRepoInstall(repoKey, btn)
}

async function runRepoInstall(repoKey, btn) {
  const textSpan = btn.querySelector('.btn-text')
  const loadSpan = btn.querySelector('.btn-loading')
  btn.disabled = true
  if (textSpan) textSpan.hidden = true
  if (loadSpan) loadSpan.hidden = false
  const resetBtn = () => {
    btn.disabled = false
    if (textSpan) textSpan.hidden = false
    if (loadSpan) loadSpan.hidden = true
  }
  try {
    const res = await fetch('/api/updates/apply', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ repo: repoKey }),
    })
    const data = await res.json().catch(() => ({}))
    if (!res.ok) {
      resetBtn()
      if (data.reason === 'dirty-tree' && repoKey !== 'upstream') {
        if (confirm(t('updates.confirm.stash'))) {
          // Retry with autoStash for fork
          await runRepoInstallWithStash(repoKey, btn)
        }
        return
      }
      if (data.reason === 'merge-conflict') {
        showToast(t('updates.toast.upstream_conflict', { msg: data.error || '' }))
        return
      }
      showToast(t('updates.toast.not_started', { msg: data.error || ('HTTP ' + res.status) }))
      return
    }
    if (repoKey === 'upstream') {
      resetBtn()
      showToast(t('updates.toast.upstream_success'))
      // Reload the updates view so the new commit counts are fresh.
      await loadUpdates()
    } else {
      // Fork update: same poll flow as runUpdate (service restarts)
      showToast(t('updates.toast.applying'))
      await pollUpdateOutcome(resetBtn)
    }
  } catch (err) {
    resetBtn()
    showToast(t('updates.toast.error', { msg: err.message || err }))
  }
}

async function runRepoInstallWithStash(repoKey, btn) {
  const textSpan = btn.querySelector('.btn-text')
  const loadSpan = btn.querySelector('.btn-loading')
  btn.disabled = true
  if (textSpan) textSpan.hidden = true
  if (loadSpan) loadSpan.hidden = false
  const resetBtn = () => {
    btn.disabled = false
    if (textSpan) textSpan.hidden = false
    if (loadSpan) loadSpan.hidden = true
  }
  try {
    const res = await fetch('/api/updates/apply', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ repo: repoKey, autoStash: true }),
    })
    const data = await res.json().catch(() => ({}))
    if (!res.ok) {
      resetBtn()
      showToast(t('updates.toast.not_started', { msg: data.error || ('HTTP ' + res.status) }))
      return
    }
    showToast(t('updates.toast.applying'))
    await pollUpdateOutcome(resetBtn)
  } catch (err) {
    resetBtn()
    showToast(t('updates.toast.error', { msg: err.message || err }))
  }
}

// ============================================================
// === First-run onboarding wizard -- see web/app-onboarding.js ===
// ============================================================
// (Moved to app-onboarding.js as part of modularisation, slice 24/N.
//  app-onboarding.js is loaded AFTER this file in index.html.
//  initOnboarding() is called from the Init block below.)
/* STUB -- content removed */
// === Init ===
populateAvatarGrid()
loadMemAgents()
// loadOverview() -- called by app-overview.js at load time (self-init, slice 16)
loadAvailableModels()
{
  const onbClose = document.getElementById('onboardingClose')
  if (onbClose) onbClose.addEventListener('click', dismissOnboarding)
}
initOnboarding()

// "DeepSeek API kulcs hozzáadása" link az agent edit panel-en --
// a Vault page-re visz, ahol a felhasználó egy DEEPSEEK_API_KEY
// secret-et tud felvenni, és visszatérve frissítjük a model listát.
document.getElementById('deepseekConfigLink')?.addEventListener('click', (e) => {
  e.preventDefault()
  location.hash = 'vault'
})

// ============================================================
// === Utility modals -- see web/app-modals.js ===
// ============================================================
// (showSudoModal, fallbackCopyToClipboard, showSlackManifestModal,
//  chSlackManifestBtn event listener -- moved to app-modals.js, slice 26.)
/* STUB -- content removed */

// ============================================================
// === Recall / Napló -- see web/app-recall.js ===
// ============================================================
// (Moved to app-recall.js as part of modularisation, card 48d891b4 / slice 8/N.
//  app-recall.js is loaded AFTER this file in index.html.
//  loadRecallPage() is only called from switchPage, never at init time.
//  esc() helper stays here -- used by all modules loaded after app.js.)
/* STUB -- content removed */

function esc(s) {
  if (!s) return ''
  const d = document.createElement('div')
  d.textContent = String(s)
  return d.innerHTML
}

// ============================================================
// === Background Tasks -- see web/app-bg-tasks.js ===
// ============================================================
// (Moved to app-bg-tasks.js as part of modularisation, card cc6f787d / slice 7/N.
//  app-bg-tasks.js is loaded AFTER this file in index.html.
//  loadBgTasksPage() is only called from switchPage, never at init time.)
/* STUB -- content removed */

// ============================================================
// ============================================================
// === Autonomy -- see web/app-autonomy.js ===
// ============================================================
// (Moved to app-autonomy.js as part of modularisation, slice 17/N.
//  app-autonomy.js is loaded AFTER this file in index.html.)
/* STUB -- content removed */

// ============================================================
// === Approvals -- see web/app-approvals.js ===
// ============================================================
// (Moved to app-approvals.js as part of modularisation, card fa28ae18 / slice 6/N.
//  app-approvals.js is loaded AFTER this file in index.html.
//  loadApprovalsPage() is only called from switchPage, never at init time.)
/* STUB -- content removed */

// ============================================================
// === Settings + Dashboard auth + Bridge pairing -- see web/app-settings-auth.js ===
// ============================================================
// (settingsDirty, SETTINGS_ACTIVE_TAB_KEY, settingsModuleLabel, settingInputValue,
//  markSettingDirty, updateSettingsSaveBar, refreshSettingsBtn listener,
//  beforeunload guard, fetchAuthStatus, renderAuthCard,
//  renderBridgeEnrollSection, bridgeEnrollFromUi -- moved to app-settings-auth.js, slice 27.)
/* STUB -- content removed */

// === Per-device keys (mint/list/revoke) + Settings load -- see web/app-device-keys.js ===
// (Moved to app-device-keys.js as part of modularisation, slice 13/N.
//  app-device-keys.js is loaded AFTER this file in index.html.
//  loadSettings() is called from switchPage via () => loadSettings() lambda.)
/* STUB -- content removed */
// === connectors.hu install banner ===
;(function () {
  const DISMISSED_KEY = 'cxhu_banner_dismissed'
  const banner = document.getElementById('cxhuBanner')
  const closeBtn = document.getElementById('cxhuBannerClose')
  if (!banner || !closeBtn) return
  if (localStorage.getItem(DISMISSED_KEY) === '1') { banner.hidden = true; return }

  // dismiss with animation
  closeBtn.addEventListener('click', () => {
    banner.style.transition = 'opacity 0.2s ease, max-height 0.3s ease'
    banner.style.overflow = 'hidden'
    banner.style.opacity = '0'
    banner.style.maxHeight = banner.offsetHeight + 'px'
    requestAnimationFrame(() => { banner.style.maxHeight = '0' })
    setTimeout(() => { banner.hidden = true }, 300)
    localStorage.setItem(DISMISSED_KEY, '1')
  })

  // --- state machine ---
  const states = ['Loading','Done','Install','Installing','Token','Configuring','Error']
  function showState(name) {
    states.forEach(s => {
      const el = document.getElementById('cxhuState' + s)
      if (el) el.hidden = (s !== name)
    })
  }

  let lastError = null

  async function checkStatus() {
    showState('Loading')
    try {
      const res = await fetch('/api/connectors-hu/status')
      if (!res.ok) throw new Error('HTTP ' + res.status)
      const data = await res.json()
      if (data.installed && data.configured) {
        showState('Done')
      } else if (data.installed) {
        showState('Token')
      } else {
        showState('Install')
      }
    } catch (e) {
      showError(e.message || t('status.error.fetch'), checkStatus)
    }
  }

  function showError(msg, retryFn) {
    document.getElementById('cxhuErrorMsg').textContent = msg
    showState('Error')
    const retryBtn = document.getElementById('cxhuRetryBtn')
    retryBtn.onclick = retryFn || checkStatus
  }

  // Telepítés gomb
  const installBtn = document.getElementById('cxhuInstallBtn')
  if (installBtn) {
    installBtn.addEventListener('click', async () => {
      showState('Installing')
      try {
        const res = await fetch('/api/connectors-hu/install', { method: 'POST' })
        const data = await res.json().catch(() => ({}))
        if (!res.ok || !data.ok) throw new Error(data.error || t('connectors.error.install'))
        showState('Token')
      } catch (e) {
        showError(e.message, () => { showState('Install') })
      }
    })
  }

  // Mentés és szinkron gomb
  const configureBtn = document.getElementById('cxhuConfigureBtn')
  if (configureBtn) {
    configureBtn.addEventListener('click', async () => {
      const token = (document.getElementById('cxhuTokenInput') || {}).value || ''
      if (!token.trim()) {
        document.getElementById('cxhuTokenInput').focus()
        return
      }
      showState('Configuring')
      try {
        const res = await fetch('/api/connectors-hu/configure', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ token: token.trim() }),
        })
        const data = await res.json().catch(() => ({}))
        if (!res.ok || !data.ok) throw new Error(data.error || t('connectors.error.configure'))
        showState('Done')
      } catch (e) {
        showError(e.message, () => { showState('Token') })
      }
    })
  }

  // Enter key a token inputban
  const tokenInput = document.getElementById('cxhuTokenInput')
  if (tokenInput) {
    tokenInput.addEventListener('keydown', e => { if (e.key === 'Enter') configureBtn && configureBtn.click() })
  }

  checkStatus()
})()

// ============================================================
// === Token Usage Monitor -- see web/app-token-usage.js ===
// ============================================================
// (Moved to app-token-usage.js as part of modularisation, card 8d7550a8 / slice 4/N.
//  app-token-usage.js is loaded AFTER this file in index.html.
//  loadTokenUsage() is only called from switchPage, never at init time.)
/* STUB -- content removed */

// (Moved to app-ideas.js as part of modularisation, card cb5cef0f / slice 5/N.
//  app-ideas.js is loaded AFTER this file in index.html.
//  loadIdeasPage() is only called from switchPage and kanban handlers, never at init time.)
/* STUB -- content removed */

// === Agent reauth login flow + Agent terminal modal -- see web/app-terminal.js ===
// (Moved to app-terminal.js as part of modularisation, slice 18/N.
//  app-terminal.js is loaded AFTER this file in index.html.)
/* STUB -- content removed */

// === Agent conversation modal -- see web/app-conversation.js ===
// (Moved to app-conversation.js as part of modularisation, card b33fc5f7.
//  app-conversation.js is loaded after this file in index.html.)

// === Federation page -- see web/app-federation.js ===
// (Moved to app-federation.js as part of modularisation, slice 12/N.
//  app-federation.js is loaded AFTER this file in index.html.
//  loadFederationPage() is only called from switchPage, never at init time.)
/* STUB -- content removed */
;(() => {
  function routeFromHash() {
    let pageId = decodeURIComponent((location.hash || '').replace(/^#/, ''))
    if (!pageId) pageId = new URLSearchParams(window.location.search).get('page') || ''
    // 'team' page is merged into 'agents' (org-chart view toggle).
    if (pageId === 'team') { pageId = 'agents'; _agentsActiveView = 'tree' }
    if (pageId && document.getElementById(pageId + 'Page')) switchPage(pageId)
  }
  window.addEventListener('hashchange', routeFromHash)
  routeFromHash()
})()

// ============================================================
// === Docs viewer + Research viewer + Mobile login -- see web/app-docs.js ===
// ============================================================
// (Moved to app-docs.js as part of modularisation, slice 14/N.
//  app-docs.js is loaded AFTER this file in index.html.)
/* STUB -- content removed */

// === Archivalt kartyak + Naplo (Audit Timeline) + Kanban Gantt -- see web/app-archive-timeline.js ===
// (Moved to app-archive-timeline.js as part of modularisation, slice 15/N.
//  app-archive-timeline.js is loaded AFTER this file in index.html.)
/* STUB -- content removed */
