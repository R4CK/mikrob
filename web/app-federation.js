// === Federation page -- extracted from app.js (slice 12/N, card 0c2f5730 placeholder) ===
// Globals from app.js used here (resolved at call time): t, escapeHtml, esc,
// showToast, closeModal, federatedPeerStatus (declared in app.js ~L3839).
// app-federation.js is loaded AFTER app.js in index.html.

// === Federation page ===
// State lets live BEFORE the router IIFE (top-level code runs in order; a
// first-load #federation route must not hit a TDZ on these).
let fedPageWired = false
let fedPeersViewCache = null

async function loadFederationPage() {
  wireFederationPage()
  // A 'pending' state with no active poller (the poller stops itself when the page is hidden --
  // see fedTailscalePoll) means the user navigated away mid-login and came back: there is nothing
  // left driving that state to completion, so it would otherwise sit on "Csatlakozás
  // folyamatban..." forever. Reset to idle so the login button is reachable again.
  if (_fedTailscaleState.status === 'pending' && !_fedTailscalePollTimer) {
    _fedTailscaleState = { status: 'idle' }
  }
  fedTailscaleRender() // renders whatever state is already known (idle on first visit)
  const statsEl = document.getElementById('federationStats')
  const masterEl = document.getElementById('federationMaster')
  const peersEl = document.getElementById('federationPeers')
  if (!statsEl || !masterEl || !peersEl) return
  peersEl.innerHTML = `<p style="color:var(--text-muted);font-size:13px">${t('common.loading')}</p>`
  try {
    const [peersRes, statusRes] = await Promise.all([
      fetch('/api/federation/peers'),
      fetch('/api/federation/status').then((r) => (r.ok ? r.json() : null)).catch(() => null),
    ])
    if (!peersRes.ok) throw new Error('HTTP ' + peersRes.status)
    fedPeersViewCache = await peersRes.json()
    if (statusRes && Array.isArray(statusRes.peers)) federatedPeerStatus = statusRes.peers
    renderFederationPage()
  } catch (e) {
    peersEl.innerHTML = `<p style="color:var(--danger)">${t('federation.error', { msg: escapeHtml(String(e.message || e)) })}</p>`
  }
}

function fedStateLabel(state) {
  const key = 'federation.peer_state.' + (state || 'unknown')
  return t(key)
}

