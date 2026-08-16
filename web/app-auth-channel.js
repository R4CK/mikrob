// === app-auth-channel.js ===
// Auth Mode settings panel + Channel tab (provider-aware connect/disconnect,
// pairing, allowlist, invites, channel requests, smoke-test, pending pairings).
// Extracted from app.js as part of modularisation (slice 21/N).
// This file is loaded AFTER app.js via a synchronous <script> tag in index.html.
//
// Globals from app.js: t, escapeHtml, showToast, openModal, closeModal,
//   currentAgent, loadAgents, currentChannelProvider
// Functions called from app.js at event-time only:
//   selectAuthModeCard, updateAuthModeUI, agentIsConnected, updateChannelTab,
//   updateProviderUI, refreshChannelHealth, refreshPendingPairings, getProviderLabel
// === Auth Mode ===
function selectAuthModeCard(mode) {
  document.querySelectorAll('.auth-mode-card').forEach(c => {
    const isSelected = c.dataset.mode === mode
    c.classList.toggle('selected', isSelected)
    c.querySelector('input[type="radio"]').checked = isSelected
  })
  document.getElementById('authModeSharedSection').hidden = mode !== 'shared'
  document.getElementById('authModeApiKeySection').hidden = mode !== 'api'
  document.getElementById('authModeOwnTeamSection').hidden = mode !== 'own_team'
  document.getElementById('authFlowResult').hidden = true
  document.getElementById('authFlowError').hidden = true
  document.getElementById('authSharedError').hidden = true
}

function updateAuthModeUI(mode, hasApiKey) {
  selectAuthModeCard(mode)
  const keyInput = document.getElementById('editAgentApiKey')
  keyInput.value = ''
  if (mode === 'api') {
    const statusEl = document.getElementById('authModeApiKeyStatus')
    statusEl.textContent = hasApiKey ? t('agents.api_key.ok') : t('agents.api_key.missing')
    statusEl.style.color = hasApiKey ? 'var(--success)' : 'var(--warning)'
  }
}

document.querySelectorAll('.auth-mode-card').forEach(card => {
  card.addEventListener('click', () => {
    selectAuthModeCard(card.dataset.mode)
  })
})

document.getElementById('authSharedApplyBtn').addEventListener('click', async () => {
  if (!currentAgent) return
  const btn = document.getElementById('authSharedApplyBtn')
  const btnText = btn.querySelector('.btn-text')
  const btnLoading = btn.querySelector('.btn-loading')
  const errorDiv = document.getElementById('authSharedError')
  errorDiv.hidden = true
  btnText.hidden = true
  btnLoading.hidden = false
  btn.disabled = true
  try {
    const base = `/api/agents/${encodeURIComponent(currentAgent.name)}`
    const saveRes = await fetch(base, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ authMode: 'shared' }),
    })
    if (!saveRes.ok) throw new Error('Save failed')
    if (currentAgent.running) {
      await fetch(`${base}/stop`, { method: 'POST' })
      await new Promise(r => setTimeout(r, 2000))
      const startRes = await fetch(`${base}/start`, { method: 'POST' })
      const startData = await startRes.json()
      if (!startRes.ok) {
        errorDiv.textContent = startData.error || t('agents.error.restart')
        errorDiv.hidden = false
        return
      }
    }
    showToast(t('agents.toast.host_oauth_restart'))
    loadAgents()
    const detailRes = await fetch(base)
    if (detailRes.ok) {
      currentAgent = await detailRes.json()
      updateAuthModeUI(currentAgent.authMode || 'shared', currentAgent.hasApiKey || false)
      updateProcessControl(currentAgent)
    }
  } catch {
    errorDiv.textContent = t('agents.error.apply')
    errorDiv.hidden = false
  } finally {
    btnText.hidden = false
    btnLoading.hidden = true
    btn.disabled = false
  }
})

