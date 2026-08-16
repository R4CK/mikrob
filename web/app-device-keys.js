// === Per-device keys + Settings load -- extracted from app.js (slice 13/N) ===
// Globals from app.js used here (resolved at call time): t, esc, escapeHtml,
// showToast, closeModal. loadSettings() is called from switchPage (app.js L460)
// via a lambda () => loadSettings() to defer resolution to call time.
// app-device-keys.js is loaded AFTER app.js in index.html.

// === Per-device keys (mint/list/revoke) ===
// A device key is a revocable per-device credential (Bridge, phone). The raw
// key is displayed exactly once, right after minting.

function renderDeviceKeysSection(body) {
  const wrap = document.createElement('div')
  wrap.className = 'auth-device-keys'
  wrap.id = 'authDeviceKeys'
  wrap.innerHTML =
    `<div class="auth-sessions-title">${t('auth.devices.title')}</div>` +
    `<p class="auth-muted">${t('auth.devices.desc')}</p>` +
    `<div class="auth-form-msg err auth-device-warn" id="authDeviceKeyWarn" hidden></div>` +
    `<div id="authDeviceKeyList"></div>` +
    `<div class="auth-form auth-device-mint">` +
      `<input id="authDevName" type="text" autocapitalize="off" spellcheck="false" maxlength="64" placeholder="${t('auth.devices.name_placeholder')}">` +
      `<input id="authDevExpiry" type="number" min="1" max="3650" placeholder="${t('auth.devices.expiry_placeholder')}">` +
      `<button class="btn-secondary" id="authDevMintBtn">${t('auth.devices.mint')}</button>` +
      `<div class="auth-form-msg" id="authDevMsg"></div>` +
      `<div id="authDevMinted" hidden></div>` +
    `</div>`
  body.appendChild(wrap)
  document.getElementById('authDevMintBtn').addEventListener('click', mintDeviceKey)
  refreshDeviceKeyList()
}

async function refreshDeviceKeyList() {
  const el = document.getElementById('authDeviceKeyList')
  if (!el) return
  try {
    const r = await fetch('/api/auth/device-keys')
    if (!r.ok) { el.innerHTML = ''; return }
    const { keys } = await r.json()
    if (!keys || !keys.length) { el.innerHTML = `<p class="auth-muted">${t('auth.devices.empty')}</p>`; return }
    el.innerHTML = keys.map((k) => {
      const created = new Date(k.createdAt * 1000).toLocaleDateString()
      const lastUsed = k.lastUsedAt ? new Date(k.lastUsedAt * 1000).toLocaleString() : t('auth.devices.never_used')
      const expires = k.expiresAt ? ` &middot; ${t('auth.devices.expires', { date: new Date(k.expiresAt * 1000).toLocaleDateString() })}` : ''
      const bridge = k.installId ? ` <span class="auth-device-bridge-badge">${t('auth.devices.bridge_badge')}</span>` : ''
      return `<div class="auth-session-row auth-device-row" data-key-id="${k.id}">` +
        `<span class="auth-device-name">${escapeHtml(k.name)}${bridge}</span>` +
        `<span class="auth-device-meta">${created} &middot; ${t('auth.devices.last_used', { date: lastUsed })}${expires}</span>` +
        `<button class="btn-secondary btn-compact auth-device-revoke" data-key-id="${k.id}">${t('auth.devices.revoke')}</button>` +
      `</div>`
    }).join('')
    el.querySelectorAll('.auth-device-revoke').forEach((btn) => {
      btn.addEventListener('click', async () => {
        if (!confirm(t('auth.devices.revoke_confirm'))) return
        // A Bridge-paired revoke means BOTH halves (dashboard key + ssh line).
        // The key is dead either way, but ssh_removed:false means the
        // authorized_keys line survived (fs error) and the device can still
        // open the tunnel -- the ONE outcome the UI must never hide.
        const warnBefore = document.getElementById('authDeviceKeyWarn')
        if (warnBefore) warnBefore.hidden = true
        let sshWarn = false
        try {
          const r = await fetch(`/api/auth/device-keys/${btn.dataset.keyId}`, { method: 'DELETE' })
          const data = await r.json().catch(() => ({}))
          if (r.ok && data.ssh_removed === false) sshWarn = true
        } catch { /* ignore -- the list refresh below shows the real state */ }
        await refreshDeviceKeyList()
        const warnEl = document.getElementById('authDeviceKeyWarn')
        if (warnEl && sshWarn) {
          warnEl.hidden = false
          warnEl.textContent = t('auth.devices.revoke_ssh_warning')
        }
      })
    })
  } catch { el.innerHTML = '' }
}

