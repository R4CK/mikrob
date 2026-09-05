// app-llm-monitor.js -- "LLM monitor" page: KPI row + Swimlane Timeline (Tasks) + workload
// time-series, built on the task-event feed (card 87be1810, pair-BE a5bbfb98, phase aecd9a12).
//
// Design ref (source of truth): store/design-refs/local-llm-swimlane-mockup-2026-09-03.jpg.
//
// USER FLOW (user-flow-menu-design). Sidebar > Statisztikák > "LLM monitor" (#llmMonitor), a
// sibling of Költségek and Token Monitor -- the design is a monitoring SCREEN, not a card, so it
// gets a page; the Áttekintés keeps its compact per-MODEL swimlane (card d6ecb003) and links here.
//   1. Window select (1h / 6h / 24h / 7d, remembered per browser) + Frissítés   wired
//   2. KPI row: active models, tasks (+ failed), avg duration, requests, error rate  wired
//        <- GET /api/task-summary?from&to
//   3. Swimlane Timeline (Tasks): one lane per AGENT, blocks by real start/duration,
//      coloured by category; click / Enter -> detail panel (duration, agent, category,
//      status, start, card link)                                                   wired
//        <- GET /api/task-events?from&to&limit=2000
//   4. Workload time-series: tasks per bucket, one line per top category            wired
//        <- derived from the same events client-side
//   5. Models table: requests / tokens / agents per model in the window            wired
//        <- task-summary.models
//   NOT here, said out loud: per-model requests-per-minute for the ONLINE models (the
//   design's "Model A / Model B" curves). The summary carries per-model TOTALS only; a bucketed
//   per-model series needs a backend field (proposed to backend as
//   task-summary?buckets=N -> series[] ). Also: per-task tokens/throughput -- only local-LLM
//   tasks record start+end and the ledger that has tokens is keyed differently; the detail
//   panel says so instead of showing zeros (rule 12).
//
// The only DOM work at load is nothing: every listener is wired on the first loadLlmMonitor(),
// so the pure helpers below can be imported under a bare window shim in tests.

const LLM_MON_WINDOWS = [1, 6, 24, 168]
const LLM_MON_DEFAULT_HOURS = 6
const LLM_MON_BUCKETS = 24
const LLM_MON_MAX_EVENTS = 2000
const LLM_MON_TOP_SERIES = 4
// The canvas is this many viewports wide; the scroller opens on NOW (right edge) like the
// Overview swimlane, and the operator drags back in time.
const LLM_MON_ZOOM = 6
const LLM_MON_MIN_W_PCT = 2.0
const LLM_MON_GAP_PCT = 0.25
const LLM_MON_COMPACT_FROM_ROWS = 6
const LLM_MON_PALETTE = ['#4a9eff', '#34d399', '#a78bfa', '#f59e0b', '#f87171', '#22d3ee', '#fb7185', '#facc15']
const LLM_MON_OTHER_KEY = '(other)'

let llmMonWired = false
let llmMonCategoryColors = new Map()
let llmMonLastEvents = []
let llmMonDetailIdx = -1

// ── Pure helpers (exported on window, executed by the tests) ──────────────────

function llmMonColorFor(category) {
  const key = String(category || '')
  if (!llmMonCategoryColors.has(key)) {
    llmMonCategoryColors.set(key, LLM_MON_PALETTE[llmMonCategoryColors.size % LLM_MON_PALETTE.length])
  }
  return llmMonCategoryColors.get(key)
}

/** Lanes per agent, busiest first, name as a stable tiebreak. Returns a new structure. */
function llmMonLanesFromEvents(events) {
  const byAgent = new Map()
  for (const ev of events || []) {
    const agent = String(ev.agent || '?')
    if (!byAgent.has(agent)) byAgent.set(agent, [])
    byAgent.get(agent).push(ev)
  }
  return [...byAgent.entries()]
    .map(([agent, evs]) => ({ agent, events: evs }))
    .sort((a, b) => (b.events.length - a.events.length) || a.agent.localeCompare(b.agent))
}

/** Category order: by task count, so the legend and the series both lead with what matters. */
function llmMonTopCategories(events, limit) {
  const counts = new Map()
  for (const ev of events || []) {
    const c = String(ev.category || '')
    counts.set(c, (counts.get(c) || 0) + 1)
  }
  return [...counts.entries()]
    .sort((a, b) => (b[1] - a[1]) || a[0].localeCompare(b[0]))
    .slice(0, limit)
    .map(([c]) => c)
}

