// === app-agent-bundle.js ===
// Export ALL agents (fleet .tar.gz bundle), Agent import (single or fleet bundle),
// and per-agent voice/TTS configuration (loadVoiceConfig).
// Extracted from app.js as part of modularisation (slice 23/N).
// This file is loaded AFTER app.js via a synchronous <script> tag in index.html.
//
// Globals from app.js: t, escapeHtml, showToast, currentAgent, loadAgents
// Functions called from app.js at event-time only: loadVoiceConfig
// === Export ALL agents (whole fleet) into one .tar.gz bundle ===
const exportAllAgentsBtn = document.getElementById('exportAllAgentsBtn')
if (exportAllAgentsBtn) {
  exportAllAgentsBtn.addEventListener('click', async () => {
    const withSecrets = confirm(
      'Belevegyük a titkokat (channel bot tokenek, párosítási állapot) MINDEN ügynöknél?\n\n' +
      'OK = igen, csak saját gépek közötti átvitelhez.\n' +
      'Mégse = nem, biztonságosan megosztható (csak identitás + viselkedés).'
    )
    const url = `/api/agents/export-all${withSecrets ? '?secrets=1' : ''}`
    try {
      const res = await fetch(url)
      if (!res.ok) {
        const data = await res.json().catch(() => ({}))
        showToast(data.error || 'Hiba az exportálás során')
        return
      }
      const blob = await res.blob()
      const objectUrl = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = objectUrl
      a.download = 'marveen-fleet.tar.gz'
      document.body.appendChild(a)
      a.click()
      a.remove()
      URL.revokeObjectURL(objectUrl)
      showToast(`Flotta exportálva${withSecrets ? ' (titkokkal)' : ''}`)
    } catch {
      showToast('Hiba az exportálás során')
    }
  })
}

// === Agent import (upload a .tar.gz bundle exported from another machine) ===
// Accepts both a single-agent bundle and a whole-fleet bundle -- the backend
// auto-detects the format from the manifest.
const importAgentBtn = document.getElementById('importAgentBtn')
const importAgentFile = document.getElementById('importAgentFile')
if (importAgentBtn && importAgentFile) {
  importAgentBtn.addEventListener('click', () => importAgentFile.click())
  importAgentFile.addEventListener('change', async () => {
    const file = importAgentFile.files && importAgentFile.files[0]
    if (!file) return
    // Reset the input so picking the same file again re-fires change.
    const upload = async (overwrite) => {
      const form = new FormData()
      form.append('file', file)
      if (overwrite) form.append('overwrite', '1')
      const res = await fetch('/api/agents/import', { method: 'POST', body: form })
      const data = await res.json().catch(() => ({}))
      return { res, data }
    }
    try {
      let { res, data } = await upload(false)
      if (res.status === 409) {
        const prompt = data.kind === 'fleet'
          ? 'Néhány ügynök már létezik ezen a gépen. Felülírjuk az ütközőket?'
          : `Már létezik "${data.name || ''}" nevű ügynök. Felülírjuk?`
        if (confirm(prompt)) {
          ;({ res, data } = await upload(true))
        } else {
          return
        }
      }
      if (!res.ok) { showToast(data.error || 'Hiba az importálás során'); return }
      const note = data.includedSecrets ? ' (titkokkal)' : ''
      if (data.kind === 'fleet') {
        const n = (data.imported || []).length
        const skipped = (data.skipped || []).length
        showToast(`Flotta importálva: ${n} ügynök${note}${skipped ? ` (${skipped} kihagyva)` : ''}`)
      } else {
        showToast(`Ügynök importálva: ${data.name}${note}${data.overwritten ? ' (felülírva)' : ''}`)
      }
      loadAgents()
    } catch {
      showToast('Hiba az importálás során')
    } finally {
      importAgentFile.value = ''
    }
  })
}

document.getElementById('saveAutoRestartBtn').addEventListener('click', async () => {
  if (!currentAgent) return
  // Auto-restart applies to the main session too, so (unlike model/profile) we
  // do NOT skip role === 'main'. The store key is autoRestartId for the main
  // session, the sanitized name for sub-agents.
  const id = currentAgent.autoRestartId || currentAgent.name
  const schedKind = document.getElementById('arSchedKind').value
  const cfg = {
    enabled: document.getElementById('arEnabled').checked,
    mode: document.getElementById('arMode').value === 'fresh' ? 'fresh' : 'continue',
    dailyTime: schedKind === 'daily' ? document.getElementById('arDailyTime').value : null,
    intervalHours: schedKind === 'interval' ? Number(document.getElementById('arIntervalHours').value) : null,
    handoff: false,
  }
  try {
    const res = await fetch(`/api/agents/${encodeURIComponent(id)}/auto-restart`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(cfg),
    })
    if (!res.ok) throw new Error()
    const body = await res.json()
    if (currentAgent) currentAgent.autoRestart = body.autoRestart
    showToast(t('agents.toast.auto_restart_saved'))
  } catch { showToast(t('common.error_save')) }
})

// ---- voice config UI -------------------------------------------------------