async function mintDeviceKey() {
  const msg = document.getElementById('authDevMsg')
  const minted = document.getElementById('authDevMinted')
  const name = (document.getElementById('authDevName').value || '').trim()
  const expiryRaw = document.getElementById('authDevExpiry').value
  msg.className = 'auth-form-msg'
  minted.hidden = true
  if (!name) { msg.classList.add('err'); msg.textContent = t('auth.devices.err_name'); return }
  const payload = { name }
  if (expiryRaw) payload.expires_in_days = Number(expiryRaw)
  try {
    const r = await fetch('/api/auth/device-keys', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    })
    const data = await r.json().catch(() => ({}))
    if (!r.ok) { msg.classList.add('err'); msg.textContent = data.error || t('auth.card.err_generic'); return }
    document.getElementById('authDevName').value = ''
    document.getElementById('authDevExpiry').value = ''
    minted.hidden = false
    minted.innerHTML =
      `<p class="auth-muted">${t('auth.devices.minted_hint')}</p>` +
      `<div class="auth-form auth-device-minted-row">` +
        `<input id="authDevMintedKey" type="text" readonly value="${escapeHtml(data.key)}" onclick="this.select()">` +
        `<button class="btn-secondary btn-compact" id="authDevCopyBtn">${t('auth.devices.copy')}</button>` +
      `</div>`
    document.getElementById('authDevCopyBtn').addEventListener('click', async () => {
      try {
        await navigator.clipboard.writeText(data.key)
        document.getElementById('authDevCopyBtn').textContent = t('auth.devices.copied')
      } catch { document.getElementById('authDevMintedKey').select() }
    })
    refreshDeviceKeyList()
  } catch { msg.classList.add('err'); msg.textContent = t('auth.login.err_network') }
}

function renderCreateLoginForm(body) {
  body.innerHTML =
    `<p class="auth-muted">${t('auth.card.setup_desc')}</p>` +
    `<div class="auth-form">` +
      `<input id="authNewUser" type="text" autocomplete="username" autocapitalize="off" spellcheck="false" placeholder="${t('auth.login.username')}">` +
      `<input id="authNewPass" type="password" autocomplete="new-password" placeholder="${t('auth.card.new_password')}">` +
      `<input id="authNewPass2" type="password" autocomplete="new-password" placeholder="${t('auth.card.repeat_password')}">` +
      `<button class="btn-primary" id="authCreateBtn">${t('auth.card.create')}</button>` +
      `<div class="auth-form-msg" id="authCreateMsg"></div>` +
    `</div>`
  document.getElementById('authCreateBtn').addEventListener('click', async () => {
    const msg = document.getElementById('authCreateMsg')
    const username = (document.getElementById('authNewUser').value || '').trim()
    const p1 = document.getElementById('authNewPass').value || ''
    const p2 = document.getElementById('authNewPass2').value || ''
    msg.className = 'auth-form-msg'
    if (!username || !p1) { msg.classList.add('err'); msg.textContent = t('auth.login.err_empty'); return }
    if (p1 !== p2) { msg.classList.add('err'); msg.textContent = t('auth.card.err_mismatch'); return }
    try {
      const r = await fetch('/api/auth/users', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username, password: p1 }),
      })
      const data = await r.json().catch(() => ({}))
      if (r.ok) { msg.classList.add('ok'); msg.textContent = t('auth.card.created'); renderAuthCard(); initAuthBanner() }
      else { msg.classList.add('err'); msg.textContent = data.error || t('auth.card.err_generic') }
    } catch { msg.classList.add('err'); msg.textContent = t('auth.login.err_network') }
  })
}

