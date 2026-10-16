// Card 8bb7cf54 (MT F5 / MT-11): "Megoldás-tár" dashboard page -- search, node detail with
// neighbors, project/global scope switch, graph view, stats, archiving.
//
// Contract-first (8b. szabály): the BE pair (34c2d2a2, MT-03/04) and the storage layer
// (ee9ee17b, MT-01/02) are both still `planned` at the time this was built -- every endpoint
// below is built against the FROZEN contract in card 3f6fc4ce comment 20763 (which overrides
// comment 20727's section 3) plus MikroB's decisions in comments 20758/20814. Until the BE
// lands, every call 404s; this page shows an honest "nincs meg még" state (rule 12), not a
// raw error, same spirit as the hide-on-404 widget pattern but for a whole page the user
// navigated to on purpose (it cannot just vanish).
//
// GET /api/kg/stats is NOT part of the frozen F0 contract (only search/nodes/for-card are) --
// its shape here is a FORWARD-COMPATIBLE proposal for the "Statisztika" screen (spec section
// 10), documented in the REVIEW for MikroB/backend to confirm or adjust. Every field is read
// defensively (never throws on a missing optional stat).

let kgSelectedNodeId = null
let kgGraphMode = false
let kgSearchDebounce = null

const KG_TYPES = ['solution', 'anti_pattern', 'decision', 'finding', 'lesson', 'card', 'commit', 'file', 'symbol', 'skill', 'error_class']

function kgEl(id) { return document.getElementById(id) }

function kgStatusBadgeClass(status) {
  if (status === 'active') return 'kg-badge kg-badge-active'
  if (status === 'draft') return 'kg-badge kg-badge-draft'
  if (status === 'stale') return 'kg-badge kg-badge-stale'
  if (status === 'superseded') return 'kg-badge kg-badge-superseded'
  if (status === 'archived') return 'kg-badge kg-badge-archived'
  return 'kg-badge'
}

function kgAnchorStateClass(state) {
  if (state === 'drifted') return 'kg-anchor-state kg-anchor-drifted'
  if (state === 'gone') return 'kg-anchor-state kg-anchor-gone'
  return 'kg-anchor-state kg-anchor-fresh'
}

function kgTypeLabel(type) {
  const key = 'kg.type.' + type
  const label = t(key)
  return label === key ? type : label
}

function kgRelLabel(rel) {
  const key = 'kg.rel.' + rel
  const label = t(key)
  return label === key ? rel : label
}

async function kgFetch(path) {
  const token = localStorage.getItem('marveen-dashboard-token') || ''
  const res = await fetch(path, { headers: { Authorization: 'Bearer ' + token } })
  return res
}

function kgShowDisabledState(container) {
  container.innerHTML = `<div class="kg-disabled">
    <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>
    <p>${escapeHtml(t('kg.disabled'))}</p>
  </div>`
}

async function loadKgPage() {
  const searchInput = kgEl('kgSearchInput')
  const projectSelect = kgEl('kgProjectSelect')
  const typeFilter = kgEl('kgTypeFilter')
  const strictToggle = kgEl('kgStrictToggle')
  if (!searchInput || !kgEl('kgResultsBody')) return

  if (!searchInput.dataset.kgWired) {
    searchInput.dataset.kgWired = '1'
    searchInput.addEventListener('input', () => {
      if (kgSearchDebounce) clearTimeout(kgSearchDebounce)
      kgSearchDebounce = setTimeout(() => { void kgRunSearch() }, 300)
    })
    projectSelect.addEventListener('change', () => { void kgRunSearch() })
    typeFilter.addEventListener('change', () => { void kgRunSearch() })
    strictToggle.addEventListener('change', () => { void kgRunSearch() })
    kgEl('kgTabDetail').addEventListener('click', () => kgSwitchTab('detail'))
    kgEl('kgTabGraph').addEventListener('click', () => kgSwitchTab('graph'))
    const depthBtn = kgEl('kgGraphDepthBtn')
    if (depthBtn) depthBtn.addEventListener('click', () => kgToggleGraphDepth())
  }

  void kgLoadStats()
}

function kgCurrentQuery() {
  const q = (kgEl('kgSearchInput').value || '').trim()
  const project = kgEl('kgProjectSelect').value || ''
  const types = Array.from(kgEl('kgTypeFilter').selectedOptions).map((o) => o.value)
  const strict = kgEl('kgStrictToggle').checked
  return { q, project, types, strict }
}

