// web/app-freellm.js -- FreeAPI LLM provider (offload path dashboard)
// Loads and manages the freellm on/off switch + usage meter.
// Globals resolved at call time: t(), escapeHtml(), showToast().
// Exposes: loadFreellm() (called from switchPage in app.js).

let _freellmToggleBound = false
let _freellmRetryBound = false
let _freellmStatusPollTimer = null

function freellmMsg(text, cls) {
  const m = document.getElementById('freellmMsg')
  if (!m) return
  m.textContent = text || ''
  m.className = 'freellm-msg' + (cls ? ' ' + cls : '')
}

// MikroB decision (25258) / RedHat N1 + QA F3 (25256, 25239): the HTML ships with
// #freellmErrorSection carrying the `hidden` attribute, and nothing ever cleared it on the
// WRAPPER -- only the inner #freellmLastError text was being touched, so a real lastError from a
// stopped freellmapi server rendered into an invisible parent (a rule-12 failure: the error never
// reached the operator). These two helpers own the wrapper's visibility exclusively.
function freellmShowErrorSection(message) {
  const section = document.getElementById('freellmErrorSection')
  const lastError = document.getElementById('freellmLastError')
  // textContent never interprets markup -- assigning an already-escaped string here double-escapes
  // it (WhiteHat2 F1/N2, RedHat N2: the operator saw literal "&lt;" instead of "<"). Assign the raw
  // string directly.
  if (lastError) lastError.textContent = message
  if (section) section.hidden = false
}

function freellmHideErrorSection() {
  const section = document.getElementById('freellmErrorSection')
  const lastError = document.getElementById('freellmLastError')
  if (section) section.hidden = true
  if (lastError) lastError.textContent = ''
}

function freellmRenderStatus(data) {
  const toggle = document.getElementById('freellmToggle')
  const label = document.getElementById('freellmLabel')
  const callsCount = document.getElementById('freellmCallsCount')
  const draftsCount = document.getElementById('freellmDraftsCount')

  if (toggle) toggle.checked = !!data.enabled
  if (label) {
    label.textContent = t(data.enabled ? 'freellm.status.on' : 'freellm.status.off')
    label.className = 'freellm-label' + (data.enabled ? ' enabled' : ' disabled')
  }
  if (callsCount) callsCount.textContent = String(data.calls || 0)
  if (draftsCount) draftsCount.textContent = String(data.drafts || 0)
  if (data.lastError) {
    freellmShowErrorSection(String(data.lastError))
  } else {
    freellmHideErrorSection()
  }
}

async function freellmLoadStatus() {
  try {
    const res = await fetch('/api/freellm/status')
    if (!res.ok) throw new Error('HTTP ' + res.status)
    const d = await res.json()
    freellmRenderStatus(d)
    freellmMsg('')
  } catch (e) {
    // Rule 12: speak the failure in the flow (not a silent no-op) with a retry-able message --
    // AND surface it in the (now correctly unhidden) error section, since a failed status call is
    // exactly the "freellmapi server is down" case the card's done-criterion 2 names.
    freellmMsg(t('freellm.load_error'), 'bad')
    freellmShowErrorSection(t('freellm.load_error'))
  }
}

async function freellmPostStatus(enabled) {
  try {
    const res = await fetch('/api/freellm/status', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ enabled }),
    })
    if (!res.ok) throw new Error('HTTP ' + res.status)
    const d = await res.json()
    freellmRenderStatus(d)
    freellmMsg(t(d.enabled ? 'freellm.saved_on' : 'freellm.saved_off'), 'ok')
  } catch (e) {
    // Rule 12: speak the failure in the flow with a retry-able message; put the toggle back where
    // it actually is (the write may or may not have landed), not where the click left it.
    freellmMsg(t('freellm.save_error'), 'bad')
    freellmLoadStatus()
  }
}

function freellmSetup() {
  const toggle = document.getElementById('freellmToggle')
  if (toggle && !_freellmToggleBound) {
    _freellmToggleBound = true
    toggle.addEventListener('change', () => freellmPostStatus(toggle.checked))
  }
  const retryBtn = document.getElementById('freellmErrorRetryBtn')
  if (retryBtn && !_freellmRetryBound) {
    _freellmRetryBound = true
    retryBtn.addEventListener('click', () => freellmLoadStatus())
  }
  freellmLoadStatus()
}

async function loadFreellm() {
  freellmSetup()
  freellmSetupKeys()
  // Live refresh of status while the page is open (5s poll like local-llm)
  if (_freellmStatusPollTimer) clearInterval(_freellmStatusPollTimer)
  _freellmStatusPollTimer = setInterval(() => {
    if (document.getElementById('freellmPage') && document.getElementById('freellmPage').hidden) {
      if (_freellmStatusPollTimer) { clearInterval(_freellmStatusPollTimer); _freellmStatusPollTimer = null }
      return
    }
    freellmLoadStatus()
  }, 5000)
}

// WhiteHat2 F2 (25254): a key typed but not yet saved stayed in its password field until a full
// page reload (stopFreellmPoll only cleared the timer). Clearing on page-leave means a typo'd or
// abandoned key does not keep sitting in the DOM once the operator navigates elsewhere.
function freellmClearKeyFields() {
  FREELLM_PROVIDERS.forEach(provider => {
    const input = document.getElementById('freellmKeyInput_' + provider)
    if (input) input.value = ''
  })
}

function stopFreellmPoll() {
  if (_freellmStatusPollTimer) { clearInterval(_freellmStatusPollTimer); _freellmStatusPollTimer = null }
  freellmClearKeyFields()
}

