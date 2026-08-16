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
// ============================================================
// === Kanban + Drag&Drop + Card modals -- see web/app-kanban.js ===
// ============================================================
// (Kanban board, Drag & Drop, Touch DnD, New card modal, Card labels,
//  Card detail, Breakdown modal -- all moved to app-kanban.js, slice 30.
//  loadKanban() is called from switchPage and startKanbanRefresh() in app.js.
//  app-kanban.js is loaded AFTER this file in index.html.)
/* STUB -- content removed */
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
// === Connectors -- see web/app-connectors.js ===
// ============================================================
// (Connectors page: loadConnectors, loadCatalog, openConnector, etc.
//  All moved to app-connectors.js, slice 29.
//  loadConnectors() is called from switchPage in app.js.
//  app-connectors.js is loaded AFTER this file in index.html.)
/* STUB -- content removed */
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
// ============================================================
// === connectors.hu install banner -- see web/app-connectors-banner.js ===
// ============================================================
// (Self-contained IIFE moved to app-connectors-banner.js, slice 28.)
/* STUB -- content removed */

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
