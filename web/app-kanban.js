// app-kanban.js -- Kanban board, Drag & Drop, Card modals (app.js modularisation slice 30).
// Globals from app.js: t, showToast, escapeHtml, openModal, closeModal
// Exposed globally: loadKanban() -- called from switchPage and startKanbanRefresh() in app.js

// === Kanban ===
// ============================================================

// Every move made from this dashboard is made by the human at the keyboard, so
// each /move call names the owner as `actor`. That is what lets the backend tell
// an assignment ("the owner dragged this onto you") apart from a self-pickup ("the
// agent moved its own card"), and only wake the agent in the first case. Falls
// back to undefined until /api/marveen has loaded -- an unnamed mover means the
// backend dispatches as it always did, never the opposite.
function kanbanMoveActor() { return window._marveen?.ownerName || undefined }

let kanbanCards = []
let kanbanAssignees = []
let kanbanProjects = []
// Label registry (id/name/color), independent of which cards currently carry
// which labels -- card.labels (embedded by GET /api/kanban) holds that link.
let kanbanAllLabels = []
// Active label-filter ids -- the quick-filter chip row AND the per-card
// footer label pills both toggle this same set (two entry points, one
// filter dimension). OR-combined within itself (any active label matches),
// AND-combined with the existing project/assignee filters. Persisted in
// localStorage alongside the swimlane groupBy choice.
let kanbanLabelFilter = new Set()
// The kanban quick-filter chip row is generated from the LIVE fleet agent list
// (GET /api/agents) rather than from the kanban label registry, so EVERY created
// agent gets a chip -- including newly-created ones and agents that have no
// @<name> label yet (e.g. qa2, teszter). Populated in loadKanban().
let kanbanAgents = []
// Agents whose chip is active but which have no @<name> label to filter by are
// filtered by assignee instead (lower-cased agent name matched against
// card.assignee). Parallel OR-dimension to kanbanLabelFilter; the two combine as
// a single logical quick-filter (a card matches if it carries an active label OR
// its assignee is an active agent). Persisted alongside the label filter.
let kanbanAgentFilter = new Set()
let kanbanProjectFilter = ''
// Assignee filter for the kanban board. '' = show all. Set via the
// assignee dropdown / "Csak Gábor" toggle injected by setupAssigneeFilter().
// Matched case-insensitively against card.assignee so a casing mismatch
// (e.g. card "gorcsevivan" vs list "GorcsevIvan") still filters correctly.
let kanbanAssigneeFilter = ''
// Swimlane grouping: 'none' (flat board, default) | 'assignee' | 'priority'.
// The initial value is pulled from window._marveen.kanbanSwimlanes.defaultGroup
// the first time loadKanban() runs (see kanbanGroupByInitialized below), then
// fully user-controlled via the toolbar dropdown.
let kanbanGroupBy = 'none'
let kanbanGroupByInitialized = false
// Which swimlane keys (assignee name or priority value) are collapsed. Lives
// for the page session only -- intentionally not persisted across reloads.
const kanbanCollapsedLanes = new Set()
// Set of status column keys that are hidden from the board view.
// Empty = all columns visible. Persisted in localStorage.
let kanbanHiddenColumns = new Set()

const cardModalOverlay = document.getElementById('cardModalOverlay')
const cardDetailOverlay = document.getElementById('cardDetailOverlay')
const breakdownOverlay = document.getElementById('breakdownOverlay')
let breakdownCardId = null
let breakdownSubtasks = []
// Breakdown modal is shared between kanban-card breakdown and idea promote.
let breakdownMode = 'kanban' // 'kanban' | 'idea'
let breakdownIdeaId = null
const columns = document.querySelectorAll('.kanban-col-body')

// Modal wiring
document.getElementById('cardModalClose').addEventListener('click', () => closeModal(cardModalOverlay))
document.getElementById('cardDetailClose').addEventListener('click', () => closeModal(cardDetailOverlay))
cardModalOverlay.addEventListener('click', (e) => { if (e.target === cardModalOverlay) closeModal(cardModalOverlay) })
cardDetailOverlay.addEventListener('click', (e) => { if (e.target === cardDetailOverlay) closeModal(cardDetailOverlay) })

// Add card buttons per column
document.querySelectorAll('.kanban-add-btn').forEach((btn) => {
  btn.addEventListener('click', () => openNewCardModal(btn.dataset.status))
})

async function loadKanban() {
  try {
    // Always refresh the marveen config so values changed on the Settings page
    // (e.g. WIP limits) show up on the board on the next Kanban open, without a
    // hard reload. The full /api/marveen payload includes kanbanAging, kanbanWip,
    // kanbanSwimlanes and kanbanLabels, so the labels (from the labels feature)
    // stay populated too. Also covers opening the Kanban page first, before the
    // Agents page populated window._marveen.
    try {
      const mr = await fetch('/api/marveen')
      if (mr.ok) window._marveen = { ...(window._marveen || {}), ...(await mr.json()) }
    } catch { /* ignore -- aging/WIP/swimlanes/labels just won't render until _marveen loads */ }
    if (!kanbanGroupByInitialized) {
      kanbanGroupByInitialized = true
      // A user's own past choice (saved to localStorage) wins over the
      // server-configured default, so switching the grouping sticks across
      // page reloads instead of resetting every time.
      const stored = localStorage.getItem('marveen.kanbanGroupBy')
      const defaultGroup = window._marveen?.kanbanSwimlanes?.defaultGroup
      const initialGroup = (stored === 'assignee' || stored === 'priority' || stored === 'none')
        ? stored
        : (defaultGroup === 'assignee' || defaultGroup === 'priority' ? defaultGroup : 'none')
      if (initialGroup !== 'none') {
        kanbanGroupBy = initialGroup
        const sel = document.getElementById('kanbanGroupBy')
        if (sel) sel.value = initialGroup
      }
      // Active label-filter selection, restored the same way as the groupBy
      // choice -- a fresh page load should not lose the filters set up.
      try {
        const storedLabels = JSON.parse(localStorage.getItem('marveen.kanbanLabelFilter') || '[]')
        if (Array.isArray(storedLabels)) kanbanLabelFilter = new Set(storedLabels)
      } catch { /* ignore malformed storage */ }
      try {
        const storedAgents = JSON.parse(localStorage.getItem('marveen.kanbanAgentFilter') || '[]')
        if (Array.isArray(storedAgents)) kanbanAgentFilter = new Set(storedAgents)
      } catch { /* ignore malformed storage */ }
      try {
        const storedHiddenCols = JSON.parse(localStorage.getItem('marveen.kanbanHiddenColumns') || '[]')
        if (Array.isArray(storedHiddenCols)) kanbanHiddenColumns = new Set(storedHiddenCols)
      } catch { /* ignore malformed storage */ }
    }
    const [cardsRes, assigneesRes, projectsRes, labelsRes, agentsRes] = await Promise.all([
      fetch('/api/kanban'),
      fetch('/api/kanban/assignees'),
      fetch('/api/kanban-projects'),
      fetch('/api/kanban/labels'),
      fetch('/api/agents'),
    ])
    kanbanCards = await cardsRes.json()
    kanbanAssignees = await assigneesRes.json()
    kanbanProjects = await projectsRes.json()
    kanbanAllLabels = await labelsRes.json()
    // Live fleet agent list drives the quick-filter chip row (one chip per
    // agent, not per label). A failure here just leaves the previous list in
    // place -- the board still renders.
    try {
      if (agentsRes.ok) {
        const list = await agentsRes.json()
        if (Array.isArray(list)) kanbanAgents = list
      }
    } catch { /* keep previous kanbanAgents */ }
    populateProjectFilter()
    populatePriorityProjectFilter()
    populateProjectSuggestions()
    setupAssigneeFilter()
    renderKanban()
  } catch (err) {
    console.error('Kanban betöltés hiba:', err)
  }
}

document.getElementById('kanbanGroupBy').addEventListener('change', (e) => {
  kanbanGroupBy = e.target.value
  localStorage.setItem('marveen.kanbanGroupBy', kanbanGroupBy)
  renderKanban()
})

function populateProjectFilter() {
  const sel = document.getElementById('kanbanProjectFilter')
  const prev = sel.value
  sel.innerHTML = '<option value="">Mind</option>'
  for (const p of kanbanProjects) {
    const opt = document.createElement('option')
    opt.value = p
    opt.textContent = p
    if (p === prev) opt.selected = true
    sel.appendChild(opt)
  }
  if (prev && !kanbanProjects.includes(prev)) kanbanProjectFilter = ''
}

// Project-level dispatch priority dropdown (card e291e9c4, BE sibling 2d6587fe). Single-select in
// the UI: the API supports an ordered array (multiple projects) for a future need, but a dropdown
// is a single choice, which is what "legordulo menu" actually asked for -- the array with zero or
// one entries is the simplest form that fits both.
async function populatePriorityProjectFilter() {
  const sel = document.getElementById('kanbanPriorityProjectSelect')
  if (!sel) return
  sel.innerHTML = `<option value="">${t('kanban.filter.priority_default')}</option>`
  for (const p of kanbanProjects) {
    const opt = document.createElement('option')
    opt.value = p
    opt.textContent = p
    sel.appendChild(opt)
  }
  try {
    const res = await fetch('/api/config/project-priority')
    if (res.ok) {
      const data = await res.json()
      const current = Array.isArray(data.priority) ? data.priority[0] : undefined
      // The saved project may no longer exist (renamed/no cards left) -- fall back to the default
      // option rather than silently selecting nothing the dropdown never offered.
      sel.value = current && kanbanProjects.includes(current) ? current : ''
    }
  } catch { /* leave the default selection -- the board still works without this */ }
  // Baseline for the change handler's revert-on-failure below -- without this, the FIRST edit
  // after page load would revert to '' regardless of what was actually loaded above.
  sel.dataset.lastValue = sel.value
}

document.getElementById('kanbanPriorityProjectSelect').addEventListener('change', async (e) => {
  const sel = e.target
  const value = sel.value
  const prevValue = sel.dataset.lastValue || ''
  try {
    const res = await fetch('/api/config/project-priority', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ priority: value ? [value] : [] }),
    })
    if (!res.ok) throw new Error('save-failed')
    sel.dataset.lastValue = value
    showToast(value ? t('kanban.filter.priority_saved', { project: value }) : t('kanban.filter.priority_cleared'))
  } catch {
    // Revert the visible selection to what is actually saved -- a silently-failed PUT must not
    // leave the dropdown claiming a priority that was never persisted. Never surface the raw
    // server error text here (rule 12): the dropdown only ever offers real project names, so a
    // rejection means the save itself failed, not a user input mistake -- a generic, localized,
    // retry-pointing message is both honest and all that is actionable from here.
    sel.value = prevValue
    showToast(t('kanban.filter.priority_save_failed'))
  }
})

function renderKanbanColumnChips() {
  const container = document.getElementById('kanbanColumnChips')
  if (!container) return
  container.innerHTML = ''
  for (const def of KANBAN_STATUS_DEFS) {
    const hidden = kanbanHiddenColumns.has(def.status)
    const label = typeof def.title === 'function' ? def.title() : def.title
    const chip = document.createElement('span')
    chip.className = 'kanban-col-chip' + (hidden ? ' hidden' : '')
    chip.title = hidden ? t('kanban.filter.column_show') : t('kanban.filter.column_hide')
    chip.textContent = label
    chip.addEventListener('click', () => {
      if (kanbanHiddenColumns.has(def.status)) kanbanHiddenColumns.delete(def.status)
      else kanbanHiddenColumns.add(def.status)
      localStorage.setItem('marveen.kanbanHiddenColumns', JSON.stringify([...kanbanHiddenColumns]))
      renderKanban()
    })
    container.appendChild(chip)
  }
}