function renderFederationPage() {
  const view = fedPeersViewCache
  if (!view) return
  const statsEl = document.getElementById('federationStats')
  const masterEl = document.getElementById('federationMaster')
  const peersEl = document.getElementById('federationPeers')
  const statusById = new Map(federatedPeerStatus.map((p) => [p.id, p]))
  const okCount = federatedPeerStatus.filter((p) => p.state === 'ok').length

  const statBox = (value, label) => `<div style="background:var(--surface);border:1px solid var(--border);border-radius:8px;padding:10px 16px;min-width:110px">
    <div style="font-size:20px;font-weight:600">${value}</div>
    <div style="font-size:12px;color:var(--text-muted)">${label}</div>
  </div>`
  statsEl.innerHTML = [
    statBox(view.enabled ? t('common.yes') : t('common.no'), t('federation.stat.enabled')),
    statBox(String(view.peers.length), t('federation.stat.peers')),
    statBox(String(okCount), t('federation.stat.reachable')),
    statBox(escapeHtml(view.systemId || '-'), t('federation.stat.system_id')),
  ].join('')

  const routingMode = view.routingMode || 'catalog-first'
  const routingRadios = ['strong', 'catalog-first', 'advisory'].map((m) => `
    <label style="display:flex;align-items:flex-start;gap:8px;cursor:pointer;padding:5px 0">
      <input type="radio" name="fedRoutingMode" value="${m}" ${routingMode === m ? 'checked' : ''} style="margin-top:3px;accent-color:var(--accent)">
      <span>
        <span style="font-weight:600">${t('federation.routing.mode.' + m + '.label')}</span>
        <span style="display:block;font-size:12px;color:var(--text-muted)">${t('federation.routing.mode.' + m + '.hint')}</span>
      </span>
    </label>`).join('')
  masterEl.innerHTML = `
    <label style="display:flex;align-items:center;gap:10px;cursor:pointer">
      <input type="checkbox" id="fedEnabledToggle" style="width:16px;height:16px;accent-color:var(--accent)" ${view.enabled ? 'checked' : ''}>
      <span style="font-weight:600">${t('federation.master_label')}</span>
    </label>
    <p style="font-size:12px;color:var(--text-muted);margin:6px 0 0 26px">${t('federation.master_hint')}</p>
    <div style="margin-top:14px;padding-top:12px;border-top:1px solid var(--border)">
      <div style="font-weight:600">${t('federation.routing.title')}</div>
      <p style="font-size:12px;color:var(--text-muted);margin:2px 0 8px 0">${t('federation.routing.subtitle')}</p>
      ${routingRadios}
      <p style="font-size:12px;color:var(--text-muted);margin:8px 0 0 0">${t('federation.routing.apply_note')}</p>
    </div>`
  document.getElementById('fedEnabledToggle').addEventListener('change', async (e) => {
    const enabled = e.target.checked
    if (!enabled && !confirm(t('federation.confirm.disable'))) { e.target.checked = true; return }
    try {
      const res = await fetch('/api/federation/enabled', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ enabled }) })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) { showToast(t('federation.toast.error', { msg: data.error || ('HTTP ' + res.status) })); e.target.checked = !enabled; return }
      showToast(enabled ? t('federation.toast.enabled') : t('federation.toast.disabled'))
      fedRefreshAndReload()
    } catch (err) { showToast(t('federation.toast.error', { msg: String(err.message || err) })); e.target.checked = !enabled }
  })
  document.querySelectorAll('input[name="fedRoutingMode"]').forEach((radio) => {
    radio.addEventListener('change', async (e) => {
      const mode = e.target.value
      try {
        const res = await fetch('/api/federation/routing-mode', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ mode }) })
        const data = await res.json().catch(() => ({}))
        if (!res.ok) { showToast(t('federation.toast.error', { msg: data.error || ('HTTP ' + res.status) })); return }
        showToast(t('federation.routing.toast_set', { mode: t('federation.routing.mode.' + mode + '.label') }))
      } catch (err) { showToast(t('federation.toast.error', { msg: String(err.message || err) })) }
    })
  })

  if (!view.peers.length) {
    peersEl.innerHTML = `<p style="color:var(--text-muted);font-size:13px">${t('federation.peers_empty')}</p>`
    return
  }
  peersEl.innerHTML = ''
  for (const peer of view.peers) {
    const st = statusById.get(peer.id)
    const state = peer.hasOutboundToken ? (st ? st.state : 'unknown') : 'unpaired'
    const reachable = state === 'ok'
    const lastOk = st && st.lastOkAt ? new Date(st.lastOkAt).toLocaleString() : '-'
    const agentCount = st && st.manifest && Array.isArray(st.manifest.agents) ? String(st.manifest.agents.length) : '-'
    const card = document.createElement('div')
    card.className = 'card'
    card.style.cssText = 'padding:12px 16px;display:flex;flex-direction:column;gap:8px'
    // Peer ids/baseUrls are OWNER-entered and segment-validated; state labels
    // come from t(). Still: text nodes only, escapeHtml everywhere.
    card.innerHTML = `
      <div style="display:flex;align-items:center;gap:10px;flex-wrap:wrap">
        <strong style="font-size:15px">${escapeHtml(peer.id)}</strong>
        <span class="tg-status"><span class="tg-dot ${reachable ? 'connected' : 'disconnected'}"></span> ${fedStateLabel(state)}</span>
        <span style="color:var(--text-muted);font-size:12px;margin-left:auto">${t('federation.card.last_ok')}: ${escapeHtml(lastOk)} · ${t('federation.card.agents')}: ${escapeHtml(agentCount)}</span>
      </div>
      <div style="font-size:13px;color:var(--text-muted);word-break:break-all">${escapeHtml(peer.baseUrl)}</div>
      ${st && st.error ? `<div style="font-size:12px;color:var(--danger)">${escapeHtml(st.error)}</div>` : ''}
      <label style="display:flex;align-items:center;gap:8px;font-size:12px;color:var(--text-muted);cursor:pointer">
        <input type="checkbox" class="fed-share-cap" ${peer.shareCapabilitySummaries ? 'checked' : ''} style="accent-color:var(--accent)">
        ${t('federation.share_cap_label')}
      </label>
      <div style="display:flex;gap:6px;flex-wrap:wrap">
        <button class="btn-secondary btn-compact" data-action="reveal">${t('federation.btn.reveal')}</button>
        <button class="btn-secondary btn-compact" data-action="rotate">${t('federation.btn.rotate')}</button>
        <button class="btn-secondary btn-compact" data-action="edit">${t('common.edit')}</button>
        <button class="btn-secondary btn-compact" data-action="delete" style="color:var(--danger)">${t('common.delete')}</button>
      </div>
      <div class="fed-token-reveal" hidden style="font-family:monospace;font-size:12px;background:var(--surface);border:1px solid var(--border);border-radius:6px;padding:8px;word-break:break-all"></div>`
    card.querySelector('[data-action="reveal"]').addEventListener('click', () => fedRevealToken(peer.id, card))
    card.querySelector('[data-action="rotate"]').addEventListener('click', () => fedRotateToken(peer.id))
    card.querySelector('[data-action="edit"]').addEventListener('click', () => fedOpenPeerModal(peer))
    card.querySelector('[data-action="delete"]').addEventListener('click', () => fedDeletePeer(peer.id))
    card.querySelector('.fed-share-cap').addEventListener('change', (e) => fedToggleShareCap(peer.id, e.target.checked))
    peersEl.appendChild(card)
  }
}