// --- Provider key form (card fd5fcc2c point 5, Peti 12500, Pair-BE 08d1aa90) -----------------
// Contract: POST /api/freellm/keys {provider,key} -> {provider,setBy,since,masked}
//           GET  /api/freellm/keys -> [{provider,setBy,since,masked}, ...]
//           DELETE /api/freellm/keys/<provider> -> {provider,deleted:true}
// The full key is NEVER rendered back -- only "masked" (***...last4) from the backend's own
// response. The input field is cleared immediately after a successful save (never left holding
// the secret), and the raw key never goes into a URL, a log call, or console output.
const FREELLM_PROVIDERS = ['groq', 'cerebras', 'google_ai_studio', 'openrouter', 'mistral']

let _freellmKeysBound = false
let _freellmKeysByProvider = {} // provider -> {provider,setBy,since,masked} | absent = not set

function freellmKeyMsg(provider, text, cls) {
  const m = document.getElementById('freellmKeyMsg_' + provider)
  if (!m) return
  m.textContent = text || ''
  m.className = 'freellm-key-msg' + (cls ? ' ' + cls : '')
}

function freellmProviderLabel(provider) {
  return t('freellm.keys.provider.' + provider) || provider
}

// WhiteHat2 F1 (25254): the FE rendered the backend's "masked" field verbatim. If a buggy or
// hostile backend ever returns the FULL key as "masked", the row would print the secret. This
// shape guard accepts only the backend's own short masked form (leading mask characters, a short
// remainder) and falls back to a generic "set" marker for anything else -- never the raw value.
function freellmLooksMasked(masked) {
  return typeof masked === 'string' && /^\*{2,}/.test(masked) && masked.length <= 20
}

function freellmRenderKeyRow(provider) {
  const input = document.getElementById('freellmKeyInput_' + provider)
  const statusEl = document.getElementById('freellmKeyStatus_' + provider)
  const delBtn = document.getElementById('freellmKeyDeleteBtn_' + provider)
  const entry = _freellmKeysByProvider[provider]
  if (input) input.value = ''
  if (statusEl) {
    if (entry) {
      // textContent never interprets markup -- escapeHtml() before it double-escapes (the operator
      // would see literal "&amp;" for a masked value containing "&"). Assign the raw string.
      const safeMasked = freellmLooksMasked(entry.masked) ? entry.masked : '***'
      statusEl.textContent = t('freellm.keys.status_set', { masked: safeMasked })
      statusEl.className = 'freellm-key-status freellm-key-status--set'
    } else {
      statusEl.textContent = t('freellm.keys.status_unset')
      statusEl.className = 'freellm-key-status freellm-key-status--unset'
    }
  }
  if (delBtn) delBtn.hidden = !entry
}

function freellmRenderAllKeyRows() {
  FREELLM_PROVIDERS.forEach(freellmRenderKeyRow)
}

async function freellmLoadKeys() {
  try {
    const res = await fetch('/api/freellm/keys')
    if (!res.ok) throw new Error('HTTP ' + res.status)
    const list = await res.json()
    _freellmKeysByProvider = {}
    if (Array.isArray(list)) {
      for (const entry of list) {
        if (entry && typeof entry.provider === 'string') _freellmKeysByProvider[entry.provider] = entry
      }
    }
    freellmRenderAllKeyRows()
  } catch (e) {
    // Rule 12: a failed list load must not hide the form -- show a retry-able notice on each row's
    // status slot instead of leaving the panel blank.
    FREELLM_PROVIDERS.forEach(p => freellmKeyMsg(p, t('freellm.keys.load_error'), 'bad'))
  }
}

async function freellmSaveKey(provider) {
  const input = document.getElementById('freellmKeyInput_' + provider)
  const saveBtn = document.getElementById('freellmKeySaveBtn_' + provider)
  if (!input) return
  const key = input.value
  if (!key) {
    freellmKeyMsg(provider, t('freellm.keys.empty_error'), 'bad')
    return
  }
  if (saveBtn) saveBtn.disabled = true
  try {
    const res = await fetch('/api/freellm/keys', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ provider, key }),
    })
    if (!res.ok) throw new Error('HTTP ' + res.status)
    const d = await res.json()
    _freellmKeysByProvider[provider] = d
    // Field is cleared immediately -- the secret never lingers in the DOM after a successful save.
    input.value = ''
    freellmRenderKeyRow(provider)
    freellmKeyMsg(provider, t('freellm.keys.saved'), 'ok')
  } catch (e) {
    freellmKeyMsg(provider, t('freellm.keys.save_error'), 'bad')
  } finally {
    if (saveBtn) saveBtn.disabled = false
  }
}

async function freellmDeleteKey(provider) {
  const delBtn = document.getElementById('freellmKeyDeleteBtn_' + provider)
  if (delBtn) delBtn.disabled = true
  try {
    const res = await fetch('/api/freellm/keys/' + encodeURIComponent(provider), { method: 'DELETE' })
    if (!res.ok) throw new Error('HTTP ' + res.status)
    delete _freellmKeysByProvider[provider]
    freellmRenderKeyRow(provider)
    freellmKeyMsg(provider, t('freellm.keys.deleted'), 'ok')
  } catch (e) {
    freellmKeyMsg(provider, t('freellm.keys.delete_error'), 'bad')
  } finally {
    if (delBtn) delBtn.disabled = false
  }
}

function freellmSetupKeys() {
  if (!_freellmKeysBound) {
    _freellmKeysBound = true
    FREELLM_PROVIDERS.forEach(provider => {
      const saveBtn = document.getElementById('freellmKeySaveBtn_' + provider)
      const delBtn = document.getElementById('freellmKeyDeleteBtn_' + provider)
      if (saveBtn) saveBtn.addEventListener('click', () => freellmSaveKey(provider))
      if (delBtn) delBtn.addEventListener('click', () => freellmDeleteKey(provider))
    })
  }
  freellmLoadKeys()
}