function renderSessionPanel(body, status) {
  body.innerHTML =
    `<p class="auth-muted">${t('auth.card.signed_in_as', { user: escapeHtml(status.user) })}</p>` +
    `<div class="auth-form">` +
      `<input id="authCurPass" type="password" autocomplete="current-password" placeholder="${t('auth.card.current_password')}">` +
      `<input id="authChgPass" type="password" autocomplete="new-password" placeholder="${t('auth.card.new_password')}">` +
      `<input id="authChgPass2" type="password" autocomplete="new-password" placeholder="${t('auth.card.repeat_password')}">` +
      `<button class="btn-primary" id="authChgBtn">${t('auth.card.change_password')}</button>` +
      `<div class="auth-form-msg" id="authChgMsg"></div>` +
    `</div>` +
    `<div class="auth-sessions" id="authSessions"></div>` +
    `<div class="auth-actions">` +
      `<button class="btn-secondary btn-compact" id="authLogoutAllBtn">${t('auth.card.logout_all')}</button>` +
      `<button class="btn-secondary btn-compact" id="authLogoutBtn">${t('auth.card.logout')}</button>` +
    `</div>`
  document.getElementById('authChgBtn').addEventListener('click', async () => {
    const msg = document.getElementById('authChgMsg')
    const cur = document.getElementById('authCurPass').value || ''
    const p1 = document.getElementById('authChgPass').value || ''
    const p2 = document.getElementById('authChgPass2').value || ''
    msg.className = 'auth-form-msg'
    if (p1 !== p2) { msg.classList.add('err'); msg.textContent = t('auth.card.err_mismatch'); return }
    try {
      const r = await fetch('/api/auth/password', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ current_password: cur, new_password: p1 }),
      })
      const data = await r.json().catch(() => ({}))
      if (r.ok) { msg.classList.add('ok'); msg.textContent = t('auth.card.password_changed') }
      else { msg.classList.add('err'); msg.textContent = data.error || t('auth.card.err_generic') }
    } catch { msg.classList.add('err'); msg.textContent = t('auth.login.err_network') }
  })
  document.getElementById('authLogoutBtn').addEventListener('click', async () => {
    try { await fetch('/api/auth/logout', { method: 'POST' }) } catch { /* ignore */ }
    window.location.reload()
  })
  document.getElementById('authLogoutAllBtn').addEventListener('click', async () => {
    try { await fetch('/api/auth/logout-all', { method: 'POST' }) } catch { /* ignore */ }
    window.location.reload()
  })
  renderAuthSessions()
}

async function renderAuthSessions() {
  const el = document.getElementById('authSessions')
  if (!el) return
  try {
    const r = await fetch('/api/auth/sessions')
    if (!r.ok) { el.innerHTML = ''; return }
    const { sessions } = await r.json()
    if (!sessions || !sessions.length) { el.innerHTML = ''; return }
    el.innerHTML = `<div class="auth-sessions-title">${t('auth.card.active_sessions')}</div>` +
      sessions.map((s) => {
        const last = new Date(s.lastSeenAt * 1000).toLocaleString()
        const ua = escapeHtml(s.userAgent || '-')
        return `<div class="auth-session-row"><code>${escapeHtml(s.idHashPrefix)}</code><span>${last}</span><span class="auth-session-ua">${ua}</span></div>`
      }).join('')
  } catch { el.innerHTML = '' }
}

function renderTokenModePanel(body) {
  body.innerHTML =
    `<p class="auth-muted">${t('auth.card.token_mode')}</p>`
}

// Dismissible setup banner: shown only when the operator is authed via the token
// and has not yet created a browser login. Dismissal persists per browser.
const AUTH_BANNER_DISMISS_KEY = 'marveen.auth-banner-dismissed'

async function initAuthBanner() {
  const banner = document.getElementById('authSetupBanner')
  if (!banner) return
  let dismissed = false
  try { dismissed = localStorage.getItem(AUTH_BANNER_DISMISS_KEY) === '1' } catch { /* storage blocked */ }
  const status = await fetchAuthStatus()
  const show = !!status && status.authenticated && status.method === 'token' && status.setup_required && !dismissed
  banner.hidden = !show
}

function wireAuthBanner() {
  const banner = document.getElementById('authSetupBanner')
  if (!banner) return
  const dismiss = document.getElementById('authBannerDismiss')
  const go = document.getElementById('authBannerGoBtn')
  if (dismiss) dismiss.addEventListener('click', () => {
    try { localStorage.setItem(AUTH_BANNER_DISMISS_KEY, '1') } catch { /* storage blocked */ }
    banner.hidden = true
  })
  if (go) go.addEventListener('click', () => {
    // Land on the Security tab, where the auth card lives now.
    try { localStorage.setItem(SETTINGS_ACTIVE_TAB_KEY, 'security') } catch { /* storage blocked */ }
    if (typeof switchPage === 'function') switchPage('settings')
    const link = document.querySelector('.sb-link[data-page="settings"]')
    if (link) { document.querySelectorAll('.sb-link').forEach((l) => l.classList.remove('active')); link.classList.add('active') }
  })
}

document.addEventListener('DOMContentLoaded', () => {
  wireAuthBanner()
  initAuthBanner()
  wireBranchDriftBanner()
})