/**
 * Tasks per bucket, one series per top category plus "(other)". A task lands in the bucket of
 * its START; a start outside the window (the feed returns overlapping tasks) is clamped to the
 * edge bucket rather than dropped, so the totals agree with the swimlane.
 */
function llmMonBucketize(events, fromMs, toMs, n) {
  const count = Math.max(1, Number(n) || LLM_MON_BUCKETS)
  const span = Math.max(1, Number(toMs) - Number(fromMs))
  const bucketMs = span / count
  const top = llmMonTopCategories(events, LLM_MON_TOP_SERIES)
  const keys = top.concat(LLM_MON_OTHER_KEY)
  const series = keys.map((key) => ({ key, counts: new Array(count).fill(0) }))
  const total = new Array(count).fill(0)
  let otherUsed = false
  for (const ev of events || []) {
    const rel = (Number(ev.startMs) - Number(fromMs)) / span
    const i = Math.min(count - 1, Math.max(0, Math.floor(rel * count)))
    const c = String(ev.category || '')
    let s = series.find((x) => x.key === c)
    if (!s) { s = series[series.length - 1]; otherUsed = true }
    s.counts[i] += 1
    total[i] += 1
  }
  if (!otherUsed) series.pop()
  const starts = Array.from({ length: count }, (_, i) => Number(fromMs) + i * bucketMs)
  return { bucketMs, starts, series, total }
}

/** The five KPI tiles from the summary contract. null stays null -- never a fake zero. */
function llmMonKpis(summary) {
  const s = summary || {}
  const models = Array.isArray(s.models) ? s.models : []
  const requests = models.reduce((acc, m) => acc + (Number(m.requests) || 0), 0)
  const tasks = Number(s.taskCount) || 0
  const failed = Number(s.failedCount) || 0
  return [
    { key: 'active_models', value: Number(s.activeModels) || 0 },
    { key: 'tasks', value: tasks, failed },
    { key: 'avg_duration', value: s.avgDurationMs == null ? null : Number(s.avgDurationMs) },
    { key: 'total_requests', value: requests },
    { key: 'error_rate', value: tasks > 0 ? (failed / tasks) * 100 : null },
  ]
}

/** Catmull-Rom -> cubic bezier, the smooth curve of the design's workload chart. */
function llmMonSmoothPath(points) {
  const p = (points || []).filter((q) => Number.isFinite(q.x) && Number.isFinite(q.y))
  if (p.length === 0) return ''
  if (p.length === 1) return `M${p[0].x.toFixed(1)} ${p[0].y.toFixed(1)}`
  let d = `M${p[0].x.toFixed(1)} ${p[0].y.toFixed(1)}`
  for (let i = 0; i < p.length - 1; i++) {
    const p0 = p[i - 1] || p[i]
    const p1 = p[i]
    const p2 = p[i + 1]
    const p3 = p[i + 2] || p2
    const c1x = p1.x + (p2.x - p0.x) / 6
    const c1y = p1.y + (p2.y - p0.y) / 6
    const c2x = p2.x - (p3.x - p1.x) / 6
    const c2y = p2.y - (p3.y - p1.y) / 6
    d += ` C${c1x.toFixed(1)} ${c1y.toFixed(1)} ${c2x.toFixed(1)} ${c2y.toFixed(1)} ${p2.x.toFixed(1)} ${p2.y.toFixed(1)}`
  }
  return d
}

/** Greedy first-fit packing over RENDERED geometry (same reasoning as the Overview swimlane:
 *  blocks shorter than the min-width floor collide visually even when their intervals do not). */
function llmMonPackRows(blocks, gapPct) {
  const rowRightEdge = []
  const order = blocks.map((b, i) => ({ b, i })).sort((x, y) => (x.b.leftPct - y.b.leftPct) || (x.i - y.i))
  for (const { b } of order) {
    const right = b.leftPct + b.widthPct
    let row = rowRightEdge.findIndex((edge) => b.leftPct >= edge + gapPct)
    if (row === -1) {
      rowRightEdge.push(right)
      row = rowRightEdge.length - 1
    } else {
      rowRightEdge[row] = Math.max(rowRightEdge[row], right)
    }
    b.row = row
  }
  return rowRightEdge.length
}