function populateProjectSuggestions() {
  const dl = document.getElementById('projectSuggestions')
  if (!dl) return
  dl.innerHTML = ''
  for (const p of kanbanProjects) {
    const opt = document.createElement('option')
    opt.value = p
    dl.appendChild(opt)
  }
}

document.getElementById('kanbanProjectFilter').addEventListener('change', (e) => {
  kanbanProjectFilter = e.target.value
  renderKanban()
})

// The kanban "owner" is the assignee whose type is 'owner' -- the person the
// board is primarily run for, on any deployment. Identified by type, never by
// a hard-coded display name, so the quick "show what's on me" view is generic.
// Returns null when no owner-type assignee exists (then the quick button is
// hidden and only the general per-assignee dropdown is shown).
function ownerAssigneeName() {
  const owner = kanbanAssignees.find((a) => a.type === 'owner')
  return owner ? owner.name : null
}

// Reflect the active state of the owner quick-toggle button (hidden when there
// is no owner-type assignee).
function syncOwnerFilterBtn() {
  const btn = document.getElementById('kanbanOwnerBtn')
  if (!btn) return
  const owner = ownerAssigneeName()
  if (!owner) { btn.style.display = 'none'; return }
  btn.style.display = ''
  const on = !!kanbanAssigneeFilter && kanbanAssigneeFilter.toLowerCase() === owner.toLowerCase()
  btn.style.background = on ? 'var(--accent)' : 'var(--bg)'
  btn.style.color = on ? '#081a2d' : 'var(--fg)'
  btn.setAttribute('aria-pressed', on ? 'true' : 'false')
}

// Inject the assignee filter (per-assignee dropdown + an owner "Rám vár" quick
// toggle) into the kanban toolbar. Built in JS rather than as static markup so
// the toolbar stays self-contained. Idempotent: the controls are created once;
// later calls only refresh the <option>s from the current assignee list.
function setupAssigneeFilter() {
  const projectSel = document.getElementById('kanbanProjectFilter')
  if (!projectSel) return
  const toolbar = projectSel.parentElement
  let sel = document.getElementById('kanbanAssigneeFilter')
  if (!sel) {
    const label = document.createElement('label')
    label.setAttribute('for', 'kanbanAssigneeFilter')
    label.textContent = t('kanban.filter.assignee_label')
    label.style.cssText = 'font-size:13px;color:var(--muted);white-space:nowrap;margin-left:8px;'

    sel = document.createElement('select')
    sel.id = 'kanbanAssigneeFilter'
    sel.style.cssText = 'font-size:13px;padding:4px 8px;border-radius:6px;border:1px solid var(--border);background:var(--bg);color:var(--fg);min-width:140px;'
    sel.addEventListener('change', (e) => {
      kanbanAssigneeFilter = e.target.value
      syncOwnerFilterBtn()
      renderKanban()
    })

    const ownerBtn = document.createElement('button')
    ownerBtn.id = 'kanbanOwnerBtn'
    ownerBtn.type = 'button'
    ownerBtn.textContent = t('kanban.filter.owner_btn')
    ownerBtn.title = t('kanban.owner_filter')
    ownerBtn.style.cssText = 'font-size:13px;padding:4px 10px;border-radius:6px;border:1px solid var(--border);background:var(--bg);color:var(--fg);cursor:pointer;'
    ownerBtn.addEventListener('click', () => {
      const owner = ownerAssigneeName()
      if (!owner) return
      const on = kanbanAssigneeFilter.toLowerCase() === owner.toLowerCase()
      kanbanAssigneeFilter = on ? '' : owner
      // Keep the dropdown in sync (only selectable if the owner is a known assignee).
      sel.value = kanbanAssignees.some((a) => a.name === kanbanAssigneeFilter) ? kanbanAssigneeFilter : ''
      syncOwnerFilterBtn()
      renderKanban()
    })

    toolbar.appendChild(label)
    toolbar.appendChild(sel)
    toolbar.appendChild(ownerBtn)
  }

  // (Re)populate options from the current assignee list, preserving selection.
  const prev = kanbanAssigneeFilter
  sel.innerHTML = '<option value="">Mind</option>'
  for (const a of kanbanAssignees) {
    const opt = document.createElement('option')
    opt.value = a.name
    // Show the persona displayName (id as fallback), matching #216; the
    // option value / filter key stays the agent id.
    opt.textContent = a.displayName || a.name
    if (a.name === prev) opt.selected = true
    sel.appendChild(opt)
  }
  // syncOwnerFilterBtn shows/hides the owner quick-button based on whether an
  // owner-type assignee exists in the freshly loaded list.
  syncOwnerFilterBtn()
}

// Project + assignee + label filters, independent of the priority quick-filter
// Project + assignee filters only -- the baseline the label quick-filter
// chip counts are computed against, independent of which labels are
// currently active, so a chip's count stays meaningful whether it's the one
// being toggled or not.
function kanbanCardMatchesBaseFilters(card) {
  if (kanbanProjectFilter && (card.project || '') !== kanbanProjectFilter) return false
  const assigneeFilter = kanbanAssigneeFilter.toLowerCase()
  if (assigneeFilter && String(card.assignee || '').trim().toLowerCase() !== assigneeFilter) return false
  return true
}

// The quick-filter dimension: a card matches when no quick-filter is active, or
// when it carries at least one active label OR its assignee is an active
// (label-less) agent. Label and agent selections OR together into one logical
// quick-filter so mixing a labelled agent (@backend) with a label-less one
// (qa2) shows the union.
function kanbanCardMatchesLabelFilter(card) {
  if (kanbanLabelFilter.size === 0 && kanbanAgentFilter.size === 0) return true
  const cardLabelIds = (card.labels || []).map((l) => l.id)
  if (cardLabelIds.some((id) => kanbanLabelFilter.has(id))) return true
  const asg = String(card.assignee || '').trim().toLowerCase()
  if (asg && kanbanAgentFilter.has(asg)) return true
  return false
}

// Shared by both the header quick-filter chips and the per-card footer label
// pills -- one filter dimension, two entry points into the same toggle.
function toggleKanbanLabelFilter(labelId) {
  if (kanbanLabelFilter.has(labelId)) kanbanLabelFilter.delete(labelId)
  else kanbanLabelFilter.add(labelId)
  persistKanbanFilters()
  renderKanban()
}

// Toggle a label-less agent's chip: filters by assignee (lower-cased agent
// name). Mirrors toggleKanbanLabelFilter but for the assignee OR-dimension.
function toggleKanbanAgentFilter(agentName) {
  const key = String(agentName || '').trim().toLowerCase()
  if (!key) return
  if (kanbanAgentFilter.has(key)) kanbanAgentFilter.delete(key)
  else kanbanAgentFilter.add(key)
  persistKanbanFilters()
  renderKanban()
}

function clearKanbanQuickFilters() {
  kanbanLabelFilter.clear()
  kanbanAgentFilter.clear()
  persistKanbanFilters()
  renderKanban()
}

function persistKanbanFilters() {
  localStorage.setItem('marveen.kanbanLabelFilter', JSON.stringify([...kanbanLabelFilter]))
  localStorage.setItem('marveen.kanbanAgentFilter', JSON.stringify([...kanbanAgentFilter]))
}

// Deterministic fallback colour for an agent that has no @<name> label (and so
// no assigned colour). Hashes the name into the configured label palette so the
// same agent always gets the same chip colour, and two label-less agents rarely
// collide. Falls back to a neutral slate if the palette is unavailable.
function agentChipFallbackColor(name) {
  const palette = window._marveen?.kanbanLabels?.colors
  if (!Array.isArray(palette) || palette.length === 0) return '#64748b'
  let hash = 0
  for (const ch of String(name)) hash = (hash + ch.charCodeAt(0)) % palette.length
  return palette[hash]
}

// Build the ordered chip descriptor list from the LIVE fleet agent list. The
// main agent (mikrob) is prepended -- /api/agents lists only sub-agents, but it
// carries its own @<name> label and belongs on the board like any other agent.
// Each descriptor resolves the agent's @<name> label (case-insensitive) to pick
// up its colour + id; a label-less agent keeps labelId=null and filters by
// assignee instead.
function buildKanbanAgentChips() {
  const chips = []
  const seen = new Set()
  const labelByName = new Map(
    (kanbanAllLabels || []).map((l) => [String(l.name || '').toLowerCase(), l])
  )
  const push = (name, displayName) => {
    const key = String(name || '').trim().toLowerCase()
    if (!key || seen.has(key)) return
    seen.add(key)
    const label = labelByName.get('@' + key) || null
    chips.push({
      name: key,
      displayName: displayName || name,
      label,
      color: label ? label.color : agentChipFallbackColor(key),
    })
  }
  // Main agent first.
  const mv = window._marveen
  if (mv && mv.agentId) push(mv.agentId, mv.name || mv.agentId)
  for (const a of kanbanAgents) push(a.name, a.displayName || a.name)
  return chips
}

// Quick-filter chip row: one chip per LIVE fleet agent (not per label), tinted
// with the agent's assigned colour (its @<name> label colour, or a stable
// palette fallback when it has no label). Clicking a labelled agent toggles the
// shared kanbanLabelFilter set the footer pills use; a label-less agent toggles
// the assignee-based kanbanAgentFilter -- both feed the same board filter.
function renderKanbanQuickFilters() {
  const row = document.getElementById('kanbanQuickFilters')
  if (!row) return
  row.innerHTML = ''
  for (const chip of buildKanbanAgentChips()) {
    const active = chip.label
      ? kanbanLabelFilter.has(chip.label.id)
      : kanbanAgentFilter.has(chip.name)
    const count = kanbanCards.filter((c) => {
      if (!kanbanCardMatchesBaseFilters(c)) return false
      if (chip.label) return (c.labels || []).some((l) => l.id === chip.label.id)
      return String(c.assignee || '').trim().toLowerCase() === chip.name
    }).length
    const el = document.createElement('span')
    el.className = 'kanban-quick-filter-chip' + (active ? ' active' : '')
    if (chip.label) el.dataset.labelId = chip.label.id
    el.dataset.agent = chip.name
    el.style.setProperty('--chip-color', chip.color)
    el.innerHTML = `@${escapeHtml(chip.displayName)} <span class="kanban-quick-filter-count">${count}</span>${active ? '<span class="kanban-quick-filter-clear">&times;</span>' : ''}`
    el.addEventListener('click', () =>
      chip.label ? toggleKanbanLabelFilter(chip.label.id) : toggleKanbanAgentFilter(chip.name)
    )
    row.appendChild(el)
  }
  if (kanbanLabelFilter.size > 0 || kanbanAgentFilter.size > 0) {
    const clearAll = document.createElement('button')
    clearAll.className = 'kanban-quick-filter-clear-all'
    clearAll.textContent = t('kanban.filter.clear')
    clearAll.addEventListener('click', clearKanbanQuickFilters)
    row.appendChild(clearAll)
  }
}