async function loadSettings() {
  const tabNav = document.getElementById('settingsTabNav')
  const tabPanels = document.getElementById('settingsTabPanels')
  if (!tabNav || !tabPanels) return

  // Park the auth card back outside the panels before wiping them: a previous
  // loadSettings run moved it INTO the Security panel, and clearing
  // tabPanels.innerHTML with the card still inside would destroy the node.
  const parkedAuthCard = document.getElementById('authCard')
  if (parkedAuthCard) {
    parkedAuthCard.hidden = true
    tabNav.parentElement.insertBefore(parkedAuthCard, tabNav)
  }

  tabNav.innerHTML = `<span style="color:var(--text-muted);font-size:13px;padding:12px 0;display:inline-block">${t('settings.loading')}</span>`
  tabPanels.innerHTML = ''
  settingsDirty.clear()
  updateSettingsSaveBar()

  renderAuthCard()

  try {
    const res = await fetch('/api/settings')
    if (!res.ok) throw new Error('fetch failed')
    const { settings } = await res.json()

    const byModule = new Map()
    for (const s of settings) {
      if (!byModule.has(s.module)) byModule.set(s.module, [])
      byModule.get(s.module).push(s)
    }

    tabNav.innerHTML = ''
    tabPanels.innerHTML = ''

    if (byModule.size === 0) {
      tabPanels.innerHTML = `<p style="padding:24px;color:var(--text-muted);font-size:13px">${t('settings.empty')}</p>`
      // No tabs to host the Security panel: fall back to showing the auth card
      // in its static spot above the (empty) tab area.
      const orphanAuthCard = document.getElementById('authCard')
      if (orphanAuthCard) orphanAuthCard.hidden = false
      return
    }

    // Registry keys declared with module:'security' render inside the synthetic
    // Security tab (below the auth card) instead of getting their own tab.
    const securityDefs = byModule.get('security') ?? []
    byModule.delete('security')

    // Fork: 'integrations' is a synthetic tab (like autonomy) rendered below.
    const allModules = [...byModule.keys(), 'security', 'autonomy', 'integrations']
    const savedTab = localStorage.getItem(SETTINGS_ACTIVE_TAB_KEY) || allModules[0]
    const activeTab = allModules.includes(savedTab) ? savedTab : allModules[0]

    // Build a tab button + panel for each settings module
    for (const [mod, defs] of byModule) {
      const btn = document.createElement('button')
      btn.className = 'tab-btn' + (mod === activeTab ? ' active' : '')
      btn.dataset.tab = mod
      btn.textContent = settingsModuleLabel(mod)
      btn.addEventListener('click', () => activateSettingsTab(mod))
      tabNav.appendChild(btn)

      const panel = document.createElement('div')
      panel.className = 'tab-panel'
      panel.id = `settings-panel-${mod}`
      panel.hidden = mod !== activeTab

      const group = document.createElement('div')
      group.className = 'settings-group'
      for (const def of defs) {
        group.appendChild(buildSettingRow(def))
      }
      panel.appendChild(group)
      tabPanels.appendChild(panel)
    }

    // Security tab (synthetic, like autonomy: exists even with zero registry
    // entries). Hosts the auth card -- browser login, password change, device
    // keys -- plus any module:'security' registry keys.
    {
      const mod = 'security'
      const btn = document.createElement('button')
      btn.className = 'tab-btn' + (mod === activeTab ? ' active' : '')
      btn.dataset.tab = mod
      btn.textContent = settingsModuleLabel(mod)
      btn.addEventListener('click', () => activateSettingsTab(mod))
      tabNav.appendChild(btn)

      const panel = document.createElement('div')
      panel.className = 'tab-panel'
      panel.id = `settings-panel-${mod}`
      panel.hidden = mod !== activeTab

      const authCard = document.getElementById('authCard')
      if (authCard) {
        panel.appendChild(authCard)
        authCard.hidden = false
      }

      if (securityDefs.length) {
        const group = document.createElement('div')
        group.className = 'settings-group'
        for (const def of securityDefs) {
          group.appendChild(buildSettingRow(def))
        }
        panel.appendChild(group)
      }
      tabPanels.appendChild(panel)
    }

    // Autonomy tab
    {
      const mod = 'autonomy'
      const btn = document.createElement('button')
      btn.className = 'tab-btn' + (mod === activeTab ? ' active' : '')
      btn.dataset.tab = mod
      btn.textContent = settingsModuleLabel(mod)
      btn.addEventListener('click', () => activateSettingsTab(mod))
      tabNav.appendChild(btn)

      const panel = document.createElement('div')
      panel.className = 'tab-panel'
      panel.id = `settings-panel-${mod}`
      panel.hidden = mod !== activeTab

      const legend = document.createElement('div')
      legend.className = 'autonomy-legend'
      legend.innerHTML = `
        <div class="autonomy-legend-item"><span class="autonomy-level-dot" style="background:var(--text-muted)"></span><span><strong>1</strong> ${t('autonomy.level.1')}</span></div>
        <div class="autonomy-legend-item"><span class="autonomy-level-dot" style="background:var(--accent)"></span><span><strong>2</strong> ${t('autonomy.level.2')}</span></div>
        <div class="autonomy-legend-item"><span class="autonomy-level-dot" style="background:var(--success)"></span><span><strong>3</strong> ${t('autonomy.level.3')}</span></div>
      `
      panel.appendChild(legend)

      const grid = document.createElement('div')
      grid.className = 'autonomy-grid'
      grid.id = 'settingsAutonomyGrid'
      panel.appendChild(grid)

      const footer = document.createElement('p')
      footer.className = 'autonomy-footer'
      footer.id = 'settingsAutonomyUpdatedAt'
      panel.appendChild(footer)

      const refreshBtn = document.createElement('button')
      refreshBtn.className = 'btn-secondary btn-compact'
      refreshBtn.textContent = t('common.btn.refresh')
      refreshBtn.addEventListener('click', () => renderAutonomyContent(grid, footer))
      panel.appendChild(refreshBtn)

      tabPanels.appendChild(panel)

      if (mod === activeTab) {
        renderAutonomyContent(grid, footer)
      }
    }

    // Integrations tab
    {
      const mod = 'integrations'
      const btn = document.createElement('button')
      btn.className = 'tab-btn' + (mod === activeTab ? ' active' : '')
      btn.dataset.tab = mod
      btn.textContent = settingsModuleLabel(mod)
      btn.addEventListener('click', () => activateSettingsTab(mod))
      tabNav.appendChild(btn)

      const panel = document.createElement('div')
      panel.className = 'tab-panel'
      panel.id = `settings-panel-${mod}`
      panel.hidden = mod !== activeTab

      const intContainer = document.createElement('div')
      intContainer.id = 'settingsIntegrationsContainer'
      panel.appendChild(intContainer)
      tabPanels.appendChild(panel)

      if (mod === activeTab) {
        renderIntegrationsContent(intContainer)
      }
    }
  } catch (err) {
    tabPanels.innerHTML = `<p style="padding:24px;color:var(--danger)">${t('settings.error')}</p>`
  }
}