document.getElementById('authFlowInitBtn').addEventListener('click', async () => {
  if (!currentAgent) return
  const btn = document.getElementById('authFlowInitBtn')
  const btnText = btn.querySelector('.btn-text')
  const btnLoading = btn.querySelector('.btn-loading')
  const resultDiv = document.getElementById('authFlowResult')
  const errorDiv = document.getElementById('authFlowError')
  resultDiv.hidden = true
  errorDiv.hidden = true
  btnText.hidden = true
  btnLoading.hidden = false
  btn.disabled = true
  try {
    const res = await fetch(`/api/agents/${encodeURIComponent(currentAgent.name)}/auth/init`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
    })
    const data = await res.json()
    if (data.ok && data.authUrl) {
      const urlEl = document.getElementById('authFlowUrl')
      urlEl.href = data.authUrl
      urlEl.textContent = data.authUrl
      resultDiv.hidden = false
    } else {
      errorDiv.textContent = data.error || 'Auth URL nem talalhato'
      errorDiv.hidden = false
    }
  } catch {
    errorDiv.textContent = t('agents.error.auth_network')
    errorDiv.hidden = false
  } finally {
    btnText.hidden = false
    btnLoading.hidden = true
    btn.disabled = false
  }
})

document.getElementById('authFlowCopyBtn').addEventListener('click', () => {
  const url = document.getElementById('authFlowUrl').textContent
  navigator.clipboard.writeText(url).then(() => showToast('URL masolva'))
})

document.getElementById('memoryIsolationToggle').addEventListener('change', async (e) => {
  if (!currentAgent || currentAgent.role === 'main') return
  const enabled = e.target.checked
  try {
    const res = await fetch(`/api/agents/${encodeURIComponent(currentAgent.name)}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ memoryIsolation: enabled }),
    })
    if (!res.ok) throw new Error()
    currentAgent.memoryIsolation = enabled
    showToast(t(enabled ? 'agents.toast.memory_isolation_on' : 'agents.toast.memory_isolation_off'))
  } catch {
    e.target.checked = !enabled
    showToast(t('common.error_save'))
  }
})

document.getElementById('saveAuthModeBtn').addEventListener('click', async () => {
  if (!currentAgent || currentAgent.role === 'main') return
  const mode = document.querySelector('input[name="authMode"]:checked')?.value || 'shared'
  const payload = { authMode: mode }
  if (mode === 'api') {
    const key = document.getElementById('editAgentApiKey').value.trim()
    if (key) payload.apiKey = key
  }
  try {
    const res = await fetch(`/api/agents/${encodeURIComponent(currentAgent.name)}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    })
    if (!res.ok) throw new Error()
    showToast(t('agents.toast.auth_mode_saved'))
    loadAgents()
    const detailRes = await fetch(`/api/agents/${encodeURIComponent(currentAgent.name)}`)
    if (detailRes.ok) {
      const updated = await detailRes.json()
      currentAgent = updated
      updateAuthModeUI(updated.authMode || 'shared', updated.hasApiKey || false)
    }
  } catch { showToast(t('common.error_save')) }
})

document.getElementById('saveClaudeMdBtn').addEventListener('click', async () => {
  if (!currentAgent) return
  try {
    const res = await fetch(`/api/agents/${encodeURIComponent(currentAgent.name)}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ claudeMd: document.getElementById('editClaudeMd').value }),
    })
    if (!res.ok) throw new Error()
    showToast(t('agents.claude_md_saved'))
  } catch { showToast(t('common.error_save')) }
})

document.getElementById('saveSoulMdBtn').addEventListener('click', async () => {
  if (!currentAgent) return
  try {
    const res = await fetch(`/api/agents/${encodeURIComponent(currentAgent.name)}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ soulMd: document.getElementById('editSoulMd').value }),
    })
    if (!res.ok) throw new Error()
    showToast(t('agents.soul_md_saved'))
  } catch { showToast(t('common.error_save')) }
})

