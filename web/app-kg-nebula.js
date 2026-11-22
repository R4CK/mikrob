// Card dcb196f9 (MikroB, URGENT, Peti Telegram 14489/14492, 2026-11-22): "Megoldas-tar" live
// nebula graph -- agents + knowledge-graph nodes as one connected graph, with glowing search
// trails from an agent node to its hit nodes that cool down and fade over ~15s.
//
// Pair-BE: a1d57d99 (backend2) -- GET /api/kg/graph and GET /api/kg/activity. Both cards were
// `planned`/undispatched when this was built, so EVERY network call below degrades to the
// existing honest "not available yet" state (kgShowDisabledState, already proven on this same
// page for the other /api/kg/* endpoints) -- it never fabricates demo nodes/edges/trails for a
// real user (rule 13 of kodminosegi-alapelvek: UI always shows real DB-backed data). The mock
// data in this file is used ONLY by the unit tests and by the local fps-measurement harness
// (never reachable from loadKgNebula()/the real page).
//
// Proposed contract (posted as dcb196f9 comment + a1d57d99 cross-reference, since BE had not
// posted one yet at build time -- align or override in review):
//   GET /api/kg/graph?project=&limit=500
//     -> { nodes: [{ id, type, label, project }], edges: [{ source, target, type }] }
//   GET /api/kg/activity?since=<ms>
//     -> { events: [{ agent_id, ts, hit: [nodeId, ...] }], config: { fadeDurationMs } }
//   config.fadeDurationMs is read every poll and overrides the 15000 default (code-quality rule
//   14: the fade time is not a baked-in constant, it is always what the last config response
//   said, with 15000 as the only-until-BE-lands fallback).

const KG_NEBULA_DEFAULT_FADE_MS = 15000
const KG_NEBULA_POLL_MS = 4000

// Colour-blind-safe-ish categorical palette: golden-angle hue stepping (137.508 deg) starting
// from a fixed seed hue, fixed S/L tuned for legibility on the dark nebula background. Index i
// maps 1:1 to the CSS class `.kg-neb-c<i>` in style.css (canvas drawing uses the hex value
// directly -- CSS classes are only for the legend DOM, which must stay free of inline styles).
const KG_NEBULA_PALETTE_SIZE = 24
function kgNebulaPaletteColor(index) {
  const i = ((index % KG_NEBULA_PALETTE_SIZE) + KG_NEBULA_PALETTE_SIZE) % KG_NEBULA_PALETTE_SIZE
  const hue = Math.round((i * 137.508 + 18) % 360)
  return `hsl(${hue}, 72%, 62%)`
}

// Stable order for the agents we know about today (root CLAUDE.md "A flotta tobbi agense" +
// mikrob) -- sorted so the mapping does not depend on object/array iteration order anywhere.
// Any agent_id NOT in this list (a future agent) still gets a deterministic, distinct-looking
// slot via a simple string hash, it just is not guaranteed collision-free against this fixed set.
const KG_NEBULA_KNOWN_AGENTS = [
  'backend', 'backend2', 'backend3', 'cybered', 'cybersec', 'cybersec2', 'elemzo',
  'fron-ted', 'fron-teddy', 'fullstack', 'jogasz', 'marketing', 'mikrob', 'penzugy',
  'qa', 'qa2', 'teszter', 'videooo',
].sort()

function kgNebulaHashString(s) {
  let h = 0
  for (let i = 0; i < s.length; i++) { h = (h * 31 + s.charCodeAt(i)) | 0 }
  return Math.abs(h)
}

function kgNebulaAgentColorIndex(agentId) {
  const known = KG_NEBULA_KNOWN_AGENTS.indexOf(agentId)
  if (known !== -1) return known
  return kgNebulaHashString(String(agentId)) % KG_NEBULA_PALETTE_SIZE
}

function kgNebulaAgentColor(agentId) {
  return kgNebulaPaletteColor(kgNebulaAgentColorIndex(agentId))
}

