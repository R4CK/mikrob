// app-conversation.js -- first extracted module from app.js (card b33fc5f7).
//
// WHY THIS FILE EXISTS. app.js grew to 19 287 lines (as of 2026-08-16). Parallel
// FE work causes merge conflicts inside the single file, and there is nothing to
// unit-test below the full-source level. This file is the first slice of a
// progressive modularisation that keeps plain-<script>-tag loading (no bundler
// needed at this stage) and global scope so the fork-updates.js override pattern
// and all other cross-section globals keep working unchanged.
//
// LOADING ORDER. index.html loads app.js first, then this file. The conversation
// functions call openModal/closeModal/t/escapeHtml -- all globals defined in
// app.js -- which are resolved at call time (event-listener invocations), not at
// parse time, so the reverse load order is safe.
//
// SCOPE. This slice covers the "Agent conversation (readable transcript) modal"
// section that lived at lines 18200-18373 in the original app.js. The app.js
// call sites (openConversationModal at lines ~3446 and ~3517) are event-listener
// callbacks so they resolve the global at click time.

// === Agent conversation (readable transcript) modal ===
// Renders the agent's Claude Code transcript as a chat-style timeline: inbound
// Telegram messages, the agent's replies, and (optionally) its notes/actions.
// Solves what the raw terminal can't: a readable, searchable review of what
// actually happened -- also the support view for customer-hosted Marveens.
const CONVERSATION_PAGE_SIZE = 400
let conversationEntries = []
let conversationAgentName = null
let conversationHasOlder = false
let conversationLoadingOlder = false
// Session list (card 03d2ae9c): null = newest; string = specific sessionId
let conversationCurrentSessionId = null
let conversationSessions = []

async function openConversationModal(agentName, displayName) {
  const overlay = document.getElementById('conversationOverlay')
  const container = document.getElementById('conversationContainer')
  const title = document.getElementById('conversationModalTitle')
  if (!overlay || !container) return
  conversationAgentName = agentName
  conversationCurrentSessionId = null
  conversationSessions = []
  title.textContent = t('conversation.title', { name: displayName || agentName })
  container.innerHTML = `<div class="conversation-empty">${t('conversation.loading')}</div>`
  openModal(overlay)
  // Load session list first (non-blocking; falls back gracefully on 404)
  await loadConversationSessions(agentName)
  await loadConversation()
}

async function loadConversationSessions(agentName) {
  const row = document.getElementById('conversationSessionRow')
  const sel = document.getElementById('conversationSessionSelect')
  if (!row || !sel) return
  const token = localStorage.getItem('marveen-dashboard-token') || ''
  try {
    const r = await fetch(`/api/agents/${encodeURIComponent(agentName)}/sessions`, {
      headers: { 'Authorization': 'Bearer ' + token },
    })
    if (!r.ok) { row.hidden = true; return }
    const d = await r.json()
    const sessions = Array.isArray(d.sessions) ? d.sessions : []
    conversationSessions = sessions
    if (!sessions.length) { row.hidden = true; return }
    // Populate: newest first option (default), then each historical session
    const newestLabel = t('conversation.session_newest')
    sel.innerHTML = `<option value="">${newestLabel}</option>` +
      sessions.map((s) => {
        const date = s.mtime ? new Date(s.mtime).toLocaleString('hu-HU', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }) : s.sessionId
        const count = typeof s.entryCount === 'number' ? ` · ${t('conversation.session_entries', { count: s.entryCount })}` : ''
        return `<option value="${escapeHtml(s.sessionId)}">${escapeHtml(date)}${escapeHtml(count)}</option>`
      }).join('')
    row.hidden = false
  } catch {
    row.hidden = true
  }
}

// Latest page (offset=0); resets the loaded window.
// When conversationCurrentSessionId is set, fetches that specific session.
async function loadConversation() {
  const container = document.getElementById('conversationContainer')
  const token = localStorage.getItem('marveen-dashboard-token') || ''
  try {
    const sessionParam = conversationCurrentSessionId ? `&sessionId=${encodeURIComponent(conversationCurrentSessionId)}` : ''
    const r = await fetch(`/api/agents/${encodeURIComponent(conversationAgentName)}/conversation?limit=${CONVERSATION_PAGE_SIZE}&offset=0${sessionParam}`, {
      headers: { 'Authorization': 'Bearer ' + token },
    })
    const d = await r.json()
    conversationEntries = Array.isArray(d.entries) ? d.entries : []
    conversationHasOlder = !!d.hasOlder
    renderConversation()
  } catch {
    if (container) container.innerHTML = `<div class="conversation-empty">${t('conversation.error')}</div>`
  }
}

