// app-connectors-banner.js -- connectors.hu install banner IIFE
// (app.js modularisation slice 28.)
// Globals from app.js: t

// === connectors.hu install banner ===
;(function () {
  const DISMISSED_KEY = 'cxhu_banner_dismissed'
  const banner = document.getElementById('cxhuBanner')
  const closeBtn = document.getElementById('cxhuBannerClose')
  if (!banner || !closeBtn) return
  if (localStorage.getItem(DISMISSED_KEY) === '1') { banner.hidden = true; return }

  // dismiss with animation
  closeBtn.addEventListener('click', () => {
    banner.style.transition = 'opacity 0.2s ease, max-height 0.3s ease'
    banner.style.overflow = 'hidden'
    banner.style.opacity = '0'
    banner.style.maxHeight = banner.offsetHeight + 'px'
    requestAnimationFrame(() => { banner.style.maxHeight = '0' })
    setTimeout(() => { banner.hidden = true }, 300)
    localStorage.setItem(DISMISSED_KEY, '1')
  })

  // --- state machine ---
  const states = ['Loading','Done','Install','Installing','Token','Configuring','Error']
  function showState(name) {
    states.forEach(s => {
      const el = document.getElementById('cxhuState' + s)
      if (el) el.hidden = (s !== name)
    })
  }

  let lastError = null

  async function checkStatus() {
    showState('Loading')
    try {
      const res = await fetch('/api/connectors-hu/status')
      if (!res.ok) throw new Error('HTTP ' + res.status)
      const data = await res.json()
      if (data.installed && data.configured) {
        showState('Done')
      } else if (data.installed) {
        showState('Token')
      } else {
        showState('Install')
      }
    } catch (e) {
      showError(e.message || t('status.error.fetch'), checkStatus)
    }
  }

  function showError(msg, retryFn) {
    document.getElementById('cxhuErrorMsg').textContent = msg
    showState('Error')
    const retryBtn = document.getElementById('cxhuRetryBtn')
    retryBtn.onclick = retryFn || checkStatus
  }

  // Telepítés gomb
  const installBtn = document.getElementById('cxhuInstallBtn')
  if (installBtn) {
    installBtn.addEventListener('click', async () => {
      showState('Installing')
      try {
        const res = await fetch('/api/connectors-hu/install', { method: 'POST' })
        const data = await res.json().catch(() => ({}))
        if (!res.ok || !data.ok) throw new Error(data.error || t('connectors.error.install'))
        showState('Token')
      } catch (e) {
        showError(e.message, () => { showState('Install') })
      }
    })
  }

  // Mentés és szinkron gomb
  const configureBtn = document.getElementById('cxhuConfigureBtn')
  if (configureBtn) {
    configureBtn.addEventListener('click', async () => {
      const token = (document.getElementById('cxhuTokenInput') || {}).value || ''
      if (!token.trim()) {
        document.getElementById('cxhuTokenInput').focus()
        return
      }
      showState('Configuring')
      try {
        const res = await fetch('/api/connectors-hu/configure', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ token: token.trim() }),
        })
        const data = await res.json().catch(() => ({}))
        if (!res.ok || !data.ok) throw new Error(data.error || t('connectors.error.configure'))
        showState('Done')
      } catch (e) {
        showError(e.message, () => { showState('Token') })
      }
    })
  }

  // Enter key a token inputban
  const tokenInput = document.getElementById('cxhuTokenInput')
  if (tokenInput) {
    tokenInput.addEventListener('keydown', e => { if (e.key === 'Enter') configureBtn && configureBtn.click() })
  }

  checkStatus()
})()