document.getElementById('saveMcpJsonBtn').addEventListener('click', async () => {
  if (!currentAgent) return
  try {
    const res = await fetch(`/api/agents/${encodeURIComponent(currentAgent.name)}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ mcpJson: document.getElementById('editMcpJson').value }),
    })
    if (!res.ok) throw new Error()
    showToast('.mcp.json mentve')
  } catch { showToast(t('common.error_save')) }
})

// === Channel tab ===
// Provider-aware "connected" check: a sub-agent record carries hasTelegram /
// hasDiscord / hasSlack flags from the backend, Marveen carries the same
// shape from /api/marveen. Falls back to hasTelegram for legacy callers.
function agentIsConnected(agent) {
  if (!agent) return false
  if (currentChannelProvider === 'discord') return !!agent.hasDiscord
  if (currentChannelProvider === 'slack') return !!agent.hasSlack
  if (currentChannelProvider === 'teams') return !!agent.hasTeams
  return !!agent.hasTelegram
}

function getProviderLabel() {
  if (currentChannelProvider === 'discord') return 'Discord'
  if (currentChannelProvider === 'slack') return 'Slack'
  if (currentChannelProvider === 'teams') return 'Microsoft Teams'
  return 'Telegram'
}

// Connected-view help text per provider. Returns innerHTML for the
// #chHowtoContent <div> -- swapped on every updateProviderUI() call so the
// "Hogyan adj hozzá több embert vagy csoportot?" panel matches the active
// channel provider.
function buildHowtoHtml() {
  if (currentChannelProvider === 'discord') return t('channel.howto.discord')
  if (currentChannelProvider === 'slack') return t('channel.howto.slack')
  if (currentChannelProvider === 'teams') return t('channel.howto.teams')
  return t('channel.howto.telegram')
}

function updateProviderUI() {
  const isTg = currentChannelProvider === 'telegram'
  const title = document.getElementById('chSetupTitle')
  const steps = document.getElementById('chSetupSteps')
  const label = document.getElementById('chTokenLabel')
  const input = document.getElementById('chTokenInput')
  const slackGroup = document.getElementById('chSlackAppTokenGroup')
  const manifestBtnGroup = document.getElementById('chSlackManifestBtnGroup')
  const smokeTestBtn = document.getElementById('chSmokeTestBtn')
  const reconnectBtn = document.getElementById('chReconnectBtn')
  const howto = document.getElementById('chHowtoContent')
  const pairingInfo = document.getElementById('chPairingInfo')
  const discordChannelGroup = document.getElementById('chDiscordChannelIdGroup')
  const tokenGroup = document.getElementById('chTokenGroup')
  // Teams config is terminal-driven (creds land in the .env via setup-azure-bot.sh),
  // not a dashboard token paste -- default the token field visible, hide it for teams.
  if (tokenGroup) tokenGroup.hidden = false

  if (isTg) {
    if (title) title.textContent = t('channel.setup.tg_title')
    if (steps) steps.innerHTML = t('channel.setup.tg_steps')
    if (label) label.textContent = 'Bot API Token'
    if (input) input.placeholder = '123456:ABC-DEF1234ghIkl-zyx57W2v1u123ew11'
    if (slackGroup) slackGroup.hidden = true
    if (manifestBtnGroup) manifestBtnGroup.hidden = true
    if (smokeTestBtn) smokeTestBtn.hidden = true
    if (discordChannelGroup) discordChannelGroup.hidden = true
    if (pairingInfo) pairingInfo.textContent = t('channel.setup.tg_pairing')
  } else if (currentChannelProvider === 'discord') {
    if (title) title.textContent = t('channel.setup.discord_title')
    if (steps) steps.innerHTML = t('channel.setup.discord_steps')
    if (label) label.textContent = 'Bot Token'
    if (input) input.placeholder = 'MTIzNDU2Nzg5MDEyMzQ1Njc4OQ...'
    if (slackGroup) slackGroup.hidden = true
    if (manifestBtnGroup) manifestBtnGroup.hidden = true
    if (smokeTestBtn) smokeTestBtn.hidden = true
    if (discordChannelGroup) discordChannelGroup.hidden = false
    if (pairingInfo) pairingInfo.textContent = t('channel.setup.discord_pairing')
  } else if (currentChannelProvider === 'teams') {
    if (title) title.textContent = t('channel.setup.teams_title')
    if (steps) steps.innerHTML = t('channel.setup.teams_steps')
    if (slackGroup) slackGroup.hidden = true
    if (manifestBtnGroup) manifestBtnGroup.hidden = true
    if (smokeTestBtn) smokeTestBtn.hidden = true
    if (discordChannelGroup) discordChannelGroup.hidden = true
    // No dashboard token entry for Teams -- creds come from the terminal setup.
    if (tokenGroup) tokenGroup.hidden = true
    if (pairingInfo) pairingInfo.textContent = t('channel.setup.teams_pairing')
  } else {
    if (title) title.textContent = t('channel.setup.slack_title')
    if (steps) steps.innerHTML = t('channel.setup.slack_steps')
    if (label) label.textContent = 'Bot Token (xoxb-...)'
    if (input) input.placeholder = 'xoxb-...'
    if (slackGroup) slackGroup.hidden = false
    if (manifestBtnGroup) manifestBtnGroup.hidden = false
    if (smokeTestBtn) smokeTestBtn.hidden = false
    if (discordChannelGroup) discordChannelGroup.hidden = true
    if (pairingInfo) pairingInfo.textContent = t('channel.setup.slack_pairing')
  }
  if (howto) howto.innerHTML = buildHowtoHtml()
  if (reconnectBtn) {
    reconnectBtn.hidden = !(currentAgent && currentAgent.running && agentIsConnected(currentAgent))
  }
}

function updateChannelTab(agent) {
  const connected = agentIsConnected(agent)
  const running = agent.running || false
  document.getElementById('chNotConnected').hidden = connected
  document.getElementById('chConnected').hidden = !connected
  if (connected) {
    document.getElementById('chBotUsername').textContent = agent.telegramBotUsername || '@bot'
    document.getElementById('chRunNotice').hidden = running
    document.getElementById('chRunningNotice').hidden = !running
  }
  document.getElementById('chTokenInput').value = ''
  const slackInput = document.getElementById('chSlackAppToken')
  if (slackInput) slackInput.value = ''
  const discordChanInput = document.getElementById('chDiscordChannelId')
  if (discordChanInput) discordChanInput.value = ''
  updateProviderUI()
  if (connected && running) {
    refreshChannelHealth()
  } else {
    document.getElementById('chDisconnectedNotice').hidden = true
    document.getElementById('chReconnectBtn').hidden = true
  }
  if (connected) {
    refreshPendingPairings()
    refreshAllowedList()
    refreshInvites()
    refreshChannelRequests()
  }
}

async function refreshChannelHealth() {
  if (!currentAgent) return
  try {
    const res = await fetch(`/api/agents/${encodeURIComponent(currentAgent.name)}/channel/health`)
    if (!res.ok) return
    const data = await res.json()
    const notice = document.getElementById('chDisconnectedNotice')
    const btn = document.getElementById('chReconnectBtn')
    if (!data.healthy) {
      if (notice) notice.hidden = false
      if (btn) btn.hidden = false
    } else {
      if (notice) notice.hidden = true
      if (btn) btn.hidden = false
    }
  } catch { /* ignore */ }
}

document.getElementById('chProviderSelect').addEventListener('change', (e) => {
  currentChannelProvider = e.target.value
  updateProviderUI()
  if (currentAgent) {
    updateChannelTab(currentAgent)
  }
})

document.getElementById('chConnectBtn').addEventListener('click', async () => {
  if (!currentAgent) return
  const token = document.getElementById('chTokenInput').value.trim()
  if (!token) {
    document.getElementById('chTokenInput').focus()
    return
  }

  const payload = { botToken: token }
  if (currentChannelProvider === 'slack') {
    const appToken = document.getElementById('chSlackAppToken').value.trim()
    if (appToken) payload.appToken = appToken
  } else if (currentChannelProvider === 'discord') {
    const channelId = document.getElementById('chDiscordChannelId').value.trim()
    if (channelId) payload.channelId = channelId
  }

  const btn = document.getElementById('chConnectBtn')
  btn.disabled = true
  btn.querySelector('.btn-text').hidden = true
  btn.querySelector('.btn-loading').hidden = false

  try {
    const res = await fetch(`${channelApiBase()}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    })
    if (res.status === 409) {
      const err = await res.json()
      if (err.error === 'managed-settings-missing') {
        showSudoModal(err.sudoCommand)
        return
      }
    }
    if (!res.ok) {
      const err = await res.json().catch(() => ({}))
      throw new Error(err.error || 'Kapcsolodasi hiba')
    }
    const result = await res.json()
    showToast(`${getProviderLabel()} sikeresen csatlakoztatva!`)
    // Refresh detail
    await openAgentDetail(currentAgent.name)
    loadAgents()
  } catch (err) {
    showToast(`Hiba: ${err.message}`)
  } finally {
    btn.disabled = false
    btn.querySelector('.btn-text').hidden = false
    btn.querySelector('.btn-loading').hidden = true
  }
})

