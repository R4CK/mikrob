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
