// === app-skills-detail.js ===
// Per-agent Skills tab in the Agent Detail modal (loadSkills, delete/install handlers).
// NOT the global Skills Page (that is app-skills.js).
// Extracted from app.js as part of modularisation (slice 22/N).
// This file is loaded AFTER app.js via a synchronous <script> tag in index.html.
//
// Globals from app.js: t, escapeHtml, showToast, currentAgent, loadAgents
// Functions called from app.js at event-time only: loadSkills
// === Skills ===
async function loadSkills(agentName) {
  const listEl = document.getElementById('skillList')
  const emptyEl = document.getElementById('skillEmpty')
  listEl.innerHTML = ''

  try {
    const res = await fetch(`/api/agents/${encodeURIComponent(agentName)}/skills`)
    if (!res.ok) throw new Error()
    const skills = await res.json()

    emptyEl.hidden = skills.length > 0
    document.getElementById('agentDetailSkillCount').textContent = skills.length

    for (const skill of skills) {
      const item = document.createElement('div')
      item.className = 'skill-item'
      // Inherited global skills (~/.claude/skills) are shared across every
      // agent, so they get a badge and no per-agent delete button -- only the
      // agent's own local skills are deletable from this view.
      const isGlobal = skill.source === 'global'
      const badge = isGlobal
        ? `<span class="skill-item-badge" title="${t('skills.badge.global')}">${t('skills.badge.global')}</span>`
        : ''
      const deletable = skill.deletable !== false
      item.innerHTML = `
        <div class="skill-item-info">
          <div class="skill-item-name">${escapeHtml(skill.name)}${badge}</div>
          ${skill.description ? `<div class="skill-item-desc">${escapeHtml(skill.description)}</div>` : ''}
        </div>
        <div class="skill-item-actions">
          ${deletable ? `<button class="btn-icon btn-icon-danger" title="${t('skills.btn.delete')}">${trashIcon()}</button>` : ''}
        </div>
      `
      const delBtn = item.querySelector('.btn-icon-danger')
      if (delBtn) {
        delBtn.addEventListener('click', async () => {
          if (!confirm(t('skills.confirm.delete', { name: skill.name }))) return
          try {
            await fetch(`/api/agents/${encodeURIComponent(agentName)}/skills/${encodeURIComponent(skill.name)}`, { method: 'DELETE' })
            showToast(t('skills.toast.deleted'))
            loadSkills(agentName)
          } catch {
            showToast(t('common.error_delete'))
          }
        })
      }
      listEl.appendChild(item)
    }
  } catch {
    emptyEl.hidden = false
    document.getElementById('agentDetailSkillCount').textContent = '0'
  }
}

// Add skill button
document.getElementById('addSkillBtn').addEventListener('click', () => {
  skillModalScope = null  // per-agent flow keyed off currentAgent
  document.getElementById('skillName').value = ''
  document.getElementById('skillDescription').value = ''
  skillFile = null
  document.getElementById('skillFileName').textContent = ''
  // Reset to create tab
  document.querySelectorAll('.skill-tab-btn').forEach(b => b.classList.toggle('active', b.dataset.skillTab === 'create'))
  document.getElementById('skillTabCreate').hidden = false
  document.getElementById('skillTabImport').hidden = true
  openModal(skillModalOverlay)
  setTimeout(() => document.getElementById('skillName').focus(), 200)
})

// Skill modal tab switching
document.querySelectorAll('.skill-tab-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.skill-tab-btn').forEach(b => b.classList.toggle('active', b === btn))
    document.getElementById('skillTabCreate').hidden = btn.dataset.skillTab !== 'create'
    document.getElementById('skillTabImport').hidden = btn.dataset.skillTab !== 'import'
  })
})

// File upload area
const skillFileArea = document.getElementById('skillFileArea')
const skillFileInput = document.getElementById('skillFileInput')
let skillFile = null

skillFileArea.addEventListener('click', () => skillFileInput.click())
skillFileArea.addEventListener('dragover', (e) => { e.preventDefault(); skillFileArea.style.borderColor = 'var(--accent)' })
skillFileArea.addEventListener('dragleave', () => { skillFileArea.style.borderColor = '' })
skillFileArea.addEventListener('drop', (e) => {
  e.preventDefault()
  skillFileArea.style.borderColor = ''
  const file = e.dataTransfer.files[0]
  if (file) { skillFile = file; document.getElementById('skillFileName').textContent = file.name }
})
skillFileInput.addEventListener('change', () => {
  const file = skillFileInput.files[0]
  if (file) { skillFile = file; document.getElementById('skillFileName').textContent = file.name }
})

// Create skill
document.getElementById('saveSkillBtn').addEventListener('click', async () => {
  const isGlobal = skillModalScope === 'global'
  if (!isGlobal && !currentAgent) return
  const name = document.getElementById('skillName').value.trim()
  if (!name) { document.getElementById('skillName').focus(); return }

  const btn = document.getElementById('saveSkillBtn')
  btn.disabled = true
  btn.querySelector('.btn-text').hidden = true
  btn.querySelector('.btn-loading').hidden = false

  try {
    const url = isGlobal
      ? '/api/skills'
      : `/api/agents/${encodeURIComponent(agentApiName())}/skills`
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name,
        description: document.getElementById('skillDescription').value.trim(),
      }),
    })
    if (!res.ok) {
      const err = await res.json()
      throw new Error(err.error || 'Hiba')
    }
    closeModal(skillModalOverlay)
    showToast(t('skills.toast.added'))
    if (isGlobal) {
      loadGlobalSkills()
    } else {
      loadSkills(agentApiName())
    }
  } catch (err) {
    showToast(`Hiba: ${err.message}`)
  } finally {
    btn.disabled = false
    btn.querySelector('.btn-text').hidden = false
    btn.querySelector('.btn-loading').hidden = true
  }
})

// Import skill
document.getElementById('importSkillBtn').addEventListener('click', async () => {
  const isGlobal = skillModalScope === 'global'
  if (!skillFile) { showToast(t('skills.toast.select_file')); return }
  if (!isGlobal && !currentAgent) { showToast(t('skills.toast.select_file')); return }

  const btn = document.getElementById('importSkillBtn')
  btn.disabled = true
  btn.querySelector('.btn-text').hidden = true
  btn.querySelector('.btn-loading').hidden = false

  try {
    const formData = new FormData()
    formData.append('file', skillFile)
    const url = isGlobal
      ? '/api/skills/import'
      : `/api/agents/${encodeURIComponent(agentApiName())}/skills/import`
    const res = await fetch(url, {
      method: 'POST',
      body: formData,
    })
    if (!res.ok) {
      const err = await res.json()
      throw new Error(err.error || 'Import hiba')
    }
    const result = await res.json()
    closeModal(skillModalOverlay)
    const importedList = Array.isArray(result.imported) ? result.imported : []
    showToast(t('skills.toast.imported', { list: importedList.join(', ') }))
    skillFile = null
    document.getElementById('skillFileName').textContent = ''
    if (isGlobal) {
      loadGlobalSkills()
    } else {
      loadSkills(agentApiName())
    }
  } catch (err) {
    showToast(`Hiba: ${err.message}`)
  } finally {
    btn.disabled = false
    btn.querySelector('.btn-text').hidden = false
    btn.querySelector('.btn-loading').hidden = true
  }
})

