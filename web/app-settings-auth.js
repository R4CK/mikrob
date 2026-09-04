// app-settings-auth.js -- Settings registry helpers + Dashboard auth + Bridge pairing
// (app.js modularisation slice 27).
// Globals from app.js: t, escapeHtml, loadSettings, showToast
// Globals from here used by app-device-keys.js: settingsDirty, SETTINGS_ACTIVE_TAB_KEY,
//   settingsModuleLabel, settingInputValue, markSettingDirty, updateSettingsSaveBar,
//   refreshDeviceKeyList, renderDeviceKeysSection

// ============================================================
// === Settings (central config registry) ===
// ============================================================

// Human label for a registry "module" -- falls back to a capitalised key for
// any future module the UI doesn't know about yet, so adding a registry
// entry never requires a frontend change just to render a sane heading.
function settingsModuleLabel(mod) {
  const key = `settings.module.${mod}`
  const known = { kanban: true, system: true, heartbeat: true, audit: true, ideabox: true, channels: true, integrations: true, security: true, autonomy: true }
  return known[mod] ? t(key) : (mod.charAt(0).toUpperCase() + mod.slice(1))
}

// Track dirty state: key -> { input, originalValue, type, errorEl }
const settingsDirty = new Map()

function updateSettingsSaveBar() {
  const bar = document.getElementById('settingsSaveBar')
  const countEl = document.getElementById('settingsDirtyCount')
  if (!bar) return
  const n = settingsDirty.size
  bar.style.display = n > 0 ? 'flex' : 'none'
  if (countEl) countEl.textContent = t('settings.dirty_count', {n})
}

// Read the current editor value in the canonical form the API expects. A
// boolean setting renders as a checkbox, so its value is derived from .checked
// as the canonical "1"/"0" string (not the element's .value, which is "on").
function settingInputValue(input, type) {
  if (type === 'boolean') return input.checked ? '1' : '0'
  return input.value
}

function markSettingDirty(key, input, originalValue, type, errorEl) {
  const currentVal = settingInputValue(input, type)
  if (currentVal === String(originalValue)) {
    settingsDirty.delete(key)
  } else {
    settingsDirty.set(key, { input, originalValue, type, errorEl })
  }
  updateSettingsSaveBar()
}

const SETTINGS_ACTIVE_TAB_KEY = 'settings-active-tab'

// Top-level wiring (equivalent to the old inline registrations in app.js).
document.getElementById('refreshSettingsBtn').addEventListener('click', () => loadSettings())
window.addEventListener('beforeunload', (e) => {
  if (settingsDirty.size > 0) { e.preventDefault(); e.returnValue = '' }
})

// ============================================================
// === Dashboard browser login (optional) ===
// ============================================================
// The card in the Settings page lets the operator opt into a username+password
// login (in addition to the always-available access token). All copy is framed
// around the existing public remote-access surfaces (Tailscale Serve, LAN,
// mobile QR) -- no other transport is referenced.

async function fetchAuthStatus() {
  try {
    const r = await fetch('/api/auth/status')
    return r.ok ? await r.json() : null
  } catch {
    return null
  }
}

async function renderAuthCard() {
  const body = document.getElementById('authCardBody')
  if (!body) return
  const status = await fetchAuthStatus()
  if (!status) { body.innerHTML = `<p class="auth-muted">${t('auth.card.unavailable')}</p>`; return }
  if (status.setup_required) { renderCreateLoginForm(body) }
  else if (status.method === 'session') { renderSessionPanel(body, status) }
  else renderTokenModePanel(body)
  // Device keys are managed by token/session operators only (a device key
  // itself gets 403 from the management endpoints, so don't render the panel).
  if (status.method === 'token' || status.method === 'session') {
    renderDeviceKeysSection(body)
    renderBridgeEnrollSection(body)
    void renderNamePatternsSection(body)
  }
}

// ============================================================
// === Bridge pairing (AUTHPLAN1 #2) ===
// ============================================================
// Paste the public-key line shown by the Bridge app -> one confirm -> the
// server writes the restricted SSH entry + mints a per-device key -> the
// returned bundle (shown once, copyable) goes back into the Bridge.