async function fedRevealToken(peerId, card) {
  const box = card.querySelector('.fed-token-reveal')
  if (!box.hidden) { box.hidden = true; box.textContent = ''; return }
  try {
    const res = await fetch(`/api/federation/peers/${encodeURIComponent(peerId)}/inbound-token`)
    const data = await res.json().catch(() => ({}))
    if (!res.ok) { showToast(t('federation.toast.error', { msg: data.error || ('HTTP ' + res.status) })); return }
    box.textContent = data.inboundToken
    box.hidden = false
    navigator.clipboard?.writeText(data.inboundToken).then(
      () => showToast(t('federation.toast.token_copied')),
      () => {},
    )
  } catch (err) { showToast(t('federation.toast.error', { msg: String(err.message || err) })) }
}

async function fedRotateToken(peerId) {
  if (!confirm(t('federation.confirm.rotate', { peer: peerId }))) return
  try {
    const res = await fetch(`/api/federation/peers/${encodeURIComponent(peerId)}/rotate-inbound-token`, { method: 'POST' })
    const data = await res.json().catch(() => ({}))
    if (!res.ok) { showToast(t('federation.toast.error', { msg: data.error || ('HTTP ' + res.status) })); return }
    showToast(t('federation.toast.rotated'))
    loadFederationPage()
  } catch (err) { showToast(t('federation.toast.error', { msg: String(err.message || err) })) }
}

async function fedToggleShareCap(peerId, share) {
  try {
    const res = await fetch(`/api/federation/peers/${encodeURIComponent(peerId)}`, {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ shareCapabilitySummaries: share }),
    })
    const data = await res.json().catch(() => ({}))
    if (!res.ok) { showToast(t('federation.toast.error', { msg: data.error || ('HTTP ' + res.status) })); loadFederationPage(); return }
    showToast(share ? t('federation.toast.share_cap_on') : t('federation.toast.share_cap_off'))
  } catch (err) { showToast(t('federation.toast.error', { msg: String(err.message || err) })); loadFederationPage() }
}

async function fedDeletePeer(peerId) {
  if (!confirm(t('federation.confirm.delete_peer', { peer: peerId }))) return
  try {
    const res = await fetch(`/api/federation/peers/${encodeURIComponent(peerId)}`, { method: 'DELETE' })
    const data = await res.json().catch(() => ({}))
    if (!res.ok) { showToast(t('federation.toast.error', { msg: data.error || ('HTTP ' + res.status) })); return }
    // Sweep browser leftovers scoped to the removed peer.
    for (let i = localStorage.length - 1; i >= 0; i--) {
      const key = localStorage.key(i)
      if (key && key.startsWith('chat_last_seen_' + peerId + '/')) localStorage.removeItem(key)
    }
    if (chatSelectedAgent && chatSelectedAgent.startsWith(peerId + '/')) chatSelectedAgent = null
    showToast(t('federation.toast.peer_deleted'))
    loadFederationPage()
  } catch (err) { showToast(t('federation.toast.error', { msg: String(err.message || err) })) }
}

