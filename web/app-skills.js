// Skills Page module -- extracted from app.js (card 7a2a7ef3 / slice 10/N).
// Loaded AFTER app.js in index.html; globals (t, escapeHtml, esc, showToast,
// currentAgent) resolved at call time.
// loadGlobalSkills() is only called from switchPage (pageId=skills), never at init time.
// Top-level DOM references (skillsGrid etc.) and the IIFE event-listener block execute
// on module load -- safe because scripts run after full body parse.


// ============================================================
// === Skills Page ===
// ============================================================

const skillsGrid = document.getElementById('skillsGrid')
const skillsStats = document.getElementById('skillsStats')
const skillsEmpty = document.getElementById('skillsEmpty')
const skillDetailOverlay = document.getElementById('skillDetailOverlay')

let globalSkills = []
let localAgentSkills = []
let skillsActiveFilter = 'all'
let skillsSearchQuery = ''
let skillsActiveCategory = 'all'

function deriveSkillCategory(name) {
  // Use the first dash-separated segment as the category group.
  // "fleet-dashboard-api" -> "fleet", "morning-chain" -> "morning",
  // "handoff" -> "handoff"
  const seg = name.split(':').pop() || name  // strip plugin prefix
  return seg.split('-')[0] || seg
}

function formatMtime(ms) {
  if (!ms) return ''
  const d = new Date(ms)
  const pad = n => String(n).padStart(2, '0')
  return `${d.getFullYear()}.${pad(d.getMonth() + 1)}.${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}

document.getElementById('skillDetailClose').addEventListener('click', () => closeModal(skillDetailOverlay))
attachOverlayCloseGuard(skillDetailOverlay)

// Scope for the next skill create/import action. 'global' means the
// Skills page opened the modal (write to ~/.claude/skills/); any other
// value (or null) falls back to the legacy per-agent flow keyed off
// `currentAgent`. Reset on modal close so a subsequent per-agent open
// cannot inherit the global scope.
let skillModalScope = null

// Wire the Skills-page "Új skill" button to reuse the same skillModalOverlay
// the per-agent Skill list uses. The save/import handlers branch on
// skillModalScope so we don't have to duplicate the modal markup.
const skillsPageNewBtn = document.getElementById('skillsPageNewBtn')
if (skillsPageNewBtn) {
  skillsPageNewBtn.addEventListener('click', () => {
    skillModalScope = 'global'
    document.getElementById('skillName').value = ''
    document.getElementById('skillDescription').value = ''
    skillFile = null
    document.getElementById('skillFileName').textContent = ''
    document.querySelectorAll('.skill-tab-btn').forEach(b => b.classList.toggle('active', b.dataset.skillTab === 'create'))
    document.getElementById('skillTabCreate').hidden = false
    document.getElementById('skillTabImport').hidden = true
    openModal(skillModalOverlay)
    setTimeout(() => document.getElementById('skillName').focus(), 200)
  })
}

async function loadGlobalSkills() {
  skillsGrid.innerHTML = `<div class="connector-loading"><span class="spinner"></span> ${t('skills.loading')}</div>`
  skillsStats.innerHTML = ''
  try {
    const [globalRes, localRes] = await Promise.all([
      fetch('/api/skills'),
      fetch('/api/skills/local'),
    ])
    globalSkills = await globalRes.json()
    localAgentSkills = localRes.ok ? await localRes.json() : []
    renderGlobalSkills()
  } catch (err) {
    console.error('Skills betoltes hiba:', err)
    skillsGrid.innerHTML = `<div class="connector-loading">${t('skills.error')}</div>`
  }
}

// Wire search, filter, and export controls once DOM is ready
;(() => {
  const searchEl = document.getElementById('skillsSearch')
  if (searchEl) {
    searchEl.addEventListener('input', () => {
      skillsSearchQuery = searchEl.value.toLowerCase().trim()
      renderSkillsSidebar()
      renderGlobalSkillsGrid()
    })
  }

  const filterBtns = document.getElementById('skillsFilterBtns')
  if (filterBtns) {
    filterBtns.addEventListener('click', (e) => {
      const btn = e.target.closest('.skills-filter-btn')
      if (!btn) return
      filterBtns.querySelectorAll('.skills-filter-btn').forEach(b => b.classList.remove('active'))
      btn.classList.add('active')
      skillsActiveFilter = btn.dataset.filter || 'all'
      skillsActiveCategory = 'all'
      renderSkillsSidebar()
      renderGlobalSkillsGrid()
    })
  }

  const exportBtn = document.getElementById('skillsExportBtn')
  if (exportBtn) {
    exportBtn.addEventListener('click', () => {
      const a = document.createElement('a')
      a.href = '/api/skills/export'
      a.download = 'skills-export.zip'
      document.body.appendChild(a)
      a.click()
      document.body.removeChild(a)
    })
  }
})()

function getSkillIcon(name) {
  if (name.includes('factory') || name.includes('creator')) return '\u{1F3ED}'
  if (name.includes('blog') || name.includes('post')) return '\u{1F4DD}'
  if (name.includes('image') || name.includes('thumbnail') || name.includes('fal')) return '\u{1F3A8}'
  if (name.includes('frontend') || name.includes('design')) return '\u{1F58C}\uFE0F'
  if (name.includes('youtube') || name.includes('video') || name.includes('seo')) return '\u{1F3AC}'
  if (name.includes('docx') || name.includes('doc')) return '\u{1F4C4}'
  if (name.includes('skool')) return '\u{1F393}'
  if (name.includes('skill')) return '\u{1F9E9}'
  return '\u2699\uFE0F'
}

function renderSkillsSidebar() {
  const sidebar = document.getElementById('skillsCategorySidebar')
  if (!sidebar) return

  // For the 'agent' filter, category counts come from localAgentSkills so the
  // sidebar stays populated. All other filters draw from globalSkills as before.
  const sourceFiltered = skillsActiveFilter === 'agent'
    ? localAgentSkills
    : skillsActiveFilter === 'all'
      ? globalSkills
      : globalSkills.filter(s => s.source === skillsActiveFilter)

  const catCounts = new Map()
  for (const s of sourceFiltered) {
    const cat = deriveSkillCategory(s.name)
    catCounts.set(cat, (catCounts.get(cat) || 0) + 1)
  }

  const cats = [...catCounts.entries()].sort((a, b) => a[0].localeCompare(b[0]))

  sidebar.innerHTML = `
    <div class="skills-cat-title">${t('skills.category.title')}</div>
    <button class="skills-cat-btn${skillsActiveCategory === 'all' ? ' active' : ''}" data-cat="all">
      ${t('skills.filter.all')} <span class="skills-cat-count">${sourceFiltered.length}</span>
    </button>
    ${cats.map(([cat, count]) => `
      <button class="skills-cat-btn${skillsActiveCategory === cat ? ' active' : ''}" data-cat="${escapeHtml(cat)}">
        ${escapeHtml(cat)} <span class="skills-cat-count">${count}</span>
      </button>
    `).join('')}
  `

  sidebar.addEventListener('click', (e) => {
    const btn = e.target.closest('.skills-cat-btn')
    if (!btn) return
    skillsActiveCategory = btn.dataset.cat || 'all'
    renderSkillsSidebar()
    renderGlobalSkillsGrid()
  })
}

function renderGlobalSkills() {
  const userCount = globalSkills.filter(s => s.source === 'user').length
  const pluginCount = globalSkills.filter(s => s.source === 'plugin').length

  skillsStats.innerHTML = `
    <div class="stat-card"><div class="stat-value">${globalSkills.length}</div><div class="stat-label">${t('skills.stat.total')}</div></div>
    <div class="stat-card"><div class="stat-value" style="color:var(--info)">${userCount}</div><div class="stat-label">${t('skills.stat.user')}</div></div>
    ${pluginCount ? `<div class="stat-card"><div class="stat-value" style="color:var(--accent)">${pluginCount}</div><div class="stat-label">${t('skills.stat.plugin')}</div></div>` : ''}
    ${localAgentSkills.length ? `<div class="stat-card"><div class="stat-value" style="color:var(--warning)">${localAgentSkills.length}</div><div class="stat-label">${t('skills.stat.agent_local')}</div></div>` : ''}
  `

  skillsActiveCategory = 'all'
  renderSkillsSidebar()
  renderGlobalSkillsGrid()
}

function renderGlobalSkillsGrid() {
  skillsGrid.innerHTML = ''

  const isAgentFilter = skillsActiveFilter === 'agent'

  // When 'agent' filter is active, show only local agent skills; otherwise show global/plugin.
  const filteredGlobal = isAgentFilter ? [] : globalSkills.filter(s => {
    if (skillsActiveFilter !== 'all' && s.source !== skillsActiveFilter) return false
    if (skillsActiveCategory !== 'all' && deriveSkillCategory(s.name) !== skillsActiveCategory) return false
    if (!skillsSearchQuery) return true
    const haystack = [s.name, s.label, s.description, ...(s.keywords || [])].join(' ').toLowerCase()
    return haystack.includes(skillsSearchQuery)
  })

  // Local agent skills: always merged in for 'all' or filtered to 'agent'.
  const filteredLocal = (skillsActiveFilter === 'all' || isAgentFilter) ? localAgentSkills.filter(s => {
    if (skillsActiveCategory !== 'all' && deriveSkillCategory(s.name) !== skillsActiveCategory) return false
    if (!skillsSearchQuery) return true
    const haystack = [s.name, s.label, s.description, s.agentId, ...(s.keywords || [])].join(' ').toLowerCase()
    return haystack.includes(skillsSearchQuery)
  }) : []

  const allFiltered = [...filteredGlobal, ...filteredLocal]

  if (allFiltered.length === 0) {
    skillsEmpty.hidden = false
    return
  }
  skillsEmpty.hidden = true

  const sourceLabels = { user: 'user', plugin: 'plugin', agent: t('skills.filter.agent') }

  const renderCard = (skill, isLocal) => {
    const card = document.createElement('div')
    card.className = isLocal ? 'skills-card skills-card--local' : 'skills-card'
    const icon = getSkillIcon(skill.name)
    const sourceBadge = isLocal
      ? `<span class="connector-source-badge skills-badge--agent">${escapeHtml(skill.agentId)}</span>`
      : (skill.source ? `<span class="connector-source-badge">${escapeHtml(sourceLabels[skill.source] || skill.source)}</span>` : '')

    const hasDesc = !!skill.description
    const healthClass = hasDesc ? 'skill-health-ok' : 'skill-health-warn'
    const healthTitle = hasDesc ? t('skills.health.ok') : t('skills.health.nodesc')

    const kws = (skill.keywords || []).slice(0, 3)
    const kwTags = kws.map(k => `<span class="skill-keyword-tag">${escapeHtml(k)}</span>`).join('')

    const agents = skill.agents || []
    const agentBadges = agents.length > 0
      ? `<span class="skills-agent-badge skill-agent-count" title="${escapeHtml(agents.join(', '))}">&#x1F916; ${agents.length} ${t('skills.agents.count')}</span>`
      : ''

    const mtimeStr = skill.mtime ? formatMtime(skill.mtime) : ''

    const displayName = skill.label || skill.name
    card.innerHTML = `
      <div class="skills-card-header">
        <div class="skills-card-icon">${icon}</div>
        <div class="skills-card-info">
          <div class="skills-card-name">
            ${escapeHtml(displayName)} ${sourceBadge}
            <span class="skill-health-dot ${healthClass}" title="${escapeHtml(healthTitle)}"></span>
          </div>
          <div class="skills-card-desc">${escapeHtml(skill.description || t('skills.no_description'))}</div>
        </div>
      </div>
      ${(kwTags || agentBadges || mtimeStr) ? `
      <div class="skills-card-footer">
        ${kwTags}
        ${agentBadges}
        ${mtimeStr ? `<span class="skill-card-mtime" title="${t('skills.mtime.title')}">${escapeHtml(mtimeStr)}</span>` : ''}
      </div>` : ''}
    `
    card.addEventListener('click', () => openSkillDetail(skill.name, skill.label, skill.agentId || null))
    skillsGrid.appendChild(card)
  }

  for (const skill of filteredGlobal) renderCard(skill, false)
  for (const skill of filteredLocal) renderCard(skill, true)
}