function activateSettingsTab(mod) {
  document.querySelectorAll('#settingsTabNav .tab-btn').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.tab === mod)
  })
  document.querySelectorAll('#settingsTabPanels .tab-panel').forEach(panel => {
    panel.hidden = panel.id !== `settings-panel-${mod}`
  })
  localStorage.setItem(SETTINGS_ACTIVE_TAB_KEY, mod)

  if (mod === 'integrations') {
    const container = document.getElementById('settingsIntegrationsContainer')
    if (container && !container.innerHTML.trim()) renderIntegrationsContent(container)
  }
  if (mod === 'autonomy') {
    const grid = document.getElementById('settingsAutonomyGrid')
    const footer = document.getElementById('settingsAutonomyUpdatedAt')
    if (grid && !grid.innerHTML.trim()) renderAutonomyContent(grid, footer)
  }
}

function buildSettingRow(def) {
  const row = document.createElement('div')
  row.className = 'settings-row'

  const info = document.createElement('div')
  info.className = 'settings-row-info'

  const title = document.createElement('div')
  title.className = 'settings-row-key'
  title.textContent = def.key
  if (def.requiresRestart) {
    const badge = document.createElement('span')
    badge.className = 'settings-restart-badge'
    badge.textContent = t('settings.restart_badge')
    title.appendChild(badge)
  }
  info.appendChild(title)

  const desc = document.createElement('div')
  desc.className = 'settings-row-desc'
  desc.textContent = t('settings.desc.' + def.key) || def.description
  info.appendChild(desc)

  const meta = document.createElement('div')
  meta.className = 'settings-row-meta'
  const metaParts = []
  if (Array.isArray(def.valueSet) && def.valueSet.length) metaParts.push(t('settings.meta.values') + ': ' + def.valueSet.join(', '))
  if (def.type === 'int' && (def.min !== undefined || def.max !== undefined)) {
    metaParts.push(t('settings.meta.range') + ': ' + (def.min ?? '–') + '–' + (def.max ?? '–'))
  }
  if (def.type === 'color') metaParts.push(t('settings.meta.format') + ': #rrggbb')
  metaParts.push(t('settings.meta.default') + ': ' + def.default)
  meta.textContent = metaParts.join(' · ')
  info.appendChild(meta)

  row.appendChild(info)

  const editor = document.createElement('div')
  editor.className = 'settings-row-editor'

  const originalValue = String(def.value)
  let valueInput
  if (Array.isArray(def.valueSet) && def.valueSet.length) {
    valueInput = document.createElement('select')
    valueInput.className = 'input'
    for (const opt of def.valueSet) {
      const o = document.createElement('option')
      o.value = opt
      o.textContent = opt
      valueInput.appendChild(o)
    }
    valueInput.value = originalValue
  } else if (def.type === 'boolean') {
    valueInput = document.createElement('input')
    valueInput.type = 'checkbox'
    valueInput.className = 'settings-toggle'
    valueInput.checked = String(def.value) === '1'
  } else if (def.type === 'color') {
    valueInput = document.createElement('input')
    valueInput.type = 'color'
    valueInput.className = 'settings-color-input'
    valueInput.value = def.value
  } else if (def.type === 'int') {
    valueInput = document.createElement('input')
    valueInput.type = 'number'
    valueInput.className = 'input'
    if (def.min !== undefined) valueInput.min = def.min
    if (def.max !== undefined) valueInput.max = def.max
    valueInput.value = def.value
  } else {
    valueInput = document.createElement('input')
    valueInput.type = 'text'
    valueInput.className = 'input'
    valueInput.value = def.value
  }
  valueInput.dataset.settingKey = def.key
  valueInput.dataset.settingType = def.type
  valueInput.dataset.originalValue = originalValue
  editor.appendChild(valueInput)

  const errorEl = document.createElement('div')
  errorEl.className = 'settings-row-error'
  editor.appendChild(errorEl)

  valueInput.addEventListener('input', () => markSettingDirty(def.key, valueInput, originalValue, def.type, errorEl))
  valueInput.addEventListener('change', () => markSettingDirty(def.key, valueInput, originalValue, def.type, errorEl))

  row.appendChild(editor)
  return row
}