// Apply federation config changes to the RUNNING main agent by restarting it
// (it reloads CLAUDE.md, which carries the federation onboarding + delegation
// directive). Reuses the existing main-agent restart endpoint -- no new
// backend, no terminal command for the operator.
async function fedApplyToMainAgent() {
  if (!confirm(t('federation.confirm.apply'))) return
  try {
    // Server-side apply: restarts the main channels agent by MAIN_AGENT_ID,
    // so the client does not depend on window._marveen being loaded (the
    // Federation page does not populate it -> the old /api/agents/:name path
    // 404'd when it fell back to the 'marveen' default).
    const res = await fetch('/api/federation/apply', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}',
    })
    const data = await res.json().catch(() => ({}))
    if (!res.ok) { showToast(t('federation.toast.error', { msg: data.error || ('HTTP ' + res.status) })); return }
    showToast(t('federation.toast.applied'))
  } catch (err) { showToast(t('federation.toast.error', { msg: String(err.message || err) })) }
}

// Re-poll peer reachability then re-render. Called after config mutations
// (enable, peer add/edit) so the status shows fresh -- there is no separate
// manual "refresh" button anymore (the apply action owns the top-right slot).
async function fedRefreshAndReload() {
  try { await fetch('/api/federation/refresh', { method: 'POST' }) } catch { /* best effort */ }
  loadFederationPage()
}

let fedPeerModalEditId = null

function fedOpenPeerModal(peer) {
  fedPeerModalEditId = peer ? peer.id : null
  document.getElementById('fedPeerModalTitle').textContent = peer ? t('federation.modal.edit_title', { peer: peer.id }) : t('federation.modal.add_title')
  const idInput = document.getElementById('fedPeerId')
  idInput.value = peer ? peer.id : ''
  idInput.disabled = !!peer
  document.getElementById('fedPeerBaseUrl').value = peer ? peer.baseUrl : ''
  document.getElementById('fedPeerOutboundToken').value = ''
  document.getElementById('fedPeerOutboundToken').placeholder = peer && peer.hasOutboundToken ? t('federation.modal.outbound_keep') : ''
  document.getElementById('fedPeerAbandonWindow').value = peer && peer.abandonWindowMinutes ? String(peer.abandonWindowMinutes) : ''
  openModal(document.getElementById('fedPeerModalOverlay'))
}

