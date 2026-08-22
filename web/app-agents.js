// Globals from app.js: t, showToast, escapeHtml, openModal, closeModal, agents, agentsGrid, addBtn,
//   mainAgentId, avatarBust, switchAgentTab, loadAvailableModels, currentAgent, currentChannelProvider
// Globals from app-auth-channel.js: agentIsConnected, updateChannelTab, updateProviderUI
// Globals from app-skills-detail.js: loadSkills
// Globals from app-terminal.js: handleAgentLogin, openTerminalModal
// Globals from app-conversation.js: openConversationModal
// Exposed globally: loadAgents(), renderAgents(), startAgentsBusyPoll(), stopAgentsBusyPoll()
//   -- loadAgents() called from switchPage in app.js
//   -- startAgentsBusyPoll() / stopAgentsBusyPoll() called from switchPage in app.js

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

// Populate the idle-flush controls from an agent payload. Same source as
// setupAutoRestartUI (the agent detail carries contextGuard alongside
// autoRestart), so the settings pane needs no extra fetch.
//
// The tokens field is shown in THOUSANDS: the stored value is an absolute
// token count, and asking an operator to type 500000 into a box invites the
// 500 that normalizeContextGuardConfig has to defend against.
function setupIdleFlushUI(agent) {
  const cg = (agent && agent.contextGuard) || { idleFlushEnabled: false, idleFlushTokens: 400000, idleMinutes: 20 }
  const enabled = document.getElementById('ifEnabled')
  const tokens = document.getElementById('ifTokens')
  const minutes = document.getElementById('ifMinutes')
  if (!enabled || !tokens || !minutes) return
  enabled.checked = cg.idleFlushEnabled === true
  tokens.value = Math.round((cg.idleFlushTokens || 400000) / 1000)
  minutes.value = cg.idleMinutes || 20
  showIdleFlushScheduleWarning(agent)
}

// Warn when this agent has ANY scheduled task, because the idle clock is the
// transcript mtime and every scheduled wake writes to the transcript: a
// schedule that fires more often than idleMinutes means the tier can never
// accumulate enough quiet and will sit switched on doing nothing.
//
// Deliberately NOT a computed comparison of cron period vs idleMinutes. A cron
// parser in the settings pane is a lot of fragile surface for a hint, and it
// would be silent exactly when it got a schedule shape wrong. Listing the
// schedules and letting the operator judge is both cheaper and harder to make
// quietly incorrect.
async function showIdleFlushScheduleWarning(agent) {
  const box = document.getElementById('ifScheduleWarning')
  if (!box) return
  // Clear as well as hide: the pane is reused for every agent, and a stale
  // warning left in the node is one accidental unhide away from naming the
  // wrong agent's schedules.
  box.hidden = true
  box.textContent = ''
  const id = (agent && (agent.autoRestartId || agent.name)) || null
  if (!id) return
  try {
    const res = await fetch('/api/schedules')
    if (!res.ok) return
    const all = await res.json()
    const mine = (Array.isArray(all) ? all : []).filter(t => t && t.agent === id && t.schedule)
    if (!mine.length) return
    const list = mine.map(t => `${t.name} (${t.schedule})`).join(', ')
    box.textContent = t('agents.settings.idle_flush_sched_warning').replace('{list}', list)
    box.hidden = false
  } catch { /* the hint is best-effort; never break the pane over it */ }
}

async function openMarveenDetail() {
  const m = window._marveen
  if (!m) return

  // Reuse the agent detail modal for Marveen
  currentAgent = { ...m, name: mainAgentId(), claudeMd: '', soulMd: '', mcpJson: '', skills: [] }
  setupAutoRestartUI(currentAgent)
  setupIdleFlushUI(currentAgent)

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

