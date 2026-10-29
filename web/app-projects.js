// web/app-projects.js -- Projects overview page
// Ported from upstream 227d21319 (dropped during the Koteg 20 app.js-split merge,
// RedHat N3, card 4f5e43e6 comment 24984, follow-up 42426bc1). Logic unchanged from
// upstream; only the module boundary and the switchPage wiring (now in
// app-page-switch.js) differ from the original web/app.js diff.
// Loaded after app-kanban.js (kanbanProjectFilter, switchPage) and after
// app-docs.js (escapeAttr). Globals resolved at call time: t(), escapeHtml(),
// escapeAttr(), formatRelative(), showToast(), switchPage(), kanbanProjectFilter.
// Exposes: initProjectsPage() (called from switchPage in app-page-switch.js);
// binds the filter buttons + the grid's delegated click handler once (guarded,
// matching the app-freellm.js/app-kg.js module convention) rather than at
// script-load time the way the original monolithic app.js diff did, since
// the module split means this file's top level runs once per page load, not
// once per app lifetime in a context where "once" was already guaranteed.

// Human-readable, project-grouped summary of the kanban board. Everything
// except the free-text description is computed server-side straight from
// kanban_cards (GET /api/kanban-projects/summary) -- this page never derives
// card counts/status locally, so it can never disagree with the Kanban board
// itself. Fetches its own assignee list rather than depending on
// kanbanAssignees (populated by loadKanban()) so the page works correctly
// even if the user opens Projects before ever visiting Kanban.
let _projectsAssignees = []
// Last fetched summaries, kept so the status filter toggles below can
// re-render instantly without a round trip -- the summary endpoint already
// carries everything the filter needs (cardTotal/cardDone), so this is a
// pure client-side filter, no new API.
let _projectsLastSummaries = []
let projectsShowDone = true
let projectsShowInProgress = true

// A project's overall state, derived the same way the card-count badge is:
// "done" once every one of its (non-archived) cards is done, and only once
// it has at least one card -- a project with zero live cards never reaches
// here anyway (listKanbanProjectSummaries excludes it), but cardTotal===0
// is guarded regardless so a future zero-card summary can't misreport as done.
function projectOverallStatus(p) {
  return p.cardTotal > 0 && p.cardDone === p.cardTotal ? 'done' : 'in_progress'
}

async function loadProjects() {
  const grid = document.getElementById('projectsGrid')
  const empty = document.getElementById('projectsEmpty')
  if (!grid) return
  try {
    const [summaryRes, assigneesRes] = await Promise.all([
      fetch('/api/kanban-projects/summary'),
      fetch('/api/kanban/assignees'),
    ])
    if (!summaryRes.ok) throw new Error('HTTP ' + summaryRes.status)
    _projectsLastSummaries = await summaryRes.json()
    _projectsAssignees = assigneesRes.ok ? await assigneesRes.json() : []
    renderProjects()
  } catch (err) {
    console.error('loadProjects failed:', err)
    grid.innerHTML = ''
    if (empty) { empty.hidden = false; empty.textContent = t('projects.load_error') }
  }
}

function setProjectsFilterBtn(btnId, active) {
  const btn = document.getElementById(btnId)
  if (btn) btn.classList.toggle('active', active)
}

let _projectsFiltersBound = false
function setupProjectsFilters() {
  if (_projectsFiltersBound) return
  _projectsFiltersBound = true
  document.getElementById('projectsFilterDone')?.addEventListener('click', () => {
    projectsShowDone = !projectsShowDone
    setProjectsFilterBtn('projectsFilterDone', projectsShowDone)
    renderProjects()
  })
  document.getElementById('projectsFilterInProgress')?.addEventListener('click', () => {
    projectsShowInProgress = !projectsShowInProgress
    setProjectsFilterBtn('projectsFilterInProgress', projectsShowInProgress)
    renderProjects()
  })
}

// Case-insensitive match against the assignee list (mirrors
// kanbanSwimlaneKeyFor's own resolution rule) so display names/avatar colors
// are consistent with how the Kanban board itself labels the same assignee.
// An assignee id with no match (e.g. one that predates the current agent
// roster) falls back to the raw id with the neutral "unknown" dot color --
// same fallback the Kanban board uses, not a worse one.
function projectAssigneeMeta(rawName) {
  const raw = String(rawName || '').trim()
  const match = _projectsAssignees.find((a) => a.name.toLowerCase() === raw.toLowerCase())
  return match
    ? { label: match.displayName || match.name, type: match.type }
    : { label: raw, type: 'unknown' }
}