document.getElementById('chTestBtn').addEventListener('click', async () => {
  if (!currentAgent) return
  try {
    const res = await fetch(`${channelApiBase()}/test`, { method: 'POST' })
    if (!res.ok) throw new Error()
    showToast('Kapcsolat rendben!')
  } catch {
    showToast(t('channel.toast.smoke_failed'))
  }
})

document.getElementById('chReconnectBtn').addEventListener('click', async () => {
  if (!currentAgent) return
  const btn = document.getElementById('chReconnectBtn')
  const origText = btn.textContent
  btn.disabled = true
  btn.textContent = t('agents.btn.reconnect')
  try {
    const res = await fetch(`/api/agents/${encodeURIComponent(currentAgent.name)}/channel/reconnect`, { method: 'POST' })
    const data = await res.json()
    if (data.ok) {
      showToast('Channel-MCP reconnect sikeres')
      document.getElementById('chDisconnectedNotice').hidden = true
    } else {
      showToast(data.message || 'Reconnect sikertelen', true)
    }
  } catch {
    showToast('Reconnect hiba', true)
  } finally {
    btn.disabled = false
    btn.textContent = origText
  }
})

document.getElementById('chSmokeTestBtn').addEventListener('click', async () => {
  if (!currentAgent) return
  const btn = document.getElementById('chSmokeTestBtn')
  const origText = btn.textContent
  btn.disabled = true
  btn.textContent = t('agents.btn.running')
  try {
    const res = await fetch(`/api/agents/${encodeURIComponent(currentAgent)}/channels/slack/smoke-test`, { method: 'POST' })
    const data = await res.json()
    if (!res.ok) {
      showToast(data.error || 'Smoke-test sikertelen', true)
      return
    }
    showSmokeTestResult(data.output || 'OK')
  } catch {
    showToast('Smoke-test hiba', true)
  } finally {
    btn.disabled = false
    btn.textContent = origText
  }
})