async function saveAllSettings() {
  if (settingsDirty.size === 0) return
  const btn = document.getElementById('settingsSaveAllBtn')
  if (btn) { btn.disabled = true; btn.textContent = t('settings.save_btn.saving') }

  const errors = []
  let needsRestart = false

  for (const [key, { input, type, errorEl }] of settingsDirty) {
    errorEl.textContent = ''
    const raw = type === 'int' ? Number(input.value) : settingInputValue(input, type)
    try {
      const res = await fetch('/api/settings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ key, value: raw }),
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) {
        errorEl.textContent = data.error || 'Hiba'
        errors.push(`${key}: ${data.error || 'hiba'}`)
      } else {
        input.dataset.originalValue = String(raw)
        if (data.requiresRestart) needsRestart = true
      }
    } catch {
      errorEl.textContent = 'Kapcsolati hiba'
      errors.push(`${key}: kapcsolati hiba`)
    }
  }

  // Remove successfully saved keys from dirty map
  for (const [key, { input, type }] of settingsDirty) {
    if (settingInputValue(input, type) === input.dataset.originalValue) settingsDirty.delete(key)
  }
  updateSettingsSaveBar()

  if (btn) { btn.disabled = false; btn.textContent = t('settings.btn.save') }
  if (errors.length) {
    showToast(t('settings.toast.partial_error'), 'error')
  } else {
    showToast(needsRestart ? t('settings.toast.saved_restart') : t('settings.toast.saved'))
  }
}

function resetAllSettings() {
  for (const [key, { input, originalValue }] of settingsDirty) {
    input.value = originalValue
    const errorEl = document.querySelector(`[data-setting-key="${key}"]`)?.closest('.settings-row')?.querySelector('.settings-row-error')
    if (errorEl) errorEl.textContent = ''
  }
  settingsDirty.clear()
  updateSettingsSaveBar()
}

document.getElementById('settingsSaveAllBtn')?.addEventListener('click', saveAllSettings)
document.getElementById('settingsResetBtn')?.addEventListener('click', resetAllSettings)

