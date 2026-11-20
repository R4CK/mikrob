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

// Card 5ae7e8be point 4 / WhiteHat2 R3 (25351): while the status call is failing, the toggle/
// label/calls/drafts kept showing the LAST SUCCESSFUL values underneath the (now-visible) error
// notice -- e.g. "Bekapcsolva", "7" hívás -- which reads as current when it may be minutes stale
// or simply wrong. This clears them to the house "no value" marker and disables the toggle (an
// unknown state is not a safe thing to flip) whenever the error section is shown.
function freellmResetStatusDisplay() {
  const toggle = document.getElementById('freellmToggle')
  const label = document.getElementById('freellmLabel')
  const callsCount = document.getElementById('freellmCallsCount')
  const draftsCount = document.getElementById('freellmDraftsCount')
  if (toggle) { toggle.disabled = true; toggle.checked = false }
  if (label) { label.textContent = '—'; label.className = 'freellm-label' }
  if (callsCount) callsCount.textContent = '—'
  if (draftsCount) draftsCount.textContent = '—'
}

// Card 685f25cb (MikroB root-cause measurement, 2026-11-20): lastError is a PER-CALL fact (the
// most recent failed freellm call, if any within the window), not a sign that this status READ
// itself failed. A live 200 response with real enabled/calls/drafts next to a lastError is valid,
// current data -- it must render normally, with the error notice shown alongside it. The earlier
// version treated any truthy lastError as "status unknown" and blanked the whole panel, which is
// why the page showed nothing even while freellm was working. freellmResetStatusDisplay() is still
// used, deliberately, by the actual "we have no fresh data at all" paths: the fetch-throws catch
// block in freellmLoadStatus below.
function freellmRenderStatus(data) {
  const toggle = document.getElementById('freellmToggle')
  const label = document.getElementById('freellmLabel')
  const callsCount = document.getElementById('freellmCallsCount')
  const draftsCount = document.getElementById('freellmDraftsCount')

  if (toggle) { toggle.checked = !!data.enabled; toggle.disabled = false }
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
    // exactly the "freellmapi server is down" case the card's done-criterion 2 names. A fully
    // failed fetch means we have NO fresh data at all, so the stale-state reset applies here too.
    freellmMsg(t('freellm.load_error'), 'bad')
    freellmResetStatusDisplay()
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

// --- Call log (card ebe20efe, Peti 14295) --------------------------------------------------
// Contract (backend2, Pair-BE 685f25cb, msg_id:21895, reconciling an earlier draft 21882 after a
// MikroB scope correction -- branch fix/freellm-call-journal-685f25cb, commit cb3e9e23a, not yet
// landed): GET /api/freellm/calls?since=<unix_s>&limit=<1..500>
//   -> { calls: [{ ts: <unix SECONDS>, agent, card, model, provider: null (reserved, never
//          populated today), outcome: 'ok'|'fail'|'auth'|'429'|'stalled', fail_reason: <string>|
//          null, duration_ms }, ...], // newest first, no `attempt` field (not recorded today)
//        counts_24h: { ok, fail, stalled, rate_429, auth }, counts_7d: { same shape } }
// `ts` is unix SECONDS, not ms (Date() needs *1000). The counts object's key for the 429 bucket
// is `rate_429`, but a ROW's own outcome value for the same thing is the string '429' -- two
// different spellings for the same case, both handled below. outcome is a closed enum but
// rendered through a lookup with a safe fallback, so an unexpected future value never breaks the
// page. `provider` and `attempt` are not rendered (the panel never used them).
const FREELLM_CALLS_LIMIT = 50
const FREELLM_COUNT_FIELDS = ['ok', 'fail', 'stalled', 'rate_429', 'auth']
let _freellmCallsRefreshBound = false

function freellmOutcomeLabel(outcome) {
  return t('freellm.calls.outcome.' + outcome) || String(outcome)
}

// The aggregate counts object spells the 429 bucket 'rate_429'; a call row's own outcome value
// spells the same case '429'. Route 'rate_429' to the same label as outcome '429' rather than
// requiring (and risking someone forgetting) a second, parallel translation key.
function freellmCountFieldLabel(field) {
  const outcomeKey = field === 'rate_429' ? '429' : field
  return freellmOutcomeLabel(outcomeKey)
}

// A technical fail_reason code (e.g. "http_404") gets a translated label if we have one, else a
// de-snaked fallback ("http 404") rather than the raw underscored string -- rule 12.
function freellmFailReasonLabel(reason) {
  const known = t('freellm.calls.fail_reason.' + reason)
  if (known) return known
  return String(reason).replace(/_/g, ' ')
}

// Rows the table highlights as failed (rule 12: the operator needs the bad ones to stand out).
function freellmOutcomeIsFailure(outcome) {
  return outcome !== 'ok'
}

function freellmFmtDuration(ms) {
  if (ms == null || isNaN(ms)) return '—'
  if (ms < 1000) return Math.round(ms) + ' ms'
  return (ms / 1000).toFixed(1) + ' s'
}

// ts from the backend is unix SECONDS, not milliseconds.
function freellmFmtTime(tsSeconds) {
  if (tsSeconds == null || isNaN(tsSeconds)) return '—'
  try {
    return new Date(tsSeconds * 1000).toLocaleString()
  } catch {
    return '—'
  }
}

function freellmSetCallsLoading(on) {
  const el = document.getElementById('freellmCallsLoading')
  if (el) el.hidden = !on
}

function freellmSetCallsError(msg) {
  const el = document.getElementById('freellmCallsError')
  if (!el) return
  if (msg) {
    el.hidden = false
    el.textContent = msg
  } else {
    el.hidden = true
    el.textContent = ''
  }
}

function freellmSetCallsEmpty(on) {
  const el = document.getElementById('freellmCallsEmpty')
  if (el) el.hidden = !on
}

function freellmRenderCountsRow(elId, counts) {
  const el = document.getElementById(elId)
  if (!el) return
  el.textContent = ''
  const safe = counts || {}
  FREELLM_COUNT_FIELDS.forEach((field) => {
    const span = document.createElement('span')
    span.className = 'freellm-calls-count-chip freellm-calls-count-chip--' + field
    span.textContent = freellmCountFieldLabel(field) + ': ' + String(safe[field] || 0)
    el.appendChild(span)
  })
}

function freellmRenderCallsTable(calls) {
  const tbody = document.getElementById('freellmCallsTbody')
  if (!tbody) return
  tbody.textContent = ''
  calls.forEach((call) => {
    const tr = document.createElement('tr')
    if (freellmOutcomeIsFailure(call.outcome)) tr.className = 'freellm-calls-row--failed'
    // rule 12: a failed row shows WHY, not just that it failed.
    const outcomeText = call.fail_reason
      ? freellmOutcomeLabel(call.outcome) + ' (' + freellmFailReasonLabel(call.fail_reason) + ')'
      : freellmOutcomeLabel(call.outcome)
    const cells = [
      freellmFmtTime(call.ts),
      call.agent != null ? String(call.agent) : '—',
      call.card != null ? String(call.card) : '—',
      call.model != null ? String(call.model) : '—',
      outcomeText,
      freellmFmtDuration(call.duration_ms),
    ]
    cells.forEach((text) => {
      const td = document.createElement('td')
      td.textContent = text
      tr.appendChild(td)
    })
    tbody.appendChild(tr)
  })
}

async function freellmLoadCalls() {
  freellmSetCallsLoading(true)
  freellmSetCallsError(null)
  freellmSetCallsEmpty(false)
  const countsEl = document.getElementById('freellmCallsCounts')
  const tableWrap = document.getElementById('freellmCallsTableWrap')

  try {
    const res = await fetch('/api/freellm/calls?limit=' + FREELLM_CALLS_LIMIT)
    if (!res.ok) throw new Error('HTTP ' + res.status)
    const data = await res.json()
    const calls = Array.isArray(data.calls) ? data.calls : []

    freellmRenderCountsRow('freellmCounts24h', data.counts_24h)
    freellmRenderCountsRow('freellmCounts7d', data.counts_7d)
    if (countsEl) countsEl.hidden = false

    if (calls.length === 0) {
      freellmSetCallsEmpty(true)
      if (tableWrap) tableWrap.hidden = true
    } else {
      freellmRenderCallsTable(calls)
      if (tableWrap) tableWrap.hidden = false
    }
  } catch (e) {
    freellmSetCallsError(t('freellm.calls.load_error'))
    if (countsEl) countsEl.hidden = true
    if (tableWrap) tableWrap.hidden = true
  } finally {
    freellmSetCallsLoading(false)
  }
}

function freellmSetupCalls() {
  const refreshBtn = document.getElementById('freellmCallsRefreshBtn')
  if (refreshBtn && !_freellmCallsRefreshBound) {
    _freellmCallsRefreshBound = true
    refreshBtn.addEventListener('click', () => freellmLoadCalls())
  }
  freellmLoadCalls()
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
  freellmSetupCalls()
  // Live refresh of status + calls while the page is open (5s poll like local-llm)
  if (_freellmStatusPollTimer) clearInterval(_freellmStatusPollTimer)
  _freellmStatusPollTimer = setInterval(() => {
    if (document.getElementById('freellmPage') && document.getElementById('freellmPage').hidden) {
      if (_freellmStatusPollTimer) { clearInterval(_freellmStatusPollTimer); _freellmStatusPollTimer = null }
      return
    }
    freellmLoadStatus()
    freellmLoadCalls()
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

// DEAD CODE REMOVED (card 678848ce): freellmLooksMasked() used to regex-parse the backend's raw
// "masked" string (e.g. "***ABCD") on the FE. Backend (08d1aa90 REVIEW 25388, commit 603e6df89)
// now sends a normalized { set, hint, error } instead of a mask string at all -- hint is never
// more than the upstream's own trailing 2-4 characters, and a decrypt failure is its own explicit
// error state rather than a silent "set". There is no mask-string shape left on the FE to parse,
// so the old regex guard was removed rather than kept as unreachable code.
//
// freellmHintLooksSafe is its narrower replacement: defense-in-depth against a buggy or
// compromised backend sending more than the contract promises, not re-deriving a mask format.
function freellmHintLooksSafe(hint) {
  return hint === null || hint === undefined || (typeof hint === 'string' && hint.length <= 4)
}

function freellmRenderKeyRow(provider) {
  const input = document.getElementById('freellmKeyInput_' + provider)
  const statusEl = document.getElementById('freellmKeyStatus_' + provider)
  const delBtn = document.getElementById('freellmKeyDeleteBtn_' + provider)
  const entry = _freellmKeysByProvider[provider]
  if (input) input.value = ''
  if (statusEl) {
    if (entry && entry.set) {
      if (entry.error === 'decrypt_failed') {
        // A set-but-undecryptable key is a distinct, actionable state -- never shown as a plain
        // "set" (that would hide a broken credential from the operator).
        statusEl.textContent = t('freellm.keys.status_decrypt_failed')
        statusEl.className = 'freellm-key-status freellm-key-status--error'
      } else {
        // textContent never interprets markup, so no escapeHtml() needed here. A hint longer than
        // the contract promises (buggy/hostile backend) falls back to no hint at all, never the
        // raw value.
        const safeHint = freellmHintLooksSafe(entry.hint) ? entry.hint : null
        statusEl.textContent = safeHint
          ? t('freellm.keys.status_set', { masked: '***' + safeHint })
          : t('freellm.keys.status_set_no_hint')
        statusEl.className = 'freellm-key-status freellm-key-status--set'
      }
    } else {
      statusEl.textContent = t('freellm.keys.status_unset')
      statusEl.className = 'freellm-key-status freellm-key-status--unset'
    }
  }
  if (delBtn) delBtn.hidden = !(entry && entry.set)
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