function showSmokeTestResult(output) {
  const overlay = document.createElement('div')
  overlay.className = 'modal-overlay'
  overlay.innerHTML = `
    <div class="modal-content" style="max-width:600px">
      <h3>${t('channel.smoke_test.title')}</h3>
      <pre style="background:#1a1a2e;color:#e0e0e0;padding:12px;border-radius:6px;overflow-x:auto;font-size:13px;max-height:400px;white-space:pre-wrap">${output.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')}</pre>
      <div style="text-align:right;margin-top:12px">
        <button class="btn-secondary" id="smokeTestCloseBtn">${t('common.btn.close')}</button>
      </div>
    </div>`
  document.body.appendChild(overlay)
  overlay.addEventListener('click', (e) => { if (e.target === overlay) overlay.remove() })
  document.getElementById('smokeTestCloseBtn').addEventListener('click', () => overlay.remove())
}

// Pairing: refresh pending list
async function refreshPendingPairings() {
  if (!currentAgent) return
  const listEl = document.getElementById('chPendingList')
  try {
    const res = await fetch(`${channelApiBase()}/pending`)
    if (!res.ok) return
    const pending = await res.json()
    listEl.innerHTML = ''
    if (pending.length === 0) {
      listEl.innerHTML = `<div style="font-size:12px; color:var(--text-muted); padding:6px 0;">${t('channel.pending.empty')}</div>`
      return
    }
    for (const p of pending) {
      const item = document.createElement('div')
      item.className = 'tg-pending-item'
      const created = new Date(p.createdAt).toLocaleString('hu-HU')
      item.innerHTML = `
        <div>
          <span class="tg-pending-code">${escapeHtml(p.code)}</span>
          <span class="tg-pending-sender">Sender: ${escapeHtml(p.senderId)}</span>
        </div>
        <button class="btn-primary btn-compact" style="padding:5px 12px; font-size:12px; margin:0" data-code="${escapeHtml(p.code)}">${t('common.btn.approve')}</button>
      `
      item.querySelector('button').addEventListener('click', async () => {
        await approvePairing(p.code)
      })
      listEl.appendChild(item)
    }
  } catch { /* ignore */ }
}

async function approvePairing(code) {
  if (!currentAgent) return
  try {
    const res = await fetch(`${channelApiBase()}/approve`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code }),
    })
    if (!res.ok) {
      const err = await res.json()
      throw new Error(err.error || t('channel.toast.approve_error'))
    }
    showToast(t('channel.toast.pairing_approved'))
    refreshPendingPairings()
    refreshAllowedList()
  } catch (err) {
    showToast(`Hiba: ${err.message}`)
  }
}