function llmMonReadHours() {
  try {
    const v = Number(localStorage.getItem('marveen.llmMon.hours'))
    if (LLM_MON_WINDOWS.includes(v)) return v
  } catch { /* storage blocked */ }
  return LLM_MON_DEFAULT_HOURS
}

function llmMonStoreHours(h) {
  try { localStorage.setItem('marveen.llmMon.hours', String(h)) } catch { /* storage blocked */ }
}

// ── Formatting ───────────────────────────────────────────────────────────────

function llmMonLocale() {
  return window._lang === 'en' ? 'en-US' : 'hu-HU'
}

function llmMonFmtDuration(ms) {
  const n = Number(ms)
  if (!Number.isFinite(n)) return '—'
  if (n < 1000) return t('llmMon.dur.ms', { n: String(Math.round(n)) })
  if (n < 60_000) return t('llmMon.dur.sec', { n: (n / 1000).toFixed(1) })
  const min = Math.floor(n / 60_000)
  const sec = Math.round((n % 60_000) / 1000)
  return t('llmMon.dur.min', { m: String(min), s: String(sec).padStart(2, '0') })
}

function llmMonFmtTime(ms, withDate) {
  const d = new Date(Number(ms))
  const opts = withDate
    ? { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }
    : { hour: '2-digit', minute: '2-digit' }
  return d.toLocaleString(llmMonLocale(), opts)
}

function llmMonFmtInt(n) {
  return (Number(n) || 0).toLocaleString(llmMonLocale())
}

function llmMonWindowLabel(hours) {
  if (hours >= 168) return t('llmMon.window.7d')
  if (hours >= 24) return t('llmMon.window.24h')
  if (hours >= 6) return t('llmMon.window.6h')
  return t('llmMon.window.1h')
}

function llmMonBucketLabel(bucketMs) {
  const min = bucketMs / 60_000
  if (min >= 60) return t('llmMon.bucket.hour', { n: (min / 60).toFixed(min % 60 === 0 ? 0 : 1) })
  return t('llmMon.bucket.min', { n: min.toFixed(min % 1 === 0 ? 0 : 1) })
}

function llmMonStatusLabel(status) {
  return status === 'failed' ? t('llmMon.status.failed') : t('llmMon.status.done')
}

// ── Rendering ────────────────────────────────────────────────────────────────

function llmMonKpiHtml(summary) {
  const esc = escapeHtml
  return llmMonKpis(summary).map((k) => {
    let value
    let sub = ''
    if (k.key === 'avg_duration') value = k.value == null ? '—' : llmMonFmtDuration(k.value)
    else if (k.key === 'error_rate') value = k.value == null ? '—' : k.value.toFixed(1) + '%'
    else value = llmMonFmtInt(k.value)
    if (k.key === 'tasks' && k.failed > 0) sub = `<p class="llm-mon-kpi-sub">${esc(t('llmMon.kpi.failed_sub', { n: llmMonFmtInt(k.failed) }))}</p>`
    return `<div class="ovw-llmdist-kpi llm-mon-kpi" data-kpi="${esc(k.key)}">
      <p class="ovw-llmdist-kpi-label">${esc(t('llmMon.kpi.' + k.key))}</p>
      <p class="ovw-llmdist-kpi-value">${esc(value)}</p>${sub}
    </div>`
  }).join('')
}

function llmMonAxisHtml(rangeStartMs, rangeEndMs, ticks) {
  const span = Math.max(1, rangeEndMs - rangeStartMs)
  const n = Math.max(2, ticks)
  const withDate = span >= 24 * 3600_000
  const out = []
  for (let i = 0; i <= n; i++) {
    const at = rangeStartMs + (span * i) / n
    const leftPct = (i / n) * 100
    out.push(`<span style="left:${leftPct.toFixed(2)}%">${escapeHtml(llmMonFmtTime(at, withDate))}</span>`)
  }
  return `<div class="ovw-llmdist-axis-track">${out.join('')}</div>`
}