async function kgRunSearch() {
  const body = kgEl('kgResultsBody')
  const meta = kgEl('kgResultsMeta')
  const { q, project, types, strict } = kgCurrentQuery()

  if (!q && types.length === 0) {
    body.innerHTML = `<p class="kg-empty" data-i18n="kg.empty.type_to_search">${escapeHtml(t('kg.empty.type_to_search'))}</p>`
    meta.innerHTML = ''
    return
  }

  body.innerHTML = `<p class="kg-loading">${escapeHtml(t('common.loading'))}</p>`
  const params = new URLSearchParams()
  if (q) params.set('q', q)
  if (project) params.set('project', project)
  for (const ty of types) params.append('types', ty)
  if (strict) params.set('strict', '1')
  params.set('k', '8')

  let res
  try {
    res = await kgFetch('/api/kg/search?' + params.toString())
  } catch {
    body.innerHTML = `<p class="kg-error">${escapeHtml(t('kg.error.network'))}</p>`
    meta.innerHTML = ''
    return
  }
  if (res.status === 404) { kgShowDisabledState(body); meta.innerHTML = ''; return }
  if (!res.ok) {
    let errMsg = t('kg.error.generic')
    try {
      const d = await res.json()
      if (d && d.error) {
        const key = 'kg.error.' + d.error
        const resolved = t(key)
        if (resolved !== key) errMsg = resolved
      }
    } catch { /* non-JSON error body -- keep the generic message */ }
    body.innerHTML = `<p class="kg-error">${escapeHtml(errMsg)}</p>`
    meta.innerHTML = ''
    return
  }

  let data
  try { data = await res.json() } catch { body.innerHTML = `<p class="kg-error">${escapeHtml(t('kg.error.generic'))}</p>`; return }
  kgRenderResults(Array.isArray(data.results) ? data.results : [], data.meta || {})
}

function kgRenderResults(results, meta) {
  const body = kgEl('kgResultsBody')
  const metaEl = kgEl('kgResultsMeta')

  const metaBits = []
  if (meta.scope) metaBits.push(escapeHtml(t('kg.meta.scope', { scope: meta.scope })))
  if (typeof meta.hits === 'number') metaBits.push(escapeHtml(t('kg.meta.hits', { n: meta.hits })))
  if (meta.relaxed) metaBits.push(`<span class="kg-meta-relaxed">${escapeHtml(t('kg.meta.relaxed'))}</span>`)
  metaEl.innerHTML = metaBits.join(' · ')

  if (!results.length) {
    body.innerHTML = `<p class="kg-empty">${escapeHtml(t('kg.empty.no_results'))}</p>`
    return
  }

  body.innerHTML = results.map((r) => {
    const scorePct = typeof r.score === 'number' ? Math.round(Math.max(0, Math.min(1, r.score)) * 100) : null
    return `
      <button type="button" class="kg-result-item" data-kg-node-id="${escapeHtml(r.id)}">
        <div class="kg-result-head">
          <span class="${kgStatusBadgeClass(r.status)}">${escapeHtml(kgTypeLabel(r.type))}</span>
          <span class="kg-result-project">${escapeHtml(r.project || '')}</span>
          ${scorePct !== null ? `<span class="kg-result-score">${scorePct}%</span>` : ''}
        </div>
        <div class="kg-result-title">${escapeHtml(r.title || '')}</div>
        ${r.snippet ? `<div class="kg-result-snippet">${escapeHtml(r.snippet)}</div>` : ''}
        ${r.why ? `<div class="kg-result-why">${escapeHtml(t('kg.result.why', { why: r.why }))}</div>` : ''}
      </button>`
  }).join('')

  for (const btn of body.querySelectorAll('[data-kg-node-id]')) {
    btn.addEventListener('click', () => { void kgSelectNode(btn.getAttribute('data-kg-node-id')) })
  }
}

async function kgSelectNode(id) {
  kgSelectedNodeId = id
  const detailPanel = kgEl('kgDetailPanel')
  const placeholder = kgEl('kgDetailPlaceholder')
  const detailBody = kgEl('kgDetailBody')
  placeholder.hidden = true
  detailPanel.hidden = false
  kgSwitchTab('detail')
  detailBody.innerHTML = `<p class="kg-loading">${escapeHtml(t('common.loading'))}</p>`

  let res
  try {
    res = await kgFetch('/api/kg/nodes/' + encodeURIComponent(id) + '?depth=1')
  } catch {
    detailBody.innerHTML = `<p class="kg-error">${escapeHtml(t('kg.error.network'))}</p>`
    return
  }
  if (res.status === 404) { kgShowDisabledState(detailBody); return }
  if (!res.ok) { detailBody.innerHTML = `<p class="kg-error">${escapeHtml(t('kg.error.generic'))}</p>`; return }

  let data
  try { data = await res.json() } catch { detailBody.innerHTML = `<p class="kg-error">${escapeHtml(t('kg.error.generic'))}</p>`; return }
  kgRenderDetail(data.node, Array.isArray(data.neighbors) ? data.neighbors : [])
}