// Builds the legend entries for every agent that has fired at least one event in the current
// trail buffer, plus (if requested) the full known roster -- callers decide which to show.
function kgNebulaBuildLegend(agentIds) {
  const seen = new Set()
  const out = []
  for (const id of agentIds) {
    if (seen.has(id)) continue
    seen.add(id)
    out.push({ agentId: id, color: kgNebulaAgentColor(id), paletteIndex: kgNebulaAgentColorIndex(id) % KG_NEBULA_PALETTE_SIZE })
  }
  return out
}

// --- Trail fade math (pure, no Date.now() inside -- callers pass `now` so fake-timer tests can
// drive it exactly) ---------------------------------------------------------------------------

function kgNebulaTrailAlpha(nowMs, startMs, fadeMs) {
  const fade = fadeMs > 0 ? fadeMs : KG_NEBULA_DEFAULT_FADE_MS
  const t = (nowMs - startMs) / fade
  if (t <= 0) return 1
  if (t >= 1) return 0
  return 1 - t
}

function kgNebulaHexToRgb(hex) {
  const m = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex)
  if (!m) return { r: 255, g: 255, b: 255 }
  return { r: parseInt(m[1], 16), g: parseInt(m[2], 16), b: parseInt(m[3], 16) }
}

// "Hot -> cool" colour: the trail is born white-hot and cools into the agent's own colour over
// the first third of its life, then holds that colour while alpha (computed separately) carries
// the rest of the fade to fully transparent.
function kgNebulaTrailRgba(baseColorCss, nowMs, startMs, fadeMs) {
  const alpha = kgNebulaTrailAlpha(nowMs, startMs, fadeMs)
  const coolT = Math.min(1, ((nowMs - startMs) / (fadeMs > 0 ? fadeMs : KG_NEBULA_DEFAULT_FADE_MS)) * 3)
  const base = baseColorCss.startsWith('#') ? kgNebulaHexToRgb(baseColorCss) : kgNebulaHslToRgb(baseColorCss)
  const r = Math.round(255 * (1 - coolT) + base.r * coolT)
  const g = Math.round(255 * (1 - coolT) + base.g * coolT)
  const b = Math.round(255 * (1 - coolT) + base.b * coolT)
  return `rgba(${r},${g},${b},${alpha.toFixed(3)})`
}

function kgNebulaHslToRgb(hslCss) {
  const m = /hsl\(\s*([\d.]+)\s*,\s*([\d.]+)%\s*,\s*([\d.]+)%\s*\)/.exec(hslCss)
  if (!m) return { r: 255, g: 255, b: 255 }
  const h = parseFloat(m[1]) / 360, s = parseFloat(m[2]) / 100, l = parseFloat(m[3]) / 100
  if (s === 0) { const v = Math.round(l * 255); return { r: v, g: v, b: v } }
  const hue2rgb = (p, q, tt) => {
    let x = tt
    if (x < 0) x += 1
    if (x > 1) x -= 1
    if (x < 1 / 6) return p + (q - p) * 6 * x
    if (x < 1 / 2) return q
    if (x < 2 / 3) return p + (q - p) * (2 / 3 - x) * 6
    return p
  }
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s
  const p = 2 * l - q
  return {
    r: Math.round(hue2rgb(p, q, h + 1 / 3) * 255),
    g: Math.round(hue2rgb(p, q, h) * 255),
    b: Math.round(hue2rgb(p, q, h - 1 / 3) * 255),
  }
}

// Drops events whose trail has fully faded; keeps the rest with their current alpha attached.
function kgNebulaActiveTrails(events, nowMs, fadeMs) {
  const out = []
  for (const ev of events) {
    const alpha = kgNebulaTrailAlpha(nowMs, ev.ts, fadeMs)
    if (alpha <= 0) continue
    out.push({ agentId: ev.agent_id, ts: ev.ts, hit: Array.isArray(ev.hit) ? ev.hit : [], alpha })
  }
  return out
}