function renderKanban() {
  const cardById = new Map(kanbanCards.map(c => [c.id, c]))

  renderKanbanColumnChips()
  renderKanbanQuickFilters()

  // Determine which top-level cards are visible under current filters.
  const visibleCardIds = new Set()
  for (const card of kanbanCards) {
    if (!kanbanCardMatchesBaseFilters(card)) continue
    if (!kanbanCardMatchesLabelFilter(card)) continue
    visibleCardIds.add(card.id)
  }

  // A subtask is "embedded" when its parent is visible AND both share the same
  // column. Embedded subtasks are hidden as standalone cards and rendered
  // inside the parent card instead. Filter state of the subtask itself is
  // intentionally ignored so it always shows under its visible parent.
  const embeddedSubtaskIds = new Set()
  for (const card of kanbanCards) {
    if (!card.parent_id) continue
    const parent = cardById.get(card.parent_id)
    if (!parent || !visibleCardIds.has(parent.id)) continue
    if (parent.status === card.status) embeddedSubtaskIds.add(card.id)
  }

  const grouped = { planned: [], in_progress: [], waiting: [], testing: [], done: [] }
  for (const card of kanbanCards) {
    if (embeddedSubtaskIds.has(card.id)) continue
    if (!visibleCardIds.has(card.id)) continue
    if (grouped[card.status]) grouped[card.status].push(card)
  }

  // Update counts (embedded subtasks don't count as separate cards)
  document.getElementById('countPlanned').textContent = grouped.planned.length
  document.getElementById('countInProgress').textContent = grouped.in_progress.length
  document.getElementById('countTesting').textContent = grouped.testing.length
  document.getElementById('countWaiting').textContent = grouped.waiting.length
  document.getElementById('countDone').textContent = grouped.done.length

  const flatBoard = document.getElementById('kanbanBoard')
  const swimlaneBoard = document.getElementById('kanbanSwimlaneBoard')

  if (kanbanGroupBy === 'none') {
    swimlaneBoard.hidden = true
    flatBoard.hidden = false
    for (const [status, cards] of Object.entries(grouped)) {
      const col = document.querySelector(`#kanbanBoard .kanban-col-body[data-status="${status}"]`)
      col.innerHTML = ''
      cards.sort((a, b) => a.sort_order - b.sort_order)

      for (const card of cards) {
        const embeddedChildren = kanbanCards
          .filter(c => c.parent_id === card.id && embeddedSubtaskIds.has(c.id))
          .sort((a, b) => a.sort_order - b.sort_order)
        col.appendChild(createCardEl(card, embeddedChildren))
      }
    }
    // Hide/show flat-board columns based on visibility set
    const allColsHidden = KANBAN_STATUS_DEFS.every(d => kanbanHiddenColumns.has(d.status))
    for (const def of KANBAN_STATUS_DEFS) {
      const colEl = flatBoard.querySelector(`.kanban-col[data-status="${def.status}"]`)
      if (colEl) colEl.hidden = kanbanHiddenColumns.has(def.status)
    }
    // "All columns hidden" hint
    let allHiddenMsg = document.getElementById('kanbanAllHiddenMsg')
    if (allColsHidden) {
      if (!allHiddenMsg) {
        allHiddenMsg = document.createElement('p')
        allHiddenMsg.id = 'kanbanAllHiddenMsg'
        allHiddenMsg.style.cssText = 'color:var(--muted);font-size:13px;padding:24px 0;text-align:center;width:100%;'
        flatBoard.appendChild(allHiddenMsg)
      }
      allHiddenMsg.textContent = t('kanban.filter.all_cols_hidden')
    } else {
      allHiddenMsg?.remove()
    }
    // Badge: only count subtasks that are in a different column (not embedded here)
    updateSubtaskBadges(embeddedSubtaskIds)
    // WIP limit badges (count/limit + colour) on the flat board too -- previously
    // only the swimlane view updated these, so a configured limit never showed
    // on the default flat board.
    updateWipBadges(grouped)
  } else {
    flatBoard.hidden = true
    swimlaneBoard.hidden = false
    renderSwimlaneBoard(grouped, embeddedSubtaskIds)
  }
}

const KANBAN_STATUS_DEFS = [
  { status: 'planned', title: () => t('kanban.col.planned') },
  { status: 'in_progress', title: () => t('kanban.col.in_progress') },
  { status: 'waiting', title: () => t('kanban.col.waiting') },
  { status: 'testing', title: () => t('kanban.col.testing') },
  { status: 'done', title: () => t('kanban.col.done') },
]
const KANBAN_PRIORITY_LABELS = { urgent: () => t('kanban.priority.urgent'), high: () => t('kanban.priority.high'), normal: () => t('kanban.priority.normal'), low: () => t('kanban.priority.low') }
const KANBAN_PRIORITY_ORDER = ['urgent', 'high', 'normal', 'low']

// Which swimlane a card belongs to under the current grouping. Returns a
// stable string key: the matched assignee's canonical name, '__unassigned__'
// for cards with no/unmatched assignee, or the priority value.
function kanbanSwimlaneKeyFor(card) {
  if (kanbanGroupBy === 'priority') return card.priority || 'normal'
  const raw = card.assignee ? String(card.assignee).trim() : ''
  if (!raw) return '__unassigned__'
  const match = kanbanAssignees.find(a => a.name.toLowerCase() === raw.toLowerCase())
  return match ? match.name : raw
}

// Display metadata (label + avatar styling) for a swimlane key.
function kanbanSwimlaneMeta(key) {
  if (kanbanGroupBy === 'priority') {
    const _rawPL = KANBAN_PRIORITY_LABELS[key]; const label = _rawPL ? (typeof _rawPL === 'function' ? _rawPL() : _rawPL) : key
    return { label, avatarClass: `priority-${key}`, avatarChar: '' }
  }
  if (key === '__unassigned__') return { label: t('kanban.unassigned'), avatarClass: 'unknown', avatarChar: '?' }
  const match = kanbanAssignees.find(a => a.name === key)
  const label = match ? (match.displayName || match.name) : key
  return { label, avatarClass: match ? match.type : 'unknown', avatarChar: (label[0] || '?').toUpperCase() }
}

function renderSwimlaneBoard(grouped, embeddedSubtaskIds) {
  const board = document.getElementById('kanbanSwimlaneBoard')
  board.innerHTML = ''

  const presentKeys = new Set()
  for (const cards of Object.values(grouped)) {
    for (const c of cards) presentKeys.add(kanbanSwimlaneKeyFor(c))
  }

  const canonicalOrder = kanbanGroupBy === 'priority'
    ? KANBAN_PRIORITY_ORDER
    : [...kanbanAssignees.map(a => a.name), '__unassigned__']
  const orderedKeys = canonicalOrder.filter(k => presentKeys.has(k))
  const leftoverKeys = [...presentKeys].filter(k => !orderedKeys.includes(k)).sort((a, b) => a.localeCompare(b))
  const keys = [...orderedKeys, ...leftoverKeys]

  const separatorColor = window._marveen?.kanbanSwimlanes?.separatorColor

  for (const key of keys) {
    const meta = kanbanSwimlaneMeta(key)
    const collapsed = kanbanCollapsedLanes.has(key)

    const laneCardsByStatus = {}
    let totalCount = 0
    for (const def of KANBAN_STATUS_DEFS) {
      const cards = grouped[def.status].filter(c => kanbanSwimlaneKeyFor(c) === key)
      laneCardsByStatus[def.status] = cards
      if (!kanbanHiddenColumns.has(def.status)) totalCount += cards.length
    }

    const lane = document.createElement('div')
    lane.className = 'kanban-swimlane' + (collapsed ? ' collapsed' : '')
    lane.dataset.group = key
    if (separatorColor) lane.style.borderBottomColor = separatorColor

    const header = document.createElement('div')
    header.className = 'kanban-swimlane-header'
    header.innerHTML = `
      <span class="kanban-swimlane-avatar ${meta.avatarClass}">${escapeHtml(meta.avatarChar)}</span>
      <span class="kanban-swimlane-name">${escapeHtml(meta.label)}</span>
      <span class="kanban-swimlane-count">${totalCount}</span>
      <button class="kanban-swimlane-toggle" type="button" aria-expanded="${!collapsed}" title="${collapsed ? t('kanban.swimlane.expand') : t('kanban.swimlane.collapse')}">${collapsed ? '▶' : '▼'}</button>
    `
    header.querySelector('.kanban-swimlane-toggle').addEventListener('click', (e) => {
      e.stopPropagation()
      if (kanbanCollapsedLanes.has(key)) kanbanCollapsedLanes.delete(key)
      else kanbanCollapsedLanes.add(key)
      renderKanban()
    })
    lane.appendChild(header)

    const body = document.createElement('div')
    body.className = 'kanban-swimlane-body'
    for (const def of KANBAN_STATUS_DEFS) {
      if (kanbanHiddenColumns.has(def.status)) continue
      const col = document.createElement('div')
      col.className = 'kanban-swimlane-col'

      const colHeader = document.createElement('div')
      colHeader.className = 'kanban-swimlane-col-header'
      colHeader.textContent = typeof def.title === 'function' ? def.title() : def.title

      const colBody = document.createElement('div')
      colBody.className = 'kanban-col-body kanban-swimlane-col-body'
      colBody.dataset.status = def.status

      const cards = laneCardsByStatus[def.status].sort((a, b) => a.sort_order - b.sort_order)
      for (const card of cards) {
        const embeddedChildren = kanbanCards
          .filter(c => c.parent_id === card.id && embeddedSubtaskIds.has(c.id))
          .sort((a, b) => a.sort_order - b.sort_order)
        colBody.appendChild(createCardEl(card, embeddedChildren))
      }
      wireKanbanColumnDnD(colBody)

      col.appendChild(colHeader)
      col.appendChild(colBody)
      body.appendChild(col)
    }
    lane.appendChild(body)
    board.appendChild(lane)
  }

  updateSubtaskBadges(embeddedSubtaskIds)

  // WIP limit badges: update column-header count spans with "count/limit" when configured
  updateWipBadges(grouped)
}

// Map column status keys to their count-span IDs
const WIP_COUNT_IDS = {
  planned: 'countPlanned',
  in_progress: 'countInProgress',
  testing: 'countTesting',
  waiting: 'countWaiting',
  done: 'countDone',
}

function updateWipBadges(grouped) {
  const cfg = window._marveen?.kanbanWip
  for (const [status, cards] of Object.entries(grouped)) {
    const el = document.getElementById(WIP_COUNT_IDS[status])
    if (!el) continue
    const limit = cfg?.limits?.[status] || 0
    if (!limit) {
      // No limit configured: restore plain count and clear WIP styling
      el.textContent = cards.length
      delete el.dataset.wip
      el.style.color = ''
      el.style.borderColor = ''
      continue
    }
    const count = cards.length
    el.textContent = `${count}/${limit}`
    let state, color
    if (count > limit) {
      state = 'over'; color = cfg.overColor
    } else if (count === limit) {
      state = 'full'; color = cfg.fullColor
    } else if ((count / limit) * 100 >= cfg.warnPct) {
      state = 'warn'; color = cfg.warnColor
    } else {
      state = 'ok'; color = cfg.okColor
    }
    el.dataset.wip = state
    el.style.color = color
    el.style.borderColor = color
  }
}