function renderBridgeEnrollSection(body) {
  const wrap = document.createElement('div')
  wrap.className = 'auth-device-keys auth-bridge-enroll'
  wrap.id = 'authBridgeEnroll'
  wrap.innerHTML =
    `<div class="auth-sessions-title">${t('auth.bridge.title')}</div>` +
    `<p class="auth-muted">${t('auth.bridge.desc')}</p>` +
    `<div class="auth-form">` +
      `<input id="authBridgeKeyLine" type="text" autocapitalize="off" spellcheck="false" placeholder="${t('auth.bridge.key_placeholder')}">` +
      `<input id="authBridgeName" type="text" autocapitalize="off" spellcheck="false" maxlength="64" placeholder="${t('auth.bridge.name_placeholder')}">` +
      `<input id="authBridgeHost" type="text" autocapitalize="off" spellcheck="false" maxlength="253" placeholder="${t('auth.bridge.host_placeholder')}">` +
      // The placeholder alone cannot carry this: it is clipped by the input's
      // width, and it disappears the moment the user types. The Tailscale trap
      // (account email vs 100.x address) has to stay readable while they type.
      `<p class="auth-muted">${t('auth.bridge.host_hint')}</p>` +
      `<button class="btn-secondary" id="authBridgeEnrollBtn">${t('auth.bridge.enroll')}</button>` +
      `<div class="auth-form-msg" id="authBridgeMsg"></div>` +
      `<div id="authBridgeBundle" hidden></div>` +
    `</div>`
  body.appendChild(wrap)
  document.getElementById('authBridgeEnrollBtn').addEventListener('click', bridgeEnrollFromUi)
}

async function bridgeEnrollFromUi() {
  const msg = document.getElementById('authBridgeMsg')
  const out = document.getElementById('authBridgeBundle')
  const keyLine = (document.getElementById('authBridgeKeyLine').value || '').trim()
  const name = (document.getElementById('authBridgeName').value || '').trim()
  const hostOverride = (document.getElementById('authBridgeHost').value || '').trim()
  msg.className = 'auth-form-msg'
  msg.textContent = ''
  out.hidden = true
  if (!keyLine || !name) { msg.classList.add('err'); msg.textContent = t('auth.bridge.err_empty'); return }
  // The confirm step: pairing grants the device SSH-tunnel + dashboard access.
  if (!confirm(t('auth.bridge.confirm', { name }))) return
  msg.textContent = t('auth.bridge.working')
  try {
    const r = await fetch('/api/security/bridge-enroll', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(hostOverride ? { key_line: keyLine, name, host: hostOverride } : { key_line: keyLine, name }),
    })
    const data = await r.json().catch(() => ({}))
    if (!r.ok) { msg.classList.add('err'); msg.textContent = data.error || t('auth.card.err_generic'); return }
    msg.classList.add('ok')
    msg.textContent = (data.action === 'replaced' ? t('auth.bridge.repaired') : t('auth.bridge.paired')) +
      (data.warnings && data.warnings.length ? ` (${data.warnings.join('; ')})` : '')
    document.getElementById('authBridgeKeyLine').value = ''
    document.getElementById('authBridgeName').value = ''
    document.getElementById('authBridgeHost').value = ''
    out.hidden = false
    out.innerHTML =
      `<p class="auth-muted">${t('auth.bridge.bundle_hint', { host: escapeHtml(data.host || '') })}</p>` +
      `<div class="auth-form auth-device-minted-row">` +
        `<input id="authBridgeBundleVal" type="text" readonly value="${escapeHtml(data.bundle)}" onclick="this.select()">` +
        `<button class="btn-secondary btn-compact" id="authBridgeCopyBtn">${t('auth.devices.copy')}</button>` +
      `</div>`
    document.getElementById('authBridgeCopyBtn').addEventListener('click', async () => {
      try {
        await navigator.clipboard.writeText(data.bundle)
        document.getElementById('authBridgeCopyBtn').textContent = t('auth.devices.copied')
      } catch { document.getElementById('authBridgeBundleVal').select() }
    })
    refreshDeviceKeyList()
  } catch { msg.classList.add('err'); msg.textContent = t('auth.login.err_network') }
}

// ============================================================
// === Outgoing filter: name/phrase rules (card 98dbbcc9) ===
// ============================================================
// CRUD over store/outgoing-copy-gate-rules.json's bad_name_patterns, which the
// outgoing-copy gate compiles as ONE Python regex on every tool call. The server
// validates with Python before writing (Node's RegExp disagrees with Python in both
// directions), so this panel's job is to render the verdict, not to second-guess it.
//
// Every pattern is rendered through escapeHtml: these strings are operator input and
// land in innerHTML, so an unescaped one would be self-inflicted XSS on the very page
// that manages a security control.