// --- Deterministic static layout ---------------------------------------------------------------
// Golden-angle spiral seeded ONLY by stable input order (node array index + project bucket), no
// Math.random anywhere -- same nodes/edges in, same positions out, every time (testable).
// One-time settle (repulsion + spring), then frozen: the "736 nodes without freezing" requirement
// is about the BROWSER not locking up, which a per-frame O(n^2) simulation on 736 nodes would
// risk -- settling once and redrawing static positions every frame is what the fps budget needs.

function kgNebulaProjectBuckets(nodes) {
  const projects = [...new Set(nodes.map((n) => n.project || '_global'))].sort()
  const map = new Map()
  projects.forEach((p, i) => map.set(p, i))
  return map
}

function kgNebulaInitialPositions(nodes, width, height) {
  const buckets = kgNebulaProjectBuckets(nodes)
  const nBuckets = Math.max(1, buckets.size)
  const clusterR = Math.min(width, height) * 0.32
  const positions = new Map()
  const perBucketIndex = new Map()
  for (const node of nodes) {
    const bucket = buckets.get(node.project || '_global') || 0
    const idx = perBucketIndex.get(bucket) || 0
    perBucketIndex.set(bucket, idx + 1)
    const clusterAngle = (bucket / nBuckets) * Math.PI * 2
    const cx = Math.cos(clusterAngle) * clusterR
    const cy = Math.sin(clusterAngle) * clusterR
    const spiralAngle = idx * 2.399963229728653 // golden angle, radians
    const spiralR = Math.sqrt(idx + 1) * 9
    positions.set(node.id, {
      x: cx + Math.cos(spiralAngle) * spiralR,
      y: cy + Math.sin(spiralAngle) * spiralR,
      vx: 0, vy: 0,
    })
  }
  return positions
}

function kgNebulaSettleStep(nodes, edges, positions, w, h) {
  const arr = nodes.map((n) => positions.get(n.id))
  for (let i = 0; i < arr.length; i++) {
    for (let j = i + 1; j < arr.length; j++) {
      const dx = arr[j].x - arr[i].x
      const dy = arr[j].y - arr[i].y
      const dist = Math.sqrt(dx * dx + dy * dy) || 1
      if (dist > 220) continue // bounded repulsion radius keeps this near-linear in practice
      const force = 260 / (dist * dist)
      const fx = (dx / dist) * force, fy = (dy / dist) * force
      arr[i].vx -= fx; arr[i].vy -= fy
      arr[j].vx += fx; arr[j].vy += fy
    }
  }
  const byId = positions
  for (const e of edges) {
    const a = byId.get(e.source), b = byId.get(e.target)
    if (!a || !b) continue
    const dx = b.x - a.x, dy = b.y - a.y
    const dist = Math.sqrt(dx * dx + dy * dy) || 1
    const force = (dist - 36) * 0.02
    const fx = (dx / dist) * force, fy = (dy / dist) * force
    a.vx += fx; a.vy += fy
    b.vx -= fx; b.vy -= fy
  }
  for (const p of arr) {
    p.vx *= 0.82; p.vy *= 0.82
    p.x += p.vx; p.y += p.vy
    p.x = Math.max(-w / 2 + 10, Math.min(w / 2 - 10, p.x))
    p.y = Math.max(-h / 2 + 10, Math.min(h / 2 - 10, p.y))
  }
}

function kgNebulaLayout(nodes, edges, width, height, iterations) {
  const positions = kgNebulaInitialPositions(nodes, width, height)
  const iter = typeof iterations === 'number' ? iterations : 90
  for (let i = 0; i < iter; i++) kgNebulaSettleStep(nodes, edges, positions, width, height)
  return positions
}

// --- Page wiring (DOM/network -- not covered by the pure-function unit tests above) -----------

const kgNebulaState = {
  open: false,
  nodes: [], edges: [], positions: null, nodeIndex: new Map(),
  events: [], fadeDurationMs: KG_NEBULA_DEFAULT_FADE_MS, sinceMs: 0,
  pollTimer: null, rafId: null, reduced: false,
  lastProject: '',
}

