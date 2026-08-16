// app-autonomy.js -- Autonomy/Integrations content rendering (slice 17).
// Loaded AFTER app.js in index.html; globals used from app.js:
//   t, escapeHtml, showToast
// renderAutonomyContent is called from loadSettings (app-device-keys.js) at event-time.
// === Autonomy ===
// ============================================================

async function renderIntegrationsContent(container) {
  container.innerHTML = `<p style="color:var(--text-muted);font-size:13px;padding:16px 0">${t('common.loading')}</p>`

  let configured = false
  let masked = null

  try {
    const res = await fetch('/api/settings/integrations/gemini', { headers: { Authorization: `Bearer ${(localStorage.getItem('marveen-dashboard-token') || '')}` } })
    if (!res.ok) throw new Error('fetch failed')
    const data = await res.json()
    configured = !!data.configured
    masked = data.masked || null
  } catch {
    container.innerHTML = `<p style="color:var(--danger);padding:16px 0;font-size:13px">${t('integrations.gemini.err.load')}</p>`
    return
  }

  // Build the Gemini section
  const section = document.createElement('div')
  section.className = 'settings-group'
  section.style.maxWidth = '540px'

  // Header row
  const headerRow = document.createElement('div')
  headerRow.style.cssText = 'display:flex;align-items:center;justify-content:space-between;margin-bottom:4px'

  const titleEl = document.createElement('div')
  titleEl.className = 'settings-row-key'
  titleEl.style.fontWeight = '600'
  titleEl.textContent = t('integrations.gemini.title')
  headerRow.appendChild(titleEl)

  const statusBadge = document.createElement('span')
  statusBadge.id = 'geminiStatusBadge'
  statusBadge.style.cssText = `font-size:12px;padding:2px 8px;border-radius:12px;font-weight:500;${configured
    ? 'background:var(--success-bg,rgba(34,197,94,.15));color:var(--success,#22c55e)'
    : 'background:var(--bg-card,rgba(255,255,255,.06));color:var(--text-muted)'}`
  statusBadge.textContent = configured ? t('integrations.gemini.status.set') : t('integrations.gemini.status.unset')
  headerRow.appendChild(statusBadge)

  section.appendChild(headerRow)

  const descEl = document.createElement('div')
  descEl.className = 'settings-row-desc'
  descEl.style.marginBottom = '16px'
  descEl.textContent = t('integrations.gemini.desc')
  section.appendChild(descEl)

  // Masked key display (shown when configured)
  const maskedRow = document.createElement('div')
  maskedRow.id = 'geminiMaskedRow'
  maskedRow.hidden = !configured
  maskedRow.style.cssText = 'display:flex;align-items:center;gap:8px;margin-bottom:12px;font-family:monospace;font-size:13px;color:var(--text-muted)'
  maskedRow.textContent = masked || ''
  section.appendChild(maskedRow)

  // Input row
  const inputRow = document.createElement('div')
  inputRow.style.cssText = 'display:flex;gap:8px;align-items:center;margin-bottom:8px'

  const inputWrap = document.createElement('div')
  inputWrap.style.cssText = 'position:relative;flex:1'

  const keyInput = document.createElement('input')
  keyInput.id = 'geminiKeyInput'
  keyInput.type = 'password'
  keyInput.className = 'input'
  keyInput.placeholder = t('integrations.gemini.input.ph')
  keyInput.setAttribute('aria-label', t('integrations.gemini.input.label'))
  keyInput.autocomplete = 'off'
  keyInput.style.cssText = 'width:100%;padding-right:44px'
  inputWrap.appendChild(keyInput)

  const revealBtn = document.createElement('button')
  revealBtn.type = 'button'
  revealBtn.setAttribute('aria-label', t('integrations.gemini.btn.show'))
  revealBtn.style.cssText = 'position:absolute;right:8px;top:50%;transform:translateY(-50%);background:none;border:none;cursor:pointer;color:var(--text-muted);padding:4px;min-height:44px;min-width:44px;display:flex;align-items:center;justify-content:center'
  revealBtn.innerHTML = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>'
  revealBtn.addEventListener('click', () => {
    const showing = keyInput.type === 'text'
    keyInput.type = showing ? 'password' : 'text'
    revealBtn.setAttribute('aria-label', showing ? t('integrations.gemini.btn.show') : t('integrations.gemini.btn.hide'))
  })
  inputWrap.appendChild(revealBtn)
  inputRow.appendChild(inputWrap)
  section.appendChild(inputRow)

  // Buttons row
  const btnRow = document.createElement('div')
  btnRow.style.cssText = 'display:flex;gap:8px;align-items:center;flex-wrap:wrap'

  const saveBtn = document.createElement('button')
  saveBtn.type = 'button'
  saveBtn.className = 'btn-primary btn-compact'
  saveBtn.textContent = t('integrations.gemini.btn.save')
  saveBtn.style.minHeight = '44px'

  const deleteBtn = document.createElement('button')
  deleteBtn.type = 'button'
  deleteBtn.className = 'btn-danger btn-compact'
  deleteBtn.textContent = t('integrations.gemini.btn.delete')
  deleteBtn.hidden = !configured
  deleteBtn.style.minHeight = '44px'

  const feedbackEl = document.createElement('span')
  feedbackEl.id = 'geminiFeedback'
  feedbackEl.style.cssText = 'font-size:13px;flex:1'

  btnRow.appendChild(saveBtn)
  btnRow.appendChild(deleteBtn)
  btnRow.appendChild(feedbackEl)
  section.appendChild(btnRow)

  container.innerHTML = ''
  container.appendChild(section)

  // Save handler
  saveBtn.addEventListener('click', async () => {
    const val = keyInput.value.trim()
    feedbackEl.textContent = ''
    feedbackEl.style.color = 'var(--text-muted)'
    if (!val) {
      feedbackEl.style.color = 'var(--danger)'
      feedbackEl.textContent = t('integrations.gemini.err.empty')
      return
    }
    saveBtn.disabled = true
    saveBtn.textContent = t('integrations.gemini.btn.saving')
    try {
      const res = await fetch('/api/settings/integrations/gemini', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${(localStorage.getItem('marveen-dashboard-token') || '')}` },
        body: JSON.stringify({ apiKey: val }),
      })
      const data = await res.json()
      if (!res.ok || !data.ok) throw new Error(data.error || 'failed')
      // Update UI state
      keyInput.value = ''
      keyInput.type = 'password'
      masked = data.masked
      maskedRow.textContent = masked || ''
      maskedRow.hidden = false
      deleteBtn.hidden = false
      statusBadge.textContent = t('integrations.gemini.status.set')
      statusBadge.style.background = 'var(--success-bg,rgba(34,197,94,.15))'
      statusBadge.style.color = 'var(--success,#22c55e)'
      feedbackEl.style.color = 'var(--success,#22c55e)'
      feedbackEl.textContent = t('integrations.gemini.saved')
    } catch {
      feedbackEl.style.color = 'var(--danger)'
      feedbackEl.textContent = t('integrations.gemini.err.save')
    } finally {
      saveBtn.disabled = false
      saveBtn.textContent = t('integrations.gemini.btn.save')
    }
  })

  // Delete handler
  deleteBtn.addEventListener('click', async () => {
    feedbackEl.textContent = ''
    deleteBtn.disabled = true
    deleteBtn.textContent = t('integrations.gemini.btn.deleting')
    try {
      const res = await fetch('/api/settings/integrations/gemini', {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${(localStorage.getItem('marveen-dashboard-token') || '')}` },
      })
      const data = await res.json()
      if (!res.ok || !data.ok) throw new Error(data.error || 'failed')
      masked = null
      maskedRow.textContent = ''
      maskedRow.hidden = true
      deleteBtn.hidden = true
      statusBadge.textContent = t('integrations.gemini.status.unset')
      statusBadge.style.background = 'var(--bg-card,rgba(255,255,255,.06))'
      statusBadge.style.color = 'var(--text-muted)'
      feedbackEl.style.color = 'var(--text-muted)'
      feedbackEl.textContent = t('integrations.gemini.deleted')
    } catch {
      feedbackEl.style.color = 'var(--danger)'
      feedbackEl.textContent = t('integrations.gemini.err.delete')
    } finally {
      deleteBtn.disabled = false
      deleteBtn.textContent = t('integrations.gemini.btn.delete')
    }
  })
}