let _skillDetailCurrentName = null
let _skillDetailCurrentAgentId = null
let _skillDetailIsPlugin = false

function _skillDetailExitEdit() {
  const editor = document.getElementById('skillDetailEditor')
  const contentEl = document.getElementById('skillDetailContent')
  const editActions = document.getElementById('skillDetailEditActions')
  const editBtn = document.getElementById('skillDetailEditBtn')
  editor.hidden = true
  contentEl.hidden = false
  editActions.hidden = true
  editBtn.disabled = false
}

async function openSkillDetail(skillName, displayLabel, agentId = null) {
  _skillDetailCurrentName = skillName
  _skillDetailCurrentAgentId = agentId
  _skillDetailExitEdit()

  document.getElementById('skillDetailTitle').textContent = displayLabel || skillName

  const editBtn = document.getElementById('skillDetailEditBtn')
  if (editBtn) {
    editBtn.hidden = false
    editBtn.disabled = false
  }

  try {
    const detailUrl = agentId
      ? `/api/skills/${encodeURIComponent(skillName)}?agent=${encodeURIComponent(agentId)}`
      : `/api/skills/${encodeURIComponent(skillName)}`
    const res = await fetch(detailUrl)
    if (!res.ok) throw new Error('Failed to fetch skill detail')
    const detail = await res.json()
    _skillDetailIsPlugin = detail.source === 'plugin'

    // Hide edit button for plugin skills
    if (editBtn) editBtn.hidden = _skillDetailIsPlugin

    // Description
    const descEl = document.getElementById('skillDetailDesc')
    descEl.textContent = detail.description || t('skills.no_description')

    // Meta: source + mtime
    const metaEl = document.getElementById('skillDetailMeta')
    if (metaEl) {
      const sourceLabel = detail.source === 'plugin'
        ? `plugin${detail.pluginPackage ? ' (' + escapeHtml(detail.pluginPackage) + ')' : ''}`
        : detail.source === 'user'
        ? t('skills.source.user')
        : t('skills.source.unknown')
      const mtimeStr = detail.mtime ? formatMtime(detail.mtime) : ''
      metaEl.innerHTML = `
        <div class="skill-detail-source">${t('skills.detail.source_label')} <strong>${sourceLabel}</strong>${mtimeStr ? ` &middot; <span title="${escapeHtml(t('skills.mtime.title'))}">${escapeHtml(mtimeStr)}</span>` : ''}</div>
        <div class="skill-detail-note">${t('skills.detail.auto_available')}</div>
      `
    }

    // Keywords
    const kwEl = document.getElementById('skillDetailKeywords')
    if (kwEl) {
      const kws = detail.keywords || []
      if (kws.length > 0) {
        kwEl.hidden = false
        kwEl.innerHTML = `<span class="skill-kw-label">${t('skills.keywords.label')}</span> ` +
          kws.map(k => `<span class="skill-keyword-tag">${escapeHtml(k)}</span>`).join(' ')
      } else {
        kwEl.hidden = true
      }
    }

    // Agent coverage
    const agentsEl = document.getElementById('skillDetailAgentsCoverage')
    if (agentsEl) {
      const agents = detail.agents || []
      if (agents.length > 0) {
        agentsEl.hidden = false
        agentsEl.innerHTML = `<span class="skill-kw-label">${t('skills.agents.label')}</span> ` +
          agents.map(a => `<span class="skills-agent-badge">${escapeHtml(a)}</span>`).join(' ')
      } else {
        agentsEl.hidden = true
      }
    }

    // Health indicator
    const healthEl = document.getElementById('skillDetailHealth')
    if (healthEl) {
      const hasDesc = !!detail.description
      const hasContent = !!detail.content
      if (hasDesc && hasContent) {
        healthEl.className = 'skill-health-label skill-health-ok'
        healthEl.textContent = t('skills.health.ok')
      } else if (hasContent) {
        healthEl.className = 'skill-health-label skill-health-warn'
        healthEl.textContent = t('skills.health.nodesc')
      } else {
        healthEl.className = 'skill-health-label skill-health-err'
        healthEl.textContent = t('skills.health.empty')
      }
    }

    // Content: render as markdown
    const contentEl = document.getElementById('skillDetailContent')
    const rawContent = detail.content || t('skills.content_not_found')
    contentEl.innerHTML = renderMarkdown(rawContent)

    // Prefill editor
    const editor = document.getElementById('skillDetailEditor')
    if (editor) editor.value = rawContent

  } catch (err) {
    console.error('Skill detail hiba:', err)
    document.getElementById('skillDetailDesc').textContent = t('connectors.error_list')
    document.getElementById('skillDetailContent').innerHTML = ''
    const metaEl = document.getElementById('skillDetailMeta')
    if (metaEl) metaEl.innerHTML = ''
    if (editBtn) editBtn.hidden = true
  }

  openModal(skillDetailOverlay)
}