function updateSubtaskBadges(embeddedSubtaskIds) {
  for (const el of document.querySelectorAll('.kanban-card[data-id]')) {
    const id = el.dataset.id
    const badge = el.querySelector('.kanban-subtask-badge')
    if (!badge) continue
    const nonEmbedded = kanbanCards.filter(c => c.parent_id === id && !embeddedSubtaskIds.has(c.id))
    if (nonEmbedded.length > 0) {
      badge.textContent = `${nonEmbedded.length} subtask`
      badge.style.display = ''
      badge.onclick = (e) => {
        e.stopPropagation()
        const card = kanbanCards.find(c => c.id === id)
        if (card) showCardDetail(card)
      }
    } else {
      badge.style.display = 'none'
    }
  }
}

function createCardEl(card, embeddedChildren = []) {
  const el = document.createElement('div')
  el.className = 'kanban-card'
  el.dataset.id = card.id
  el.dataset.priority = card.priority
  el.draggable = true

  // Assignee chip. Match the card's assignee against the known list
  // case-insensitively (a card stored as "gorcsevivan" must still match the
  // list entry "GorcsevIvan"). When the assignee is set but not in the list
  // at all, still render a fallback chip with the raw name + a neutral dot,
  // so a card never silently loses its assignee chip on a name mismatch.
  const rawAssignee = card.assignee ? String(card.assignee).trim() : ''
  const assignee = rawAssignee
    ? kanbanAssignees.find((a) => a.name.toLowerCase() === rawAssignee.toLowerCase())
    : null
  // Display the persona displayName (falling back to the id) per #216, while
  // keeping the robust match above and the raw-name fallback chip below.
  const assigneeLabel = assignee ? (assignee.displayName || assignee.name) : ''
  // Per-agent dot colour: agents all share the type-based green otherwise, which
  // makes them indistinguishable on the board. Derive a stable colour from the
  // agent name (owner/bot keep their semantic colour). Requested by Peti.
  const assigneeColor = (name) => {
    let h = 0
    for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) >>> 0
    return `hsl(${h % 360} 60% 45%)`
  }
  const agentDotStyle =
    assignee && assignee.type === 'agent' ? ` style="background:${assigneeColor(assignee.name)}"` : ''
  const assigneeHtml = assignee
    ? `<span class="kanban-card-assignee"><span class="assignee-dot ${assignee.type}"${agentDotStyle}>${escapeHtml(assigneeLabel[0])}</span>${escapeHtml(assigneeLabel)}</span>`
    : rawAssignee
      ? `<span class="kanban-card-assignee"><span class="assignee-dot unknown">${escapeHtml(rawAssignee[0])}</span>${escapeHtml(rawAssignee)}</span>`
      : ''

  let dueHtml = ''
  if (card.due_date) {
    const d = new Date(card.due_date * 1000)
    const now = new Date()
    const overdue = d < now && card.status !== 'done'
    const label = d.toLocaleDateString('hu-HU', { month: 'short', day: 'numeric' })
    dueHtml = `<span class="kanban-card-due ${overdue ? 'overdue' : ''}">${label}</span>`
  }

  const projectHtml = card.project
    ? `<span class="kanban-card-project">${escapeHtml(card.project)}</span>`
    : ''

  // Label footer pills: at most 3 shown + a "+N" overflow indicator. Each pill
  // (except the overflow one) toggles that label into the active label-filter
  // when clicked, mirroring the priority quick-filter chips above the board.
  let labelsHtml = ''
  if (Array.isArray(card.labels) && card.labels.length > 0) {
    const shown = card.labels.slice(0, 3)
    const overflow = card.labels.length - shown.length
    const pills = shown.map((l) =>
      `<span class="kanban-card-label-pill" data-label-id="${escapeHtml(l.id)}" style="--label-color:${escapeHtml(l.color)}" title="${t('kanban.label.filter_tooltip', { name: escapeHtml(l.name) })}">#${escapeHtml(l.name)}</span>`
    ).join('')
    const overflowHtml = overflow > 0
      ? `<span class="kanban-card-label-pill kanban-card-label-overflow" title="${t('kanban.label.overflow_tooltip', { n: overflow })}">+${overflow}</span>`
      : ''
    labelsHtml = `<div class="kanban-card-labels">${pills}${overflowHtml}</div>`
  }

  const seqHtml = card.seq != null
    ? `<span class="kanban-card-seq" style="font-family:monospace;font-size:11px;color:var(--muted);margin-right:5px">#${card.seq}</span>`
    : ''

  // WCAG AA priority badge (card e291e9c4): the border-left alone was the only signal and does
  // not read as text at all -- see the .priority-badge CSS comment for the measured contrast.
  const priorityLabel = KANBAN_PRIORITY_LABELS[card.priority]?.() ?? card.priority
  const priorityBadgeHtml = card.priority
    ? `<span class="priority-badge priority-${escapeHtml(card.priority)}">${escapeHtml(priorityLabel)}</span>`
    : ''

  // Card aging: left stripe + top-right badge based on hours since last update.
  // Skipped for done cards. Config thresholds and colours come from window._marveen.kanbanAging.
  let agingBadgeHtml = ''
  const agingCfg = window._marveen?.kanbanAging
  if (agingCfg && card.updated_at && card.status !== 'done') {
    const hoursOld = (Date.now() / 1000 - card.updated_at) / 3600
    let agingLevel = null
    let agingColor = null
    if (hoursOld >= agingCfg.criticalH) {
      agingLevel = 'critical'; agingColor = agingCfg.criticalColor
    } else if (hoursOld >= agingCfg.cautionH) {
      agingLevel = 'caution'; agingColor = agingCfg.cautionColor
    } else if (hoursOld >= agingCfg.warnH) {
      agingLevel = 'warn'; agingColor = agingCfg.warnColor
    }
    if (agingLevel) {
      const days = Math.floor(hoursOld / 24)
      const ageLabel = days >= 1 ? `${days}d` : `${Math.floor(hoursOld)}h`
      const exact = new Date(card.updated_at * 1000).toLocaleString('hu-HU')
      agingBadgeHtml = `<span class="kanban-card-aging-badge kanban-card-aging-${agingLevel}" style="color:${agingColor}" title="${t('kanban.aging.tooltip', { exact })}">⏳ ${ageLabel}</span>`
      el.dataset.aging = agingLevel
      el.style.setProperty('--card-aging-color', agingColor)
    }
  }

  // Embedded subtasks: rendered as mini-cards below a divider when the subtask
  // shares the same column as this parent card.
  let embeddedHtml = ''
  if (embeddedChildren.length > 0) {
    const items = embeddedChildren.map(c => {
      const rawCa = c.assignee ? String(c.assignee).trim() : ''
      const ca = rawCa ? kanbanAssignees.find(a => a.name.toLowerCase() === rawCa.toLowerCase()) : null
      const caLabel = ca ? (ca.displayName || ca.name) : rawCa
      const caHtml = caLabel ? `<span class="kanban-embedded-assignee">${escapeHtml(caLabel)}</span>` : ''
      const cSeq = c.seq != null ? `<span class="kanban-embedded-seq">#${c.seq}</span> ` : ''
      return `<div class="kanban-embedded-subtask" data-id="${escapeHtml(c.id)}">${cSeq}${escapeHtml(c.title)}${caHtml}</div>`
    }).join('')
    embeddedHtml = `<div class="kanban-embedded-subtasks">${items}</div>`
  }

  el.innerHTML = `
    ${projectHtml}
    <div class="kanban-card-title">${seqHtml}${escapeHtml(card.title)}</div>
    <div class="kanban-card-footer">${priorityBadgeHtml}${assigneeHtml}${dueHtml}</div>
    ${labelsHtml}
    <div class="kanban-card-actions">
      <button class="card-breakdown-btn" title="${t('kanban.btn.breakdown')}" aria-label="${t('kanban.btn.breakdown')}">⚡</button>
    </div>
    ${agingBadgeHtml}
    <div class="kanban-subtask-badge" style="display:none"></div>
    ${embeddedHtml}
  `

  // "AI szétbont" gomb – ne nyissa meg a detail modalt
  el.querySelector('.card-breakdown-btn').addEventListener('click', (e) => {
    e.stopPropagation()
    triggerBreakdown(card)
  })

  // Label pills -> toggle that label into the active filter (don't open detail)
  el.querySelectorAll('.kanban-card-label-pill[data-label-id]').forEach((pillEl) => {
    pillEl.addEventListener('click', (e) => {
      e.stopPropagation()
      toggleKanbanLabelFilter(pillEl.dataset.labelId)
    })
  })

  // Click on embedded subtask -> open that subtask's detail (don't bubble to parent)
  el.querySelectorAll('.kanban-embedded-subtask').forEach(subEl => {
    subEl.addEventListener('click', (e) => {
      e.stopPropagation()
      const child = kanbanCards.find(c => c.id === subEl.dataset.id)
      if (child) showCardDetail(child)
    })
  })

  // Drag events
  el.addEventListener('dragstart', (e) => {
    el.classList.add('dragging')
    e.dataTransfer.setData('text/plain', card.id)
    e.dataTransfer.effectAllowed = 'move'
  })
  el.addEventListener('dragend', () => el.classList.remove('dragging'))

  // Touch equivalent of the above -- see wireKanbanCardTouchDnD. Wired before
  // the click listener so its capture-phase guard can swallow the tap that
  // ends a drag.
  wireKanbanCardTouchDnD(el, card)

  // Click -> detail
  el.addEventListener('click', () => showCardDetail(card))

  return el
}

// === Drag & Drop ===
// Wires the drag/drop handlers for one column-body element. Used for the
// 4 static flat-board columns at load time, and again for every swimlane
// column-body created dynamically in renderSwimlaneBoard (those elements
// don't exist yet when this module first runs).
function wireKanbanColumnDnD(col) {
  col.addEventListener('dragover', (e) => {
    e.preventDefault()
    e.dataTransfer.dropEffect = 'move'
    col.classList.add('drag-over')

    // Insert indicator position
    const afterEl = getDragAfterElement(col, e.clientY)
    const dragging = document.querySelector('.kanban-card.dragging')
    if (!dragging) return
    if (afterEl) {
      col.insertBefore(dragging, afterEl)
    } else {
      col.appendChild(dragging)
    }
  })

  col.addEventListener('dragleave', (e) => {
    if (!col.contains(e.relatedTarget)) col.classList.remove('drag-over')
  })

  col.addEventListener('drop', async (e) => {
    e.preventDefault()
    col.classList.remove('drag-over')
    const cardId = e.dataTransfer.getData('text/plain')
    const newStatus = col.dataset.status

    // Calculate sort_order based on position
    const cards = [...col.querySelectorAll('.kanban-card')]
    const idx = cards.findIndex((c) => c.dataset.id === cardId)
    let sortOrder = idx

    try {
      await fetch(`/api/kanban/${encodeURIComponent(cardId)}/move`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status: newStatus, sort_order: sortOrder, actor: kanbanMoveActor() }),
      })
      loadKanban()
    } catch {
      showToast(t('kanban.toast.move_error'))
    }
  })
}
columns.forEach(wireKanbanColumnDnD)

// === Touch drag & drop (mobile) ===
// HTML5 drag & drop above never fires on a touch screen -- no dragstart, no
// drop -- so on a phone the board could only be read, never rearranged. This
// is a parallel touch path over the same /move call.
//
// Why touch events and not Pointer Events + touch-action: a card fills most of
// the column, so making it permanently untouchable for scrolling (touch-action:
// none) would break scrolling the board. Instead the gesture stays ambiguous
// until it resolves: a long press (250ms) means "drag", any earlier movement
// means "scroll" and hands the gesture straight back to the browser. Only once
// dragging is committed does touchmove call preventDefault() to hold the page
// still -- which is why that listener MUST be non-passive.
const TOUCH_DRAG_DELAY_MS = 250
const TOUCH_DRAG_SLOP_PX = 10
let touchDrag = null