function renderProjects() {
  const grid = document.getElementById('projectsGrid')
  const empty = document.getElementById('projectsEmpty')
  if (!grid) return
  grid.innerHTML = ''
  const all = Array.isArray(_projectsLastSummaries) ? _projectsLastSummaries : []
  if (all.length === 0) {
    if (empty) { empty.hidden = false; empty.textContent = t('projects.empty') }
    return
  }
  const summaries = all.filter((p) => {
    const status = projectOverallStatus(p)
    if (status === 'done') return projectsShowDone
    return projectsShowInProgress
  })
  if (summaries.length === 0) {
    // Projects exist, but the current filter combination hides all of
    // them -- a different message from "no project at all", so the user
    // does not read this as an empty board.
    if (empty) { empty.hidden = false; empty.textContent = t('projects.filter_empty') }
    return
  }
  if (empty) empty.hidden = true

  for (const p of summaries) {
    const pct = p.cardTotal > 0 ? Math.round((p.cardDone / p.cardTotal) * 100) : 0
    const activity = p.lastActivityAt
      ? t('projects.last_activity', { when: formatRelative(p.lastActivityAt * 1000) })
      : t('projects.no_activity')
    const assigneeChips = (p.activeAssignees || []).length
      ? p.activeAssignees.map((name) => {
          const meta = projectAssigneeMeta(name)
          return `<span class="kanban-card-assignee"><span class="assignee-dot ${escapeAttr(meta.type)}">${escapeHtml((meta.label[0] || '?').toUpperCase())}</span>${escapeHtml(meta.label)}</span>`
        }).join('')
      : `<span class="kanban-card-assignee">${escapeHtml(t('projects.no_assignee'))}</span>`

    const card = document.createElement('div')
    card.className = 'overview-card'
    card.dataset.project = p.project
    card.innerHTML = `
      <div class="overview-card-head">
        <h3>${escapeHtml(p.project)}</h3>
        <span class="overview-card-meta">${escapeHtml(t('projects.cards_done', { done: p.cardDone, total: p.cardTotal }))}</span>
      </div>
      <div class="project-card-progress"><div class="project-card-progress-fill" style="width:${pct}%"></div></div>
      <div class="project-card-desc" data-role="desc-view" data-raw="${escapeHtml(p.description || '')}">${p.description ? escapeHtml(p.description) : `<em>${escapeHtml(t('projects.no_description'))}</em>`}</div>
      <textarea class="project-card-desc-edit" data-role="desc-edit" hidden>${escapeHtml(p.description || '')}</textarea>
      <div data-role="desc-actions" style="display:flex;gap:6px;margin:6px 0">
        <button class="btn-secondary btn-compact" data-act="edit">${escapeHtml(t('projects.edit'))}</button>
        <button class="btn-primary btn-compact" data-act="save" hidden>${escapeHtml(t('projects.save'))}</button>
        <button class="btn-secondary btn-compact" data-act="cancel" hidden>${escapeHtml(t('projects.cancel'))}</button>
      </div>
      <div class="project-card-assignees">${assigneeChips}</div>
      <div class="project-card-foot">
        <span>${escapeHtml(activity)}</span>
        <a href="#" data-act="view-kanban">${escapeHtml(t('projects.view_in_kanban'))}</a>
      </div>
    `
    grid.appendChild(card)
  }
}

// Delegated click handler (one listener for the whole grid, not one per
// card): the grid is fully re-rendered on every loadProjects() call, so
// per-card listeners would leak on each refresh. data-act encodes which
// button was pressed; data-project on the ancestor card carries the key.
let _projectsGridClickBound = false
function setupProjectsGridClick() {
  if (_projectsGridClickBound) return
  _projectsGridClickBound = true
  document.getElementById('projectsGrid')?.addEventListener('click', async (e) => {
    const card = e.target.closest('.overview-card[data-project]')
    if (!card) return
    const project = card.dataset.project
    const view = card.querySelector('[data-role="desc-view"]')
    const editArea = card.querySelector('[data-role="desc-edit"]')
    const [editBtn, saveBtn, cancelBtn] = card.querySelectorAll('[data-role="desc-actions"] button')

    if (e.target.closest('[data-act="edit"]')) {
      view.hidden = true; editArea.hidden = false
      editBtn.hidden = true; saveBtn.hidden = false; cancelBtn.hidden = false
      editArea.focus()
      return
    }
    if (e.target.closest('[data-act="cancel"]')) {
      editArea.value = view.dataset.raw ?? editArea.value
      view.hidden = false; editArea.hidden = true
      editBtn.hidden = false; saveBtn.hidden = true; cancelBtn.hidden = true
      return
    }
    if (e.target.closest('[data-act="save"]')) {
      const text = editArea.value
      try {
        const res = await fetch(`/api/kanban-projects/${encodeURIComponent(project)}`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ description: text }),
        })
        if (!res.ok) throw new Error('HTTP ' + res.status)
        view.innerHTML = text.trim() ? escapeHtml(text.trim()) : `<em>${escapeHtml(t('projects.no_description'))}</em>`
        view.dataset.raw = text.trim()
        view.hidden = false; editArea.hidden = true
        editBtn.hidden = false; saveBtn.hidden = true; cancelBtn.hidden = true
        showToast(t('common.saved'))
      } catch (err) {
        console.error('save project description failed:', err)
        showToast(t('projects.save_error'))
      }
      return
    }
    if (e.target.closest('[data-act="view-kanban"]')) {
      e.preventDefault()
      kanbanProjectFilter = project
      const sel = document.getElementById('kanbanProjectFilter')
      if (sel) sel.value = project
      switchPage('kanban')
    }
  })
}

function initProjectsPage() {
  setupProjectsFilters()
  setupProjectsGridClick()
  loadProjects()
}
