// === Collapsible sidebar groups ===
// Globals from app.js: (none -- fully standalone)
// Exposed globally: openSidebarGroupForPage(), SIDEBAR_GROUPS, PAGE_SIDEBAR_GROUP
// Open/closed state lives in localStorage (marveen.sidebarGroups) as a JSON
// array of open group keys. Missing or corrupt state means everything starts
// collapsed -- that is the designed default, not an error.
const SIDEBAR_GROUPS_LS_KEY = 'marveen.sidebarGroups'
// Declarative single source of truth for the group -> pages mapping. The markup
// order is only the default snapshot: at boot the static links are re-parented
// into their group containers per this map, so regrouping a page (say, moving
// naplo under system) or relabeling a group is a one-line change right here.
const SIDEBAR_GROUPS = [
  { key: 'team',        labelKey: 'nav.group.team',        pages: ['agents', 'activity', 'messages', 'tasks', 'bgTasks'] },
  { key: 'knowledge',   labelKey: 'nav.group.knowledge',   pages: ['memories', 'skills', 'research', 'ideas'] },
  { key: 'stats',       labelKey: 'nav.group.stats',       pages: ['costs', 'tokenUsage'] },
  { key: 'system',      labelKey: 'nav.group.system',      pages: ['status', 'naplo', 'updates', 'repos', 'settings', 'vault'] },
  { key: 'connections', labelKey: 'nav.group.connections', pages: ['connectors', 'federation', 'migrate'] },
]
const sidebarGroupEls = document.querySelectorAll('.sb-group[data-group]')
// data-page -> group key, derived from the map (not the DOM) so the map wins.
const PAGE_SIDEBAR_GROUP = {}
SIDEBAR_GROUPS.forEach((def) => def.pages.forEach((p) => { PAGE_SIDEBAR_GROUP[p] = def.key }))
// Re-parent the 23 static links to match the map. Moving an existing DOM node
// does not invalidate the navLinks refs captured by querySelectorAll at boot.
SIDEBAR_GROUPS.forEach((def) => {
  const group = document.querySelector(`.sb-group[data-group="${def.key}"]`)
  if (!group) return
  const label = group.querySelector('.sb-group-label')
  if (label) label.dataset.i18n = def.labelKey
  const items = group.querySelector('.sb-group-items')
  if (!items) return
  def.pages.forEach((p) => {
    const link = document.querySelector(`.sb-link[data-page="${p}"]`)
    if (link) items.appendChild(link)
  })
})

function loadSidebarGroupState() {
  try {
    const arr = JSON.parse(localStorage.getItem(SIDEBAR_GROUPS_LS_KEY))
    return Array.isArray(arr) ? arr.filter((k) => typeof k === 'string') : []
  } catch { return [] }
}

function setSidebarGroupOpen(groupEl, open, persist = true) {
  groupEl.classList.toggle('open', open)
  const btn = groupEl.querySelector('.sb-group-header')
  if (btn) btn.setAttribute('aria-expanded', open ? 'true' : 'false')
  if (persist) {
    const key = groupEl.dataset.group
    const state = loadSidebarGroupState().filter((k) => k !== key)
    if (open) state.push(key)
    try { localStorage.setItem(SIDEBAR_GROUPS_LS_KEY, JSON.stringify(state)) } catch {}
  }
}

// Called from switchPage: the active page's group must always be visible so the
// "where am I" highlight is never hidden inside a collapsed group.
function openSidebarGroupForPage(pageId) {
  const key = PAGE_SIDEBAR_GROUP[pageId]
  if (!key) return
  sidebarGroupEls.forEach((g) => {
    // persist=false: only user clicks may be remembered. Persisting the
    // auto-open would let everyday navigation accumulate all 5 groups as
    // saved-open and quietly bring back the flat 23-item menu.
    if (g.dataset.group === key && !g.classList.contains('open')) setSidebarGroupOpen(g, true, false)
  })
}

{
  const openKeys = loadSidebarGroupState()
  sidebarGroupEls.forEach((g) => setSidebarGroupOpen(g, openKeys.includes(g.dataset.group), false))
}
sidebarGroupEls.forEach((g) => {
  const btn = g.querySelector('.sb-group-header')
  if (btn) btn.addEventListener('click', () => setSidebarGroupOpen(g, !g.classList.contains('open')))
})