function kanbanColBodyAt(x, y) {
  const el = document.elementFromPoint(x, y)
  return el ? el.closest('.kanban-col-body') : null
}

// On a phone the columns stack vertically, so the next column starts ~2000px
// below the fold -- dragging a card "one column over" would mean dragging it
// at an invisible target while the page auto-scrolls for several seconds.
// Instead, committing to a drag raises a fixed bar of status targets over the
// bottom of the screen: the same gesture, with somewhere to drop. Column
// hit-testing stays active for viewports where the target column IS visible.
const KANBAN_TOUCH_STATUSES = ['planned', 'in_progress', 'waiting', 'testing', 'done']

function buildTouchDropBar(currentStatus) {
  const bar = document.createElement('div')
  bar.className = 'kanban-touch-dropbar'
  for (const s of KANBAN_TOUCH_STATUSES) {
    const chip = document.createElement('div')
    chip.className = 'kanban-drop-target'
    chip.dataset.status = s
    if (s === currentStatus) chip.classList.add('is-current')
    chip.textContent = t(`kanban.status.${s}`)
    bar.appendChild(chip)
  }
  document.body.appendChild(bar)
  return bar
}

function kanbanDropTargetAt(x, y) {
  const el = document.elementFromPoint(x, y)
  return el ? el.closest('.kanban-drop-target') : null
}

function clearTouchDragHighlight() {
  document.querySelectorAll('.kanban-col-body.drag-over, .kanban-drop-target.drag-over')
    .forEach((c) => c.classList.remove('drag-over'))
}

function endTouchDrag() {
  if (!touchDrag) return
  clearTimeout(touchDrag.timer)
  touchDrag.ghost?.remove()
  touchDrag.dropBar?.remove()
  touchDrag.el.classList.remove('dragging')
  clearTouchDragHighlight()
  document.removeEventListener('touchmove', kanbanTouchMove)
  document.removeEventListener('touchend', kanbanTouchEnd)
  document.removeEventListener('touchcancel', endTouchDrag)
  touchDrag = null
}

// The ghost is deliberately NOT a full-size copy of the card: at full width it
// covered three of the five drop targets, so the user could not see what they
// were aiming at. It rides ABOVE the fingertip (see positionTouchGhost) for the
// same reason -- the target under the finger has to stay visible.
const TOUCH_GHOST_MAX_W = 200
const TOUCH_GHOST_LIFT = 28

function positionTouchGhost(x, y) {
  const g = touchDrag.ghost
  const gx = x - g.offsetWidth / 2
  const gy = y - g.offsetHeight - TOUCH_GHOST_LIFT
  g.style.transform = `translate(${Math.max(4, gx)}px, ${Math.max(4, gy)}px) rotate(2deg)`
}

function beginTouchDrag(x, y) {
  if (!touchDrag) return
  const el = touchDrag.el
  const box = el.getBoundingClientRect()
  const ghost = document.createElement('div')
  ghost.className = 'kanban-card kanban-card-ghost'
  ghost.textContent = touchDrag.card.title
  ghost.style.cssText = `position:fixed; left:0; top:0; width:${Math.min(box.width, TOUCH_GHOST_MAX_W)}px; pointer-events:none; z-index:9999; opacity:.95; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; box-shadow:0 8px 24px rgba(0,0,0,.35)`
  document.body.appendChild(ghost)
  touchDrag.ghost = ghost
  positionTouchGhost(x, y)
  touchDrag.active = true
  touchDrag.dropBar = buildTouchDropBar(touchDrag.card.status)
  el.classList.add('dragging')
  // Confirm the mode switch on devices that support it -- without a cursor,
  // the only other signal that a long press "took" is the ghost appearing.
  navigator.vibrate?.(10)
}

function kanbanTouchMove(e) {
  if (!touchDrag || e.touches.length !== 1) return
  const p = e.touches[0]
  if (!touchDrag.active) {
    // Still ambiguous: movement beyond the slop means the user is scrolling.
    if (Math.abs(p.clientX - touchDrag.startX) > TOUCH_DRAG_SLOP_PX ||
        Math.abs(p.clientY - touchDrag.startY) > TOUCH_DRAG_SLOP_PX) {
      endTouchDrag()
    }
    return
  }
  e.preventDefault()
  positionTouchGhost(p.clientX, p.clientY)
  clearTouchDragHighlight()
  // The drop bar sits above everything, so test it first -- a chip and a
  // column body can overlap on screen.
  const chip = kanbanDropTargetAt(p.clientX, p.clientY)
  if (chip) { chip.classList.add('drag-over'); return }
  const col = kanbanColBodyAt(p.clientX, p.clientY)
  if (col) col.classList.add('drag-over')
}

async function kanbanTouchEnd(e) {
  if (!touchDrag) return
  if (!touchDrag.active) { endTouchDrag(); return }
  const p = e.changedTouches[0]
  const chip = kanbanDropTargetAt(p.clientX, p.clientY)
  const col = chip ? null : kanbanColBodyAt(p.clientX, p.clientY)
  const cardId = touchDrag.card.id
  // The release that ends a drag would otherwise also register as a tap and
  // open the detail modal on top of the board the user just rearranged.
  touchDrag.el.dataset.suppressClick = '1'
  // Read the drop position BEFORE endTouchDrag drops the .dragging class --
  // getDragAfterElement excludes .dragging, which is what keeps the card from
  // counting itself when it is dropped back into its own column.
  let sortOrder = 0
  let newStatus = null
  if (chip) {
    // Dropped on the status bar: no position information, so append.
    newStatus = chip.dataset.status
    sortOrder = document.querySelectorAll(`.kanban-col-body[data-status="${newStatus}"] .kanban-card`).length
  } else if (col) {
    newStatus = col.dataset.status
    const after = getDragAfterElement(col, p.clientY)
    const others = [...col.querySelectorAll('.kanban-card:not(.dragging)')]
    sortOrder = after ? others.indexOf(after) : others.length
  }
  endTouchDrag()
  // Released outside any target: treat as a cancelled drag, not a move.
  // A drop inside a column always posts, even when the status is unchanged --
  // that is a reorder within the column, which is just as valid a move.
  if (!newStatus) return
  try {
    const r = await fetch(`/api/kanban/${encodeURIComponent(cardId)}/move`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status: newStatus, sort_order: sortOrder, actor: kanbanMoveActor() }),
    })
    if (!r.ok) throw new Error('move failed')
    loadKanban()
  } catch {
    showToast(t('kanban.toast.move_error'))
  }
}

function wireKanbanCardTouchDnD(el, card) {
  el.addEventListener('touchstart', (e) => {
    if (e.touches.length !== 1) return
    const p = e.touches[0]
    endTouchDrag()
    touchDrag = {
      card, el, ghost: null, active: false,
      startX: p.clientX, startY: p.clientY,
      timer: setTimeout(() => beginTouchDrag(p.clientX, p.clientY), TOUCH_DRAG_DELAY_MS),
    }
    document.addEventListener('touchmove', kanbanTouchMove, { passive: false })
    document.addEventListener('touchend', kanbanTouchEnd)
    document.addEventListener('touchcancel', endTouchDrag)
  }, { passive: true })

  // A long press that turned into a drag must not also open the detail modal
  // on release. The click listener in createCardEl fires after touchend, so
  // the guard flag is read there.
  el.addEventListener('click', (e) => {
    if (el.dataset.suppressClick === '1') {
      delete el.dataset.suppressClick
      e.stopImmediatePropagation()
      e.preventDefault()
    }
  }, true)
}

function getDragAfterElement(col, y) {
  const els = [...col.querySelectorAll('.kanban-card:not(.dragging)')]
  let closest = null
  let closestOffset = Number.NEGATIVE_INFINITY

  for (const el of els) {
    const box = el.getBoundingClientRect()
    const offset = y - box.top - box.height / 2
    if (offset < 0 && offset > closestOffset) {
      closestOffset = offset
      closest = el
    }
  }
  return closest
}

// === New card modal ===
function openNewCardModal(status) {
  document.getElementById('cardModalTitle').textContent = t('kanban.modal.title_new')
  document.getElementById('cardTitle').value = ''
  document.getElementById('cardDesc').value = ''
  document.getElementById('cardPriority').value = 'normal'
  document.getElementById('cardProject').value = ''
  document.getElementById('cardDue').value = ''
  document.getElementById('cardEditId').value = ''
  document.getElementById('cardEditStatus').value = status || 'planned'
  populateAssigneeSelect('cardAssignee')
  populateProjectSuggestions()
  openModal(cardModalOverlay)
  setTimeout(() => document.getElementById('cardTitle').focus(), 200)
}

function populateAssigneeSelect(selectId, selected) {
  const sel = document.getElementById(selectId)
  sel.innerHTML = '<option value="">-- Nincs --</option>'
  for (const a of kanbanAssignees) {
    const opt = document.createElement('option')
    opt.value = a.name
    opt.textContent = a.displayName || a.name
    if (selected && a.name === selected) opt.selected = true
    sel.appendChild(opt)
  }
}