// Inline edit wiring
;(() => {
  const editBtn = document.getElementById('skillDetailEditBtn')
  const saveBtn = document.getElementById('skillDetailSaveBtn')
  const cancelBtn = document.getElementById('skillDetailCancelEditBtn')
  const editor = document.getElementById('skillDetailEditor')
  const contentEl = document.getElementById('skillDetailContent')
  const editActions = document.getElementById('skillDetailEditActions')

  if (editBtn) {
    editBtn.addEventListener('click', () => {
      if (_skillDetailIsPlugin) return
      contentEl.hidden = true
      editor.hidden = false
      editActions.hidden = false
      editBtn.disabled = true
      editor.focus()
    })
  }

  if (cancelBtn) {
    cancelBtn.addEventListener('click', _skillDetailExitEdit)
  }

  if (saveBtn) {
    saveBtn.addEventListener('click', async () => {
      if (!_skillDetailCurrentName || _skillDetailIsPlugin) return
      const newContent = editor.value
      saveBtn.disabled = true
      try {
        const putUrl = _skillDetailCurrentAgentId
          ? `/api/skills/${encodeURIComponent(_skillDetailCurrentName)}?agent=${encodeURIComponent(_skillDetailCurrentAgentId)}`
          : `/api/skills/${encodeURIComponent(_skillDetailCurrentName)}`
        const res = await fetch(putUrl, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ content: newContent }),
        })
        if (!res.ok) throw new Error('PUT failed: ' + res.status)
        contentEl.innerHTML = renderMarkdown(newContent)
        _skillDetailExitEdit()
        showToast(t('skills.toast.saved'))
        // Refresh list to pick up new description/keywords
        loadGlobalSkills()
      } catch (err) {
        console.error('Skill mentés hiba:', err)
        showToast(t('skills.toast.save_error'))
      } finally {
        saveBtn.disabled = false
      }
    })
  }
})()

