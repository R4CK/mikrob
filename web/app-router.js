// app-router.js -- Hash-based page router (app.js modularisation slice 45).
// Globals from app-page-switch.js: switchPage()
// Globals from app-agents-team.js: _agentsActiveView
// Must load LAST in index.html -- DOMContentLoaded fires after all prior scripts,
// so switchPage() and _agentsActiveView are defined by the time routeFromHash runs.
;(() => {
  function routeFromHash() {
    let pageId = decodeURIComponent((location.hash || '').replace(/^#/, ''))
    if (!pageId) pageId = new URLSearchParams(window.location.search).get('page') || ''
    // 'team' page is merged into 'agents' (org-chart view toggle).
    if (pageId === 'team') { pageId = 'agents'; _agentsActiveView = 'tree' }
    if (pageId && document.getElementById(pageId + 'Page')) switchPage(pageId)
  }
  window.addEventListener('hashchange', routeFromHash)
  // Initial dispatch must wait until every later <script src="/app-*.js"> tag has
  // executed -- switchPage() calls functions (stopAgentsBusyPoll, loadOverview,
  // loadKanban, loadDocs, ...) that live in those files, which load AFTER app.js.
  // DOMContentLoaded fires once all synchronous scripts have run, so it is the
  // earliest safe point (live regression: stopAgentsBusyPoll not defined at
  // switchPage, 2026-08-16).
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', routeFromHash)
  } else {
    routeFromHash()
  }
})()