function kgNebulaReducedMotion() {
  try { return !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches) } catch { return false }
}

function kgNebulaEl(id) { return document.getElementById(id) }

async function kgNebulaFetchGraph(project) {
  const params = new URLSearchParams()
  if (project) params.set('project', project)
  params.set('limit', '500')
  return kgFetch('/api/kg/graph?' + params.toString())
}

async function kgNebulaFetchActivity(sinceMs) {
  const params = new URLSearchParams()
  if (sinceMs) params.set('since', String(sinceMs))
  return kgFetch('/api/kg/activity?' + params.toString())
}

function kgNebulaShowMessage(key) {
  const wrap = kgNebulaEl('kgNebulaCanvasWrap')
  if (!wrap) return
  wrap.innerHTML = `<div class="kg-nebula-msg">${escapeHtml(t(key))}</div>`
}

function kgNebulaShowErrorWithRetry() {
  const wrap = kgNebulaEl('kgNebulaCanvasWrap')
  if (!wrap) return
  wrap.innerHTML = `<div class="kg-nebula-msg kg-nebula-msg-error">
    <p>${escapeHtml(t('kg.nebula.error'))}</p>
    <button type="button" class="btn-secondary btn-compact" id="kgNebulaRetryBtn">${escapeHtml(t('common.btn.retry'))}</button>
  </div>`
  const btn = kgNebulaEl('kgNebulaRetryBtn')
  if (btn) btn.addEventListener('click', () => { void kgNebulaLoad() })
}

function kgNebulaRestoreCanvas() {
  const wrap = kgNebulaEl('kgNebulaCanvasWrap')
  if (!wrap || kgNebulaEl('kgNebulaCanvas')) return
  wrap.innerHTML = '<canvas id="kgNebulaCanvas" class="kg-nebula-canvas"></canvas>'
}

async function kgNebulaLoad() {
  const project = kgNebulaEl('kgProjectSelect') ? kgNebulaEl('kgProjectSelect').value : ''
  kgNebulaState.lastProject = project && project !== '*' ? project : ''
  kgNebulaShowMessage('common.loading')

  let res
  try {
    res = await kgNebulaFetchGraph(kgNebulaState.lastProject)
  } catch {
    kgNebulaShowErrorWithRetry()
    return
  }
  if (res.status === 404) { kgNebulaShowMessage('kg.disabled'); return }
  if (!res.ok) { kgNebulaShowErrorWithRetry(); return }

  let data
  try { data = await res.json() } catch { kgNebulaShowErrorWithRetry(); return }
  const nodes = Array.isArray(data.nodes) ? data.nodes : []
  const edges = Array.isArray(data.edges) ? data.edges : []
  if (!nodes.length) { kgNebulaShowMessage('kg.nebula.empty'); return }

  kgNebulaRestoreCanvas()
  kgNebulaState.nodes = nodes
  kgNebulaState.edges = edges
  kgNebulaState.nodeIndex = new Map(nodes.map((n) => [n.id, n]))

  const canvas = kgNebulaEl('kgNebulaCanvas')
  const rect = canvas.parentElement.getBoundingClientRect()
  const w = Math.max(240, rect.width)
  const h = Math.max(240, Math.min(560, w * 0.6))
  kgNebulaState.positions = kgNebulaLayout(nodes, edges, w, h)

  kgNebulaRenderLegend()
  kgNebulaStartPolling()
  kgNebulaStartLoop()
}

function kgNebulaRenderLegend() {
  const legend = kgNebulaEl('kgNebulaLegend')
  if (!legend) return
  const activeAgents = [...new Set(kgNebulaState.events.map((e) => e.agent_id))]
  const entries = kgNebulaBuildLegend(activeAgents)
  legend.innerHTML = entries.map((e) => `
    <span class="kg-legend-item">
      <span class="kg-legend-dot kg-neb-c${e.paletteIndex}"></span>${escapeHtml(e.agentId)}
    </span>`).join('') || `<span class="kg-nebula-legend-empty">${escapeHtml(t('kg.nebula.legend_empty'))}</span>`
}

