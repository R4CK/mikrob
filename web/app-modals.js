// app-modals.js -- Utility modal helpers (app.js modularisation slice 26).
// Globals from app.js: t, escapeHtml, showToast, currentAgent
// Globals from here used by app-auth-channel.js: showSudoModal
// Globals from here used by app-onboarding.js: showSudoModal

// === Sudo modal for managed-settings.json (Slack setup pre-flight) ===
function showSudoModal(sudoCommand, onRetry) {
  let overlay = document.getElementById('sudoModalOverlay')
  if (overlay) overlay.remove()
  overlay = document.createElement('div')
  overlay.id = 'sudoModalOverlay'
  overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.55);z-index:10001;display:flex;align-items:center;justify-content:center'
  const card = document.createElement('div')
  card.style.cssText = 'background:var(--bg-card);border:1px solid var(--border);border-radius:12px;padding:24px;max-width:560px;width:90%'
  card.innerHTML = `
    <h3 style="margin:0 0 12px">${t('channel.sudo_modal.title')}</h3>
    <p style="font-size:13px;color:var(--text-muted);margin:0 0 16px">${t('channel.sudo_modal.desc')}</p>
    <div style="position:relative">
      <pre id="sudoCmdPre" style="background:var(--bg-main);border:1px solid var(--border);border-radius:8px;padding:12px;font-size:12px;overflow-x:auto;white-space:pre-wrap;word-break:break-all">${escapeHtml(sudoCommand)}</pre>
      <button id="sudoCopyBtn" style="position:absolute;top:6px;right:6px;padding:4px 10px;font-size:11px;border-radius:6px;border:1px solid var(--border);background:var(--bg-card);cursor:pointer">${t('common.copy')}</button>
    </div>
    <div style="display:flex;gap:8px;justify-content:flex-end;margin-top:16px">
      <button id="sudoCancelBtn" class="btn btn-secondary" style="padding:6px 16px;font-size:13px">${t('channel.sudo_modal.cancel')}</button>
      <button id="sudoDoneBtn" class="btn btn-primary" style="padding:6px 16px;font-size:13px">${t('channel.sudo_modal.retry')}</button>
    </div>
  `
  overlay.appendChild(card)
  document.body.appendChild(overlay)

  document.getElementById('sudoCopyBtn').addEventListener('click', () => {
    navigator.clipboard.writeText(sudoCommand).then(() => {
      document.getElementById('sudoCopyBtn').textContent = t('common.copied')
      setTimeout(() => { document.getElementById('sudoCopyBtn').textContent = t('common.copy') }, 1500)
    })
  })
  document.getElementById('sudoCancelBtn').addEventListener('click', () => overlay.remove())
  document.getElementById('sudoDoneBtn').addEventListener('click', () => {
    overlay.remove()
    if (onRetry) onRetry()
    else document.getElementById('chConnectBtn').click()
  })
  overlay.addEventListener('click', (e) => { if (e.target === overlay) overlay.remove() })
}

// === Clipboard fallback (non-secure context / legacy browser) ===
function fallbackCopyToClipboard(text, btn) {
  const ta = document.createElement('textarea')
  ta.value = text
  ta.style.cssText = 'position:fixed;left:-9999px'
  document.body.appendChild(ta)
  ta.select()
  try {
    const ok = document.execCommand('copy')
    if (ok) {
      btn.textContent = t('common.copied')
      setTimeout(() => { btn.textContent = t('common.copy') }, 1500)
    } else {
      showToast(t('common.toast.copy_failed'))
    }
  } catch {
    showToast(t('common.toast.copy_failed'))
  }
  document.body.removeChild(ta)
}

// === Slack App manifest modal ===
function showSlackManifestModal(manifest, instructions) {
  let overlay = document.getElementById('slackManifestOverlay')
  if (overlay) overlay.remove()
  overlay = document.createElement('div')
  overlay.id = 'slackManifestOverlay'
  overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.55);z-index:9999;display:flex;align-items:center;justify-content:center'
  const card = document.createElement('div')
  card.style.cssText = 'background:var(--bg-card);border:1px solid var(--border);border-radius:12px;padding:24px;max-width:640px;width:95%;max-height:85vh;overflow-y:auto'

  const stepsHtml = instructions.map((s, i) => `<li style="margin-bottom:6px">${escapeHtml(s)}</li>`).join('')

  card.innerHTML = `
    <h3 style="margin:0 0 16px">${t('channel.slack_manifest.title')}</h3>
    <p style="font-size:13px;color:var(--text-muted);margin:0 0 12px">${t('channel.slack_manifest.desc')}</p>
    <div style="position:relative;margin-bottom:16px">
      <pre id="slackManifestPre" style="background:var(--bg-main);border:1px solid var(--border);border-radius:8px;padding:12px;font-size:12px;overflow-x:auto;white-space:pre-wrap;word-break:break-all;max-height:240px;overflow-y:auto">${escapeHtml(manifest)}</pre>
      <button id="slackManifestCopyBtn" style="position:absolute;top:6px;right:6px;padding:4px 10px;font-size:11px;border-radius:6px;border:1px solid var(--border);background:var(--bg-card);cursor:pointer">${t('common.copy')}</button>
    </div>
    <h4 style="margin:0 0 8px;font-size:14px">${t('channel.slack_manifest.steps_title')}</h4>
    <ol style="font-size:13px;padding-left:20px;margin:0 0 16px">${stepsHtml}</ol>
    <div style="display:flex;gap:8px;justify-content:flex-end">
      <button id="slackManifestCloseBtn" class="btn btn-secondary" style="padding:6px 16px;font-size:13px">${t('common.btn.close')}</button>
      <a href="https://api.slack.com/apps" target="_blank" rel="noopener" class="btn btn-primary" style="padding:6px 16px;font-size:13px;text-decoration:none;display:inline-flex;align-items:center;gap:4px">
        ${t('channel.slack_manifest.open_btn')}
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/><polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/></svg>
      </a>
    </div>
  `
  overlay.appendChild(card)
  document.body.appendChild(overlay)

  document.getElementById('slackManifestCopyBtn').addEventListener('click', () => {
    const copyBtn = document.getElementById('slackManifestCopyBtn')
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(manifest).then(() => {
        copyBtn.textContent = t('common.copied')
        setTimeout(() => { copyBtn.textContent = t('common.copy') }, 1500)
      }).catch(() => {
        fallbackCopyToClipboard(manifest, copyBtn)
      })
    } else {
      fallbackCopyToClipboard(manifest, copyBtn)
    }
  })
  document.getElementById('slackManifestCloseBtn').addEventListener('click', () => overlay.remove())
  overlay.addEventListener('click', (e) => { if (e.target === overlay) overlay.remove() })
}

document.getElementById('chSlackManifestBtn').addEventListener('click', async () => {
  if (!currentAgent) return
  const btn = document.getElementById('chSlackManifestBtn')
  btn.disabled = true
  try {
    const res = await fetch(`/api/agents/${encodeURIComponent(currentAgent.name)}/channels/slack/manifest`)
    if (!res.ok) throw new Error()
    const data = await res.json()
    showSlackManifestModal(data.manifest, data.instructions)
  } catch {
    showToast(t('channel.toast.manifest_failed'))
  } finally {
    btn.disabled = false
  }
})