function llmMonLanesHtml(events, rangeStartMs, rangeEndMs) {
  const esc = escapeHtml
  const span = Math.max(1, rangeEndMs - rangeStartMs)
  const minW = LLM_MON_MIN_W_PCT / LLM_MON_ZOOM
  const gap = LLM_MON_GAP_PCT / LLM_MON_ZOOM
  return llmMonLanesFromEvents(events).map((lane) => {
    const blocks = lane.events.map((ev) => {
      const leftPct = Math.min(100, Math.max(0, ((Number(ev.startMs) - rangeStartMs) / span) * 100))
      const widthPct = Math.min(100 - leftPct, Math.max(minW, (Number(ev.durationMs) / span) * 100))
      return { ev, leftPct, widthPct, row: 0 }
    })
    const rowCount = llmMonPackRows(blocks, gap)
    const compact = rowCount > LLM_MON_COMPACT_FROM_ROWS
    const rowsHtml = Array.from({ length: Math.max(1, rowCount) }, (_, r) => {
      const inRow = blocks.filter((b) => b.row === r).map(({ ev, leftPct, widthPct }) => {
        const idx = events.indexOf(ev)
        const color = llmMonColorFor(ev.category)
        const label = `${ev.category || ''} · ${ev.agent || ''} · ${llmMonFmtDuration(ev.durationMs)} · ${llmMonStatusLabel(ev.status)}`
        return `<button type="button" class="ovw-llmdist-block llm-mon-block" data-idx="${idx}"
        data-status="${ev.status === 'failed' ? 'err' : 'ok'}" title="${esc(label)}" aria-label="${esc(label)}"
        style="left:${leftPct.toFixed(2)}%;width:${widthPct.toFixed(2)}%;background:${color}"
      >${esc(ev.category || '')}</button>`
      }).join('')
      return `<div class="ovw-llmdist-lane-track">${inRow}</div>`
    }).join('')
    return `<div class="ovw-llmdist-lane">
      <span class="ovw-llmdist-lane-label" title="${esc(lane.agent)}">${esc(lane.agent)}</span>
      <div class="ovw-llmdist-lane-rows${compact ? ' ovw-llmdist-lane-rows--compact' : ''}">${rowsHtml}</div>
    </div>`
  }).join('')
}

function llmMonLegendHtml(events) {
  const cats = llmMonTopCategories(events, LLM_MON_PALETTE.length)
  if (!cats.length) return ''
  const items = cats.map((c) => `<span class="ovw-llmdist-legend-item"><span class="ovw-llmdist-legend-swatch" style="background:${llmMonColorFor(c)}"></span>${escapeHtml(c)}</span>`).join('')
  return `<div class="ovw-llmdist-legend"><strong>${escapeHtml(t('llmMon.swimlane.legend_title'))}:</strong> ${items}</div>`
}

function llmMonSeriesHtml(events, rangeStartMs, rangeEndMs) {
  const esc = escapeHtml
  const b = llmMonBucketize(events, rangeStartMs, rangeEndMs, LLM_MON_BUCKETS)
  const W = 800
  const H = 220
  const padL = 40
  const padR = 12
  const padT = 12
  const padB = 28
  const maxY = Math.max(1, ...b.total)
  const yFor = (v) => padT + (H - padT - padB) * (1 - v / maxY)
  const xFor = (i) => padL + ((W - padL - padR) * (i + 0.5)) / b.starts.length
  const gridLines = [0, 0.25, 0.5, 0.75, 1].map((f) => {
    const y = yFor(maxY * f)
    return `<line x1="${padL}" x2="${W - padR}" y1="${y.toFixed(1)}" y2="${y.toFixed(1)}" class="llm-mon-grid"/>
      <text x="${padL - 6}" y="${(y + 3).toFixed(1)}" class="llm-mon-ytick" text-anchor="end">${Math.round(maxY * f)}</text>`
  }).join('')
  const xLabels = [0, 0.25, 0.5, 0.75, 1].map((f) => {
    const i = Math.min(b.starts.length - 1, Math.round((b.starts.length - 1) * f))
    const at = b.starts[i]
    return `<text x="${xFor(i).toFixed(1)}" y="${H - 8}" class="llm-mon-xtick" text-anchor="middle">${esc(llmMonFmtTime(at, rangeEndMs - rangeStartMs >= 24 * 3600_000))}</text>`
  }).join('')
  const paths = b.series.map((s) => {
    const color = s.key === LLM_MON_OTHER_KEY ? 'var(--text-muted)' : llmMonColorFor(s.key)
    const pts = s.counts.map((v, i) => ({ x: xFor(i), y: yFor(v) }))
    const d = llmMonSmoothPath(pts)
    const area = `${d} L${xFor(pts.length - 1).toFixed(1)} ${yFor(0).toFixed(1)} L${xFor(0).toFixed(1)} ${yFor(0).toFixed(1)} Z`
    return `<path d="${area}" fill="${color}" class="llm-mon-area"/><path d="${d}" stroke="${color}" class="llm-mon-line"/>`
  }).join('')
  const legend = b.series.map((s) => {
    const label = s.key === LLM_MON_OTHER_KEY ? t('llmMon.series.other') : s.key
    const color = s.key === LLM_MON_OTHER_KEY ? 'var(--text-muted)' : llmMonColorFor(s.key)
    return `<span class="ovw-llmdist-legend-item"><span class="ovw-llmdist-legend-swatch" style="background:${color}"></span>${esc(label)}</span>`
  }).join('')
  const desc = t('llmMon.series.y_label', { bucket: llmMonBucketLabel(b.bucketMs) })
  return `
    <div class="llm-mon-series-head"><span class="llm-mon-series-ylabel">${esc(desc)}</span><div class="ovw-llmdist-legend">${legend}</div></div>
    <svg class="llm-mon-series-svg" viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(t('llmMon.series.title'))}: ${esc(desc)}" preserveAspectRatio="none">
      ${gridLines}${paths}${xLabels}
    </svg>`
}

