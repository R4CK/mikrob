// === Dashboard auth bootstrap: mainAgentId, activeSubagents, refreshSubagents ===
// app.js modularisation slice 43.
// Globals from app.js: (none -- no dependencies on other app.js globals)
// Exposed globally: mainAgentId(), activeSubagents (Set), refreshSubagents()
//
// mainAgentId() reads window._marveen (set asynchronously by /api/marveen, never at parse time).
// refreshSubagents() fetches /subagent-state.json (NOT an /api/* path -- no auth token needed).

// The main (channels) agent's real id. The backend /api/marveen route returns
// the configured MAIN_AGENT_ID (NOT the literal "marveen") in window._marveen;
// use this everywhere an agent id is sent to /api/agents/... or compared to a
// fleet name, so the dashboard works on non-"marveen" installs. Falls back to
// "marveen" only before /api/marveen has resolved (or on a legacy backend).
function mainAgentId() {
  return window._marveen?.agentId || 'marveen'
}

// Agents currently being run as SUBAGENTS inside MikroB's session (published to
// store/active-subagents.json, served at /subagent-state.json). Their cards get
// a blue running-ring instead of green, so it is clear the work runs in MikroB's
// session, not a separate one. Refreshed on a light interval.
let activeSubagents = new Set()
async function refreshSubagents() {
  try {
    const r = await fetch('/subagent-state.json', { cache: 'no-store' })
    if (r.ok) {
      const arr = await r.json()
      activeSubagents = new Set(Array.isArray(arr) ? arr.map(String) : [])
    }
  } catch { /* keep last known */ }
}

// init-time calls: moved here from app.js (slice 43).
// /subagent-state.json is not an /api/* path, so no auth token is required --
// the init call is safe even though app-auth-bootstrap.js loads before app-last-update.js
// triggers the first /api/status call.
refreshSubagents()
setInterval(refreshSubagents, 5000)