// Save card (create or update)
document.getElementById('saveCardBtn').addEventListener('click', async () => {
  const title = document.getElementById('cardTitle').value.trim()
  if (!title) { document.getElementById('cardTitle').focus(); return }

  const data = {
    title,
    description: document.getElementById('cardDesc').value.trim() || null,
    assignee: document.getElementById('cardAssignee').value || null,
    priority: document.getElementById('cardPriority').value,
    project: document.getElementById('cardProject').value.trim() || null,
    due_date: document.getElementById('cardDue').value
      ? Math.floor(new Date(document.getElementById('cardDue').value).getTime() / 1000)
      : null,
  }

  const editId = document.getElementById('cardEditId').value

  try {
    if (editId) {
      const res = await fetch(`/api/kanban/${encodeURIComponent(editId)}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(data),
      })
      if (!res.ok) { const e = await res.json().catch(() => ({})); throw new Error(e.error || res.status) }
      showToast(t('kanban.toast.card_updated'))
    } else {
      data.status = document.getElementById('cardEditStatus').value
      const res = await fetch('/api/kanban', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(data),
      })
      if (!res.ok) { const e = await res.json().catch(() => ({})); throw new Error(e.error || res.status) }
      showToast(t('kanban.toast.card_created'))
    }
    closeModal(cardModalOverlay)
    loadKanban()
  } catch (err) {
    showToast(t('kanban.toast.save_error_msg', { msg: err.message }))
  }
})

// === Card labels (in the detail modal) ===
// Always re-fetches the card's own labels via the dedicated endpoint instead
// of trusting card.labels -- callers that pass a card object sourced from
// /api/kanban/:id/children (subtask list) don't have labels embedded, only
// the bulk board listing (/api/kanban) does.
async function renderCardLabelsSection(card) {
  const listEl = document.getElementById('cardLabelList')
  const addSelect = document.getElementById('cardLabelAdd')
  const newBtn = document.getElementById('cardLabelNewBtn')
  const newForm = document.getElementById('cardLabelNewForm')
  const newNameInput = document.getElementById('cardLabelNewName')
  const newColorsEl = document.getElementById('cardLabelNewColors')
  const newSaveBtn = document.getElementById('cardLabelNewSaveBtn')

  let attached = []
  try {
    attached = await (await fetch(`/api/kanban/${encodeURIComponent(card.id)}/labels`)).json()
  } catch { /* leave empty -- pill list just stays blank */ }

  listEl.innerHTML = ''
  for (const label of attached) {
    const pill = document.createElement('span')
    pill.className = 'label-pill'
    pill.style.setProperty('--label-color', label.color)
    pill.innerHTML = `#${escapeHtml(label.name)} <button class="label-pill-remove" title="${t('kanban.label.remove_btn')}" aria-label="${t('kanban.label.remove_btn')}">&times;</button>`
    pill.querySelector('.label-pill-remove').addEventListener('click', async () => {
      try {
        await fetch(`/api/kanban/${encodeURIComponent(card.id)}/labels/${encodeURIComponent(label.id)}`, { method: 'DELETE' })
        renderCardLabelsSection(card)
        loadKanban()
      } catch { showToast(t('kanban.toast.label_remove_error')) }
    })
    listEl.appendChild(pill)
  }

  const attachedIds = new Set(attached.map((l) => l.id))
  addSelect.innerHTML = `<option value="">-- ${t('kanban.label.add_placeholder')} --</option>`
  for (const label of kanbanAllLabels) {
    if (attachedIds.has(label.id)) continue
    const opt = document.createElement('option')
    opt.value = label.id
    opt.textContent = label.name
    addSelect.appendChild(opt)
  }
  addSelect.onchange = async () => {
    const labelId = addSelect.value
    if (!labelId) return
    try {
      await fetch(`/api/kanban/${encodeURIComponent(card.id)}/labels`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ labelId }),
      })
      renderCardLabelsSection(card)
      loadKanban()
    } catch { showToast(t('kanban.toast.label_add_error')) }
  }

  newForm.style.display = 'none'
  newBtn.onclick = () => {
    newForm.style.display = newForm.style.display === 'none' ? '' : 'none'
    newNameInput.value = ''
  }

  const palette = window._marveen?.kanbanLabels?.colors || ['#64748b']
  newColorsEl.innerHTML = ''
  let selectedColor = palette[0]
  palette.forEach((color, i) => {
    const sw = document.createElement('span')
    sw.className = 'label-color-swatch' + (i === 0 ? ' selected' : '')
    sw.style.background = color
    sw.addEventListener('click', () => {
      selectedColor = color
      newColorsEl.querySelectorAll('.label-color-swatch').forEach((s) => s.classList.remove('selected'))
      sw.classList.add('selected')
    })
    newColorsEl.appendChild(sw)
  })

  newSaveBtn.onclick = async () => {
    const name = newNameInput.value.trim()
    if (!name) { newNameInput.focus(); return }
    try {
      const r = await fetch('/api/kanban/labels', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, color: selectedColor }),
      })
      if (!r.ok) { showToast(t('kanban.toast.label_create_error')); return }
      const newLabel = await r.json()
      kanbanAllLabels.push(newLabel)
      await fetch(`/api/kanban/${encodeURIComponent(card.id)}/labels`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ labelId: newLabel.id }),
      })
      newForm.style.display = 'none'
      renderCardLabelsSection(card)
      loadKanban()
    } catch { showToast(t('kanban.toast.label_create_error')) }
  }
}