function llmMonModelsHtml(summary) {
  const esc = escapeHtml
  const models = Array.isArray(summary && summary.models) ? summary.models : []
  if (!models.length) return `<p class="ovw-llmdist-empty">${esc(t('llmMon.models.empty'))}</p>`
  const rows = models.map((m) => `<tr>
      <td><code>${esc(m.model || '?')}</code></td>
      <td class="llm-usage-num">${esc(llmMonFmtInt(m.requests))}</td>
      <td class="llm-usage-num">${esc(llmMonFmtInt(m.inputTokens))} / ${esc(llmMonFmtInt(m.outputTokens))}</td>
      <td class="llm-usage-num">${esc(llmMonFmtInt(m.agents))}</td>
    </tr>`).join('')
  return `<div class="llm-usage-table-wrap"><table class="llm-usage-table llm-mon-models-table">
      <thead><tr><th scope="col">${esc(t('llmMon.models.col.model'))}</th><th scope="col" class="llm-usage-num">${esc(t('llmMon.models.col.requests'))}</th><th scope="col" class="llm-usage-num">${esc(t('llmMon.models.col.tokens'))}</th><th scope="col" class="llm-usage-num">${esc(t('llmMon.models.col.agents'))}</th></tr></thead>
      <tbody>${rows}</tbody></table></div>`
}

function llmMonDetailHtml(ev) {
  const esc = escapeHtml
  const card = ev.cardId
    ? `<a href="#kanban" class="llm-mon-detail-card">${esc(ev.cardId)}</a>`
    : `<span class="llm-mon-muted">${esc(t('llmMon.detail.no_card'))}</span>`
  const rows = [
    [t('llmMon.detail.category'), esc(ev.category || '')],
    [t('llmMon.detail.agent'), esc(ev.agent || '')],
    [t('llmMon.detail.status'), `<span class="llm-mon-status llm-mon-status--${ev.status === 'failed' ? 'failed' : 'done'}">${esc(llmMonStatusLabel(ev.status))}</span>`],
    [t('llmMon.detail.duration'), esc(llmMonFmtDuration(ev.durationMs))],
    [t('llmMon.detail.started'), esc(llmMonFmtTime(ev.startMs, true))],
    [t('llmMon.detail.card'), card],
  ].map(([k, v]) => `<div class="llm-mon-detail-row"><span class="llm-mon-detail-key">${esc(k)}</span><span class="llm-mon-detail-val">${v}</span></div>`).join('')
  return `<div class="llm-mon-detail-head">
      <span class="llm-mon-detail-title">${esc(t('llmMon.detail.title'))} · #${esc(String(ev.id))}</span>
      <button type="button" class="llm-mon-detail-close" id="llmMonDetailClose" aria-label="${esc(t('llmMon.detail.close'))}">×</button>
    </div>
    ${rows}
    <p class="llm-mon-detail-note">${esc(t('llmMon.detail.tokens_note'))}</p>`
}