document.getElementById('chRefreshPendingBtn').addEventListener('click', refreshPendingPairings)

async function refreshAllowedList() {
  if (!currentAgent) return
  const listEl = document.getElementById('chAllowedList')
  try {
    const res = await fetch(`${channelApiBase()}/allowed`)
    if (!res.ok) return
    const data = await res.json()
    const users = data.users || []
    const groups = data.groups || []
    if (users.length === 0 && groups.length === 0) {
      listEl.innerHTML = `<div class="tg-allowed-empty">${t('channel.allowed.empty')}</div>`
      return
    }
    listEl.innerHTML = ''
    for (const id of users) {
      const item = document.createElement('div')
      item.className = 'tg-allowed-item'
      item.innerHTML = `
        <div class="tg-allowed-meta">
          <span class="tg-allowed-kind">DM</span>
          <span class="tg-allowed-id">${escapeHtml(id)}</span>
        </div>
        <button class="btn-icon-danger" title="${t('common.btn.remove')}" data-kind="user" data-id="${escapeHtml(id)}">&times;</button>
      `
      item.querySelector('button').addEventListener('click', () => removeAllowed('user', id))
      listEl.appendChild(item)
    }
    for (const g of groups) {
      const item = document.createElement('div')
      item.className = 'tg-allowed-item'
      item.innerHTML = `
        <div class="tg-allowed-meta">
          <span class="tg-allowed-kind tg-allowed-kind-group">${t('channel.badge.group')}</span>
          <span class="tg-allowed-id">${escapeHtml(g.id)}</span>
        </div>
        <button class="btn-icon-danger" title="${t('common.btn.remove')}" data-kind="group" data-id="${escapeHtml(g.id)}">&times;</button>
      `
      item.querySelector('button').addEventListener('click', () => removeAllowed('group', g.id))
      listEl.appendChild(item)
    }
  } catch { /* ignore */ }
}

async function removeAllowed(kind, id) {
  if (!currentAgent) return
  const label = kind === 'user' ? t('channel.kind.user') : t('channel.kind.group')
  if (!confirm(t('channel.confirm.remove', { label, id }))) return
  try {
    const res = await fetch(`${channelApiBase()}/allowed/${kind}/${encodeURIComponent(id)}`, { method: 'DELETE' })
    if (!res.ok) {
      const err = await res.json().catch(() => ({}))
      throw new Error(err.error || t('channel.toast.remove_error'))
    }
    showToast(t('common.toast.removed'))
    refreshAllowedList()
  } catch (err) {
    showToast(`Hiba: ${err.message}`)
  }
}

document.getElementById('chRefreshAllowedBtn').addEventListener('click', refreshAllowedList)

async function refreshInvites() {
  if (!currentAgent) return
  const listEl = document.getElementById('chInviteList')
  try {
    const res = await fetch(`${channelApiBase()}/invites`)
    if (!res.ok) return
    const items = await res.json()
    if (!items.length) {
      listEl.innerHTML = `<div class="tg-allowed-empty">${t('channel.invite.empty')}</div>`
      return
    }
    listEl.innerHTML = ''
    for (const inv of items) {
      const item = document.createElement('div')
      item.className = 'tg-allowed-item'
      const expiresIn = Math.max(0, Math.floor((inv.expiresAt - Date.now()) / 60000))
      const status = inv.used
        ? `<span class="tg-allowed-kind" style="background:rgba(180,180,180,0.15); color:var(--text-muted);">${t('channel.invite.used_badge')}</span>`
        : `<span class="tg-allowed-kind tg-allowed-kind-group">${t('channel.invite.active_badge', { min: expiresIn })}</span>`
      const linkHtml = inv.deepLink
        ? `<a href="${escapeHtml(inv.deepLink)}" target="_blank" class="tg-allowed-id" style="text-decoration:underline;">${escapeHtml(inv.deepLink)}</a>`
        : `<span class="tg-allowed-id">${t('channel.invite.no_username')}</span>`
      item.innerHTML = `
        <div class="tg-allowed-meta" style="flex-wrap:wrap; gap:6px;">
          ${status}
          ${linkHtml}
        </div>
        <div style="display:flex; gap:6px;">
          ${inv.deepLink && !inv.used ? `<button class="btn-secondary btn-compact" data-link="${escapeHtml(inv.deepLink)}" style="padding:4px 10px; font-size:11px; margin:0;">${t('common.btn.copy_btn')}</button>` : ''}
          <button class="btn-icon-danger" title="${t('channel.btn.revoke')}" data-token="${escapeHtml(inv.token)}">&times;</button>
        </div>
      `
      const copyBtn = item.querySelector('button[data-link]')
      if (copyBtn) {
        copyBtn.addEventListener('click', async (e) => {
          const link = e.currentTarget.getAttribute('data-link')
          try { await navigator.clipboard.writeText(link); showToast(t('common.toast.copied')) }
          catch { showToast(t('common.toast.copy_failed')) }
        })
      }
      const revokeBtn = item.querySelector('button[data-token]')
      if (revokeBtn) {
        revokeBtn.addEventListener('click', () => revokeInviteToken(inv.token))
      }
      listEl.appendChild(item)
    }
  } catch { /* ignore */ }
}

