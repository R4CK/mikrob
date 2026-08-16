// app-terminal.js -- Agent reauth login flow + Agent terminal modal (xterm.js) (slice 18).
// Loaded AFTER app.js in index.html; globals used from app.js:
//   t, escapeHtml, showToast, openModal, closeModal, loadAgents
// xterm.js / addon-fit loaded from CDN before app.js in index.html.
// === Agent reauth login flow ===
async function handleAgentLogin(agentName, btn) {
  const phase = btn.dataset.phase || 'start'
  btn.disabled = true
  const origText = btn.textContent
  btn.textContent = phase === 'start' ? t('agents.auth.btn_starting') : t('agents.auth.btn_confirming')
  try {
    const res = await fetch(`/api/agents/${encodeURIComponent(agentName)}/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ phase }),
    })
    if (!res.ok) { const err = await res.json().catch(() => ({})); throw new Error(err.error || 'HTTP ' + res.status) }
    if (phase === 'start') {
      btn.dataset.phase = 'confirm'
      btn.textContent = t('agents.auth.btn_confirm')
      btn.disabled = false
      showToast(t('agents.auth.toast_started'))
    } else {
      btn.textContent = t('agents.auth.btn_logged_in')
      showToast(t('agents.auth.toast_success'))
      setTimeout(() => loadAgents(), 1500)
    }
  } catch (e) {
    showToast('Hiba: ' + (e.message || e))
    btn.textContent = origText
    btn.dataset.phase = 'start'
    btn.disabled = false
  }
}

// === Agent terminal modal (xterm.js) ===
let terminalInstance = null
let terminalSSE = null
let terminalFit = null
// Master input gate (mirrors the server-side terminal-input toggle). Keystrokes
// are dropped locally when OFF so we never spam the audit log with 403s; the
// server enforces the same gate independently (fail-closed). Owner flips it via
// the checkbox in the modal header (POST /api/terminal-input).
let terminalInputEnabled = false

function syncTerminalInputToggleUI() {
  const cb = document.getElementById('terminalInputToggle')
  const label = document.getElementById('terminalInputToggleLabel')
  if (cb) cb.checked = terminalInputEnabled
  if (label) {
    label.textContent = terminalInputEnabled ? 'Input on' : 'Input off'
    label.style.color = terminalInputEnabled ? '#8fbf6f' : '#b8b2a6'
  }
}

function openTerminalModal(agentName) {
  const overlay = document.getElementById('terminalOverlay')
  const container = document.getElementById('terminalContainer')
  const title = document.getElementById('terminalModalTitle')
  if (!overlay || !container) return

  title.textContent = agentName + ' - Terminal'

  // Read the current server-side gate so the modal reflects reality on open.
  fetch('/api/terminal-input')
    .then(r => r.ok ? r.json() : { enabled: false })
    .then(d => { terminalInputEnabled = d.enabled === true; syncTerminalInputToggleUI() })
    .catch(() => { terminalInputEnabled = false; syncTerminalInputToggleUI() })

  // Cleanup previous
  if (terminalSSE) { terminalSSE.close(); terminalSSE = null }
  if (terminalInstance) { terminalInstance.dispose(); terminalInstance = null }
  container.innerHTML = ''

  // Init xterm — fontSize 12 + wider modal fits ~140 chars of tmux output
  const term = new window.Terminal({
    theme: { background: '#1a1a1a', foreground: '#e8e4da' },
    fontFamily: 'JetBrains Mono, Menlo, monospace',
    fontSize: 12,
    cursorBlink: false,
    disableStdin: false,
    scrollback: 4000,
    convertEol: true,
    allowProposedApi: true,
  })
  const fitAddon = new window.FitAddon.FitAddon()
  term.loadAddon(fitAddon)
  term.open(container)
  fitAddon.fit()
  terminalInstance = term
  terminalFit = fitAddon

  openModal(overlay)
  setTimeout(() => term.focus(), 50)

  // SSE pane stream.
  // The pane snapshot now includes scrollback history (server uses
  // `capture-pane -S -2000`), so the user can scroll back. To keep scrolling
  // stable we (a) only repaint when the snapshot actually changed, and (b) only
  // repaint while the viewport is at the bottom — if the user has scrolled up we
  // freeze their view and resume painting when they return to the bottom (the
  // onScroll handler below). The repaint clears the scrollback (CSI 3 J) before
  // rewriting the full snapshot so frames don't accumulate duplicate history.
  let latestPane = null
  let paintedPane = null
  const isAtBottom = () => {
    const buf = term.buffer.active
    return buf.viewportY >= buf.baseY
  }
  const repaint = () => {
    if (latestPane === null || latestPane === paintedPane) return
    if (!isAtBottom()) return // user scrolled up — keep their view put
    paintedPane = latestPane
    term.write('\x1b[3J\x1b[2J\x1b[H' + latestPane)
  }
  // EventSource cannot set an Authorization header. In token mode we pass the
  // token via ?token=; in password-login (session-cookie) mode there is no
  // token, so we open a plain URL and the browser attaches the mv_session
  // cookie automatically -- the gate's cookie branch covers the SSE path.
  const token = localStorage.getItem('marveen-dashboard-token') || ''
  const streamBase = `/api/agents/${encodeURIComponent(agentName)}/pane/stream`
  const sse = new EventSource(token ? `${streamBase}?token=${encodeURIComponent(token)}` : streamBase)
  sse.onmessage = (e) => {
    try {
      const msg = JSON.parse(e.data)
      if (msg.pane !== undefined) {
        latestPane = msg.pane.replace(/\x1b]8;[^\x1b]*\x1b\\/g, '')
        repaint()
      }
    } catch {}
  }
  sse.onerror = () => term.write(`\r\n${t('terminal.stream_error')}\r\n`)
  terminalSSE = sse
  // When the user scrolls back down to the bottom, resume live repainting.
  term.onScroll(() => { if (isAtBottom()) repaint() })

  // Single onData handler — maps escape sequences to {special}, plain chars to {keys}
  // Using onData only (no onKey) avoids double-firing on arrow/Enter keys.
  // PageUp/PageDown are intentionally NOT forwarded: they scroll the xterm
  // scrollback locally (history viewing) instead of going to the agent.
  const ESC_TO_SPECIAL = {
    '\r': 'Enter', '\x1b': 'Escape',
    '\x1b[A': 'Up', '\x1b[B': 'Down', '\x1b[C': 'Right', '\x1b[D': 'Left',
    '\x7f': 'BSpace', '\t': 'Tab', '\x1b[Z': 'S-Tab',
    '\x03': 'C-c', '\x04': 'C-d', '\x15': 'C-u', '\x0c': 'C-l',
  }
  term.onData(data => {
    if (data === '\x1b[5~') { term.scrollPages(-1); return } // PageUp -> scroll history up
    if (data === '\x1b[6~') { term.scrollPages(1); return }  // PageDown -> scroll history down
    if (!terminalInputEnabled) {
      // Read-only mode: input gate is OFF. Drop the keystroke locally (server
      // would 403 it anyway) and nudge the user to the toggle.
      showToast('Terminal input is off. Enable it with the header toggle first.')
      return
    }
    const special = ESC_TO_SPECIAL[data]
    const body = special ? { special } : { keys: data }
    fetch(`/api/agents/${encodeURIComponent(agentName)}/keys`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }).catch(() => {})
  })

  // Resize fit on modal resize — observe the modal wrapper (not the xterm container
  // itself) to avoid a ResizeObserver->fit->resize->ResizeObserver infinite loop
  let fitTimer = null
  const ro = new ResizeObserver(() => {
    clearTimeout(fitTimer)
    fitTimer = setTimeout(() => { try { fitAddon.fit() } catch {} }, 50)
  })
  const modalEl = container.closest('.terminal-modal') || container.parentElement
  if (modalEl) ro.observe(modalEl)
}

document.getElementById('terminalClose')?.addEventListener('click', () => {
  const overlay = document.getElementById('terminalOverlay')
  if (overlay) closeModal(overlay)
  if (terminalSSE) { terminalSSE.close(); terminalSSE = null }
  if (terminalInstance) { terminalInstance.dispose(); terminalInstance = null }
})

// Owner flips the master terminal-input gate. Optimistically reflect the desired
// state, POST it, then reconcile with the server's authoritative response.
document.getElementById('terminalInputToggle')?.addEventListener('change', (e) => {
  const desired = e.target.checked === true
  fetch('/api/terminal-input', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ enabled: desired }),
  })
    .then(r => r.ok ? r.json() : Promise.reject(new Error('HTTP ' + r.status)))
    .then(d => {
      terminalInputEnabled = d.enabled === true
      syncTerminalInputToggleUI()
      showToast(terminalInputEnabled ? 'Terminal input enabled (audit-logged)' : 'Terminal input disabled')
    })
    .catch(() => {
      terminalInputEnabled = false
      syncTerminalInputToggleUI()
      showToast('Could not change terminal input state')
    })
})