function llmMonOpenDetail(idx, anchorEl) {
  const ev = llmMonLastEvents[idx]
  const panel = document.getElementById('llmMonDetail')
  if (!ev || !panel) return
  llmMonDetailIdx = idx
  panel.innerHTML = llmMonDetailHtml(ev)
  panel.hidden = false
  // Anchor next to the block on wide screens; the CSS turns it into a bottom sheet on narrow ones.
  const r = anchorEl && anchorEl.getBoundingClientRect ? anchorEl.getBoundingClientRect() : null
  if (r && window.innerWidth > 720) {
    const pw = Math.min(320, window.innerWidth - 24)
    const left = Math.max(12, Math.min(window.innerWidth - pw - 12, r.left))
    const top = Math.max(12, Math.min(window.innerHeight - 260, r.bottom + 8))
    panel.style.left = `${left}px`
    panel.style.top = `${top}px`
  } else {
    panel.style.left = ''
    panel.style.top = ''
  }
  const close = document.getElementById('llmMonDetailClose')
  if (close) close.focus()
}

function llmMonCloseDetail() {
  const panel = document.getElementById('llmMonDetail')
  if (!panel || panel.hidden) return
  panel.hidden = true
  panel.innerHTML = ''
  const block = llmMonDetailIdx >= 0 ? document.querySelector(`.llm-mon-block[data-idx="${llmMonDetailIdx}"]`) : null
  llmMonDetailIdx = -1
  if (block) block.focus()
}

function llmMonSetStatus(text, cls) {
  const el = document.getElementById('llmMonStatus')
  if (!el) return
  el.textContent = text || ''
  el.className = 'llm-mon-status-line' + (cls ? ' ' + cls : '')
  el.hidden = !text
}

async function llmMonFetchJson(path) {
  const token = localStorage.getItem('marveen-dashboard-token') || ''
  const r = await fetch(path, { headers: { Authorization: 'Bearer ' + token } })
  if (!r.ok) {
    let msg = ''
    try { msg = (await r.json()).error || '' } catch { /* not json */ }
    const err = new Error(msg || ('HTTP ' + r.status))
    err.status = r.status
    throw err
  }
  return r.json()
}

function llmMonWire() {
  if (llmMonWired) return
  llmMonWired = true
  const sel = document.getElementById('llmMonWindow')
  if (sel) sel.addEventListener('change', () => { llmMonStoreHours(Number(sel.value)); void loadLlmMonitor() })
  const refresh = document.getElementById('llmMonRefreshBtn')
  if (refresh) refresh.addEventListener('click', () => { void loadLlmMonitor() })
  const page = document.getElementById('llmMonitorPage')
  if (page) {
    page.addEventListener('click', (e) => {
      const block = e.target.closest ? e.target.closest('.llm-mon-block') : null
      if (block) { llmMonOpenDetail(Number(block.dataset.idx), block); return }
      if (e.target.closest && e.target.closest('#llmMonDetailClose')) { llmMonCloseDetail(); return }
      if (e.target.closest && e.target.closest('#llmMonRetryBtn')) { void loadLlmMonitor(); return }
      const panel = document.getElementById('llmMonDetail')
      if (panel && !panel.hidden && !(e.target.closest && e.target.closest('#llmMonDetail'))) llmMonCloseDetail()
    })
    page.addEventListener('keydown', (e) => { if (e.key === 'Escape') llmMonCloseDetail() })
  }
}