function kgRenderDetail(node, neighbors) {
  if (!node) { kgEl('kgDetailBody').innerHTML = `<p class="kg-error">${escapeHtml(t('kg.error.generic'))}</p>`; return }

  const anchors = Array.isArray(node.anchors) ? node.anchors : []
  const anchorsHtml = anchors.map((a) => `
    <div class="kg-anchor">
      <span class="${kgAnchorStateClass(a.state)}">${escapeHtml(t('kg.anchor.state.' + (a.state || 'fresh')))}</span>
      <span class="kg-anchor-path">${escapeHtml(a.repo || '')}/${escapeHtml(a.path || '')}${a.symbol ? '#' + escapeHtml(a.symbol) : ''}</span>
      ${typeof a.line_start === 'number' ? `<span class="kg-anchor-lines">L${a.line_start}${a.line_end ? '-' + a.line_end : ''}</span>` : ''}
    </div>`).join('') || `<p class="kg-detail-muted">${escapeHtml(t('kg.detail.no_anchors'))}</p>`

  const neighborsHtml = neighbors.map((n) => `
    <button type="button" class="kg-neighbor-item" data-kg-node-id="${escapeHtml(n.node.id)}">
      <span class="kg-neighbor-rel">${escapeHtml(kgRelLabel(n.edge.rel))}</span>
      <span class="${kgStatusBadgeClass(n.node.status)}">${escapeHtml(kgTypeLabel(n.node.type))}</span>
      <span class="kg-neighbor-title">${escapeHtml(n.node.title || n.node.id)}</span>
    </button>`).join('') || `<p class="kg-detail-muted">${escapeHtml(t('kg.detail.no_neighbors'))}</p>`

  const canArchive = node.status !== 'archived'
  const snippetBlock = node.snippet
    ? `<pre class="kg-snippet"><code>${escapeHtml(node.snippet)}</code></pre>`
    : ''

  kgEl('kgDetailBody').innerHTML = `
    <div class="kg-detail-head">
      <span class="${kgStatusBadgeClass(node.status)}">${escapeHtml(kgTypeLabel(node.type))}</span>
      <span class="kg-detail-project">${escapeHtml(node.project || '')}</span>
    </div>
    <h2 class="kg-detail-title">${escapeHtml(node.title || '')}</h2>
    ${node.body ? `<div class="kg-detail-body-text">${escapeHtml(node.body)}</div>` : ''}
    ${snippetBlock}
    <h3 class="kg-detail-subheading">${escapeHtml(t('kg.detail.anchors'))}</h3>
    <div class="kg-anchors-list">${anchorsHtml}</div>
    ${node.card_id ? `<p class="kg-detail-card-link"><a href="#" data-kg-jump-card="${escapeHtml(node.card_id)}">${escapeHtml(t('kg.detail.source_card', { id: node.card_id }))}</a></p>` : ''}
    <h3 class="kg-detail-subheading">${escapeHtml(t('kg.detail.neighbors'))}</h3>
    <div class="kg-neighbors-list">${neighborsHtml}</div>
    <div class="kg-detail-actions">
      <button type="button" class="btn-secondary btn-compact" id="kgArchiveBtn" ${canArchive ? '' : 'disabled'}>${escapeHtml(t('kg.detail.archive_btn'))}</button>
    </div>`

  for (const btn of kgEl('kgDetailBody').querySelectorAll('[data-kg-node-id]')) {
    btn.addEventListener('click', () => { void kgSelectNode(btn.getAttribute('data-kg-node-id')) })
  }
  const archiveBtn = kgEl('kgArchiveBtn')
  if (archiveBtn && canArchive) archiveBtn.addEventListener('click', () => { void kgArchiveNode(node.id) })

  kgState.centerNode = node
  kgState.neighbors = neighbors
  if (kgGraphMode) kgRenderGraphView()
}

async function kgArchiveNode(id) {
  if (!confirm(t('kg.detail.archive_confirm'))) return
  const token = localStorage.getItem('marveen-dashboard-token') || ''
  try {
    const res = await fetch('/api/kg/nodes/' + encodeURIComponent(id) + '/status', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token },
      body: JSON.stringify({ status: 'archived', reason: 'dashboard manual archive' }),
    })
    if (!res.ok) { alert(t('kg.error.generic')); return }
  } catch {
    alert(t('kg.error.network'))
    return
  }
  void kgSelectNode(id)
  void kgRunSearch()
}