async function renderNamePatternsSection(body) {
  const wrap = document.createElement('div')
  wrap.className = 'auth-device-keys auth-name-patterns'
  wrap.id = 'authNamePatterns'
  wrap.innerHTML =
    `<div class="auth-sessions-title">${t('names.title')}</div>` +
    `<p class="auth-muted">${t('names.desc')}</p>` +
    `<div id="namePatternsState" class="auth-muted"></div>` +
    `<div id="namePatternsList"></div>` +
    `<div class="auth-form">` +
      `<input id="namePatternValue" type="text" autocapitalize="off" spellcheck="false" maxlength="200" placeholder="${t('names.placeholder')}">` +
      `<select id="namePatternMode">` +
        `<option value="literal">${t('names.mode.literal')}</option>` +
        `<option value="regex">${t('names.mode.regex')}</option>` +
      `</select>` +
      `<button class="btn-secondary" id="namePatternAddBtn">${t('names.add')}</button>` +
      `<p class="auth-muted">${t('names.mode_hint')}</p>` +
      `<div class="auth-form-msg" id="namePatternMsg"></div>` +
    `</div>`
  body.appendChild(wrap)
  document.getElementById('namePatternAddBtn').addEventListener('click', addNamePatternFromUi)
  document.getElementById('namePatternValue').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') addNamePatternFromUi()
  })
  await loadNamePatterns()
}

async function loadNamePatterns() {
  const listEl = document.getElementById('namePatternsList')
  const stateEl = document.getElementById('namePatternsState')
  if (!listEl || !stateEl) return
  let data
  try {
    const r = await fetch('/api/security/name-patterns')
    if (!r.ok) throw new Error('http')
    data = await r.json()
  } catch {
    stateEl.className = 'auth-form-msg err'
    stateEl.textContent = t('names.err_generic')
    return
  }
  const pats = Array.isArray(data.patterns) ? data.patterns : []
  stateEl.className = data.state === 'broken' ? 'auth-form-msg err' : 'auth-muted'
  stateEl.textContent =
    data.state === 'broken' ? t('names.state.broken')
    : data.state === 'empty' ? t('names.state.empty')
    : t('names.state.active', { n: pats.length })
  // Two conditions the operator would otherwise never learn about: a relaxed file mode on a
  // file that names a private person, and a worktree-hosted dashboard whose writes would go
  // to a copy the fleet's hooks never read.
  if (data.file_exists && data.file_mode_ok === false) {
    stateEl.textContent += ' ' + t('names.mode_warn')
  }
  const readOnly = data.read_only === true
  const addBtn = document.getElementById('namePatternAddBtn')
  if (addBtn) addBtn.disabled = readOnly
  if (readOnly) {
    stateEl.className = 'auth-form-msg err'
    stateEl.textContent = t('names.read_only')
  }

  if (!pats.length) {
    listEl.innerHTML = `<p class="auth-muted">${t('names.empty_list')}</p>`
    return
  }
  listEl.innerHTML = pats.map((p) =>
    `<div class="auth-device-row name-pattern-row">` +
      `<code class="name-pattern-src">${escapeHtml(p)}</code>` +
      `<button class="btn-secondary btn-compact name-pattern-del" data-pattern="${escapeHtml(p)}"${readOnly ? ' disabled' : ''}>${t('names.remove')}</button>` +
    `</div>`).join('')
  listEl.querySelectorAll('.name-pattern-del').forEach((btn) => {
    btn.addEventListener('click', () => removeNamePatternFromUi(btn.getAttribute('data-pattern')))
  })
}

async function addNamePatternFromUi() {
  const msg = document.getElementById('namePatternMsg')
  const input = document.getElementById('namePatternValue')
  const value = (input.value || '').trim()
  msg.className = 'auth-form-msg'
  msg.textContent = ''
  if (!value) { msg.classList.add('err'); msg.textContent = t('names.err_empty'); return }
  const mode = document.getElementById('namePatternMode').value
  try {
    const r = await fetch('/api/security/name-patterns', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ value, mode }),
    })
    const data = await r.json().catch(() => ({}))
    if (!r.ok) {
      // The server's message is the specific reason (which regex construct failed, or that
      // the pattern backtracks catastrophically). Showing a generic string here would throw
      // away the only actionable part.
      msg.classList.add('err')
      msg.textContent = data.error || t('names.err_generic')
      return
    }
    input.value = ''
    msg.classList.add('ok')
    msg.textContent = t('names.added', { n: data.count })
    await loadNamePatterns()
  } catch {
    msg.classList.add('err')
    msg.textContent = t('names.err_generic')
  }
}

async function removeNamePatternFromUi(pattern) {
  const msg = document.getElementById('namePatternMsg')
  msg.className = 'auth-form-msg'
  msg.textContent = ''
  if (!confirm(t('names.confirm_remove'))) return
  try {
    const r = await fetch('/api/security/name-patterns', {
      method: 'DELETE', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ pattern }),
    })
    const data = await r.json().catch(() => ({}))
    if (!r.ok) { msg.classList.add('err'); msg.textContent = data.error || t('names.err_generic'); return }
    msg.classList.add('ok')
    msg.textContent = t('names.removed', { n: data.count })
    await loadNamePatterns()
  } catch {
    msg.classList.add('err')
    msg.textContent = t('names.err_generic')
  }
}