async function loadVoiceConfig(agentName) {
  const voiceModelSel = document.getElementById('editAgentVoiceModel')
  if (!voiceModelSel) return
  const banner = document.getElementById('voiceNotInstalledBanner')
  const controls = document.getElementById('voiceInstalledControls')
  try {
    // Check toolkit installation first
    const statusR = await fetch('/api/voice/status')
    if (!statusR.ok) return
    const status = await statusR.json()

    if (!status.installed) {
      if (banner) banner.hidden = false
      if (controls) controls.hidden = true
      return
    }
    if (banner) banner.hidden = true
    if (controls) controls.hidden = false

    const r = await fetch(`/api/agents/${encodeURIComponent(agentName)}/voice-config`)
    if (!r.ok) return
    const cfg = await r.json()
    voiceModelSel.innerHTML = (cfg.availableVoices || []).map(v =>
      `<option value="${v}"${v === cfg.voiceModel ? ' selected' : ''}>${v}</option>`
    ).join('')
    const modeInput = document.querySelector(`input[name="voiceResponseMode"][value="${cfg.responseMode || 'text'}"]`)
    if (modeInput) modeInput.checked = true
  } catch { /* silent */ }
}

let _voiceInstallPollTimer = null

document.getElementById('voiceInstallBtn').addEventListener('click', async () => {
  const btn = document.getElementById('voiceInstallBtn')
  const sudoHint = document.getElementById('voiceInstallSudoHint')
  const progress = document.getElementById('voiceInstallProgress')

  if (sudoHint) sudoHint.hidden = true
  btn.disabled = true
  btn.textContent = 'Indítás...'

  try {
    const r = await fetch('/api/voice/install', { method: 'POST' })
    if (!r.ok) throw new Error(await r.text())
    const data = await r.json()

    if (data.needsSudo) {
      // Show sudo command -- user must run it then click again
      if (sudoHint) {
        sudoHint.hidden = false
        sudoHint.innerHTML = 'A rendszercsomagok telepítéséhez futtasd terminálon:<br><code style="display:block;margin-top:4px;word-break:break-all">' + escapeHtml(data.sudoCommand) + '</code><br>Ezután kattints újra a Telepítés gombra.'
      }
      btn.disabled = false
      btn.textContent = 'Telepítés'
      return
    }

    if (data.alreadyInstalled) {
      if (currentAgent) loadVoiceConfig(currentAgent.name)
      return
    }

    // Install started -- poll /api/voice/status until installed=true.
    // Max 4 minutes (80 × 3s); on timeout show a hint and re-enable the button
    // so the user can retry (the only failure signal from a fire-and-forget spawn).
    if (progress) progress.hidden = false
    btn.textContent = 'Telepítés...'
    clearInterval(_voiceInstallPollTimer)
    let _voiceInstallPollCount = 0
    const VOICE_INSTALL_MAX_POLLS = 80 // 80 × 3s = 4 min
    _voiceInstallPollTimer = setInterval(async () => {
      _voiceInstallPollCount++
      try {
        const sr = await fetch('/api/voice/status')
        const s = await sr.json()
        if (s.installed) {
          clearInterval(_voiceInstallPollTimer)
          _voiceInstallPollTimer = null
          if (progress) progress.hidden = true
          if (currentAgent) loadVoiceConfig(currentAgent.name)
          return
        }
      } catch { /* keep polling */ }
      if (_voiceInstallPollCount >= VOICE_INSTALL_MAX_POLLS) {
        clearInterval(_voiceInstallPollTimer)
        _voiceInstallPollTimer = null
        if (progress) progress.hidden = true
        if (sudoHint) {
          sudoHint.hidden = false
          sudoHint.textContent = 'A telepítés tovább tart vagy elakadt. Ellenőrizd a dashboard logjait, majd próbáld újra.'
        }
        btn.disabled = false
        btn.textContent = 'Újrapróbálás'
      }
    }, 3000)
  } catch {
    btn.disabled = false
    btn.textContent = 'Telepítés'
    showToast('Hiba a telepítés során')
  }
})

document.getElementById('saveVoiceConfigBtn').addEventListener('click', async () => {
  if (!currentAgent) return
  const modeEl = document.querySelector('input[name="voiceResponseMode"]:checked')
  const modelEl = document.getElementById('editAgentVoiceModel')
  if (!modeEl || !modelEl) return
  try {
    const r = await fetch(`/api/agents/${encodeURIComponent(currentAgent.name)}/voice-config`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ responseMode: modeEl.value, voiceModel: modelEl.value }),
    })
    if (!r.ok) throw new Error()
    showToast('Hangbeállítás mentve')
  } catch { showToast('Hiba a mentés során') }
})

document.getElementById('saveProfileBtn').addEventListener('click', async () => {
  if (!currentAgent || currentAgent.role === 'main') return
  const profile = document.getElementById('editAgentProfile').value
  try {
    const res = await fetch(`/api/agents/${encodeURIComponent(currentAgent.name)}/security`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ profile }),
    })
    if (!res.ok) throw new Error()
    const body = await res.json()
    showToast(body.requiresRestart ? t('agents.toast.profile_saved_restart') : t('agents.toast.profile_saved'))
    loadAgents()
  } catch { showToast(t('agents.toast.profile_error')) }
})

document.getElementById('savePlanBtn').addEventListener('click', async () => {
  // The main agent's login comes up via channels.sh, not this path, so its
  // plan is not settable here (the selector is hidden for it anyway).
  if (!currentAgent || currentAgent.role === 'main') return
  const claudePlan = document.getElementById('editAgentPlan').value
  try {
    const res = await fetch(`/api/agents/${encodeURIComponent(currentAgent.name)}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ claudePlan }),
    })
    if (!res.ok) throw new Error()
    currentAgent.claudePlan = claudePlan || null
    showToast(t('agents.toast.plan_saved'))
    loadAgents()
  } catch { showToast(t('agents.toast.plan_error')) }
})