async function kgLoadStats() {
  const statsEl = kgEl('kgStats')
  const banner = kgEl('kgOllamaBanner')
  if (!statsEl) return
  let res
  try {
    res = await kgFetch('/api/kg/stats')
  } catch {
    statsEl.innerHTML = ''
    return
  }
  if (res.status === 404) { statsEl.innerHTML = ''; return }
  if (!res.ok) { statsEl.innerHTML = ''; return }

  let data
  try { data = await res.json() } catch { return }

  if (data.ollama_available === false && banner) {
    banner.hidden = false
  } else if (banner) {
    banner.hidden = true
  }

  const counts = data.nodes && typeof data.nodes === 'object' ? data.nodes : {}
  const tiles = Object.keys(counts).map((type) => `
    <div class="kg-stat-tile">
      <div class="kg-stat-value">${escapeHtml(String(counts[type]))}</div>
      <div class="kg-stat-label">${escapeHtml(kgTypeLabel(type))}</div>
    </div>`).join('')

  const usage = data.usage && typeof data.usage === 'object' ? data.usage : null
  const usageTile = usage && typeof usage.rate === 'number'
    ? `<div class="kg-stat-tile kg-stat-tile-usage">
        <div class="kg-stat-value">${Math.round(usage.rate * 100)}%</div>
        <div class="kg-stat-label">${escapeHtml(t('kg.stats.usage_rate'))}</div>
      </div>`
    : ''

  const backfill = data.backfill && typeof data.backfill === 'object' ? data.backfill : null
  if (backfill && typeof backfill.pending === 'number' && backfill.pending > 0) {
    const body = kgEl('kgResultsBody')
    if (body && !kgSelectedNodeId && !(kgEl('kgSearchInput').value || '').trim()) {
      body.innerHTML = `<p class="kg-empty">${escapeHtml(t('kg.empty.backfill_running', { done: backfill.done ?? 0, total: backfill.total ?? 0 }))}</p>`
    }
  }

  statsEl.innerHTML = tiles || usageTile ? `<div class="kg-stat-tiles">${tiles}${usageTile}</div>` : ''
}

// ---- Graph view: a small, bounded canvas force layout (center node + 1-2 hop neighbors).
// Same repulsion+spring+center-gravity approach already proven for the Memory page's
// relation graph (app-memories.js graphRel*/simulateGraphStep) -- not a new dependency, the
// fleet already built and shipped this technique once.

const kgState = { centerNode: null, neighbors: [], nodes: [], edges: [], dragging: null, sim: null }

function kgSwitchTab(which) {
  const isGraph = which === 'graph'
  kgGraphMode = isGraph
  kgEl('kgTabDetail').classList.toggle('active', !isGraph)
  kgEl('kgTabGraph').classList.toggle('active', isGraph)
  kgEl('kgDetailBody').hidden = isGraph
  kgEl('kgGraphView').hidden = !isGraph
  if (isGraph) kgRenderGraphView()
}

function kgToggleGraphDepth() {
  const btn = kgEl('kgGraphDepthBtn')
  const depth = btn.getAttribute('data-depth') === '1' ? '2' : '1'
  btn.setAttribute('data-depth', depth)
  btn.textContent = t(depth === '1' ? 'kg.graph.depth_1' : 'kg.graph.depth_2')
  if (kgSelectedNodeId) {
    kgFetch('/api/kg/nodes/' + encodeURIComponent(kgSelectedNodeId) + '?depth=' + depth)
      .then((res) => (res.ok ? res.json() : null))
      .then((data) => {
        if (!data) return
        kgState.centerNode = data.node
        kgState.neighbors = Array.isArray(data.neighbors) ? data.neighbors : []
        kgRenderGraphView()
      })
      .catch(() => {})
  }
}

const KG_PROJECT_COLORS = { marveen: '#6a9bcc', mopsion: '#788c5d', _global: '#87867f' }
function kgProjectColor(project) {
  return KG_PROJECT_COLORS[project] || '#d97757'
}

function kgBuildGraphNodes() {
  const center = kgState.centerNode
  if (!center) return { nodes: [], edges: [] }
  const nodes = [{ id: center.id, title: center.title, project: center.project, status: center.status, isCenter: true, x: 0, y: 0, vx: 0, vy: 0 }]
  const edges = []
  for (const n of kgState.neighbors) {
    nodes.push({
      id: n.node.id, title: n.node.title, project: n.node.project, status: n.node.status, isCenter: false,
      x: (Math.random() - 0.5) * 100, y: (Math.random() - 0.5) * 100, vx: 0, vy: 0,
    })
    edges.push({ source: center.id, target: n.node.id, rel: n.edge.rel })
  }
  return { nodes, edges }
}