async function kgNebulaPollOnce() {
  let res
  try { res = await kgNebulaFetchActivity(kgNebulaState.sinceMs) } catch { return }
  if (!res.ok) return
  let data
  try { data = await res.json() } catch { return }
  const events = Array.isArray(data.events) ? data.events : []
  if (data.config && typeof data.config.fadeDurationMs === 'number' && data.config.fadeDurationMs > 0) {
    kgNebulaState.fadeDurationMs = data.config.fadeDurationMs
  }
  if (events.length) {
    kgNebulaState.events.push(...events)
    kgNebulaState.sinceMs = events.reduce((max, e) => Math.max(max, e.ts || 0), kgNebulaState.sinceMs)
    kgNebulaRenderLegend()
  }
  // Trim: no point holding events older than 2x the fade window.
  const cutoff = Date.now() - kgNebulaState.fadeDurationMs * 2
  kgNebulaState.events = kgNebulaState.events.filter((e) => e.ts >= cutoff)
}

function kgNebulaStartPolling() {
  if (kgNebulaState.pollTimer) return
  void kgNebulaPollOnce()
  kgNebulaState.pollTimer = setInterval(() => { void kgNebulaPollOnce() }, KG_NEBULA_POLL_MS)
}

function kgNebulaStopPolling() {
  if (kgNebulaState.pollTimer) { clearInterval(kgNebulaState.pollTimer); kgNebulaState.pollTimer = null }
}

function kgNebulaDrawFrame() {
  const canvas = kgNebulaEl('kgNebulaCanvas')
  if (!canvas || !kgNebulaState.positions) return
  const dpr = window.devicePixelRatio || 1
  const rect = canvas.parentElement.getBoundingClientRect()
  const w = Math.max(240, rect.width)
  const h = Math.max(240, Math.min(560, w * 0.6))
  if (canvas.width !== Math.round(w * dpr)) canvas.width = Math.round(w * dpr)
  if (canvas.height !== Math.round(h * dpr)) canvas.height = Math.round(h * dpr)
  const ctx = canvas.getContext('2d')
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
  ctx.fillStyle = '#05060a'
  ctx.fillRect(0, 0, w, h)
  ctx.save()
  ctx.translate(w / 2, h / 2)

  ctx.strokeStyle = 'rgba(140,150,180,0.12)'
  ctx.lineWidth = 1
  for (const e of kgNebulaState.edges) {
    const a = kgNebulaState.positions.get(e.source)
    const b = kgNebulaState.positions.get(e.target)
    if (!a || !b) continue
    ctx.beginPath()
    ctx.moveTo(a.x, a.y)
    ctx.lineTo(b.x, b.y)
    ctx.stroke()
  }

  ctx.globalCompositeOperation = 'lighter'
  for (const node of kgNebulaState.nodes) {
    const p = kgNebulaState.positions.get(node.id)
    if (!p) continue
    ctx.beginPath()
    ctx.fillStyle = 'rgba(180,195,230,0.55)'
    ctx.arc(p.x, p.y, 2.2, 0, Math.PI * 2)
    ctx.fill()
  }

  if (!kgNebulaState.reduced) {
    const now = Date.now()
    for (const ev of kgNebulaState.events) {
      const alpha = kgNebulaTrailAlpha(now, ev.ts, kgNebulaState.fadeDurationMs)
      if (alpha <= 0) continue
      const color = kgNebulaAgentColor(ev.agent_id)
      const rgba = kgNebulaTrailRgba(color, now, ev.ts, kgNebulaState.fadeDurationMs)
      for (const hitId of (ev.hit || [])) {
        const b = kgNebulaState.positions.get(hitId)
        if (!b) continue
        ctx.beginPath()
        ctx.strokeStyle = rgba
        ctx.lineWidth = 2
        ctx.moveTo(0, 0)
        ctx.lineTo(b.x, b.y)
        ctx.stroke()
        ctx.beginPath()
        ctx.fillStyle = rgba
        ctx.arc(b.x, b.y, 4, 0, Math.PI * 2)
        ctx.fill()
      }
    }
  }
  ctx.globalCompositeOperation = 'source-over'
  ctx.restore()

  if (!canvas.dataset.kgNebulaClickWired) {
    canvas.dataset.kgNebulaClickWired = '1'
    canvas.addEventListener('click', kgNebulaHandleClick)
  }
}