async function loadLlmMonitor() {
  llmMonWire()
  const hours = llmMonReadHours()
  const sel = document.getElementById('llmMonWindow')
  if (sel && Number(sel.value) !== hours) sel.value = String(hours)
  const kpisEl = document.getElementById('llmMonKpis')
  const lanesEl = document.getElementById('llmMonLanes')
  const seriesEl = document.getElementById('llmMonSeries')
  const modelsEl = document.getElementById('llmMonModels')
  const metaEl = document.getElementById('llmMonMeta')
  if (!kpisEl || !lanesEl || !seriesEl || !modelsEl) return
  llmMonCloseDetail()
  llmMonSetStatus(t('common.loading'), 'llm-mon-status-line--loading')
  const toMs = Date.now()
  const fromMs = toMs - hours * 3600_000
  try {
    const [summary, feed] = await Promise.all([
      llmMonFetchJson(`/api/task-summary?from=${fromMs}&to=${toMs}`),
      llmMonFetchJson(`/api/task-events?from=${fromMs}&to=${toMs}&limit=${LLM_MON_MAX_EVENTS}`),
    ])
    const events = Array.isArray(feed.events) ? feed.events : []
    llmMonLastEvents = events
    llmMonCategoryColors = new Map()
    llmMonTopCategories(events, LLM_MON_PALETTE.length).forEach((c) => llmMonColorFor(c))
    if (metaEl) metaEl.textContent = t('llmMon.meta', { window: llmMonWindowLabel(hours), from: llmMonFmtTime(fromMs, hours >= 24), to: llmMonFmtTime(toMs, hours >= 24) })
    kpisEl.innerHTML = llmMonKpiHtml(summary)
    const notes = []
    const lanes = summary && summary.blockCoverage && Array.isArray(summary.blockCoverage.lanes) ? summary.blockCoverage.lanes : []
    if (lanes.length) notes.push(`<span title="${escapeHtml((summary.blockCoverage && summary.blockCoverage.note) || '')}">${escapeHtml(t('llmMon.coverage_note', { lanes: lanes.join(', ') }))}</span>`)
    if (feed.truncated) notes.push(`<span class="llm-mon-warn">${escapeHtml(t('llmMon.truncated_note', { n: String(LLM_MON_MAX_EVENTS) }))}</span>`)
    const notesEl = document.getElementById('llmMonNotes')
    if (notesEl) { notesEl.innerHTML = notes.join(' · '); notesEl.hidden = notes.length === 0 }
    if (!events.length) {
      lanesEl.innerHTML = `<p class="ovw-llmdist-empty">${escapeHtml(t('llmMon.empty', { window: llmMonWindowLabel(hours) }))}</p>`
      seriesEl.innerHTML = `<p class="ovw-llmdist-empty">${escapeHtml(t('llmMon.empty', { window: llmMonWindowLabel(hours) }))}</p>`
    } else {
      lanesEl.innerHTML = `
        <div class="ovw-llmdist-scroll" id="llmMonScroll" tabindex="0" role="group" aria-label="${escapeHtml(t('overview.llmDist.scroll_label'))}">
          <div class="ovw-llmdist-canvas" style="--llmdist-zoom:${LLM_MON_ZOOM}">
            <div class="ovw-llmdist-lanes">${llmMonLanesHtml(events, fromMs, toMs)}</div>
            <div class="ovw-llmdist-axis">${llmMonAxisHtml(fromMs, toMs, LLM_MON_ZOOM * 4)}</div>
          </div>
        </div>
        <p class="ovw-llmdist-scroll-hint">${escapeHtml(t('llmMon.swimlane.scroll_hint'))}</p>
        ${llmMonLegendHtml(events)}`
      seriesEl.innerHTML = llmMonSeriesHtml(events, fromMs, toMs)
      const scroller = document.getElementById('llmMonScroll')
      if (scroller) scroller.scrollLeft = scroller.scrollWidth
    }
    modelsEl.innerHTML = llmMonModelsHtml(summary)
    llmMonSetStatus('', '')
  } catch (err) {
    // Rule 12: the server's own 400 text names the parameter to fix; anything else gets the
    // localized message plus a retry, never a blank page or a raw stack.
    const detail = err && err.message && err.status === 400 ? err.message : ''
    llmMonSetStatus(`${t('llmMon.error')}${detail ? ' ' + detail : ''}`, 'llm-mon-status-line--error')
    kpisEl.innerHTML = ''
    lanesEl.innerHTML = `<button type="button" class="btn-secondary btn-compact" id="llmMonRetryBtn">${escapeHtml(t('llmMon.retry'))}</button>`
    seriesEl.innerHTML = ''
    modelsEl.innerHTML = ''
  }
}

window.llmMonLanesFromEvents = llmMonLanesFromEvents
window.llmMonTopCategories = llmMonTopCategories
window.llmMonBucketize = llmMonBucketize
window.llmMonKpis = llmMonKpis
window.llmMonSmoothPath = llmMonSmoothPath
window.llmMonPackRows = llmMonPackRows
window.loadLlmMonitor = loadLlmMonitor