function kgSimulateStep(nodes, edges, w, h) {
  for (let i = 0; i < nodes.length; i++) {
    for (let j = i + 1; j < nodes.length; j++) {
      const dx = nodes[j].x - nodes[i].x
      const dy = nodes[j].y - nodes[i].y
      const dist = Math.sqrt(dx * dx + dy * dy) || 1
      const force = 600 / (dist * dist)
      const fx = (dx / dist) * force
      const fy = (dy / dist) * force
      nodes[i].vx -= fx; nodes[i].vy -= fy
      nodes[j].vx += fx; nodes[j].vy += fy
    }
  }
  for (const e of edges) {
    const a = nodes.find((n) => n.id === e.source)
    const b = nodes.find((n) => n.id === e.target)
    if (!a || !b) continue
    const dx = b.x - a.x, dy = b.y - a.y
    const dist = Math.sqrt(dx * dx + dy * dy) || 1
    const force = (dist - 90) * 0.01
    const fx = (dx / dist) * force, fy = (dy / dist) * force
    a.vx += fx; a.vy += fy
    b.vx -= fx; b.vy -= fy
  }
  for (const node of nodes) {
    if (node.isCenter) { node.x = 0; node.y = 0; node.vx = 0; node.vy = 0; continue }
    node.vx *= 0.85; node.vy *= 0.85
    node.x += node.vx; node.y += node.vy
    node.x = Math.max(-w / 2 + 20, Math.min(w / 2 - 20, node.x))
    node.y = Math.max(-h / 2 + 20, Math.min(h / 2 - 20, node.y))
  }
}

function kgRenderGraphView() {
  const canvas = kgEl('kgGraphCanvas')
  if (!canvas || !kgState.centerNode) return
  const { nodes, edges } = kgBuildGraphNodes()
  kgState.nodes = nodes
  kgState.edges = edges

  const rect = canvas.parentElement.getBoundingClientRect()
  const dpr = window.devicePixelRatio || 1
  canvas.width = Math.max(200, rect.width) * dpr
  canvas.height = 320 * dpr
  const ctx = canvas.getContext('2d')
  ctx.scale(dpr, dpr)
  const w = Math.max(200, rect.width)
  const h = 320

  for (let i = 0; i < 80; i++) kgSimulateStep(nodes, edges, w, h)

  ctx.clearRect(0, 0, w, h)
  ctx.save()
  ctx.translate(w / 2, h / 2)

  ctx.strokeStyle = 'rgba(128,128,128,0.4)'
  ctx.lineWidth = 1.5
  for (const e of edges) {
    const a = nodes.find((n) => n.id === e.source)
    const b = nodes.find((n) => n.id === e.target)
    if (!a || !b) continue
    ctx.beginPath()
    ctx.moveTo(a.x, a.y)
    ctx.lineTo(b.x, b.y)
    ctx.stroke()
  }

  for (const node of nodes) {
    ctx.beginPath()
    ctx.arc(node.x, node.y, node.isCenter ? 14 : 9, 0, Math.PI * 2)
    ctx.fillStyle = kgProjectColor(node.project)
    ctx.fill()
    if (node.isCenter) {
      ctx.strokeStyle = '#141413'
      ctx.lineWidth = 2
      ctx.stroke()
    }
    ctx.fillStyle = '#141413'
    ctx.font = '11px sans-serif'
    const label = (node.title || node.id).slice(0, 24)
    ctx.fillText(label, node.x + (node.isCenter ? 18 : 12), node.y + 4)
  }
  ctx.restore()

  if (!canvas.dataset.kgClickWired) {
    canvas.dataset.kgClickWired = '1'
    canvas.addEventListener('click', (ev) => {
      const r = canvas.getBoundingClientRect()
      const x = ev.clientX - r.left - r.width / 2
      const y = ev.clientY - r.top - r.height / 2
      const hit = kgState.nodes.find((n) => Math.hypot(n.x - x, n.y - y) < 16)
      if (hit && !hit.isCenter) void kgSelectNode(hit.id)
    })
  }

  const legend = kgEl('kgGraphLegend')
  if (legend) {
    const projects = [...new Set(nodes.map((n) => n.project).filter(Boolean))]
    legend.innerHTML = projects.map((p) => `<span class="kg-legend-item"><span class="kg-legend-dot" style="background:${kgProjectColor(p)}"></span>${escapeHtml(p)}</span>`).join('')
  }
}