async function renderAutonomyContent(gridEl, footerEl) {
  gridEl.innerHTML = `<p style="color:var(--text-muted);font-size:13px">${t('autonomy.loading')}</p>`

  try {
    const res = await fetch('/api/autonomy')
    if (!res.ok) throw new Error('fetch failed')
    const config = await res.json()

    gridEl.innerHTML = ''
    for (const cat of config.categories) {
      const isCapped = !cat.locked && cat.maxLevel < 3
      const row = document.createElement('div')
      row.className = 'autonomy-row' + (cat.locked ? ' locked' : '') + (isCapped ? ' capped' : '')

      const label = document.createElement('div')
      label.className = 'autonomy-row-label'
      label.textContent = cat.label

      const levels = document.createElement('div')
      levels.className = 'autonomy-levels'

      for (let l = 1; l <= 3; l++) {
        const btn = document.createElement('button')
        const isOver = l > cat.maxLevel
        btn.className = 'autonomy-level-btn' + (l === cat.level ? ' active' : '') + (isOver ? ' over-cap' : '')
        btn.dataset.level = String(l)
        btn.textContent = String(l)
        btn.disabled = cat.locked || isOver
        if (!cat.locked && !isOver) {
          btn.addEventListener('click', () => setAutonomyLevel(cat.key, l))
        }
        levels.appendChild(btn)
      }

      row.appendChild(label)
      if (cat.locked) {
        const lock = document.createElement('div')
        lock.className = 'autonomy-row-lock'
        lock.innerHTML = `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="11" width="18" height="11" rx="2" ry="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg> ${t('autonomy.lock_label')}`
        row.appendChild(lock)
      } else if (isCapped) {
        const cap = document.createElement('div')
        cap.className = 'autonomy-row-cap'
        cap.innerHTML = `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/></svg> ${t('autonomy.cap_label', { n: cat.maxLevel })}`
        row.appendChild(cap)
      }
      row.appendChild(levels)
      gridEl.appendChild(row)
    }

    if (footerEl) {
      if (config.updated_at > 0) {
        const d = new Date(config.updated_at * 1000)
        footerEl.textContent = t('autonomy.last_modified', { date: d.toLocaleString('hu-HU') })
      } else {
        footerEl.textContent = t('autonomy.not_modified')
      }
    }
  } catch (err) {
    gridEl.innerHTML = `<p style="color:var(--danger)">${t('autonomy.error')}</p>`
    if (footerEl) footerEl.textContent = ''
  }
}

async function setAutonomyLevel(key, level) {
  try {
    const res = await fetch('/api/autonomy', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ key, level }),
    })
    if (!res.ok) {
      const data = await res.json().catch(() => ({}))
      showToast(data.error || 'Hiba')
      return
    }
    // Refresh the settings tab autonomy grid if it is visible
    const tabGrid = document.getElementById('settingsAutonomyGrid')
    const tabFooter = document.getElementById('settingsAutonomyUpdatedAt')
    if (tabGrid) renderAutonomyContent(tabGrid, tabFooter)
  } catch {
    showToast(t('kanban.toast.save_error'))
  }
}