async function generateInvite() {
  if (!currentAgent) return
  const btn = document.getElementById('chGenerateInviteBtn')
  btn.disabled = true
  btn.textContent = t('channel.btn.invite_gen')
  try {
    const res = await fetch(`${channelApiBase()}/invites`, { method: 'POST' })
    if (!res.ok) {
      const err = await res.json().catch(() => ({}))
      throw new Error(err.error || 'Sikertelen')
    }
    const data = await res.json()
    if (data.deepLink) {
      try { await navigator.clipboard.writeText(data.deepLink); showToast(t('channel.toast.invite_copied')) }
      catch { showToast(t('channel.toast.invite_created')) }
    } else {
      showToast(t('channel.toast.invite_pending'))
    }
    refreshInvites()
  } catch (err) {
    showToast(`Hiba: ${err.message}`)
  } finally {
    btn.disabled = false
    btn.textContent = t('channel.btn.invite_new')
  }
}

async function revokeInviteToken(token) {
  if (!currentAgent) return
  if (!confirm(t('channel.confirm.revoke'))) return
  try {
    const res = await fetch(`${channelApiBase()}/invites/${encodeURIComponent(token)}`, { method: 'DELETE' })
    if (!res.ok) {
      const err = await res.json().catch(() => ({}))
      throw new Error(err.error || 'Sikertelen')
    }
    showToast(t('channel.toast.invite_revoked'))
    refreshInvites()
  } catch (err) {
    showToast(`Hiba: ${err.message}`)
  }
}

document.getElementById('chGenerateInviteBtn').addEventListener('click', generateInvite)
document.getElementById('chRefreshInvitesBtn').addEventListener('click', refreshInvites)

// --- Channel Requests (Slack channel opt-in) ---
async function refreshChannelRequests() {
  if (!currentAgent) return
  const section = document.getElementById('chRequestSection')
  const listEl = document.getElementById('chRequestList')
  const badge = document.getElementById('chRequestBadge')
  if (currentChannelProvider !== 'slack') {
    section.hidden = true
    return
  }
  try {
    const res = await fetch(`/api/agents/${encodeURIComponent(currentAgent.name)}/channel-requests`)
    if (!res.ok) { section.hidden = true; return }
    const items = await res.json()
    if (!items.length) {
      section.hidden = true
      badge.hidden = true
      return
    }
    section.hidden = false
    badge.hidden = false
    badge.textContent = items.length
    listEl.innerHTML = ''
    for (const req of items) {
      const item = document.createElement('div')
      item.className = 'tg-allowed-item'
      const name = req.channel_name ? escapeHtml(req.channel_name) : req.channel_id
      const ts = new Date(req.requested_at * 1000).toLocaleString('hu-HU')
      const userId = req.user_id ? `<span class="tg-allowed-id">user: ${escapeHtml(req.user_id)}</span>` : ''
      item.innerHTML = `
        <div class="tg-allowed-meta">
          <span class="tg-allowed-kind tg-allowed-kind-group">#${name}</span>
          ${userId}
          <span class="tg-allowed-id" style="font-size:11px;color:var(--text-muted)">${ts}</span>
        </div>
        <div style="display:flex;gap:6px">
          <button class="btn-primary btn-compact" data-approve="${req.id}" style="padding:4px 10px;font-size:11px;margin:0">${t('common.btn.approve')}</button>
          <button class="btn-icon-danger" data-deny="${req.id}" title="${t('channel.btn.deny')}">&times;</button>
        </div>
      `
      item.dataset.reqId = req.id
      item.querySelector('[data-approve]').addEventListener('click', () => openApproveModal(req.id, req.channel_name || req.channel_id, req.user_id))
      item.querySelector('[data-deny]').addEventListener('click', () => denyChannelRequest(req.id, item))
      listEl.appendChild(item)
    }
  } catch { section.hidden = true }
}