async function fedSavePeerModal() {
  // Ids are case-insensitive server-side (stored lowercase); fold here too so
  // the operator immediately sees the canonical form.
  const id = document.getElementById('fedPeerId').value.trim().toLowerCase()
  const baseUrl = document.getElementById('fedPeerBaseUrl').value.trim()
  const outbound = document.getElementById('fedPeerOutboundToken').value.trim()
  const abandonRaw = document.getElementById('fedPeerAbandonWindow').value.trim()
  try {
    let res, data
    if (fedPeerModalEditId) {
      const body = { baseUrl }
      if (outbound) body.outboundToken = outbound
      if (abandonRaw) body.abandonWindowMinutes = parseInt(abandonRaw, 10)
      else body.abandonWindowMinutes = null
      res = await fetch(`/api/federation/peers/${encodeURIComponent(fedPeerModalEditId)}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
      data = await res.json().catch(() => ({}))
      if (!res.ok) { showToast(t('federation.toast.error', { msg: data.error || ('HTTP ' + res.status) })); return }
      showToast(t('federation.toast.peer_saved'))
    } else {
      const body = { id, baseUrl }
      if (outbound) body.outboundToken = outbound
      res = await fetch('/api/federation/peers', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
      data = await res.json().catch(() => ({}))
      if (!res.ok) { showToast(t('federation.toast.error', { msg: data.error || ('HTTP ' + res.status) })); return }
      // The minted inbound token is shown ONCE right away: the owner hands it
      // to the peer's operator during pairing.
      prompt(t('federation.modal.minted_token_hint'), data.inboundToken)
      showToast(t('federation.toast.peer_added'))
    }
    closeModal(document.getElementById('fedPeerModalOverlay'))
    fedRefreshAndReload()
  } catch (err) { showToast(t('federation.toast.error', { msg: String(err.message || err) })) }
}

async function fedRemoveAll() {
  if (!confirm(t('federation.confirm.remove'))) return
  try {
    const res = await fetch('/api/federation/remove', { method: 'POST' })
    const data = await res.json().catch(() => ({}))
    if (!res.ok) { showToast(t('federation.toast.error', { msg: data.error || ('HTTP ' + res.status) })); return }
    federatedPeerStatus = []
    // Sweep browser leftovers for ALL federated (qualified) threads -- the
    // per-peer DELETE path does this per peer, full removal must do it wholesale.
    for (let i = localStorage.length - 1; i >= 0; i--) {
      const key = localStorage.key(i)
      if (key && /^chat_last_seen_[^/]+\//.test(key)) localStorage.removeItem(key)
    }
    if (chatSelectedAgent && chatSelectedAgent.includes('/')) chatSelectedAgent = null
    showToast(t('federation.toast.removed'))
    loadFederationPage()
  } catch (err) { showToast(t('federation.toast.error', { msg: String(err.message || err) })) }
}

// --- Tailscale login + self connection info (card 9bf6a1e0) ---------------------------------
// Contract v2, drafted by backend on card b68ddae8 (2026-08-16, DRAFT -- not yet implemented).
// v1 had a gap (POST /login's idempotent "already connected" branch returned no pollToken, so
// there was no way to reach GET /status -- and therefore no systemId/baseUrl -- on that path,
// which is also the COMMON path since most visits find an already-connected node). Flagged back
// to backend rather than worked around with a guessed field; backend fixed the contract itself:
//   POST /api/federation/tailscale/login
//     -> { status: 'connected'|'needs_login', pollToken, loginUrl? }
//     pollToken ALWAYS comes back now, on both branches. loginUrl only on needs_login. `status`
//     is informational (whether to show a login link), not the UI's branching signal -- pollToken
//     presence is, and it is now unconditional.
//   GET /api/federation/tailscale/status?pollToken=...
//     -> { status: 'pending'|'connected'|'failed', systemId?, baseUrl?, error? }
//     THE ONLY place systemId/baseUrl come from, on either branch -- even an already-connected
//     node needs the `tailscale serve --bg 3420` check re-verified, which is where baseUrl comes
//     from, so it is never instantly available either.
// One poll path, two branches (whether a login link needs to be shown first) -- no more special
// no-data state for the idempotent branch, because there is no longer a data-less branch.
let _fedTailscaleState = { status: 'idle' }
let _fedTailscaleLoginUrl = null
let _fedTailscalePollTimer = null
let _fedTailscalePollAttempts = 0
const FED_TAILSCALE_POLL_MAX_ATTEMPTS = 20 // 20 * 3s = 60s ceiling, then treat as a timeout

// Cybered NO-GO (HIGH, card 9bf6a1e0, gate-sha 1c3b95a2): backend's promise to only ever send a
// validated https+tailscale.com loginUrl lives in a DRAFT contract with no implementation yet --
// "a control a not-yet-written function vouches for is not a control". The user opens this link
// WITH THE INTENT of entering credentials (the button literally says "sign in"), so an unvalidated
// URL here is a self-inflicted, first-party phishing vector regardless of what backend eventually
// ships. Validated client-side too, independent of and in addition to backend's own filtering.
function fedTailscaleValidLoginUrl(url) {
  let u
  try { u = new URL(url) } catch { return false }
  return u.protocol === 'https:' && (u.hostname === 'login.tailscale.com' || u.hostname.endsWith('.tailscale.com'))
}

function fedTailscaleRender() {
  const el = document.getElementById('federationTailscale')
  if (!el) return
  const s = _fedTailscaleState
  const title = `<h3 style="font-size:14px;font-weight:600;margin-bottom:6px">${t('federation.tailscale.title')}</h3>`
  let body
  if (s.status === 'connected') {
    body = `${title}
      <p style="font-size:12px;color:var(--text-muted);margin-bottom:10px">${t('federation.tailscale.hint')}</p>
      <div style="display:flex;flex-direction:column;gap:8px">
        <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap">
          <span style="font-size:12px;color:var(--text-muted);min-width:120px">${t('federation.tailscale.system_id_label')}</span>
          <code style="font-size:13px;word-break:break-all;flex:1">${escapeHtml(s.systemId || '-')}</code>
          <button type="button" class="btn-secondary btn-compact" data-copy="systemId">${t('federation.tailscale.copy_btn')}</button>
        </div>
        <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap">
          <span style="font-size:12px;color:var(--text-muted);min-width:120px">${t('federation.tailscale.base_url_label')}</span>
          <code style="font-size:13px;word-break:break-all;flex:1">${escapeHtml(s.baseUrl || '-')}</code>
          <button type="button" class="btn-secondary btn-compact" data-copy="baseUrl">${t('federation.tailscale.copy_btn')}</button>
        </div>
      </div>`
  } else if (s.status === 'pending') {
    body = `${title}
      <p role="status" aria-live="polite" style="font-size:13px">${t('federation.tailscale.pending')}</p>
      ${s.popupBlocked ? `<p style="color:var(--accent);font-size:12px;margin-top:6px">${t('federation.tailscale.popup_blocked')}</p>
        <button type="button" class="btn-primary btn-compact" id="fedTailscaleOpenLoginBtn">${t('federation.tailscale.open_login_btn')}</button>` : ''}`
  } else if (s.status === 'error') {
    body = `${title}
      <p style="color:var(--danger);font-size:13px">${escapeHtml(s.error || t('federation.tailscale.error_generic'))}</p>
      <button type="button" class="btn-secondary btn-compact" id="fedTailscaleLoginBtn">${t('federation.tailscale.retry_btn')}</button>
      <p style="font-size:11px;color:var(--text-muted);margin-top:6px">${t('federation.tailscale.manual_hint')}</p>`
  } else { // idle
    body = `${title}
      <p style="font-size:12px;color:var(--text-muted);margin-bottom:10px">${t('federation.tailscale.hint')}</p>
      <button type="button" class="btn-primary btn-compact" id="fedTailscaleLoginBtn">${t('federation.tailscale.login_btn')}</button>
      <p style="font-size:11px;color:var(--text-muted);margin-top:8px">${t('federation.tailscale.manual_hint')}</p>`
  }
  el.innerHTML = body
  el.querySelectorAll('[data-copy]').forEach(btn => btn.addEventListener('click', () => {
    const val = btn.dataset.copy === 'systemId' ? s.systemId : s.baseUrl
    navigator.clipboard?.writeText(val || '').then(
      () => showToast(t('federation.tailscale.copied')),
      () => {},
    )
  }))
  document.getElementById('fedTailscaleLoginBtn')?.addEventListener('click', fedTailscaleLogin)
  document.getElementById('fedTailscaleOpenLoginBtn')?.addEventListener('click', () => {
    // Defense in depth: _fedTailscaleLoginUrl is only ever set after fedTailscaleValidLoginUrl
    // passes (see fedTailscaleLogin), but this button is a second, independent call site -- it
    // re-checks rather than trusting that invariant silently held.
    if (_fedTailscaleLoginUrl && fedTailscaleValidLoginUrl(_fedTailscaleLoginUrl)) {
      window.open(_fedTailscaleLoginUrl, '_blank', 'noopener')
    }
  })
}

function fedTailscaleStopPoll() {
  if (_fedTailscalePollTimer) { clearInterval(_fedTailscalePollTimer); _fedTailscalePollTimer = null }
}

function fedTailscalePoll(pollToken) {
  fedTailscaleStopPoll()
  _fedTailscalePollAttempts = 0
  const check = async () => {
    const page = document.getElementById('federationPage')
    if (!page || page.hidden) { fedTailscaleStopPoll(); return } // left the page -- stop polling
    _fedTailscalePollAttempts++
    if (_fedTailscalePollAttempts > FED_TAILSCALE_POLL_MAX_ATTEMPTS) {
      fedTailscaleStopPoll()
      _fedTailscaleState = { status: 'error', error: t('federation.tailscale.error_generic') }
      fedTailscaleRender()
      return
    }
    try {
      const res = await fetch(`/api/federation/tailscale/status?pollToken=${encodeURIComponent(pollToken)}`)
      const data = await res.json().catch(() => ({}))
      if (!res.ok) {
        fedTailscaleStopPoll()
        _fedTailscaleState = { status: 'error', error: t('federation.tailscale.error_generic') }
        fedTailscaleRender()
        return
      }
      if (data.status === 'connected') {
        fedTailscaleStopPoll()
        _fedTailscaleState = { status: 'connected', systemId: data.systemId, baseUrl: data.baseUrl }
        fedTailscaleRender()
      } else if (data.status === 'failed') {
        fedTailscaleStopPoll()
        _fedTailscaleState = { status: 'error', error: t('federation.tailscale.error_generic') }
        fedTailscaleRender()
      }
      // 'pending' -- keep polling, the visible state is already "pending", nothing to re-render.
    } catch {
      fedTailscaleStopPoll()
      _fedTailscaleState = { status: 'error', error: t('federation.tailscale.error_generic') }
      fedTailscaleRender()
    }
  }
  check()
  _fedTailscalePollTimer = setInterval(check, 3000)
}

async function fedTailscaleLogin() {
  _fedTailscaleState = { status: 'pending', popupBlocked: false }
  fedTailscaleRender()
  try {
    const res = await fetch('/api/federation/tailscale/login', { method: 'POST' })
    const data = await res.json().catch(() => ({}))
    if (!res.ok) {
      // Cybered MEDIUM (gate-sha 1c3b95a2): never render data.error raw. The contract behind it
      // is still DRAFT -- backend's promise that `error` is always a curated, non-leaking string
      // is not yet backed by shipped code, so trusting it now would be trusting a control that
      // does not exist yet. Show the localized generic message until backend ships an errorCode
      // the UI can map to a specific i18n key.
      _fedTailscaleState = { status: 'error', error: t('federation.tailscale.error_generic') }
      fedTailscaleRender()
      return
    }
    // Contract v2: pollToken is unconditional (both branches), but this stays a real check, not
    // an assumption -- a contract saying "always" is not the same as a response that always does,
    // and failing to the error state below costs nothing if it never actually triggers.
    if (!data.pollToken) {
      _fedTailscaleState = { status: 'error', error: t('federation.tailscale.error_generic') }
      fedTailscaleRender()
      return
    }
    const loginUrl = data.loginUrl || null
    if (loginUrl && !fedTailscaleValidLoginUrl(loginUrl)) {
      // Cybered NO-GO (HIGH): a login-intent flow must never navigate to an unvalidated URL --
      // refuse outright rather than open it, regardless of what backend eventually sends.
      _fedTailscaleLoginUrl = null
      _fedTailscaleState = { status: 'error', error: t('federation.tailscale.error_generic') }
      fedTailscaleRender()
      return
    }
    _fedTailscaleLoginUrl = loginUrl
    let popupBlocked = false
    if (loginUrl) {
      const win = window.open(loginUrl, '_blank', 'noopener')
      if (!win) popupBlocked = true // browser blocked the automatic pop-up -- fallback button
    }
    _fedTailscaleState = { status: 'pending', popupBlocked }
    fedTailscaleRender()
    fedTailscalePoll(data.pollToken)
  } catch {
    _fedTailscaleState = { status: 'error', error: t('federation.tailscale.error_generic') }
    fedTailscaleRender()
  }
}

function wireFederationPage() {
  if (fedPageWired) return
  fedPageWired = true
  const fedApplyBtn = document.getElementById('federationApplyBtn')
  if (fedApplyBtn) { fedApplyBtn.title = t('federation.apply_hint'); fedApplyBtn.addEventListener('click', fedApplyToMainAgent) }
  document.getElementById('federationAddPeerBtn')?.addEventListener('click', () => fedOpenPeerModal(null))
  document.getElementById('federationRemoveBtn')?.addEventListener('click', fedRemoveAll)
  document.getElementById('fedPeerModalSave')?.addEventListener('click', fedSavePeerModal)
  document.getElementById('fedPeerModalCancel')?.addEventListener('click', () => closeModal(document.getElementById('fedPeerModalOverlay')))
  document.getElementById('fedPeerModalClose')?.addEventListener('click', () => closeModal(document.getElementById('fedPeerModalOverlay')))
  const overlay = document.getElementById('fedPeerModalOverlay')
  overlay?.addEventListener('click', (e) => { if (e.target === overlay) closeModal(overlay) })
}

