// === Avatar cache-busting epoch -- see web/app-elements.js ===
// (_avatarEpoch, bumpAvatarEpoch, avatarBust moved to end of app-elements.js, slice 44.)

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
;(() => {
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
//
// Upstream batch 8 (94765127) and batch 21 (24ba58622) both re-introduce the full,
// un-modularised kanban section inline here (thousands of lines) -- not adopted structurally:
// this fork's app-kanban.js module split (slice 30) stands. Any genuinely NEW upstream
// kanban-UI behaviour from that block is a separate, frontend-owned review (not attempted
// line-by-line in this backend merge card) -- flagged to MikroB/Fron Ted rather than guessed at.
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

// A value passed as a string argument of an inline handler
// (onclick="fn(${jsArg(id)})"). escapeHtml alone is NOT enough there: the
// HTML parser decodes &#39; back to ' before the handler's JavaScript is
// parsed, so a quote in the value would end the JS string. JSON.stringify
// makes it a JS string literal; escapeHtml then keeps it inside the attribute.
function jsArg(v) {
  return escapeHtml(JSON.stringify(String(v ?? '')))
}

// A shortened text for HTML: cut the RAW text, then escape it, and add the
// ellipsis by the raw length. Escaping first and slicing after could split an
// entity (&quot; -> &q) and would count entity bytes as visible characters.
function escSnippet(raw, max) {
  const s = String(raw ?? '')
  return escapeHtml(s.slice(0, max)) + (s.length > max ? '…' : '')
}

// The one gate for a URL from data (a catalogue file, the API, CLI output, a
// markdown doc) before it becomes an href. escapeHtml stops an attribute
// breakout but not the scheme: only http(s) and mailto pass, or -- with
// { relative: true } -- a scheme-less relative or fragment link. The URL
// parser drops control characters and spaces, and a leading // or /\ means
// another host, so the check judges the URL the same way. Returns the URL
// unchanged when it passes, '' otherwise. HTML-encode the result in markup.
function safeHref(raw, { relative = false } = {}) {
  const s = String(raw ?? '')
  const u = s.replace(/[\x00-\x20\x7f]/g, '')
  if (!u) return ''
  const scheme = /^[a-z][a-z0-9+.-]*:/i.exec(u)
  if (scheme) return /^(https?|mailto):$/i.test(scheme[0]) ? s : ''
  return relative && !/^[\\/][\\/]/.test(u) ? s : ''
}

// The dashboard's mirror of src/css-color.ts normalizeCssColor -- the same
// colour table, regexes and arithmetic; both are checked against the same
// vectors (src/__tests__/fixtures/css-color-vectors.json) and the table is
// compared entry by entry, so the server and the page apply ONE policy:
// hex kept, a CSS colour name or a strictly numeric rgb()/rgba()/hsl()/hsla()
// becomes hex, anything else (url(), declarations, words, bad hex) is null.
const CSS_NAMED_COLORS = {
  aliceblue: '#f0f8ff', antiquewhite: '#faebd7', aqua: '#00ffff', aquamarine: '#7fffd4', azure: '#f0ffff',
  beige: '#f5f5dc', bisque: '#ffe4c4', black: '#000000', blanchedalmond: '#ffebcd', blue: '#0000ff',
  blueviolet: '#8a2be2', brown: '#a52a2a', burlywood: '#deb887', cadetblue: '#5f9ea0', chartreuse: '#7fff00',
  chocolate: '#d2691e', coral: '#ff7f50', cornflowerblue: '#6495ed', cornsilk: '#fff8dc', crimson: '#dc143c',
  cyan: '#00ffff', darkblue: '#00008b', darkcyan: '#008b8b', darkgoldenrod: '#b8860b', darkgray: '#a9a9a9',
  darkgreen: '#006400', darkgrey: '#a9a9a9', darkkhaki: '#bdb76b', darkmagenta: '#8b008b', darkolivegreen: '#556b2f',
  darkorange: '#ff8c00', darkorchid: '#9932cc', darkred: '#8b0000', darksalmon: '#e9967a', darkseagreen: '#8fbc8f',
  darkslateblue: '#483d8b', darkslategray: '#2f4f4f', darkslategrey: '#2f4f4f', darkturquoise: '#00ced1', darkviolet: '#9400d3',
  deeppink: '#ff1493', deepskyblue: '#00bfff', dimgray: '#696969', dimgrey: '#696969', dodgerblue: '#1e90ff',
  firebrick: '#b22222', floralwhite: '#fffaf0', forestgreen: '#228b22', fuchsia: '#ff00ff', gainsboro: '#dcdcdc',
  ghostwhite: '#f8f8ff', gold: '#ffd700', goldenrod: '#daa520', gray: '#808080', green: '#008000',
  greenyellow: '#adff2f', grey: '#808080', honeydew: '#f0fff0', hotpink: '#ff69b4', indianred: '#cd5c5c',
  indigo: '#4b0082', ivory: '#fffff0', khaki: '#f0e68c', lavender: '#e6e6fa', lavenderblush: '#fff0f5',
  lawngreen: '#7cfc00', lemonchiffon: '#fffacd', lightblue: '#add8e6', lightcoral: '#f08080', lightcyan: '#e0ffff',
  lightgoldenrodyellow: '#fafad2', lightgray: '#d3d3d3', lightgreen: '#90ee90', lightgrey: '#d3d3d3', lightpink: '#ffb6c1',
  lightsalmon: '#ffa07a', lightseagreen: '#20b2aa', lightskyblue: '#87cefa', lightslategray: '#778899', lightslategrey: '#778899',
  lightsteelblue: '#b0c4de', lightyellow: '#ffffe0', lime: '#00ff00', limegreen: '#32cd32', linen: '#faf0e6',
  magenta: '#ff00ff', maroon: '#800000', mediumaquamarine: '#66cdaa', mediumblue: '#0000cd', mediumorchid: '#ba55d3',
  mediumpurple: '#9370db', mediumseagreen: '#3cb371', mediumslateblue: '#7b68ee', mediumspringgreen: '#00fa9a', mediumturquoise: '#48d1cc',
  mediumvioletred: '#c71585', midnightblue: '#191970', mintcream: '#f5fffa', mistyrose: '#ffe4e1', moccasin: '#ffe4b5',
  navajowhite: '#ffdead', navy: '#000080', oldlace: '#fdf5e6', olive: '#808000', olivedrab: '#6b8e23',
  orange: '#ffa500', orangered: '#ff4500', orchid: '#da70d6', palegoldenrod: '#eee8aa', palegreen: '#98fb98',
  paleturquoise: '#afeeee', palevioletred: '#db7093', papayawhip: '#ffefd5', peachpuff: '#ffdab9', peru: '#cd853f',
  pink: '#ffc0cb', plum: '#dda0dd', powderblue: '#b0e0e6', purple: '#800080', rebeccapurple: '#663399',
  red: '#ff0000', rosybrown: '#bc8f8f', royalblue: '#4169e1', saddlebrown: '#8b4513', salmon: '#fa8072',
  sandybrown: '#f4a460', seagreen: '#2e8b57', seashell: '#fff5ee', sienna: '#a0522d', silver: '#c0c0c0',
  skyblue: '#87ceeb', slateblue: '#6a5acd', slategray: '#708090', slategrey: '#708090', snow: '#fffafa',
  springgreen: '#00ff7f', steelblue: '#4682b4', tan: '#d2b48c', teal: '#008080', thistle: '#d8bfd8',
  tomato: '#ff6347', turquoise: '#40e0d0', violet: '#ee82ee', wheat: '#f5deb3', white: '#ffffff',
  whitesmoke: '#f5f5f5', yellow: '#ffff00', yellowgreen: '#9acd32', transparent: '#00000000',
}

const CSS_HEX_COLOR = /^#(?:[0-9a-f]{3}|[0-9a-f]{4}|[0-9a-f]{6}|[0-9a-f]{8})$/i
// CSS <number>: optional sign, digits with an optional fraction or a leading
// dot, optional exponent (1e2, -1, .5, +3.25E-1); nothing else
const CSS_NUMBER = /^[+-]?(?:\d*\.\d+|\d+)(?:e[+-]?\d+)?$/i
const CSS_HUE_UNIT = { deg: 1, grad: 0.9, rad: 180 / Math.PI, turn: 360 }

const CSS_HUE_UNITS = ['grad', 'turn', 'deg', 'rad']
// Input budget, as on the server: a resource bound
// well above any real spelling (a full-precision JS number serialization is
// ~85 characters); a longer value is not a colour, decided before parsing.
const MAX_CSS_COLOR_LENGTH = 256

function isCssWs(ch) {
  return ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r' || ch === '\f'
}

// Trim and split are plain character scans, one pass each, no regex (the
// regex trim was quadratic on a long internal whitespace run)
function cssTrim(s) {
  let i = 0
  let j = s.length
  while (i < j && isCssWs(s[i])) i++
  while (j > i && isCssWs(s[j - 1])) j--
  return s.slice(i, j)
}

// the tokens of a TRIMMED string separated by runs of CSS whitespace
function cssSplitWs(s) {
  const out = []
  let i = 0
  while (i < s.length) {
    let j = i
    while (j < s.length && !isCssWs(s[j])) j++
    out.push(s.slice(i, j))
    while (j < s.length && isCssWs(s[j])) j++
    i = j
  }
  return out
}

function cssHex2(n) {
  // + 1e-7: a half-way channel that float arithmetic left at 127.4999999
  // rounds up like the browser's 127.5 does
  return Math.round(Math.min(255, Math.max(0, n)) + 1e-7).toString(16).padStart(2, '0')
}

function cssToHex(r, g, b, a) {
  const rgb = `#${cssHex2(r)}${cssHex2(g)}${cssHex2(b)}`
  return a >= 1 ? rgb : rgb + cssHex2(Math.max(0, a) * 255)
}

// a token: a number (pct=false) or a percentage (pct=true), else null
function cssNum(token) {
  const pct = token.endsWith('%')
  const t = pct ? token.slice(0, -1) : token
  if (!CSS_NUMBER.test(t)) return null
  const n = Number(t)
  return Number.isNaN(n) ? null : { n, pct }
}

// alpha: a number or a percentage, clamped to 0..1
function cssAlpha(token) {
  const v = cssNum(token)
  if (!v) return null
  const a = v.pct ? v.n / 100 : v.n
  return Math.min(1, Math.max(0, a))
}

// hue: a number (degrees) or a number with deg / grad / rad / turn
// (the unit is matched ASCII case-insensitively; 'grad' is tried before 'rad')
function cssHue(token) {
  const unit = CSS_HUE_UNITS.find((u) => token.slice(-u.length).replace(/[A-Z]/g, (c) => c.toLowerCase()) === u)
  const v = cssNum(unit ? token.slice(0, -unit.length) : token)
  if (!v || v.pct) return null
  const deg = v.n * (unit ? CSS_HUE_UNIT[unit] : 1)
  return Number.isFinite(deg) ? ((deg % 360) + 360) % 360 : null
}

function cssHslToRgb(hue, s, l) {
  const h = hue / 360
  const sat = Math.min(1, Math.max(0, s / 100))
  const lig = Math.min(1, Math.max(0, l / 100))
  if (sat === 0) return [lig * 255, lig * 255, lig * 255]
  const q = lig < 0.5 ? lig * (1 + sat) : lig + sat - lig * sat
  const p = 2 * lig - q
  const ch = (t) => {
    if (t < 0) t += 1
    if (t > 1) t -= 1
    if (t < 1 / 6) return p + (q - p) * 6 * t
    if (t < 1 / 2) return q
    if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6
    return p
  }
  return [ch(h + 1 / 3) * 255, ch(h) * 255, ch(h - 1 / 3) * 255]
}

// rgb()/rgba()/hsl()/hsla() with numeric arguments (CSS Color 4):
// - legacy comma syntax: 3 values (+ alpha); rgb channels all numbers or all
//   percentages; hsl saturation / lightness must be percentages
// - modern space syntax: 3 values (+ "/ alpha"); rgb channels may mix numbers
//   and percentages; hsl saturation / lightness numbers or percentages
// Numbers may carry a sign, a leading dot or an exponent; channels clamp to
// 0..255, alpha to 0..1, saturation / lightness to 0..100. No nested
// function, keyword (none, calc, var) or anything else is accepted.
function cssColorFunction(c) {
  const m = /^(rgba?|hsla?)\(([^()]*)\)$/i.exec(c)
  if (!m) return null
  const fn = m[1].toLowerCase()
  const body = cssTrim(m[2])
  let parts
  let alphaToken
  const legacy = body.includes(',')
  if (legacy) {
    parts = body.split(',').map(cssTrim)
    if (parts.length === 4) alphaToken = parts.pop()
  } else {
    const slash = body.split('/')
    if (slash.length > 2) return null
    if (slash.length === 2) alphaToken = cssTrim(slash[1])
    parts = cssSplitWs(cssTrim(slash[0]))
  }
  if (parts.length !== 3) return null
  const a = alphaToken === undefined ? 1 : cssAlpha(alphaToken)
  if (a === null) return null
  if (fn.startsWith('rgb')) {
    const ch = parts.map(cssNum)
    if (ch.some((v) => v === null)) return null
    if (legacy && !(ch.every((v) => v.pct) || ch.every((v) => !v.pct))) return null
    const [r, g, b] = ch.map((v) => (v.pct ? (v.n * 255) / 100 : v.n))
    return cssToHex(r, g, b, a)
  }
  const hue = cssHue(parts[0])
  const s = cssNum(parts[1])
  const l = cssNum(parts[2])
  if (hue === null || !s || !l) return null
  if (legacy && !(s.pct && l.pct)) return null
  const [r, g, b] = cssHslToRgb(hue, s.n, l.n)
  return cssToHex(r, g, b, a)
}

function normalizeCssColor(value) {
  if (typeof value !== 'string' || value.length > MAX_CSS_COLOR_LENGTH) return null
  const c = cssTrim(value)
  if (CSS_HEX_COLOR.test(c)) return c
  const named = /^[a-z]+$/i.test(c) && Object.prototype.hasOwnProperty.call(CSS_NAMED_COLORS, c.toLowerCase()) ? CSS_NAMED_COLORS[c.toLowerCase()] : undefined
  if (named) return named
  return cssColorFunction(c)
}

// A colour from data (settings files, label records) before it lands in a
// style: escapeHtml keeps it inside the attribute, but a ';' or url(...) would
// still add CSS declarations or fetch a resource. A colour normalizeCssColor
// accepts comes back as hex; a var(--token) passes as is; anything else
// becomes the fallback.
function safeCssColor(v, fallback = '') {
  const n = normalizeCssColor(v)
  if (n) return n
  const c = String(v ?? '').trim()
  return /^var\(--[a-z0-9-]+\)$/i.test(c) ? c : fallback
}

// t() for a translation that is itself HTML (the *_html keys, data-i18n-html):
// the template is trusted markup, but every substituted value -- the brand
// tokens, which come from .env BRAND_NAME / BOT_NAME, and the caller's params
// -- is text, so each one is HTML-escaped. Plain t() stays raw for its
// textContent / confirm / toast callers.
function tHtml(key, params = {}) {
  const enc = {}
  for (const [k, v] of Object.entries({ ...window._brandTokens, ...params })) enc[k] = v == null ? v : escapeHtml(String(v))
  return t(key, enc)
}

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
//  renderDiagnoseOffer, renderCliUpdateOffer, applyCliUpdate, runDiagnose,
//  runUpdate, pollUpdateOutcome, wireBranchDriftBanner, pollUpdatesBadge,
//  updatesCheckBtn/ApplyBtn listeners -- all moved to app-updates.js as part
//  of modularisation slice 25.)
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
      summary.innerHTML = `<strong>${tHtml('updates.up_to_date_html')}</strong>. ${t('updates.no_changes')}`
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
  renderCliUpdateOffer()
  // Upstream batch 8 (94765127) defines renderCliUpdateOffer/applyCliUpdate inline here -- not
  // adopted, same modularisation-slice deviation as the kanban block above: both functions
  // already live in app-updates.js (slice 25), loaded after this file.
}

// Card 55885cb1: both repo blocks (the fork's own origin, and the "how far behind upstream are
// we" status block) now trigger the IDENTICAL backend action -- a plain update.sh pull+rebuild+
// restart against this fork's own origin, never a raw merge of the upstream remote (see
// src/web/routes/updates.ts). There is no longer a repo-specific confirm/outcome branch: every
// click gets the same confirm text, the same restart-polling flow, and the same dirty-tree
// stash-retry offer. 'upstream'/'marveen'-specific i18n keys and the merge-conflict toast are
// retired along with the backend branch that could ever produce that outcome.
async function handleRepoInstallClick(btn) {
  const repoKey = btn.dataset.repo
  if (!confirm(t('updates.confirm.install_repo'))) return
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
      if (data.reason === 'dirty-tree') {
        if (confirm(t('updates.confirm.stash'))) {
          await runRepoInstallWithStash(repoKey, btn)
        }
        return
      }
      showToast(t('updates.toast.not_started', { msg: data.error || ('HTTP ' + res.status) }))
      return
    }
    // Same poll flow as runUpdate: update.sh rebuilds and restarts services.
    showToast(t('updates.toast.applying'))
    await pollUpdateOutcome(resetBtn)
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
//  loadRecallPage() is only called from switchPage, never at init time.)
/* STUB -- content removed */

// === esc() helper -- see web/app-helpers.js ===
// (Moved to app-helpers.js, slice 44. app-helpers.js loads before app-recall.js and app-bg-tasks.js.)

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
// === Hash-based page router -- see web/app-router.js ===
// (routeFromHash IIFE moved to app-router.js, slice 45.
//  app-router.js is loaded LAST in index.html so DOMContentLoaded fires after
//  all modules that switchPage() calls -- stopAgentsBusyPoll, loadOverview, etc.)

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
