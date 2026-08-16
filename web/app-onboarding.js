// === app-onboarding.js: First-run onboarding wizard ===
// Globals from app.js: t, escapeHtml, mainAgentId, showSudoModal
// Globals from app-messages.js: ensureMarveenLoaded
// Globals from app-overview.js: initSidebarBrand
// app-onboarding.js is loaded AFTER app.js in index.html.
// initOnboarding() self-inits at the end of THIS file (not from app.js's
// Init block -- calling it there ran before this file loaded, ReferenceError
// on every page load, card 243de9b9).

// Full-screen overlay shown when /api/onboarding/status reports the install
// still needs setup (pre-install-now / configure-later flow). Steps 2-3 reuse
// the existing channel-setup + pairing backend endpoints.
async function fetchOnboardingStatus() {
  try { return await (await fetch('/api/onboarding/status')).json() } catch { return null }
}
// WIZFLOW809 BEGIN waitForChannelLive
// Poll the onboarding status until the channel is MEASURABLY live
// (status.channelLive: the bun-child/process liveness the channel-monitor
// uses), instead of a fixed setTimeout. The restart response's
// `restarted: true` is only a dispatch receipt -- on the cold path the real
// start takes ~minutes, and a fixed wait opened the pairing step against a
// still-booting session (WIZFLOW809, three field reports). Checks BEFORE the
// first sleep so an already-live channel advances immediately; a timeout is
// NOT success -- the caller must keep the user on this step and say the
// channel is still starting. Dependencies are parameters so the slow path is
// unit-testable with a delayed fake signal (the acceptance criterion: the
// wizard WAITS, it does not get lucky with timing).
async function waitForChannelLive(fetchStatus, delayMs, maxTries) {
  for (let i = 0; i < maxTries; i++) {
    const st = await fetchStatus()
    if (st && st.channelLive) return 'live'
    await new Promise((r) => setTimeout(r, delayMs))
  }
  return 'timeout'
}
// WIZFLOW809 END waitForChannelLive
function onboardingCurrentStep(s) {
  if (!s.identityConfirmed) return 1
  if (!s.claudeAuthPresent || !s.agentsRunning) return 2
  if (!s.channelConfigured) return 3
  if (!s.paired) return 4
  return 0
}
// Operator can dismiss the wizard (skip/close). A false positive must never
// lock the dashboard, so the choice persists across reloads; normal UI still
// covers any real setup that remains.
const ONBOARDING_DISMISS_KEY = 'mvOnboardingDismissed'
function onboardingDismissed() {
  try { return localStorage.getItem(ONBOARDING_DISMISS_KEY) === '1' } catch { return false }
}
function dismissOnboarding() {
  try { localStorage.setItem(ONBOARDING_DISMISS_KEY, '1') } catch { /* private mode */ }
  const overlay = document.getElementById('onboardingOverlay')
  if (overlay) { overlay.classList.remove('active'); overlay.hidden = true }
  document.body.style.overflow = ''
}
async function initOnboarding() {
  if (onboardingDismissed()) return
  const s = await fetchOnboardingStatus()
  if (!s || !s.needsOnboarding) return
  renderOnboarding(s)
}
async function refreshOnboarding() {
  const s = await fetchOnboardingStatus()
  if (s) renderOnboarding(s)
}
let onboardingChannelProvider = 'telegram'
let onboardingAgentId = null
// The step-3 tab is a static HTML label ("Telegram bot") that renderStaticI18n's generic data-i18n sweep would otherwise reset
// to the Telegram wording on every language switch, so both call sites re-apply the provider-specific text here.
function applyOnboardingProviderTab() {
  const el = document.querySelector('#onboardingSteps .onboarding-step[data-ostep="3"] span:last-child')
  if (el) el.textContent = onboardingChannelProvider === 'slack' ? t('onboarding.step2.tab_slack') : t('onboarding.step2.tab')
}
function renderOnboarding(s) {
  if (onboardingDismissed()) return
  const overlay = document.getElementById('onboardingOverlay')
  if (!overlay) return
  if (s.channelProvider) onboardingChannelProvider = s.channelProvider
  if (s.agentId) onboardingAgentId = s.agentId
  applyOnboardingProviderTab()
  const step = onboardingCurrentStep(s)
  if (step === 0) { overlay.classList.remove('active'); overlay.hidden = true; document.body.style.overflow = ''; return }
  overlay.hidden = false
  overlay.classList.add('active')
  document.body.style.overflow = 'hidden'
  document.querySelectorAll('#onboardingSteps .onboarding-step').forEach((el) => {
    const n = Number(el.dataset.ostep)
    el.classList.toggle('active', n === step)
    el.classList.toggle('done', n < step)
  })
  // The steps build on each other and the system only comes alive at the end
  // of step 4 -- say so, or a fresh installer reads step 2's "saved" as "done"
  // and every later "bot token not found" as a failure (BK bootcamp, 07-28).
  const flowNote = document.getElementById('onbFlowNote')
  if (flowNote) flowNote.textContent = step === 4 ? t('onboarding.flow_note_last') : t('onboarding.flow_note')
  const body = document.getElementById('onboardingBody')
  if (step === 1) body.innerHTML = onbIdentityHtml(s)
  else if (step === 2) body.innerHTML = onbStep1Html(s)
  else if (step === 3) body.innerHTML = onbStep2Html(s)
  else body.innerHTML = onbStep3Html(s)
  wireOnboarding(step)
  // Step 3, token already on disk, managed-settings.json still missing: the status GET already knows this (no probe/write/restart triggered),
  // so show the sudo command right away instead of waiting for a Save click. Retry just re-polls status -- no token POST, no channel restart.
  if (step === 3 && s.sudoCommand) showSudoModal(s.sudoCommand, () => refreshOnboarding())
}
function onbMsg(text, isErr) {
  const el = document.getElementById('onbMsg')
  if (el) { el.textContent = text; el.className = 'onb-msg' + (isErr ? ' err' : ' ok') }
}
function onbIdentityHtml(s) {
  return `<p>${escapeHtml(t('onboarding.identity.desc'))}</p>`
    + `<label class="form-label-sm">${escapeHtml(t('onboarding.identity.agent_label'))}</label>`
    + `<input id="onbAgentName" type="text" class="onb-input" maxlength="40" value="${escapeHtml(s.currentAgentName || '')}" autocomplete="off">`
    + `<label class="form-label-sm">${escapeHtml(t('onboarding.identity.owner_label'))}</label>`
    + `<input id="onbOwnerName" type="text" class="onb-input" maxlength="60" value="${escapeHtml(s.currentOwnerName || '')}" autocomplete="off">`
    + `<div class="onb-hint">${escapeHtml(t('onboarding.identity.hint'))}</div>`
    + `<button class="btn-primary btn-compact" id="onbIdentityBtn">${escapeHtml(t('onboarding.identity.save_btn'))}</button>`
    + `<div id="onbMsg" class="onb-msg"></div>`
}
function onbStep1Html(s) {
  return `<p>${escapeHtml(t('onboarding.step1.desc'))}</p>`
    + (s.claudeAuthPresent
      ? `<p class="onb-ok-line">${escapeHtml(t('onboarding.step1.auth_done'))}</p>`
      : `<label class="form-label-sm">${escapeHtml(t('onboarding.step1.token_label'))}</label>`
        + `<input id="onbToken" type="password" class="onb-input" placeholder="sk-ant-oat01-..." autocomplete="off">`
        + `<div class="onb-hint">${escapeHtml(t('onboarding.step1.token_hint'))}</div>`
        + `<button class="btn-primary btn-compact" id="onbAuthBtn">${escapeHtml(t('onboarding.step1.save_btn'))}</button>`)
    + (s.claudeAuthPresent && !s.agentsRunning
      ? `<button class="btn-primary btn-compact" id="onbLaunchBtn">${escapeHtml(t('onboarding.step1.launch_btn'))}</button>`
      : '')
    + `<div id="onbMsg" class="onb-msg"></div>`
}
function onbStep2Html(s) {
  const isSlack = onboardingChannelProvider === 'slack'
  const desc = isSlack ? t('onboarding.step2.desc_slack') : t('onboarding.step2.desc')
  const tokenLabel = isSlack ? t('onboarding.step2.token_label_slack') : t('onboarding.step2.token_label')
  const tokenHint = isSlack ? t('onboarding.step2.token_hint_slack') : t('onboarding.step2.token_hint')
  const placeholder = isSlack ? 'xoxb-...' : '123456:ABC...'
  // Pre-fill from a token already on disk (e.g. a prior save that stopped at the managed-settings.json gate) so the operator isn't forced to dig it
  // back out of ~/.claude/channels/<provider>/.env and repaste it. Saving still re-runs the managed-settings check server-side either way.
  const existingBotToken = (s && s.existingBotToken) || ''
  const existingAppToken = (s && s.existingAppToken) || ''
  const appTokenFields = isSlack
    ? `<label class="form-label-sm">${escapeHtml(t('onboarding.step2.app_token_label_slack'))}</label>`
      + `<input id="onbSlackAppToken" type="password" class="onb-input" placeholder="xapp-..." value="${escapeHtml(existingAppToken)}" autocomplete="off" required>`
      + `<div class="onb-hint">${escapeHtml(t('onboarding.step2.app_token_hint_slack'))}</div>`
    : ''
  return `<p>${escapeHtml(desc)}</p>`
    + `<label class="form-label-sm">${escapeHtml(tokenLabel)}</label>`
    + `<input id="onbBotToken" type="password" class="onb-input" placeholder="${placeholder}" value="${escapeHtml(existingBotToken)}" autocomplete="off">`
    + `<div class="onb-hint">${escapeHtml(tokenHint)}</div>`
    + appTokenFields
    + `<button class="btn-primary btn-compact" id="onbBotBtn">${escapeHtml(t('onboarding.step2.save_btn'))}</button>`
    + `<div id="onbMsg" class="onb-msg"></div>`
}
function onbStep3Html(s) {
  // Pairing needs the channels session up (the wizard restarted it after the
  // bot-token save) -- show its state so a not-yet-up service reads as
  // "starting", not as the user's failure.
  const svcLine = s && s.agentsRunning
    ? `<p class="onb-ok-line">${escapeHtml(t('onboarding.step3.svc_up'))}</p>`
    : `<p class="onb-hint">${escapeHtml(t('onboarding.step3.svc_starting'))}</p>`
  return `<p>${escapeHtml(t('onboarding.step3.desc'))}</p>`
    + svcLine
    + `<ol class="onb-list"><li>${escapeHtml(t('onboarding.step3.li1'))}</li><li>${escapeHtml(t('onboarding.step3.li2'))}</li></ol>`
    + `<div id="onbPending" class="onb-pending"></div>`
    + `<button class="btn-secondary btn-compact" id="onbRefreshBtn">${escapeHtml(t('onboarding.step3.refresh_btn'))}</button>`
    + `<div id="onbMsg" class="onb-msg"></div>`
}
function wireOnboarding(step) {
  if (step === 1) {
    const idBtn = document.getElementById('onbIdentityBtn')
    if (idBtn) idBtn.addEventListener('click', async () => {
      const agentName = (document.getElementById('onbAgentName').value || '').trim()
      const ownerName = (document.getElementById('onbOwnerName').value || '').trim()
      if (!agentName || !ownerName) { onbMsg(t('onboarding.identity.empty'), true); return }
      idBtn.disabled = true; onbMsg(t('onboarding.saving'))
      try {
        const res = await fetch('/api/onboarding/identity', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ agentName, ownerName }) })
        const d = await res.json().catch(() => ({}))
        if (!res.ok) { idBtn.disabled = false; onbMsg(d.error || t('onboarding.error'), true); return }
        // The name is live in the .env now -- repaint the chrome from
        // /api/marveen so the sidebar/title reflect it immediately, and
        // surface the automatic channels restart (same pattern as the
        // claude-auth step) instead of silently advancing.
        if (typeof initSidebarBrand === 'function') initSidebarBrand()
        if (d.restartError) { idBtn.disabled = false; onbMsg(t('onboarding.identity.saved_restart_failed'), true); setTimeout(refreshOnboarding, 6000); return }
        if (d.restarted) { onbMsg(t('onboarding.identity.saved_restarted')); setTimeout(refreshOnboarding, 2500); return }
        if (d.restartNeeded) { onbMsg(t('onboarding.identity.saved_restart_needed')); await refreshOnboarding(); return }
        onbMsg(t('onboarding.identity.saved'))
        await refreshOnboarding()
      } catch (e) { idBtn.disabled = false; onbMsg((e && e.message) || t('onboarding.error'), true) }
    })
    return
  }
  if (step === 2) {
    const authBtn = document.getElementById('onbAuthBtn')
    if (authBtn) authBtn.addEventListener('click', async () => {
      const token = (document.getElementById('onbToken').value || '').trim()
      if (!token) { onbMsg(t('onboarding.step1.token_empty'), true); return }
      authBtn.disabled = true; onbMsg(t('onboarding.saving'))
      try {
        const res = await fetch('/api/onboarding/claude-auth', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token }) })
        const d = await res.json().catch(() => ({}))
        if (!res.ok) { authBtn.disabled = false; onbMsg(d.error || t('onboarding.error'), true); return }
        // Fresh-install path: the server restarts the (previously
        // unauthenticated) channels session right after the first auth save --
        // surface that, and on failure show the manual restart step instead of
        // silently advancing.
        if (d.restartError) { authBtn.disabled = false; onbMsg(t('onboarding.step1.saved_restart_failed'), true); setTimeout(refreshOnboarding, 6000); return }
        if (d.restarted) { onbMsg(t('onboarding.step1.saved_restarted')); setTimeout(refreshOnboarding, 2500); return }
        onbMsg(d.verified ? t('onboarding.step1.saved_verified') : t('onboarding.step1.saved_unverified'))
        await refreshOnboarding()
      } catch (e) { authBtn.disabled = false; onbMsg((e && e.message) || t('onboarding.error'), true) }
    })
    const launchBtn = document.getElementById('onbLaunchBtn')
    if (launchBtn) launchBtn.addEventListener('click', async () => {
      launchBtn.disabled = true; onbMsg(t('onboarding.step1.launching'))
      try {
        const res = await fetch('/api/onboarding/launch', { method: 'POST' })
        const d = await res.json().catch(() => ({}))
        if (!res.ok) { launchBtn.disabled = false; onbMsg(d.error || t('onboarding.error'), true); return }
        onbMsg(t('onboarding.step1.launched'))
        // On a fresh install the session is CREATED here (ONBTMUX1) and takes a
        // ~minute cold start via channels.sh. Poll until it is up so the wizard
        // advances on its own instead of stranding the user on step 2 after a
        // single 2.5s re-check. Bounded so a genuinely failed start still hands
        // control back rather than spinning forever.
        let up = false
        for (let i = 0; i < 40 && !up; i++) {  // ~40 x 3s = 2 min
          await new Promise((r) => setTimeout(r, 3000))
          const st = await fetchOnboardingStatus()
          if (st && st.agentsRunning) { up = true; break }
        }
        if (up) { await refreshOnboarding() }
        // Timeout is NOT success: on a slow machine the cold start can outlast
        // the 2-min bound while still being healthy, so the message must say
        // "still starting, check back / refresh" -- repeating the launched
        // message here would also mask a genuinely dead start (PR #779 review).
        else { launchBtn.disabled = false; onbMsg(t('onboarding.step1.launch_slow'), true) }
      } catch (e) { launchBtn.disabled = false; onbMsg((e && e.message) || t('onboarding.error'), true) }
    })
  } else if (step === 3) {
    const botBtn = document.getElementById('onbBotBtn')
    if (botBtn) botBtn.addEventListener('click', async () => {
      const botToken = (document.getElementById('onbBotToken').value || '').trim()
      if (!botToken) { onbMsg(t('onboarding.step2.token_empty'), true); return }
      const payload = { botToken }
      if (onboardingChannelProvider === 'slack') {
        const appToken = (document.getElementById('onbSlackAppToken')?.value || '').trim()
        // Required, not optional: without SLACK_APP_TOKEN the channel session starts but Socket Mode never connects,
        // so "saved" would read as success while Slack silently never comes online.
        if (!appToken) { onbMsg(t('onboarding.step2.app_token_empty_slack'), true); return }
        payload.appToken = appToken
      }
      botBtn.disabled = true; onbMsg(t('onboarding.saving'))
      try {
        const res = await fetch(`/api/agents/${encodeURIComponent(onboardingAgentId || mainAgentId())}/channels/${onboardingChannelProvider}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) })
        const d = await res.json().catch(() => ({}))
        if (res.status === 409 && d.error === 'managed-settings-missing') {
          botBtn.disabled = false
          showSudoModal(d.sudoCommand, () => botBtn.click())
          return
        }
        if (!res.ok) { botBtn.disabled = false; onbMsg(d.error || t('onboarding.error'), true); return }
        // The server restarts the channels session so the new bot token goes
        // live. Do NOT advance on a timer: the restart response is a dispatch
        // receipt, and the cold start is ~minutes. Wait for the MEASURED
        // channelLive signal, tell the user the channel is starting meanwhile,
        // and on timeout stay on this step with an honest "still starting"
        // message -- the old fixed 4s opened the pairing step against a
        // booting session, which looked done-and-empty (WIZFLOW809).
        onbMsg(d.restarted ? t('onboarding.step2.saved_restarted') : t('onboarding.step2.saved'))
        onbMsg(t('onboarding.step2.waiting_channel'))
        const outcome = await waitForChannelLive(fetchOnboardingStatus, 3000, 40)  // ~2 min bound
        if (outcome === 'live') { await refreshOnboarding() }
        else { botBtn.disabled = false; onbMsg(t('onboarding.step2.channel_slow'), true) }
      } catch (e) { botBtn.disabled = false; onbMsg((e && e.message) || t('onboarding.error'), true) }
    })
  } else if (step === 4) {
    const refreshBtn = document.getElementById('onbRefreshBtn')
    // One sink for both failure paths. The box alone was not enough: it renders
    // in the same muted onb-hint slot as "no pending", so the very distinction
    // this fix is about -- "nobody is waiting" vs "I could not ask" -- stayed
    // invisible. onbMsg is the error channel this function already uses for the
    // approve step a few lines below.
    const showPendingError = (msg) => {
      const box = document.getElementById('onbPending')
      if (box) box.innerHTML = `<span class="onb-hint">${escapeHtml(msg)}</span>`
      onbMsg(msg, true)
    }
    const loadPending = async () => {
      try {
        // Same boot race the Messages page already guards against (see
        // ensureMarveenLoaded): until /api/marveen resolves window._marveen,
        // mainAgentId() returns the literal 'marveen' fallback. On a renamed
        // install that is not the main agent, so the backend takes the
        // sub-agent branch, finds no such agent dir and answers 404 -- and the
        // wizard rendered that as "no pending pairing" while the Channel view,
        // which uses the selected agent, listed the very same request.
        await ensureMarveenLoaded()
        const res = await fetch(`/api/agents/${encodeURIComponent(onboardingAgentId || mainAgentId())}/channels/${onboardingChannelProvider}/pending`)
        // Surface the failure instead of rendering it as an empty list. This is
        // a separate defect from the id race: without it a 404 or an auth error
        // reads as "nobody is waiting for approval", which is the one answer the
        // user cannot act on. A NETWORK failure does not land here at all -- the
        // fetch rejects -- so the outer catch carries the same message; see the
        // end of this function. The two together are what make the comment true.
        if (!res.ok) {
          const d = await res.json().catch(() => ({}))
          showPendingError(d.error || t('onboarding.error'))
          return
        }
        const p = await res.json()
        // Backend contract: [{code, senderId, chatId, createdAt, expiresAt}].
        // `code` is the approve key (the same code the bot sent the user) --
        // POSTing anything else gets a 400 and the pairing never completes.
        const now = Date.now()
        const list = (Array.isArray(p) ? p : (p.pending || [])).filter((x) => x && x.code && (!x.expiresAt || x.expiresAt > now))
        const box = document.getElementById('onbPending')
        if (!box) return
        if (!list.length) { box.innerHTML = `<span class="onb-hint">${escapeHtml(t('onboarding.step3.no_pending'))}</span>`; return }
        box.innerHTML = list.map((x) => {
          const code = escapeHtml(String(x.code))
          const label = escapeHtml(String(x.senderId || x.chatId || '?')) + ' · ' + code
          return `<div class="onb-pending-row"><span>${label}</span><button class="btn-primary btn-compact onb-approve" data-code="${code}">${escapeHtml(t('onboarding.step3.approve_btn'))}</button></div>`
        }).join('')
        box.querySelectorAll('.onb-approve').forEach((b) => b.addEventListener('click', async () => {
          b.disabled = true
          try {
            const res = await fetch(`/api/agents/${encodeURIComponent(onboardingAgentId || mainAgentId())}/channels/${onboardingChannelProvider}/approve`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code: b.dataset.code }) })
            const d = await res.json().catch(() => ({}))
            if (!res.ok) { b.disabled = false; onbMsg(d.error || t('onboarding.error'), true); return }
            onbMsg(t('onboarding.step3.approved'))
            setTimeout(refreshOnboarding, 1500)
          } catch (e) { b.disabled = false; onbMsg((e && e.message) || t('onboarding.error'), true) }
        }))
      } catch (e) {
        // Network-level failure: the fetch rejected, so the !res.ok branch never
        // ran. Without this the box stays empty and the user reads it as "nobody
        // is waiting" -- the exact defect this change is about.
        showPendingError((e && e.message) || t('onboarding.error'))
      }
    }
    if (refreshBtn) refreshBtn.addEventListener('click', () => { refreshOnboarding() })
    loadPending()
  }
}

// === Self-init (card 243de9b9) ===
// Runs here, not from app.js's Init block -- app-onboarding.js loads AFTER
// app.js, so calling this from app.js would ReferenceError on every page
// load (the live regression Cybered/Cybersec caught). Matches the
// self-init convention already used by app-overview.js's loadOverview().
{
  const onbClose = document.getElementById('onboardingClose')
  if (onbClose) onbClose.addEventListener('click', dismissOnboarding)
}
initOnboarding()
