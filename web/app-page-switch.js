// === Page switching + Mobile sidebar toggle ===
// Globals from app.js: t, loadUpdates (fork-overlay seam)
// Globals from app-elements.js: (all these load after app.js before other mods)
// Globals from app-sidebar-groups.js: openSidebarGroupForPage
// Globals from app-settings-auth.js: settingsDirty (typeof-safe, only in fn body)
// Globals from app-activity.js: stopActivityPoll, startActivityPoll, stopKanbanRefresh, startKanbanRefresh
// Globals from app-agents.js: stopAgentsBusyPoll, startAgentsBusyPoll, loadAgents
// Globals from app-agents-team.js: _agentsActiveView, _setAgentsView
// ... plus many more page-load fns from other modules (all resolved at call time)
// Exposed globally: switchPage(), setSidebarOpen(), navLinks, pages, _switchProviderTab()
const navLinks = document.querySelectorAll('.sb-link[data-page], .nav-link[data-page]')
const pages = document.querySelectorAll('.page')

// === Providers page tabs (card f1e33cfb): Local model / FreeLLM / Gemini, plus the nested
// Local-model Állapot/Katalógus sub-tabs. Same toggle-by-data-attribute pattern as switchAgentTab
// in app-agent-detail.js -- panels differ by a data attribute, not a fixed id list, so adding a
// fourth provider later is a markup-only change. ===
function _switchProviderTab(tab) {
  const nav = document.getElementById('providersTabNav')
  if (nav) nav.querySelectorAll('.tab-btn').forEach((b) => b.classList.toggle('active', b.dataset.providerTab === tab))
  const panels = { local: 'tabProviderLocal', freellm: 'tabProviderFreellm', gemini: 'tabProviderGemini' }
  Object.keys(panels).forEach((key) => {
    const el = document.getElementById(panels[key])
    if (el) el.hidden = key !== tab
  })
}
function _switchLocalLlmSubTab(tab) {
  const nav = document.getElementById('localLlmSubTabNav')
  if (nav) nav.querySelectorAll('.tab-btn').forEach((b) => b.classList.toggle('active', b.dataset.localTab === tab))
  const panels = { status: 'localLlmSubStatus', catalog: 'localLlmSubCatalog' }
  Object.keys(panels).forEach((key) => {
    const el = document.getElementById(panels[key])
    if (el) el.hidden = key !== tab
  })
}
;(function wireProviderTabs() {
  const outer = document.getElementById('providersTabNav')
  if (outer) outer.addEventListener('click', (e) => {
    const btn = e.target.closest('.tab-btn')
    if (btn) _switchProviderTab(btn.dataset.providerTab)
  })
  const inner = document.getElementById('localLlmSubTabNav')
  if (inner) inner.addEventListener('click', (e) => {
    const btn = e.target.closest('.tab-btn')
    if (btn) _switchLocalLlmSubTab(btn.dataset.localTab)
  })
})()

function confirmSettingsLeave() {
  if (settingsDirty.size === 0) return true
  return window.confirm(t('settings.unsaved_warning'))
}