// === Card detail ===
async function showCardDetail(card) {
  // Running number (#N) in the title bar, plus the stable hex id in the meta.
  const seqPrefix = card.seq != null ? `#${card.seq} ` : ''
  document.getElementById('cardDetailTitle').textContent = `${seqPrefix}${card.title}`

  // Case-insensitive match; fall back to the raw stored name so a casing
  // mismatch (or an unregistered assignee) shows the actual name, not "nincs".
  const rawDetailAssignee = card.assignee ? String(card.assignee).trim() : ''
  const assignee = rawDetailAssignee
    ? kanbanAssignees.find((a) => a.name.toLowerCase() === rawDetailAssignee.toLowerCase())
    : null
  const assigneeDisplay = assignee ? (assignee.displayName || assignee.name) : (rawDetailAssignee || '-- nincs --')
  const priorityLabels = { low: t('kanban.priority.low'), normal: t('kanban.priority.normal'), high: t('kanban.priority.high'), urgent: t('kanban.priority.urgent') }
  const statusLabels = { planned: t('kanban.status.planned'), in_progress: t('kanban.status.in_progress'), testing: t('kanban.status.testing'), waiting: t('kanban.status.waiting'), done: t('kanban.status.done') }

  const meta = document.getElementById('cardDetailMeta')
  const idLabel = (card.seq != null ? `#${card.seq} · ` : '') + card.id
  meta.innerHTML = `
    <div class="meta-item">
      <span class="meta-label">${t('kanban.meta.id')}</span>
      <span class="meta-value" style="font-family:monospace" title="${t('kanban.meta.id_tooltip')}">${escapeHtml(idLabel)}</span>
    </div>
    <div class="meta-item">
      <span class="meta-label">${t('kanban.meta.status')}</span>
      <span class="meta-value meta-value-editable" id="metaStatusValue" data-card-id="${card.id}" title="${t('kanban.meta.edit_tooltip')}">${statusLabels[card.status] || card.status}</span>
    </div>
    <div class="meta-item">
      <span class="meta-label">${t('kanban.meta.assignee')}</span>
      <span class="meta-value meta-value-editable" id="metaAssigneeValue" data-card-id="${card.id}" title="${t('kanban.meta.edit_tooltip')}">${escapeHtml(assigneeDisplay)}</span>
    </div>
    <div class="meta-item">
      <span class="meta-label">${t('kanban.meta.priority')}</span>
      <span class="meta-value">${priorityLabels[card.priority]}</span>
    </div>
    <div class="meta-item">
      <span class="meta-label">${t('kanban.meta.project')}</span>
      <span class="meta-value">${card.project ? escapeHtml(card.project) : t('kanban.meta.none')}</span>
    </div>
    <div class="meta-item">
      <span class="meta-label">${t('kanban.meta.deadline')}</span>
      <span class="meta-value">${card.due_date ? new Date(card.due_date * 1000).toLocaleDateString(_lang === 'en' ? 'en-US' : 'hu-HU') : t('kanban.meta.none')}</span>
    </div>
  `

  // Inline edit for status on detail view. HTML5 drag & drop is the only way to
  // change a card's column, and it is dead on touch devices (no dragstart is
  // ever fired), so on a phone the board was effectively read-only. This is the
  // pointer-independent path: tap the card, pick the new status. Mirrors the
  // assignee editor below, but POSTs to /move rather than PUT -- /move is what
  // recomputes sort_order AND fires the in_progress agent dispatch, which a
  // plain PUT would silently skip.
  const statusValueEl = document.getElementById('metaStatusValue')
  statusValueEl.addEventListener('click', () => {
    if (statusValueEl.querySelector('select')) return
    const current = card.status
    const sel = document.createElement('select')
    sel.style.cssText = 'padding:2px 6px; border-radius:4px; border:1px solid var(--border); background:var(--bg-card); color:var(--text); font-size:inherit'
    for (const s of ['planned', 'in_progress', 'waiting', 'testing', 'done']) {
      const opt = document.createElement('option')
      opt.value = s
      opt.textContent = statusLabels[s] || s
      if (s === current) opt.selected = true
      sel.appendChild(opt)
    }
    statusValueEl.innerHTML = ''
    statusValueEl.appendChild(sel)
    sel.focus()
    const restore = (status) => { statusValueEl.textContent = statusLabels[status] || status }
    const save = async () => {
      const newVal = sel.value
      if (newVal === current) { restore(current); return }
      try {
        const r = await fetch(`/api/kanban/${encodeURIComponent(card.id)}/move`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ status: newVal, sort_order: 0, actor: kanbanMoveActor() }),
        })
        if (!r.ok) throw new Error('move failed')
        card.status = newVal
        restore(newVal)
        showToast(t('kanban.toast.status_updated'))
        loadKanban && loadKanban()
      } catch {
        restore(current)
        showToast(t('kanban.toast.move_error'))
      }
    }
    sel.addEventListener('change', save)
    sel.addEventListener('blur', () => {
      if (statusValueEl.querySelector('select')) restore(card.status)
    })
  })

  // Inline edit for assignee on detail view
  const assigneeValueEl = document.getElementById('metaAssigneeValue')
  assigneeValueEl.addEventListener('click', () => {
    if (assigneeValueEl.querySelector('select')) return
    const current = card.assignee || ''
    const sel = document.createElement('select')
    sel.style.cssText = 'padding:2px 6px; border-radius:4px; border:1px solid var(--border); background:var(--bg-card); color:var(--text); font-size:inherit'
    sel.innerHTML = '<option value="">-- Nincs --</option>'
    for (const a of kanbanAssignees) {
      const opt = document.createElement('option')
      opt.value = a.name
      opt.textContent = a.displayName || a.name
      if (a.name === current) opt.selected = true
      sel.appendChild(opt)
    }
    assigneeValueEl.innerHTML = ''
    assigneeValueEl.appendChild(sel)
    sel.focus()
    const save = async () => {
      const newVal = sel.value || null
      if (newVal === current || (newVal === null && !current)) {
        assigneeValueEl.textContent = current ? current : '-- nincs --'
        return
      }
      try {
        const r = await fetch(`/api/kanban/${encodeURIComponent(card.id)}`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ ...card, assignee: newVal }),
        })
        if (!r.ok) throw new Error('PUT failed')
        card.assignee = newVal
        assigneeValueEl.textContent = newVal ? newVal : '-- nincs --'
        showToast(t('kanban.toast.assignee_updated'))
        loadKanban && loadKanban()
      } catch {
        assigneeValueEl.textContent = current ? current : '-- nincs --'
        showToast(t('kanban.toast.save_error'))
      }
    }
    sel.addEventListener('change', save)
    sel.addEventListener('blur', () => {
      if (assigneeValueEl.querySelector('select')) {
        assigneeValueEl.textContent = card.assignee ? card.assignee : '-- nincs --'
      }
    })
  })

  document.getElementById('cardDetailDesc').textContent = card.description || ''

  renderCardLabelsSection(card)

  // #115: Parent meta row — dropdown replaces the old read-only display; shown only when editable
  const parentMetaItem = document.getElementById('parentMetaItem')
  const parentSelect = document.getElementById('parentSelect')
  const canModifyParent = card.status === 'planned' || card.status === 'waiting'
  if (card.parent_id && canModifyParent) {
    // Build the parent-select dropdown: null option + all top-level non-done tasks
    parentSelect.innerHTML = `<option value="">${t('kanban.parent.empty')}</option>`
    const availableParents = kanbanCards.filter(c =>
      !c.parent_id && c.id !== card.id && !c.archived_at &&
      (c.status === 'planned' || c.status === 'in_progress' || c.status === 'testing' || c.status === 'waiting')
    )
    for (const p of availableParents) {
      const opt = document.createElement('option')
      opt.value = p.id
      const fullLabel = (p.seq != null ? `#${p.seq} ` : '') + p.title
      opt.title = fullLabel
      opt.textContent = fullLabel.length > 33 ? fullLabel.slice(0, 32) + '…' : fullLabel
      if (p.id === card.parent_id) opt.selected = true
      parentSelect.appendChild(opt)
    }
    parentSelect.onchange = async () => {
      const newParentId = parentSelect.value || null
      const label = newParentId ? t('kanban.toast.parent_updated') : t('kanban.toast.parent_unset')
      const r = await fetch(`/api/kanban/${encodeURIComponent(card.id)}`, {
        method: 'PUT', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...card, parent_id: newParentId }),
      })
      if (r.ok) { card.parent_id = newParentId; showToast(label); loadKanban(); showCardDetail(card) }
      else showToast(t('kanban.toast.save_error'))
    }
    parentMetaItem.style.display = ''
  } else {
    parentMetaItem.style.display = 'none'
  }

  // Load comments
  try {
    const res = await fetch(`/api/kanban/${encodeURIComponent(card.id)}/comments`)
    const comments = await res.json()
    const list = document.getElementById('commentsList')
    list.innerHTML = ''
    for (const c of comments) {
      const date = new Date(c.created_at * 1000).toLocaleString('hu-HU')
      const div = document.createElement('div')
      div.className = 'comment-item'
      div.innerHTML = `
        <div><span class="comment-author">${escapeHtml(c.author)}</span><span class="comment-date">${date}</span></div>
        <div class="comment-body">${escapeHtml(c.content)}</div>
      `
      list.appendChild(div)
    }
  } catch { /* ignore */ }

  // Author select for new comment. Default to the bot assignee resolved by
  // type (never a hard-coded display name -- BOT_NAME differs per deployment),
  // falling back to the first assignee. The old literal 'Marveen' never matched
  // on non-Marveen installs, so the select stayed on "-- Nincs --" and the
  // comment submit silently no-opped (addCommentBtn returns when !author).
  // (Resolution of the #254/#241 overlap: keep #241's type-resolved default
  // over #254's hard-coded "Gábor" -- same deployment-agnostic reasoning.)
  const defaultCommentAuthor =
    (kanbanAssignees.find((a) => a.type === 'owner') || kanbanAssignees[0] || {}).name || ''
  populateAssigneeSelect('commentAuthor', defaultCommentAuthor)

  // Add comment
  document.getElementById('addCommentBtn').onclick = async () => {
    const content = document.getElementById('commentContent').value.trim()
    const author = document.getElementById('commentAuthor').value
    if (!content) { document.getElementById('commentContent').focus(); return }
    if (!author) { showToast(t('kanban.toast.comment_no_author')); return }
    try {
      const res = await fetch(`/api/kanban/${encodeURIComponent(card.id)}/comments`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ author, content }),
      })
      // Without this check an HTTP error (e.g. 400) still cleared the textarea
      // and "refreshed", so the comment looked sent but was never saved.
      if (!res.ok) {
        let msg = `HTTP ${res.status}`
        try { msg = (await res.json()).error || msg } catch {}
        showToast(t('kanban.toast.comment_failed', { msg }))
        return
      }
      document.getElementById('commentContent').value = ''
      showCardDetail(card) // refresh
    } catch {
      showToast(t('kanban.toast.comment_error'))
    }
  }

  // Edit button
  document.getElementById('cardEditBtn').onclick = () => {
    closeModal(cardDetailOverlay)
    document.getElementById('cardModalTitle').textContent = t('kanban.modal.title_edit')
    document.getElementById('cardTitle').value = card.title
    document.getElementById('cardDesc').value = card.description || ''
    document.getElementById('cardPriority').value = card.priority
    document.getElementById('cardProject').value = card.project || ''
    document.getElementById('cardDue').value = card.due_date
      ? new Date(card.due_date * 1000).toISOString().split('T')[0]
      : ''
    document.getElementById('cardEditId').value = card.id
    document.getElementById('cardEditStatus').value = card.status
    populateAssigneeSelect('cardAssignee', card.assignee)
    populateProjectSuggestions()
    openModal(cardModalOverlay)
  }

  // Archive
  document.getElementById('cardArchiveBtn').onclick = async () => {
    try {
      let res = await fetch(`/api/kanban/${encodeURIComponent(card.id)}/archive`, { method: 'POST' })
      if (res.status === 409) {
        const data = await res.json().catch(() => ({}))
        const n = Array.isArray(data.openChildren) ? data.openChildren.length : 0
        if (!confirm(t('kanban.confirm.archive_open_children', { n }))) return
        res = await fetch(`/api/kanban/${encodeURIComponent(card.id)}/archive`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ force: true }),
        })
      }
      if (!res.ok) throw new Error('archive failed')
      closeModal(cardDetailOverlay)
      showToast(t('kanban.toast.card_archived'))
      loadKanban()
    } catch {
      showToast(t('kanban.toast.archive_error'))
    }
  }

  // Delete
  document.getElementById('cardDeleteBtn').onclick = async () => {
    if (!confirm(t('kanban.confirm.delete'))) return
    try {
      await fetch(`/api/kanban/${encodeURIComponent(card.id)}`, { method: 'DELETE' })
      closeModal(cardDetailOverlay)
      showToast(t('kanban.toast.card_deleted'))
      loadKanban()
    } catch {
      showToast(t('common.error_delete'))
    }
  }

  // Load children (subtasks) — only top-level tasks have children (no subtask of subtask)
  try {
    const childRes = await fetch(`/api/kanban/${encodeURIComponent(card.id)}/children`)
    const children = await childRes.json()
    const section = document.getElementById('cardChildrenSection')
    const list = document.getElementById('cardChildrenList')
    const addSubtaskSection = document.getElementById('cardAddSubtaskSection')
    const isTask = !card.parent_id

    // #113: Show add-subtask form only for top-level tasks that are not done
    if (isTask && card.status !== 'done') {
      addSubtaskSection.style.display = ''
      const titleInput = document.getElementById('newSubtaskTitle')
      titleInput.value = ''
      document.getElementById('addSubtaskBtn').onclick = async () => {
        const title = titleInput.value.trim()
        if (!title) { titleInput.focus(); return }
        try {
          const r = await fetch('/api/kanban', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ title, parent_id: card.id, status: card.status, priority: card.priority, project: card.project || null, assignee: null }),
          })
          if (!r.ok) { showToast(t('kanban.toast.subtask_error')); return }
          showToast(t('kanban.toast.subtask_created'))
          loadKanban()
          showCardDetail(card)
        } catch { showToast(t('kanban.toast.subtask_error')) }
      }
    } else {
      addSubtaskSection.style.display = 'none'
    }

    const statusLabelsShort = { planned: t('kanban.status.planned'), in_progress: t('kanban.status.in_progress'), testing: t('kanban.status.testing'), waiting: t('kanban.status.waiting_short'), done: t('kanban.status.done') }
    if (children.length > 0 || isTask) {
      section.style.display = ''
      list.innerHTML = ''
      // #114: Delete button per subtask — only shown when the parent card is not done
      const canDeleteChild = card.status !== 'done'
      for (const ch of children) {
        const div = document.createElement('div')
        div.className = 'comment-item'
        div.style.cssText = 'cursor:pointer; display:flex; justify-content:space-between; align-items:center; gap:8px'
        const info = document.createElement('div')
        info.style.flex = '1'
        info.innerHTML = `<div><strong>${escapeHtml(ch.title)}</strong> <span style="color:var(--text-muted)">[${statusLabelsShort[ch.status] || ch.status}]</span></div>
          <div style="font-size:0.85em;color:var(--text-muted)">${ch.assignee ? escapeHtml(ch.assignee) : ''}${ch.description ? ' -- ' + escapeHtml(ch.description).slice(0, 80) : ''}</div>`
        info.onclick = () => { closeModal(cardDetailOverlay); showCardDetail(ch) }
        div.appendChild(info)
        if (canDeleteChild) {
          const delBtn = document.createElement('button')
          delBtn.className = 'btn-danger btn-compact'
          delBtn.style.flexShrink = '0'
          delBtn.textContent = t('kanban.modal.delete_btn')
          delBtn.onclick = async (e) => {
            e.stopPropagation()
            if (!confirm(t('kanban.confirm.delete_subtask', { title: ch.title }))) return
            try {
              const r = await fetch(`/api/kanban/${encodeURIComponent(ch.id)}`, { method: 'DELETE' })
              if (!r.ok) { showToast(t('common.error_delete')); return }
              showToast(t('kanban.toast.subtask_deleted'))
              loadKanban()
              showCardDetail(card)
            } catch { showToast(t('common.error_delete')) }
          }
          div.appendChild(delBtn)
        }
        list.appendChild(div)
      }
    } else {
      section.style.display = 'none'
    }
  } catch {
    document.getElementById('cardChildrenSection').style.display = 'none'
    document.getElementById('cardAddSubtaskSection').style.display = 'none'
  }

  // Breakdown button
  document.getElementById('cardBreakdownBtn').onclick = async () => {
    const btn = document.getElementById('cardBreakdownBtn')
    btn.disabled = true
    btn.textContent = t('kanban.breakdown.generating')
    try {
      const res = await fetch(`/api/kanban/${encodeURIComponent(card.id)}/breakdown`, { method: 'POST' })
      const data = await res.json()
      if (!res.ok) { showToast(data.error || 'Hiba'); btn.disabled = false; btn.textContent = 'Breakdown'; return }
      breakdownMode = 'kanban'
      breakdownCardId = card.id
      breakdownSubtasks = data.subtasks
      showBreakdownModal(data.subtasks, card)
      const dodSec = document.getElementById('breakdownDoDSection')
      if (dodSec) dodSec.style.display = 'none'
    } catch (err) {
      showToast('Breakdown hiba')
    } finally {
      btn.disabled = false
      btn.textContent = 'Breakdown'
    }
  }

  openModal(cardDetailOverlay)
  // Inline diff-comment section (card c12abc67, pair-BE 906c130f).
  void loadCardDiffComments(card.id)
}

// Inline diff-comment view (card c12abc67). API: GET /api/kanban/:id/diff-comments
// Returns { diffs: [{sha, file, hunks: [{header, lines: [{type, number, content, comments: [{id, author, text}]}]}] }] }
// 404 → section stays hidden (pair-BE 906c130f not yet built -- contract-first graceful fallback).
async function loadCardDiffComments(cardId) {
  const section = document.getElementById('cardDiffSection')
  const body = document.getElementById('cardDiffBody')
  if (!section || !body) return
  section.hidden = true
  body.innerHTML = `<p class="diff-loading">${escapeHtml(t('common.loading'))}</p>`
  const token = localStorage.getItem('marveen-dashboard-token') || ''
  try {
    const r = await fetch(`/api/kanban/${encodeURIComponent(cardId)}/diff-comments`, {
      headers: { 'Authorization': 'Bearer ' + token },
    })
    if (r.status === 404) { section.hidden = true; return }
    if (!r.ok) throw new Error('HTTP ' + r.status)
    const d = await r.json()
    const diffs = Array.isArray(d.diffs) ? d.diffs : []
    if (!diffs.length) {
      body.innerHTML = `<p class="diff-empty">${escapeHtml(t('kanban.diff.empty'))}</p>`
      section.hidden = false
      wireCardDiffToggle(body)
      return
    }
    body.innerHTML = diffs.map((fileDiff) => renderDiffFile(cardId, fileDiff)).join('')
    section.hidden = false
    wireCardDiffToggle(body)
    wireDiffInteractions(cardId, body)
  } catch {
    body.innerHTML = `<p class="diff-error">${escapeHtml(t('kanban.diff.error'))}</p>`
    section.hidden = false
  }
}

