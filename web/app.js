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

// === Dashboard auth bootstrap -- see web/app-auth-bootstrap.js ===
// (mainAgentId, activeSubagents, refreshSubagents moved to app-auth-bootstrap.js, slice 43.
//  Card 62631948/8ca8576: the auth IIFE below still handles ?token= URL handling and the
//  paste overlay -- only the subagent-polling and mainAgentId helper moved out.)

// === "Last updated" sidebar badge -- see web/app-last-update.js ===
// (renderLastUpdateBadge, refreshLastUpdateBadge moved to app-last-update.js, slice 42.
//  refreshLastUpdateBadge() init call also moved there -- runs after app.js completes,
//  satisfying the card f597369b requirement of running after the auth IIFE patches fetch.)
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

// refreshLastUpdateBadge() init call moved to end of app-last-update.js (slice 42).

// === Theme + Language toggle -- see web/app-theme-lang.js ===


// ============================================================
// === Page switching + Mobile sidebar -- see web/app-page-switch.js ===
// ============================================================
// (Moved to app-page-switch.js as part of modularisation, slice 39.
//  app-page-switch.js is loaded right after app-elements.js in index.html.)
/* STUB -- content removed */
// === Collapsible sidebar groups -- see web/app-sidebar-groups.js ===
// (Moved to app-sidebar-groups.js as part of modularisation, slice 37.)
/* STUB -- content removed */
// === i18n nav + static element rendering -- see web/app-i18n-nav.js ===
// ============================================================
// (Moved to app-i18n-nav.js as part of modularisation, slice 36.
//  app-i18n-nav.js is loaded AFTER this file in index.html.
//  renderNav/renderStaticI18n called from setLang (typeof-guarded) + DOMContentLoaded.)
/* STUB -- content removed */

// ============================================================
// === Activity (live agent status) + Kanban auto-refresh -- see web/app-activity.js ===
// ============================================================
// (Moved to app-activity.js as part of modularisation, slice 35.
//  app-activity.js is loaded AFTER this file in index.html.
//  startActivityPoll/stopActivityPoll called from switchPage; no init-time calls here.)
/* STUB -- content removed */

// ============================================================
// ============================================================
// === Kanban + Drag&Drop + Card modals -- see web/app-kanban.js ===
// ============================================================
// (Kanban board, Drag & Drop, Touch DnD, New card modal, Card labels,
//  Card detail, Breakdown modal -- all moved to app-kanban.js, slice 30.
//  loadKanban() is called from switchPage and startKanbanRefresh() in app.js.
//  app-kanban.js is loaded AFTER this file in index.html.)
/* STUB -- content removed */

// ============================================================
// === Elements + Modal helpers + Avatar Gallery -- see web/app-elements.js ===
// ============================================================
// (Moved to app-elements.js as part of modularisation, slice 38.
//  app-elements.js is loaded right after app.js, before other modules.)
/* STUB -- content removed */
// === Wizard logic -- see web/app-wizard.js ===
// ============================================================
// (loadProfiles, populateProfileSelect, populatePlanSelect, renderWizardPendingBanner,
//  resetWizard, updateWizardUI, create-agent submit handler
//  -- all moved to app-wizard.js, slice 34.)
/* STUB -- content removed */
// === Toast -- see web/app-helpers.js ===

// ============================================================
// === Agents API + HUD + Federated -- see web/app-agents.js ===
// ============================================================
// (loadAgents, renderAgents, openMarveenDetail, applyMarveenReadonlyMode,
//  startAgentsBusyPoll, stopAgentsBusyPoll, refreshAgentHud,
//  federatedAgentEntries, renderFederatedAgentCards, openFederatedThread
//  -- all moved to app-agents.js, slice 31.
//  loadAgents(), startAgentsBusyPoll(), stopAgentsBusyPoll() called from switchPage.)
/* STUB -- content removed */
// ============================================================
// === Agent Detail + Avatar + Process + Tabs -- see web/app-agent-detail.js ===
// ============================================================
// (openAgentDetail, populateDetailAvatarGrid, avatar upload IIFEs,
//  updateProcessControl, switchAgentTab -- all moved to app-agent-detail.js, slice 32.
//  openAgentDetail() called from renderAgents in app-agents.js.
//  switchAgentTab() called from wizard logic here and from app-agents.js.
//  updateProcessControl() called from Settings save buttons below.)
/* STUB -- content removed */
// ============================================================
// === Settings save buttons + Model management -- see web/app-settings.js ===
// ============================================================
// (loadAvailableModels, loadOllamaModels, OpenRouter modal, model/claude.md/soul.md save buttons
//  -- all moved to app-settings.js, slice 33.
//  loadAvailableModels() init call moved to end of app-settings.js.)
/* STUB -- content removed */
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

// === SVG icons -- see web/app-helpers.js ===

// ============================================================
// === Connectors -- see web/app-connectors.js ===
// ============================================================
// (Connectors page: loadConnectors, loadCatalog, openConnector, etc.
//  All moved to app-connectors.js, slice 29.
//  loadConnectors() is called from switchPage in app.js.
//  app-connectors.js is loaded AFTER this file in index.html.)
/* STUB -- content removed */
// === Helpers + Status labels -- see web/app-helpers.js ===

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
//  app-onboarding.js is loaded AFTER this file in index.html, so its own
//  self-init at the end of that file calls initOnboarding() + wires
//  onboardingClose -- NOT here, or it would ReferenceError (fix for the
//  live regression Cybered/Cybersec caught, card 243de9b9).)
/* STUB -- content removed */
// === Init ===
// populateAvatarGrid() -- moved to end of app-elements.js (slice 38 init-time fix:
//   app-elements.js loads AFTER app.js, so the function is not yet defined here).
loadMemAgents()
// loadOverview() -- called by app-overview.js at load time (self-init, slice 16)
// loadAvailableModels() -- moved to end of app-settings.js (slice 33 init replacement)
// initOnboarding() + onboardingClose wiring -- moved to app-onboarding.js self-init (card 243de9b9)

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
  // Initial dispatch must wait until every later <script src="/app-*.js"> tag has
  // executed -- switchPage() calls functions (stopAgentsBusyPoll, loadOverview,
  // loadKanban, loadDocs, ...) that live in those files, which load AFTER this
  // script. Calling routeFromHash() synchronously here ReferenceErrors on any
  // direct-hash page load. DOMContentLoaded fires only once all synchronous
  // scripts in the document have run, so it's the earliest safe point (live
  // regression: stopAgentsBusyPoll not defined at switchPage, 2026-08-16).
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', routeFromHash)
  } else {
    routeFromHash()
  }
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