// Page further back: fetch the window of entries immediately before the oldest
// loaded one and PREPEND it, keeping the scroll position so the view does not
// jump. Lets the operator read history beyond the on-screen window (and beyond
// the old fixed cap).
async function loadOlderConversation() {
  if (conversationLoadingOlder || !conversationHasOlder) return
  conversationLoadingOlder = true
  const btn = document.getElementById('conversationLoadOlder')
  if (btn) { btn.disabled = true; btn.textContent = t('conversation.loading') }
  const token = localStorage.getItem('marveen-dashboard-token') || ''
  try {
    const offset = conversationEntries.length
    const sessionParam = conversationCurrentSessionId ? `&sessionId=${encodeURIComponent(conversationCurrentSessionId)}` : ''
    const r = await fetch(`/api/agents/${encodeURIComponent(conversationAgentName)}/conversation?limit=${CONVERSATION_PAGE_SIZE}&offset=${offset}${sessionParam}`, {
      headers: { 'Authorization': 'Bearer ' + token },
    })
    const d = await r.json()
    const older = Array.isArray(d.entries) ? d.entries : []
    conversationHasOlder = !!d.hasOlder
    if (older.length) {
      conversationEntries = older.concat(conversationEntries)
      renderConversation({ preserveScroll: true })
    } else {
      renderConversation()
    }
  } catch {
    if (btn) { btn.disabled = false; btn.textContent = t('conversation.load_more') }
  } finally {
    conversationLoadingOlder = false
  }
}

function fmtConvTs(ts) {
  if (!ts) return ''
  try {
    return new Date(ts).toLocaleString('hu-HU', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })
  } catch { return '' }
}

function renderConversation(opts = {}) {
  const container = document.getElementById('conversationContainer')
  if (!container) return
  const prevH = container.scrollHeight
  const prevTop = container.scrollTop
  const q = (document.getElementById('conversationSearch')?.value || '').toLowerCase().trim()
  const showActions = document.getElementById('conversationShowActions')?.checked
  let list = conversationEntries
  if (!showActions) list = list.filter(e => e.kind === 'in' || e.kind === 'out')
  if (q) list = list.filter(e => (e.text || '').toLowerCase().includes(q))
  // "Korábbiak betöltése" sits at the top so the operator can page further back;
  // shown whenever the server still has older entries beyond the loaded window.
  const olderBtn = conversationHasOlder
    ? `<button id="conversationLoadOlder" class="conv-load-older">${t('conversation.load_more')}</button>`
    : ''
  if (!list.length) {
    container.innerHTML = olderBtn || `<div class="conversation-empty">${t('conversation.empty')}</div>`
  } else {
    container.innerHTML = olderBtn + list.map(renderConvEntry).join('')
  }
  document.getElementById('conversationLoadOlder')?.addEventListener('click', loadOlderConversation)
  if (opts.preserveScroll) {
    // After prepending older messages, keep the previously-visible ones in place.
    container.scrollTop = prevTop + (container.scrollHeight - prevH)
  } else {
    container.scrollTop = container.scrollHeight
  }
}

function renderConvEntry(e) {
  const ts = fmtConvTs(e.ts)
  const txt = escapeHtml(e.text || '').replace(/\n/g, '<br>')
  if (e.kind === 'in') {
    return `<div class="conv-row conv-in"><div class="conv-bubble"><div class="conv-meta">Telegram be · ${ts}</div><div class="conv-text">${txt}</div></div></div>`
  }
  if (e.kind === 'out') {
    const lbl = escapeHtml(e.label || t('messages.conv.reply_label'))
    return `<div class="conv-row conv-out"><div class="conv-bubble"><div class="conv-meta">${lbl} · ${ts}</div><div class="conv-text">${txt}</div></div></div>`
  }
  if (e.kind === 'note') {
    return `<div class="conv-row conv-note"><div class="conv-note-text">📝 ${txt}</div></div>`
  }
  return `<div class="conv-row conv-action"><div class="conv-action-text">⚙ ${txt}<span class="conv-action-ts">${ts}</span></div></div>`
}

document.getElementById('conversationClose')?.addEventListener('click', () => {
  const overlay = document.getElementById('conversationOverlay')
  if (overlay) closeModal(overlay)
})
document.getElementById('conversationSearch')?.addEventListener('input', () => renderConversation())
document.getElementById('conversationShowActions')?.addEventListener('change', () => renderConversation())
document.getElementById('conversationRefresh')?.addEventListener('click', () => loadConversation())
document.getElementById('conversationSessionSelect')?.addEventListener('change', (e) => {
  conversationCurrentSessionId = e.target.value || null
  const container = document.getElementById('conversationContainer')
  if (container) container.innerHTML = `<div class="conversation-empty">${t('conversation.loading')}</div>`
  loadConversation()
})