function kgNebulaHandleClick(ev) {
  const canvas = kgNebulaEl('kgNebulaCanvas')
  if (!canvas || !kgNebulaState.positions) return
  const r = canvas.getBoundingClientRect()
  const x = ev.clientX - r.left - r.width / 2
  const y = ev.clientY - r.top - r.height / 2
  let hit = null
  let best = 14
  for (const node of kgNebulaState.nodes) {
    const p = kgNebulaState.positions.get(node.id)
    if (!p) continue
    const d = Math.hypot(p.x - x, p.y - y)
    if (d < best) { best = d; hit = node }
  }
  if (hit) void kgSelectNode(hit.id)
}

function kgNebulaStartLoop() {
  kgNebulaState.reduced = kgNebulaReducedMotion()
  const note = kgNebulaEl('kgNebulaReducedNote')
  if (note) note.hidden = !kgNebulaState.reduced
  kgNebulaDrawFrame()
  if (kgNebulaState.reduced) return // static fallback: draw once, no rAF loop
  const tick = () => {
    kgNebulaDrawFrame()
    kgNebulaState.rafId = requestAnimationFrame(tick)
  }
  kgNebulaState.rafId = requestAnimationFrame(tick)
}

function kgNebulaStopLoop() {
  if (kgNebulaState.rafId) { cancelAnimationFrame(kgNebulaState.rafId); kgNebulaState.rafId = null }
}

function kgNebulaToggle() {
  const section = kgNebulaEl('kgNebulaSection')
  const btn = kgNebulaEl('kgNebulaToggleBtn')
  if (!section) return
  kgNebulaState.open = !kgNebulaState.open
  section.hidden = !kgNebulaState.open
  if (btn) btn.setAttribute('aria-expanded', String(kgNebulaState.open))
  if (kgNebulaState.open) {
    void kgNebulaLoad()
  } else {
    kgNebulaStopPolling()
    kgNebulaStopLoop()
  }
}

function kgNebulaWireToolbar() {
  const btn = kgNebulaEl('kgNebulaToggleBtn')
  if (btn && !btn.dataset.kgWired) {
    btn.dataset.kgWired = '1'
    btn.addEventListener('click', kgNebulaToggle)
  }
  const projectSelect = kgNebulaEl('kgProjectSelect')
  if (projectSelect && !projectSelect.dataset.kgNebulaWired) {
    projectSelect.dataset.kgNebulaWired = '1'
    projectSelect.addEventListener('change', () => { if (kgNebulaState.open) void kgNebulaLoad() })
  }
}

// Classic <script> top-level `function` decls attach to `window` for free in the real page; a
// dynamic import() in the test harness runs this as an ES module instead, where they stay
// module-scoped (same seam already documented/handled in app-llm-monitor.js) -- export the
// pure-function surface explicitly so src/__tests__/kg-nebula-module.test.ts can reach it.
window.kgNebulaTrailAlpha = kgNebulaTrailAlpha
window.kgNebulaTrailRgba = kgNebulaTrailRgba
window.kgNebulaAgentColor = kgNebulaAgentColor
window.kgNebulaAgentColorIndex = kgNebulaAgentColorIndex
window.kgNebulaBuildLegend = kgNebulaBuildLegend
window.kgNebulaActiveTrails = kgNebulaActiveTrails
window.kgNebulaLayout = kgNebulaLayout
window.kgNebulaWireToolbar = kgNebulaWireToolbar
window.kgNebulaToggle = kgNebulaToggle