function switchPage(pageId) {
  // 'team' is merged into 'agents'; any internal call still passing 'team' redirects.
  if (pageId === 'team') { _agentsActiveView = 'tree'; pageId = 'agents' }
  // 'localLlm'/'freellm'/'geminiCalls' merged into 'providers' (card f1e33cfb, phase 36dc9240):
  // old deep-links and nav code paths redirect here and land on the matching tab, same pattern
  // as the 'team' redirect above. Safety window: old anchors keep working, not removed.
  if (pageId === 'localLlm' || pageId === 'freellm' || pageId === 'geminiCalls') {
    const tab = pageId === 'localLlm' ? 'local' : pageId === 'freellm' ? 'freellm' : 'gemini'
    pageId = 'providers'
    if (typeof _switchProviderTab === 'function') _switchProviderTab(tab)
  }
  // Guard unsaved settings before leaving the settings page
  if (!document.getElementById('settingsPage').hidden && pageId !== 'settings' && !confirmSettingsLeave()) return
  pages.forEach((p) => (p.hidden = p.id !== pageId + 'Page'))
  navLinks.forEach((l) => l.classList.toggle('active', l.dataset.page === pageId))
  openSidebarGroupForPage(pageId)
  // Kanban needs full-width layout (overrides main's max-width: 1200px)
  document.querySelector('main').classList.toggle('kanban-active', pageId === 'kanban')
  // Activity page runs a live poll; stop it whenever we navigate away.
  if (pageId !== 'activity') stopActivityPoll()
  if (pageId === 'activity') startActivityPoll()
  // Agents page tints each Terminal button green while that agent is working;
  // same 3s poll + source as Activity. Stop it when we leave the page.
  if (pageId !== 'agents') stopAgentsBusyPoll()
  // Kanban auto-refresh: start on enter, stop on leave.
  if (pageId !== 'kanban') stopKanbanRefresh()
  // Overview's live utilization spectrum runs its own poll + rAF scroll loop; stop both on leave.
  if (pageId !== 'overview') stopOvwSpectrum()
  // Local-LLM feladat-elosztás swimlane: same start/stop-on-leave pattern (card fix, 2026-09-11).
  if (pageId !== 'overview') stopOvwLlmDist()
  if (pageId === 'overview') loadOverview()
  if (pageId === 'projects') initProjectsPage()
  if (pageId === 'kanban') { if (typeof _initGanttViewSwitcher === 'function') _initGanttViewSwitcher(); loadKanban(); startKanbanRefresh() }
  if (pageId === 'tasks') loadSchedules()
  if (pageId === 'agents') { loadAgents().then(() => _setAgentsView(_agentsActiveView || 'grid')); startAgentsBusyPoll() }
  if (pageId === 'memories') { loadMemAgents(); loadMemStats(); loadMemories() }
  if (pageId === 'skills') loadGlobalSkills()
  // Providers page (card f1e33cfb): Local model + FreeLLM + Gemini merged into one page with tabs;
  // all three load on entry (cheap, keeps every tab warm when switching), both polls stop on leave.
  if (pageId !== 'providers') stopLocalLlmPoll()
  if (pageId !== 'providers') stopFreellmPoll()
  if (pageId === 'providers') { loadLocalLlm(); loadFreellm(); loadGeminiCalls() }
  if (pageId === 'connectors') loadConnectors()
  if (pageId === 'migrate') loadMigrateAgents()
  if (pageId === 'docs') loadDocs()
  if (pageId === 'research') loadResearch()
  if (pageId === 'status') loadStatus()
  if (pageId === 'recall') loadRecallPage()
  if (pageId === 'bgTasks') loadBgTasksPage()
  if (pageId === 'vault') loadVaultPage()
  if (pageId === 'approvals') loadApprovalsPage()
  if (pageId === 'settings') loadSettings()
  if (pageId === 'updates') loadUpdates()
  if (pageId === 'repos') loadReposPage()
  // 'team' page is merged into 'agents' -- redirect for any lingering deep-links
  if (pageId === 'messages') loadMessagesPage()
  if (pageId === 'tokenUsage') loadTokenUsage()
  if (pageId === 'costs') loadCosts()
  if (pageId === 'llmMonitor') loadLlmMonitor()
  if (pageId === 'kg') loadKgPage()
  if (pageId === 'llmLedger') initLlmLedgerPage()
  if (pageId === 'ideas') loadIdeasPage()
  if (pageId === 'archived') loadArchivedPage()
  if (pageId === 'naplo') loadNaplo()
  if (pageId === 'federation') loadFederationPage()
  if (pageId === 'notes') loadNotesPage()
}

// Mobile off-canvas sidebar toggle. No-op visual effect on desktop (the
// hamburger/backdrop are display:none there); on narrow screens it slides the
// sidebar in over a backdrop.
const sidebarEl = document.querySelector('.sidebar')
const sidebarBackdrop = document.getElementById('sidebarBackdrop')
const mobileMenuBtn = document.getElementById('mobileMenuBtn')
function setSidebarOpen(open) {
  if (sidebarEl) sidebarEl.classList.toggle('open', open)
  if (sidebarBackdrop) sidebarBackdrop.classList.toggle('open', open)
  if (mobileMenuBtn) mobileMenuBtn.setAttribute('aria-expanded', open ? 'true' : 'false')
}
if (mobileMenuBtn) mobileMenuBtn.addEventListener('click', () => setSidebarOpen(!sidebarEl.classList.contains('open')))
if (sidebarBackdrop) sidebarBackdrop.addEventListener('click', () => setSidebarOpen(false))

navLinks.forEach((link) => {
  link.addEventListener('click', (e) => {
    e.preventDefault()
    const pageId = link.dataset.page
    // Same hash won't fire 'hashchange', so re-render manually; otherwise let the
    // hashchange listener drive switchPage so the URL stays the single source of truth.
    if (location.hash.slice(1) === pageId) switchPage(pageId)
    else location.hash = pageId
    setSidebarOpen(false) // close the drawer after navigating on mobile
  })
})