let _approveReqId = null

function openApproveModal(id, channelName, userId) {
  _approveReqId = id
  const desc = document.getElementById('chApproveModalDesc')
  const userNote = userId ? t('channel.approve.requester', { user: escapeHtml(userId) }) : ''
  desc.textContent = t('channel.approve.desc', { channel: escapeHtml(channelName), requester: userNote })
  document.getElementById('chApproveRequireMention').checked = true
  document.getElementById('chApproveAllowFromAll').checked = false
  document.getElementById('chApproveModalOverlay').hidden = false
}

async function submitApproveModal() {
  const id = _approveReqId
  if (!id) return
  const requireMention = document.getElementById('chApproveRequireMention').checked
  const allowFromAll = document.getElementById('chApproveAllowFromAll').checked
  const confirmBtn = document.getElementById('chApproveModalConfirm')
  confirmBtn.querySelector('.btn-text').hidden = true
  confirmBtn.querySelector('.btn-loading').hidden = false
  confirmBtn.disabled = true
  try {
    const res = await fetch(`/api/agents/${encodeURIComponent(currentAgent.name)}/channel-requests/${id}/approve`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ requireMention, allowFromAll }),
    })
    if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || 'Hiba')
    document.getElementById('chApproveModalOverlay').hidden = true
    const item = document.querySelector(`[data-req-id="${id}"]`)
    if (item) item.remove()
    showToast(t('channel.toast.approved'))
    refreshChannelRequests()
  } catch (err) {
    showToast(`Hiba: ${err.message}`)
  } finally {
    confirmBtn.querySelector('.btn-text').hidden = false
    confirmBtn.querySelector('.btn-loading').hidden = true
    confirmBtn.disabled = false
  }
}

async function denyChannelRequest(id, itemEl) {
  if (itemEl?.dataset.denying) return
  if (itemEl) itemEl.dataset.denying = '1'
  if (itemEl) itemEl.remove()
  try {
    const res = await fetch(`/api/agents/${encodeURIComponent(currentAgent.name)}/channel-requests/${id}/deny`, { method: 'POST' })
    if (!res.ok) throw new Error('Hiba')
    showToast(t('channel.toast.denied'))
    refreshChannelRequests()
  } catch (err) {
    showToast(`Hiba: ${err.message}`)
    refreshChannelRequests()
  }
}

;(function initApproveModal() {
  function closeApproveModal() { document.getElementById('chApproveModalOverlay').hidden = true }
  document.addEventListener('DOMContentLoaded', () => {
    document.getElementById('chApproveModalConfirm').addEventListener('click', submitApproveModal)
    document.getElementById('chApproveModalClose').addEventListener('click', closeApproveModal)
    document.getElementById('chApproveModalCancel').addEventListener('click', closeApproveModal)
    document.getElementById('chApproveModalOverlay').addEventListener('click', (e) => { if (e.target === e.currentTarget) closeApproveModal() })
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && !document.getElementById('chApproveModalOverlay').hidden) closeApproveModal()
    })
  })
})()

document.getElementById('chApproveBtn').addEventListener('click', async () => {
  const code = document.getElementById('chPairCode').value.trim()
  if (!code) { document.getElementById('chPairCode').focus(); return }
  await approvePairing(code)
  document.getElementById('chPairCode').value = ''
  refreshAllowedList()
})

document.getElementById('chDisconnectBtn').addEventListener('click', async () => {
  if (!currentAgent) return
  const provLabel = getProviderLabel()
  if (!confirm(`Biztosan levalasztod a ${provLabel} csatornat?`)) return
  try {
    await fetch(`${channelApiBase()}`, { method: 'DELETE' })
    showToast(`${provLabel} levalasztva`)
    await openAgentDetail(currentAgent.name)
    loadAgents()
  } catch {
    showToast(t('channel.toast.disconnect_error'))
  }
})