function renderDiffFile(cardId, fileDiff) {
  const sha = escapeHtml(fileDiff.sha || '')
  const fileName = escapeHtml(fileDiff.file || '')
  const hunks = Array.isArray(fileDiff.hunks) ? fileDiff.hunks : []
  const linesHtml = hunks.map((hunk) => {
    const headerHtml = hunk.header
      ? `<div class="diff-hunk-header">${escapeHtml(hunk.header)}</div>`
      : ''
    const lines = Array.isArray(hunk.lines) ? hunk.lines : []
    const linesHtml = lines.map((ln) => {
      const typeClass = ln.type === 'added' ? 'diff-line-add' : ln.type === 'removed' ? 'diff-line-remove' : 'diff-line-context'
      const prefix = ln.type === 'added' ? '+' : ln.type === 'removed' ? '-' : ' '
      const comments = Array.isArray(ln.comments) ? ln.comments : []
      const commentsHtml = comments.length
        ? `<div class="diff-inline-comments">${comments.map((c) =>
            `<div class="diff-inline-comment" data-comment-id="${escapeHtml(String(c.id))}">
              <span class="diff-comment-author">${escapeHtml(c.author || '?')}</span>
              <span class="diff-comment-text">${escapeHtml(c.text || '')}</span>
              <button class="diff-comment-delete btn-danger btn-compact" data-comment-id="${escapeHtml(String(c.id))}" data-line="${escapeHtml(String(ln.number || 0))}" title="${escapeHtml(t('kanban.diff.delete_btn'))}">&times;</button>
            </div>`
          ).join('')}</div>`
        : ''
      const addFormHtml = `<div class="diff-add-form" hidden data-line="${escapeHtml(String(ln.number || 0))}" data-sha="${sha}" data-file="${fileName}">
  <textarea placeholder="${escapeHtml(t('kanban.diff.add_comment_ph'))}" rows="2"></textarea>
  <div class="diff-add-form-actions">
    <button class="btn-primary btn-compact diff-submit-btn" data-i18n="kanban.diff.add_btn">${escapeHtml(t('kanban.diff.add_btn'))}</button>
    <button class="btn-secondary btn-compact diff-cancel-btn" data-i18n="kanban.diff.cancel_btn">${escapeHtml(t('kanban.diff.cancel_btn'))}</button>
  </div>
</div>`
      return `<div class="diff-line ${typeClass}" data-line="${escapeHtml(String(ln.number || 0))}">
  <span class="diff-line-num">${escapeHtml(String(ln.number || ''))}</span>
  <span class="diff-line-content">${prefix}${escapeHtml(ln.content || '')}</span>
  <button class="diff-add-comment-btn" data-line="${escapeHtml(String(ln.number || 0))}" aria-label="${escapeHtml(t('kanban.diff.add_comment_ph'))}">+</button>
</div>${commentsHtml}${addFormHtml}`
    }).join('')
    return headerHtml + linesHtml
  }).join('')
  return `<div class="diff-file">
  <div class="diff-file-header">
    <span class="diff-file-name">${fileName}</span>
    <span class="diff-file-sha">${sha}</span>
  </div>
  <div class="diff-table">${linesHtml}</div>
</div>`
}

function wireCardDiffToggle(body) {
  const toggle = document.getElementById('cardDiffToggle')
  if (!toggle) return
  toggle.addEventListener('click', () => {
    const expanded = toggle.getAttribute('aria-expanded') !== 'false'
    toggle.setAttribute('aria-expanded', String(!expanded))
    toggle.textContent = !expanded ? t('kanban.diff.collapse') : t('kanban.diff.expand')
    body.hidden = !expanded
  })
}

function wireDiffInteractions(cardId, container) {
  // "+" buttons toggle the add-comment form for a given line
  container.querySelectorAll('.diff-add-comment-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      const line = btn.dataset.line
      const form = container.querySelector(`.diff-add-form[data-line="${line}"]`)
      if (!form) return
      const wasHidden = form.hidden
      // Close all other forms first
      container.querySelectorAll('.diff-add-form').forEach((f) => { f.hidden = true })
      form.hidden = !wasHidden
      if (!form.hidden) form.querySelector('textarea')?.focus()
    })
  })
  // Cancel buttons
  container.querySelectorAll('.diff-cancel-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      const form = btn.closest('.diff-add-form')
      if (form) { form.hidden = true; const ta = form.querySelector('textarea'); if (ta) ta.value = '' }
    })
  })
  // Submit buttons
  container.querySelectorAll('.diff-submit-btn').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const form = btn.closest('.diff-add-form')
      if (!form) return
      const text = form.querySelector('textarea')?.value?.trim() || ''
      if (!text) return
      const line = parseInt(form.dataset.line || '0', 10)
      const sha = form.dataset.sha || ''
      const file = form.dataset.file || ''
      btn.disabled = true
      try {
        await addDiffComment(cardId, sha, file, line, text)
        void loadCardDiffComments(cardId)
      } catch {
        showToast(t('kanban.diff.error'))
        btn.disabled = false
      }
    })
  })
  // Delete buttons
  container.querySelectorAll('.diff-comment-delete').forEach((btn) => {
    btn.addEventListener('click', async () => {
      if (!confirm(t('kanban.diff.delete_confirm'))) return
      const commentId = btn.dataset.commentId
      if (!commentId) return
      const token = localStorage.getItem('marveen-dashboard-token') || ''
      try {
        await fetch(`/api/kanban/${encodeURIComponent(cardId)}/diff-comments/${encodeURIComponent(commentId)}`, {
          method: 'DELETE',
          headers: { 'Authorization': 'Bearer ' + token },
        })
        void loadCardDiffComments(cardId)
      } catch {
        showToast(t('kanban.diff.error'))
      }
    })
  })
}

async function addDiffComment(cardId, sha, file, line, text) {
  const token = localStorage.getItem('marveen-dashboard-token') || ''
  const r = await fetch(`/api/kanban/${encodeURIComponent(cardId)}/diff-comments`, {
    method: 'POST',
    headers: { 'Authorization': 'Bearer ' + token, 'Content-Type': 'application/json' },
    body: JSON.stringify({ sha, file, line, text, author: 'dashboard' }),
  })
  if (!r.ok) throw new Error('HTTP ' + r.status)
}

async function triggerBreakdown(card) {
  const btn = document.querySelector(`.kanban-card[data-id="${card.id}"] .card-breakdown-btn`)
  if (btn) { btn.disabled = true; btn.textContent = '...' }
  try {
    const res = await fetch(`/api/kanban/${encodeURIComponent(card.id)}/breakdown`, { method: 'POST' })
    const data = await res.json()
    if (!res.ok) { showToast(data.error || 'Breakdown hiba'); return }
    breakdownMode = 'kanban'
    breakdownCardId = card.id
    breakdownSubtasks = data.subtasks
    showBreakdownModal(data.subtasks, card)
  } catch {
    showToast('Breakdown hiba')
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = '⚡' }
  }
}

function showBreakdownModal(subtasks, parentCard) {
  document.getElementById('breakdownProvider').textContent = t('kanban.breakdown.parent_label', { title: escapeHtml(parentCard.title) })
  const list = document.getElementById('breakdownList')
  list.innerHTML = ''

  const priorityLabels = { low: t('kanban.priority.low'), normal: t('kanban.priority.normal'), high: t('kanban.priority.high'), urgent: t('kanban.priority.urgent') }
  const assigneeOptions = kanbanAssignees
    .map((a) => `<option value="${escapeHtml(a.name)}">${escapeHtml(a.displayName || a.name)}</option>`)
    .join('')

  subtasks.forEach((st, i) => {
    const div = document.createElement('div')
    div.className = 'comment-item breakdown-subtask-item'
    div.dataset.idx = i
    div.style.borderLeft = '3px solid var(--accent)'
    div.innerHTML = `
      <div style="display:flex; justify-content:space-between; align-items:center; gap:8px; margin-bottom:8px">
        <label style="font-size:0.8em; color:var(--text-muted); white-space:nowrap">${i + 1}.</label>
        <input type="text" class="breakdown-title-input" value="${escapeHtml(st.title)}"
          style="flex:1; padding:5px 8px; border-radius:6px; border:1px solid var(--border); background:var(--bg-card); color:var(--text); font-size:0.9em">
        <label style="font-size:0.8em; white-space:nowrap">
          <input type="checkbox" class="breakdown-check" data-idx="${i}" checked> Bele
        </label>
      </div>
      <div style="display:flex; gap:8px; align-items:center; flex-wrap:wrap">
        <select class="breakdown-assignee-select" style="padding:4px 8px; border-radius:6px; border:1px solid var(--border); background:var(--bg-card); color:var(--text); font-size:0.85em">
          <option value="">-- nincs --</option>
          ${assigneeOptions}
        </select>
        <span class="priority-badge priority-${st.priority}">${priorityLabels[st.priority] || st.priority}</span>
      </div>
    `
    // Set assignee select value after insert
    const sel = div.querySelector('.breakdown-assignee-select')
    if (st.assignee) sel.value = st.assignee
    list.appendChild(div)
  })
  openModal(breakdownOverlay)
}

document.getElementById('breakdownAcceptBtn').addEventListener('click', async () => {
  const items = document.querySelectorAll('.breakdown-subtask-item')
  const accepted = []
  items.forEach((item) => {
    const idx = parseInt(item.dataset.idx, 10)
    const checked = item.querySelector('.breakdown-check')?.checked
    if (!checked) return
    const title = item.querySelector('.breakdown-title-input')?.value.trim() || breakdownSubtasks[idx]?.title
    const assignee = item.querySelector('.breakdown-assignee-select')?.value || breakdownSubtasks[idx]?.assignee
    const priority = breakdownSubtasks[idx]?.priority || 'normal'
    const description = breakdownSubtasks[idx]?.description || ''
    accepted.push({ title, assignee, priority, description })
  })
  if (accepted.length === 0) { showToast(t('kanban.breakdown.select_one')); return }
  try {
    if (breakdownMode === 'idea') {
      const successCriteria = document.getElementById('breakdownSuccessCriteria')?.value.trim() || undefined
      const res = await fetch(`/api/ideas/${encodeURIComponent(breakdownIdeaId)}/promote-breakdown`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ subtasks: accepted, success_criteria: successCriteria }),
      })
      const data = await res.json()
      if (!res.ok) { showToast(data.error || 'Hiba'); return }
      closeModal(breakdownOverlay)
      showToast(t('kanban.breakdown.promoted', { count: data.child_count }))
      loadIdeasPage()
      return
    }
    const res = await fetch(`/api/kanban/${encodeURIComponent(breakdownCardId)}/breakdown/accept`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ subtasks: accepted }),
    })
    const data = await res.json()
    if (!res.ok) { showToast(data.error || 'Hiba'); return }
    closeModal(breakdownOverlay)
    closeModal(cardDetailOverlay)
    showToast(t('kanban.breakdown.created_count', { count: data.created.length }))
    loadKanban()
  } catch {
    showToast(t('common.error_save'))
  }
})

document.getElementById('breakdownRejectBtn').addEventListener('click', () => {
  closeModal(breakdownOverlay)
  showToast(t('kanban.toast.breakdown_rejected'))
})

document.getElementById('breakdownClose').addEventListener('click', () => closeModal(breakdownOverlay))

