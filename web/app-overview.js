// app-overview.js -- Overview page + live local-LLM utilization spectrum (slice 16).
// Loaded AFTER app.js in index.html; globals used from app.js:
//   t, escapeHtml, showToast, switchPage
// Self-initializes at bottom: loadOverview() (replaces the call in app.js Init).
// === Overview page ===
function formatRelative(ts) {
  const diff = Math.max(0, Date.now() - ts)
  const min = Math.floor(diff / 60000)
  if (min < 1) return t('common.time.now_abbr')
  if (min < 60) return t('common.time.min_abbr', { n: min })
  const hr = Math.floor(min / 60)
  if (hr < 24) return t('common.time.hour_abbr', { h: hr })
  const day = Math.floor(hr / 24)
  return t('common.time.day_abbr', { n: day })
}

async function loadOverview() {
  try {
    const res = await fetch('/api/overview')
    if (!res.ok) throw new Error('HTTP ' + res.status)
    const d = await res.json()
    // Upstream-update banner (card 3c09ba6b / FÁZIS3): shown when our fork is behind the
    // upstream base. The action navigates to the existing Frissítések (updates) page.
    // Claude usage info widget (card a91c6039 redesign): load auto-sourced data.
    void loadWeeklyGauge()
    void loadWeeklyThresholds()
    void loadModelTierConfig()
    void loadLocalLlmInfo()
    void loadCostEstimatesWidget()
    void loadLlmDistWidget()
    startOvwSpectrum()
    const banner = document.getElementById('updateBanner')
    if (banner) {
      const u = d.upstreamUpdate
      if (u && u.ok && u.behind > 0) {
        document.getElementById('updateBannerText').textContent = t('overview.updateBanner.text', { n: u.behind })
        const action = document.getElementById('updateBannerAction')
        if (action) action.onclick = (e) => { e.preventDefault(); if (typeof switchPage === 'function') switchPage('updates') }
        banner.hidden = false
      } else {
        banner.hidden = true
      }
    }
    // Stats
    document.getElementById('statAgents').textContent = d.agents.running
    document.getElementById('statAgentsSub').textContent = t('overview.stat.agents_sub', { n: d.agents.total })
    document.getElementById('statTasks').textContent = d.tasksToday
    const taskDiff = d.tasksToday - d.tasksYesterday
    document.getElementById('statTasksSub').textContent = taskDiff === 0 ? t('overview.stat.same_as_yesterday') : (taskDiff > 0 ? '+' + taskDiff + ' ' + t('overview.stat.change', { n: '' }).trim() : taskDiff + ' ' + t('overview.stat.change', { n: '' }).trim())
    document.getElementById('statMemories').textContent = d.memories.count.toLocaleString('hu-HU').replace(/,/g, ' ')
    document.getElementById('statMemoriesSub').textContent = `${t('overview.stat.sub.memories')} · ${d.memories.categories} category`
    document.getElementById('statSkills').textContent = d.skills.count
    document.getElementById('statSkillsSub').textContent = d.skills.today > 0 ? t('overview.stat.skills_today', { n: d.skills.today }) : ''
    // Team: reuse the hierarchy graph renderer so the overview card shows
    // exactly what the Csapat page does (avatars + reports-to tree).
    try {
      const tg = await fetch('/api/team/graph')
      if (tg.ok) {
        const graph = await tg.json()
        renderTeamGraph(document.getElementById('overviewTeamGrid'), graph)
      }
    } catch {}
    // Activity
    const act = document.getElementById('overviewActivity')
    act.innerHTML = ''
    if (!d.activity || d.activity.length === 0) {
      act.innerHTML = '<div style="color:var(--text-muted);font-size:13px">' + t('overview.no_activity') + '</div>'
    } else {
      for (const a of d.activity) {
        const icon = a.icon === 'delegate'
          ? '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="5" y1="12" x2="19" y2="12"/><polyline points="12 5 19 12 12 19"/></svg>'
          : '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 3C7.5 3 4 6.5 4 11v4l-2 3h4v2a3 3 0 0 0 3 3h6a3 3 0 0 0 3-3v-2h4l-2-3v-4c0-4.5-3.5-8-8-8z"/></svg>'
        const item = document.createElement('div')
        item.className = 'overview-activity-item'
        item.innerHTML = `
          <div class="overview-activity-icon">${icon}</div>
          <div class="overview-activity-body">
            <div class="overview-activity-title">${escapeHtml(a.text)}</div>
            <div class="overview-activity-time">${formatRelative(a.at)}</div>
          </div>
        `
        act.appendChild(item)
      }
    }
  } catch (err) {
    document.getElementById('overviewActivity').innerHTML = '<div style="color:var(--text-muted);font-size:13px">' + t('overview.error', { msg: escapeHtml(String(err.message || err)) }) + '</div>'
  }
}

// ============================================================
// === Overview: live local-LLM utilization spectrum (card cf61fcac, Peti kep-minta) ===
// ============================================================
// Continuously-scrolling waveform (canvas, decorative + aria-hidden) showing GPU util% over the
// last few minutes, gradient dark-teal -> blue -> purple -> orange -> red left to right, with
// vertical dashed segment dividers -- matches the reference image Peti sent on Telegram. The
// canvas is never the only place the data lives: a parallel <dl> readout carries the same values
// as real, screen-reader-readable text (aria-live), since the pixels alone would not be.
//
// Data source: prefers GET /api/local-llm/utilization-history (backend2, card b6b1493d) once it
// ships -- richer, since it is populated server-side even before this page is opened. Until then
// (or if it 404s), falls back to a client-side rolling buffer sampled from the existing
// /api/local-llm/status + /api/local-llm/queue endpoints, so the widget is functional today and
// upgrades itself silently the moment the real endpoint lands (no restart needed).
const OVW_SPECTRUM_WINDOW_MS = 5 * 60 * 1000
const OVW_SPECTRUM_POLL_MS = 5000
const OVW_SPECTRUM_COLORS = ['#0d3b3e', '#2f6fed', '#8b5cf6', '#f0883e', '#e5484d']
let _ovwSpectrumSamples = [] // {ts, util, memUsed, memTotal, tasks}
let _ovwSpectrumPollTimer = null
let _ovwSpectrumRafId = null
let _ovwSpectrumUsesServerHistory = false

function stopOvwSpectrum() {
  if (_ovwSpectrumPollTimer) { clearInterval(_ovwSpectrumPollTimer); _ovwSpectrumPollTimer = null }
  if (_ovwSpectrumRafId) { cancelAnimationFrame(_ovwSpectrumRafId); _ovwSpectrumRafId = null }
}

function ovwSpectrumSetState(state) {
  const empty = document.getElementById('ovwSpectrumEmpty')
  const error = document.getElementById('ovwSpectrumError')
  if (!empty || !error) return
  empty.hidden = state !== 'collecting' && state !== 'no_gpu'
  error.hidden = state !== 'error'
  if (state === 'collecting') empty.textContent = t('overview.spectrum.collecting')
  if (state === 'no_gpu') empty.textContent = t('overview.spectrum.no_gpu')
  if (state === 'error') error.textContent = t('overview.spectrum.error')
}

function ovwSpectrumUpdateReadout(sample) {
  const gpuEl = document.getElementById('ovwSpectrumGpu')
  const vramEl = document.getElementById('ovwSpectrumVram')
  const tasksEl = document.getElementById('ovwSpectrumTasks')
  if (!sample) return
  if (gpuEl) gpuEl.textContent = typeof sample.util === 'number' ? `${Math.round(sample.util)}%` : '—'
  if (vramEl) {
    vramEl.textContent = (typeof sample.memUsed === 'number' && typeof sample.memTotal === 'number' && sample.memTotal > 0)
      ? `${llmFmtVram(sample.memUsed)} / ${llmFmtVram(sample.memTotal)}`
      : '—'
  }
  if (tasksEl) tasksEl.textContent = typeof sample.tasks === 'number' ? String(sample.tasks) : '—'
}

async function ovwSpectrumPoll() {
  try {
    const res = await fetch('/api/local-llm/utilization-history')
    if (res.ok) {
      const data = await res.json()
      if (data && Array.isArray(data.samples)) {
        _ovwSpectrumUsesServerHistory = true
        // util_pct/mem_* are null when the GPU could not be read that tick (never 0 -- see
        // local-llm-utilization-history.ts's own rule: a zero would draw a false "idle" flat line).
        // Preserve the null so the draw step can render it as a real gap, not a fabricated reading.
        _ovwSpectrumSamples = data.samples.map((s) => ({
          ts: Number(s.ts) || 0,
          util: typeof s.util_pct === 'number' ? s.util_pct : null,
          memUsed: typeof s.mem_used_mb === 'number' ? s.mem_used_mb : null,
          memTotal: typeof s.mem_total_mb === 'number' ? s.mem_total_mb : null,
          tasks: typeof s.active_tasks === 'number' ? s.active_tasks : null,
        }))
        ovwSpectrumUpdateReadout(_ovwSpectrumSamples[_ovwSpectrumSamples.length - 1])
        ovwSpectrumSetState(_ovwSpectrumSamples.length >= 2 ? 'data' : 'collecting')
        return
      }
    }
  } catch {}
  // Server endpoint already established as the source of truth but hiccuped this one tick --
  // keep the last-good frame rather than mixing in a differently-sampled client buffer.
  if (_ovwSpectrumUsesServerHistory) return
  try {
    const [statusRes, queueRes] = await Promise.all([
      fetch('/api/local-llm/status'),
      fetch('/api/local-llm/queue'),
    ])
    if (!statusRes.ok) throw new Error('HTTP ' + statusRes.status)
    const d = await statusRes.json()
    if (!d.gpu) { ovwSpectrumSetState('no_gpu'); return }
    let tasks = null
    if (queueRes.ok) {
      const q = await queueRes.json()
      if (typeof q.running === 'number') tasks = q.running
    }
    // Same null-preserving rule as the server branch above (Cybered LOW, card bddd07e4): a
    // coerced 0 here would draw the same false "idle" flat line the server side deliberately
    // avoids -- this fallback path only runs when the server history hasn't answered yet, which
    // is exactly when nobody else is watching for a wrong reading.
    const sample = {
      ts: Date.now(),
      util: typeof d.gpu.util_pct === 'number' ? d.gpu.util_pct : null,
      memUsed: typeof d.gpu.mem_used_mb === 'number' ? d.gpu.mem_used_mb : null,
      memTotal: typeof d.gpu.mem_total_mb === 'number' ? d.gpu.mem_total_mb : null,
      tasks,
    }
    _ovwSpectrumSamples.push(sample)
    const cutoff = Date.now() - OVW_SPECTRUM_WINDOW_MS
    _ovwSpectrumSamples = _ovwSpectrumSamples.filter((s) => s.ts >= cutoff)
    ovwSpectrumUpdateReadout(sample)
    ovwSpectrumSetState(_ovwSpectrumSamples.length >= 2 ? 'data' : 'collecting')
  } catch {
    ovwSpectrumSetState('error')
  }
}

function ovwSpectrumDraw() {
  const page = document.getElementById('overviewPage')
  if (!page || page.hidden) { _ovwSpectrumRafId = null; return }
  const canvas = document.getElementById('ovwSpectrumCanvas')
  if (canvas) {
    const dpr = window.devicePixelRatio || 1
    const rect = canvas.getBoundingClientRect()
    const w = Math.max(1, Math.round(rect.width))
    const h = Math.max(1, Math.round(rect.height)) || 120
    if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) {
      canvas.width = Math.round(w * dpr)
      canvas.height = Math.round(h * dpr)
    }
    const ctx = canvas.getContext('2d')
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    ctx.clearRect(0, 0, w, h)

    if (_ovwSpectrumSamples.length >= 2) {
      const now = Date.now()
      const gradient = ctx.createLinearGradient(0, 0, w, 0)
      gradient.addColorStop(0, OVW_SPECTRUM_COLORS[0])
      gradient.addColorStop(0.25, OVW_SPECTRUM_COLORS[1])
      gradient.addColorStop(0.5, OVW_SPECTRUM_COLORS[2])
      gradient.addColorStop(0.75, OVW_SPECTRUM_COLORS[3])
      gradient.addColorStop(1, OVW_SPECTRUM_COLORS[4])

      ctx.strokeStyle = 'rgba(128,128,128,0.25)'
      ctx.lineWidth = 1
      ctx.setLineDash([3, 4])
      const segments = Math.max(4, Math.round(w / 60))
      for (let i = 1; i < segments; i++) {
        const x = (w / segments) * i
        ctx.beginPath()
        ctx.moveTo(x, 0)
        ctx.lineTo(x, h)
        ctx.stroke()
      }
      ctx.setLineDash([])

      // x = how long ago each sample was (scrolls left in real time between polls), y = util%.
      // A null util (GPU unreadable that tick) is NEVER drawn at 0 -- that would read as "idle",
      // a claim we did not measure (same rule the sampler itself states). It breaks the line into
      // a real gap instead, by splitting into contiguous non-null runs and drawing each separately.
      const raw = _ovwSpectrumSamples.map((s) => {
        const age = now - s.ts
        const x = w - (age / OVW_SPECTRUM_WINDOW_MS) * w
        if (typeof s.util !== 'number' || x < -20 || x > w + 20) return null
        const y = h - (Math.max(0, Math.min(100, s.util)) / 100) * (h - 8) - 4
        return [x, y]
      })
      const runs = []
      let cur = []
      for (const p of raw) {
        if (p === null) { if (cur.length) runs.push(cur); cur = [] }
        else cur.push(p)
      }
      if (cur.length) runs.push(cur)

      for (const points of runs) {
        if (points.length < 2) continue
        ctx.beginPath()
        ctx.moveTo(points[0][0], h)
        ctx.lineTo(points[0][0], points[0][1])
        for (let i = 1; i < points.length; i++) {
          const [px, py] = points[i - 1]
          const [cx, cy] = points[i]
          ctx.quadraticCurveTo(px, py, (px + cx) / 2, (py + cy) / 2)
        }
        ctx.lineTo(points[points.length - 1][0], points[points.length - 1][1])
        ctx.lineTo(points[points.length - 1][0], h)
        ctx.closePath()
        ctx.globalAlpha = 0.28
        ctx.fillStyle = gradient
        ctx.fill()
        ctx.globalAlpha = 1

        ctx.beginPath()
        ctx.moveTo(points[0][0], points[0][1])
        for (let i = 1; i < points.length; i++) {
          const [px, py] = points[i - 1]
          const [cx, cy] = points[i]
          ctx.quadraticCurveTo(px, py, (px + cx) / 2, (py + cy) / 2)
        }
        ctx.strokeStyle = gradient
        ctx.lineWidth = 2
        ctx.lineJoin = 'round'
        ctx.stroke()
      }
    }
  }

  const reduceMotion = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches
  _ovwSpectrumRafId = reduceMotion ? null : requestAnimationFrame(ovwSpectrumDraw)
}

// Last-generation stats readout (card b21deb9a): prompt/output tokens, tokens/s and VRAM for the
// most recent COMPLETED real local-LLM call, from GET /api/local-llm/last-generation. Polled
// alongside the waveform (same interval) rather than folded into ovwSpectrumPoll() itself -- it is
// a different data source (the usage ledger + a live /api/ps lookup, not the rolling sampler) with
// its own independent "nothing yet" state, and keeping it separate avoids one endpoint's outage
// blanking the other's already-good reading.
async function ovwSpectrumPollLastGen() {
  const el = document.getElementById('ovwSpectrumLastGen')
  if (!el) return
  try {
    const res = await fetch('/api/local-llm/last-generation')
    if (!res.ok) throw new Error('HTTP ' + res.status)
    const d = await res.json()
    if (d.promptTokens == null || d.outputTokens == null) { el.textContent = '—'; return }
    const speed = typeof d.tokensPerSec === 'number' ? `${d.tokensPerSec.toFixed(2)} tok/s` : '—'
    const vram = typeof d.vramBytes === 'number' ? llmFmtVram(d.vramBytes / (1024 * 1024)) : null
    el.textContent = `${d.promptTokens}→${d.outputTokens} tok · ${speed}` + (vram ? ` · ${vram}` : '')
  } catch {
    el.textContent = '—'
  }
}

function startOvwSpectrum() {
  stopOvwSpectrum()
  // Only show the "collecting" empty state when there are no cached samples from a prior
  // visit -- if samples exist the canvas already has data and showing the overlay causes
  // a visible flash while the first poll round-trip completes.
  if (_ovwSpectrumSamples.length < 2) ovwSpectrumSetState('collecting')
  ovwSpectrumPoll()
  void ovwSpectrumPollLastGen()
  _ovwSpectrumPollTimer = setInterval(() => {
    if (document.getElementById('overviewPage').hidden) { stopOvwSpectrum(); return }
    ovwSpectrumPoll()
    void ovwSpectrumPollLastGen()
    // Reduced-motion: no rAF loop running, so redraw once per poll tick instead.
    if (window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches) ovwSpectrumDraw()
  }, OVW_SPECTRUM_POLL_MS)
  ovwSpectrumDraw()
}

// Editable weekly new-dev-stop thresholds (card f3248478). Cached module-level so
// barColor() (weekly row only) reflects whatever the sliders currently hold, not the
// CLAUDE.md defaults, once loaded.
let _weeklyThresholds = { gt3days: 90, lt2days: 92, lt1day: 95 }

// Claude Usage Info widget (card a91c6039 redesign). Read-only: renders 3 usage bars
// (weekly-all / session / fable) + optional promo from /api/costs/weekly. No manual input.
// Threshold colors (weekly row): < gt3days = success, gt3days..lt1day = accent, >= lt1day = danger.
// Session/fable rows are plain 5h-session metrics, unrelated to the weekly-threshold config -- kept
// at the original fixed 90/95 breakpoints.
async function loadWeeklyGauge() {
  const card = document.getElementById('quotaGaugeCard')
  if (!card) return
  const emptyEl = document.getElementById('quotaGaugeEmpty')
  const errEl = document.getElementById('usageInfoError')
  const sourceEl = document.getElementById('usageInfoSource')

  function barColor(pct) {
    return pct >= 95 ? 'var(--danger)' : pct >= 90 ? 'var(--accent)' : 'var(--success)'
  }

  function barColorWeekly(pct) {
    const { gt3days, lt1day } = _weeklyThresholds
    return pct >= lt1day ? 'var(--danger)' : pct >= gt3days ? 'var(--accent)' : 'var(--success)'
  }

  function renderBar(rowId, fillId, pctId, resetId, metric, colorFn) {
    const row = document.getElementById(rowId)
    if (!row) return
    if (!metric || typeof metric.pct !== 'number') { row.hidden = true; return }
    const pct = Math.max(0, Math.min(100, metric.pct))
    const fill = document.getElementById(fillId)
    const pctEl = document.getElementById(pctId)
    const resetEl = document.getElementById(resetId)
    if (fill) { fill.style.width = pct + '%'; fill.style.background = (colorFn || barColor)(pct) }
    if (pctEl) pctEl.textContent = pct + '%'
    if (resetEl) resetEl.textContent = metric.resetAt ? t('overview.quota.resets', { at: metric.resetAt }) : ''
    row.hidden = false
  }

  try {
    const res = await fetch('/api/costs/weekly')
    if (!res.ok) throw new Error('HTTP ' + res.status)
    const d = await res.json()
    if (emptyEl) emptyEl.hidden = true
    if (errEl) errEl.hidden = true

    if (d.available && typeof d.pct === 'number') {
      // Weekly All-models row (always shown when data is present)
      renderBar('usageRowWeekly', 'usageBarFillWeekly', 'usageBarPctWeekly', 'usageResetWeekly',
        { pct: d.pct, resetAt: d.resetAt }, barColorWeekly)

      // Session row (shown when snapshot includes session metric)
      renderBar('usageRowSession', 'usageBarFillSession', 'usageBarPctSession', 'usageResetSession', d.session)

      // Fable row (shown when snapshot includes fable metric)
      renderBar('usageRowFable', 'usageBarFillFable', 'usageBarPctFable', 'usageResetFable', d.fable)

      // Promo badge
      const promoEl = document.getElementById('usageInfoPromo')
      if (promoEl) { promoEl.textContent = d.promo || ''; promoEl.hidden = !d.promo }

      // Source badge (panel / oauth / manual)
      if (sourceEl && d.source) {
        const labels = { panel: t('overview.quota.source.panel'), oauth: t('overview.quota.source.oauth'), manual: t('overview.quota.source.manual') }
        sourceEl.textContent = labels[d.source] || d.source
        sourceEl.hidden = false
      }
    } else {
      // No snapshot recorded yet
      const weeklyRow = document.getElementById('usageRowWeekly')
      if (weeklyRow) weeklyRow.hidden = true
      if (emptyEl) emptyEl.hidden = false
      if (sourceEl) sourceEl.hidden = true
    }
  } catch (err) {
    if (errEl) { errEl.textContent = t('overview.quota.error'); errEl.hidden = false }
    if (emptyEl) emptyEl.hidden = true
    if (sourceEl) sourceEl.hidden = true
  }
}

// Card 52de847d (Cybersec): 100% is a valid slider value but means "never stop" -- it
// silently disables the weekly-limit protection. Make that visually distinct from 99%
// so an operator can't mistake it for an ordinary high setting.
function updateThresholdWarn(id, value) {
  const warn = document.getElementById(id + 'Warn')
  const val = document.getElementById(id + 'Val')
  const isMax = Number(value) >= 100
  if (warn) warn.hidden = !isMax
  if (val) val.classList.toggle('usage-threshold-val--warn', isMax)
}

// GET the editable weekly-threshold config and populate the 2-slider UI (cards e7a26045,
// 4da9ae0b). Fetched every time the gauge loads, so the sliders never show a stale value
// after another session/tab edits them.
async function loadWeeklyThresholds() {
  try {
    const res = await fetch('/api/costs/weekly-thresholds')
    if (!res.ok) throw new Error('HTTP ' + res.status)
    const cfg = await res.json()
    const map = { thrNewDevStop: cfg.newDevStop, thrTestStop: cfg.testStop }
    for (const [id, val] of Object.entries(map)) {
      const input = document.getElementById(id)
      const label = document.getElementById(id + 'Val')
      if (input) input.value = val
      if (label) label.textContent = val + '%'
      updateThresholdWarn(id, val)
    }
    // The sliders start disabled (HTML) so a save can never fire against the browser's raw
    // default range position before this fetch resolves -- only enable once real config is
    // actually in the DOM.
    const saveBtn = document.getElementById('thresholdSaveBtn')
    if (saveBtn) saveBtn.disabled = false
  } catch {
    // Keep the built-in defaults (already in the HTML value= attributes). Save stays
    // disabled (fail-closed): saving unknown default values would be worse than not saving.
  }
}

// Model-tier stepdown panel (card 5d2002b5 redesign, Peti 2026-08-01): enable toggle + two
// weekly-% sliders (editable) + a READ-ONLY per-agent state list. The editable model chain was
// removed -- the ladder is now the shared, dynamic model list (src/model-catalog.ts) and each
// agent steps from its OWN base, so there is nothing to hand-edit here. Thresholds save via
// POST /api/costs/model-fallback; the per-agent state is read from
// GET /api/costs/model-fallback/agents (base model, effective tier, current model, ramp target).

function renderModelTierState(state) {
  const list = document.getElementById('mtAgentState')
  if (!list) return
  list.innerHTML = ''
  const agents = state && Array.isArray(state.agents) ? state.agents : []
  if (agents.length === 0) {
    const li = document.createElement('li')
    li.className = 'usage-modeltier-state-empty'
    li.textContent = t('overview.quota.modeltier.stateEmpty')
    list.appendChild(li)
    return
  }
  for (const a of agents) {
    const li = document.createElement('li')
    li.className = 'usage-modeltier-state-item'

    const name = document.createElement('span')
    name.className = 'usage-modeltier-state-name'
    name.textContent = a.name

    const tier = document.createElement('span')
    tier.className = 'usage-modeltier-state-tier'
    tier.textContent = a.exempt
      ? t('overview.quota.modeltier.exemptTag')
      : t('overview.quota.modeltier.tierTag', { n: a.tier })

    // Base -> current model. When the two differ the agent has been stepped down; showing both
    // makes the ramp visible without a second click.
    const models = document.createElement('span')
    models.className = 'usage-modeltier-state-models'
    if (a.currentModel === a.baseModel) {
      models.textContent = a.currentLabel
    } else {
      models.textContent = a.baseLabel + ' → ' + a.currentLabel
    }
    models.title = t('overview.quota.modeltier.stateAria', {
      base: a.baseLabel, current: a.currentLabel, target: a.targetLabel,
    })

    li.append(name, tier, models)
    list.appendChild(li)
  }
}

async function loadModelTierConfig() {
  try {
    const res = await fetch('/api/costs/model-fallback')
    if (!res.ok) throw new Error('HTTP ' + res.status)
    const cfg = await res.json()
    const enabled = document.getElementById('mtEnabled')
    if (enabled) enabled.checked = cfg.weeklyTierEnabled === true
    const map = { mtTier1: cfg.weeklyTier1Percent, mtTier2: cfg.weeklyTier2Percent }
    for (const [id, val] of Object.entries(map)) {
      const input = document.getElementById(id)
      const label = document.getElementById(id + 'Val')
      if (input && Number.isFinite(Number(val))) input.value = val
      if (label && Number.isFinite(Number(val))) label.textContent = val + '%'
    }
    const saveBtn = document.getElementById('mtSaveBtn')
    if (saveBtn) saveBtn.disabled = false
  } catch {
    // Keep the HTML defaults; save stays disabled (fail-closed) so we never persist
    // guessed values over a real config we simply failed to read.
  }
  // The per-agent state comes from its own endpoint; a failure there leaves an honest
  // error row without blocking the (separately-loaded) threshold sliders.
  try {
    const res = await fetch('/api/costs/model-fallback/agents')
    if (!res.ok) throw new Error('HTTP ' + res.status)
    renderModelTierState(await res.json())
  } catch {
    const list = document.getElementById('mtAgentState')
    if (list) {
      list.innerHTML = ''
      const li = document.createElement('li')
      li.className = 'usage-modeltier-state-empty'
      li.textContent = t('overview.quota.modeltier.stateError')
      list.appendChild(li)
    }
  }
}

// Local-LLM info row (card e7a26045, replaces the removed 3rd slider). All fields are real
// -- today/week counts, model name, and measured (not estimated) tokens-saved -- from the
// backend's d08b98f4 API additions to /api/local-llm/usage.
async function loadLocalLlmInfo() {
  const errEl = document.getElementById('llmInfoError')
  const modelEl = document.getElementById('llmInfoModel')
  const todayEl = document.getElementById('llmInfoToday')
  const weekEl = document.getElementById('llmInfoWeek')
  const tokensEl = document.getElementById('llmInfoTokensSaved')
  try {
    const res = await fetch('/api/local-llm/usage')
    if (!res.ok) throw new Error('HTTP ' + res.status)
    const d = await res.json()
    if (errEl) errEl.hidden = true
    if (todayEl) todayEl.textContent = t('overview.quota.llm.count', { n: d.today ?? 0 })
    if (weekEl) weekEl.textContent = t('overview.quota.llm.count', { n: d.last_7d ?? 0 })
    // Not yet in the API response (waiting on card d08b98f4) -- honest placeholder, not 0.
    if (modelEl) modelEl.textContent = d.model || t('overview.quota.llm.pending')
    if (tokensEl) {
      // card 87b2fef9: pinned to the weekly-reset boundary, not the all-time total -- resets
      // together with the weekly Claude-usage limit instead of only ever growing.
      tokensEl.textContent =
        typeof d.tokens_saved_since_weekly_reset === 'number'
          ? d.tokens_saved_since_weekly_reset.toLocaleString(window._lang === 'hu' ? 'hu-HU' : 'en-US')
          : t('overview.quota.llm.pending')
    }
  } catch {
    if (errEl) { errEl.textContent = t('overview.quota.llm.error'); errEl.hidden = false }
    if (modelEl) modelEl.textContent = '—'
    if (todayEl) todayEl.textContent = '—'
    if (weekEl) weekEl.textContent = '—'
    if (tokensEl) tokensEl.textContent = '—'
  }
}

// Token-cost overview widget (card 01b51197).
// Calls GET /api/costops/estimates (backend f597369b, aggregated from d2cfa818's per-day
// breakdown). Still hides gracefully on 404 -- a defensive fallback, not the expected path anymore.
async function loadCostEstimatesWidget() {
  const card = document.getElementById('ovwCostCard')
  const body = document.getElementById('ovwCostBody')
  const footer = document.getElementById('ovwCostFooter')
  const totalEl = document.getElementById('ovwCostTotal')
  const noteEl = document.getElementById('ovwCostNote')
  if (!card || !body) return
  const token = localStorage.getItem('marveen-dashboard-token') || ''
  try {
    const r = await fetch('/api/costops/estimates', {
      headers: { 'Authorization': 'Bearer ' + token },
    })
    if (r.status === 404) { card.hidden = true; return }
    if (!r.ok) throw new Error('HTTP ' + r.status)
    const d = await r.json()
    const estimates = Array.isArray(d.estimates) ? d.estimates : []
    if (!estimates.length) {
      body.innerHTML = `<p class="ovw-cost-empty">${escapeHtml(t('overview.cost.empty'))}</p>`
      card.hidden = false
      return
    }
    const maxUsd = Math.max(...estimates.map((e) => e.estimatedUsd || 0), 0.0001)
    const rowsHtml = estimates.map((e) => {
      const pct = Math.round(((e.estimatedUsd || 0) / maxUsd) * 100)
      const inputK = ((e.inputTokens || 0) / 1000).toFixed(1)
      const outputK = ((e.outputTokens || 0) / 1000).toFixed(1)
      const usdStr = t('overview.cost.usd', { amount: (e.estimatedUsd || 0).toFixed(3) })
      const tpsStr = t('overview.cost.row_tps', { inputK, outputK })
      return `<div class="ovw-cost-row">
  <span class="ovw-cost-agent" title="${escapeHtml(e.agent || '')}">${escapeHtml(e.agent || '?')}</span>
  <div class="ovw-cost-bar-wrap"><div class="ovw-cost-bar" style="width:${pct}%"></div></div>
  <span class="ovw-cost-amount">${escapeHtml(usdStr)}</span>
  <span class="ovw-cost-tps">${escapeHtml(tpsStr)}</span>
</div>`
    }).join('')
    body.innerHTML = `<div class="ovw-cost-rows">${rowsHtml}</div>`
    if (totalEl) totalEl.textContent = t('overview.cost.usd', { amount: (d.totalEstimatedUsd || 0).toFixed(3) })
    if (footer) footer.hidden = false
    if (noteEl && d.note) { noteEl.textContent = t('overview.cost.note_disclaimer'); noteEl.hidden = false }
    card.hidden = false
  } catch {
    body.innerHTML = `<p class="ovw-cost-error">${escapeHtml(t('overview.cost.error'))}</p>`
    card.hidden = false
  }
}

// ============================================================
// === Overview: local-LLM model-distribution swimlane (card d6ecb003, pair-BE 2ffc0a96) ===
// ============================================================
// One lane per model that actually has activity in the window (no empty lane for an unused
// model, per Peti's spec), tasks rendered as blocks positioned by their REAL start-time and
// duration (not bucketed) and colored by task type, with a hover/focus tooltip and a legend.
// Design ref: store/design-refs/local-llm-swimlane-mockup-2026-09-03.jpg.
const OVW_LLMDIST_PALETTE = ['#4a9eff', '#34d399', '#a78bfa', '#f59e0b', '#f87171', '#22d3ee', '#fb7185', '#facc15']
let ovwLlmDistTaskColors = new Map()
let ovwLlmDistTooltipEl = null

function ovwLlmDistColorFor(task) {
  if (!ovwLlmDistTaskColors.has(task)) {
    ovwLlmDistTaskColors.set(task, OVW_LLMDIST_PALETTE[ovwLlmDistTaskColors.size % OVW_LLMDIST_PALETTE.length])
  }
  return ovwLlmDistTaskColors.get(task)
}

function ovwLlmDistFormatMs(ms) {
  return ms >= 1000
    ? t('overview.llmDist.sec', { n: (ms / 1000).toFixed(1) })
    : t('overview.llmDist.ms', { n: Math.round(ms) })
}

// avgLatencyMs (empty window) and tokensPerSec (no row in the window/lane had a usable eval
// measurement) are `number | null` in the contract (card 2ffc0a96, backend comment 19021): null
// means "not measured", and must never render as "0" -- a real 0 there would read as an actual
// zero-latency/zero-throughput measurement instead of "nothing to show".
function ovwLlmDistFormatMsOrNa(ms) {
  return ms == null ? '—' : ovwLlmDistFormatMs(ms)
}
function ovwLlmDistFormatTpsOrNa(tps) {
  return tps == null ? '—' : t('overview.llmDist.tps', { n: Number(tps).toFixed(1) })
}

function ovwLlmDistStatusLabel(status) {
  if (status === 'err') return t('overview.llmDist.status.err')
  if (status === 'busy') return t('overview.llmDist.status.busy')
  return t('overview.llmDist.status.ok')
}

function ovwLlmDistKpiHtml(kpi) {
  const items = [
    ['active_models', String(kpi.activeModels ?? 0)],
    ['avg_latency', ovwLlmDistFormatMsOrNa(kpi.avgLatencyMs)],
    ['tokens_per_sec', ovwLlmDistFormatTpsOrNa(kpi.tokensPerSec)],
    ['total_requests', (kpi.totalRequests || 0).toLocaleString('hu-HU').replace(/,/g, ' ')],
    ['error_rate', (kpi.errorRatePct || 0).toFixed(1) + '%'],
  ]
  return items.map(([key, value]) => `
    <div class="ovw-llmdist-kpi">
      <p class="ovw-llmdist-kpi-label">${escapeHtml(t('overview.llmDist.kpi.' + key))}</p>
      <p class="ovw-llmdist-kpi-value">${escapeHtml(value)}</p>
    </div>`).join('')
}

function ovwLlmDistAxisHtml(rangeStartMs, rangeEndMs) {
  const steps = 6
  const labels = []
  for (let i = 0; i <= steps; i++) {
    const ts = rangeStartMs + ((rangeEndMs - rangeStartMs) * i) / steps
    labels.push(`<span>${escapeHtml(new Date(ts).toLocaleTimeString('hu-HU', { hour: '2-digit', minute: '2-digit' }))}</span>`)
  }
  return labels.join('')
}

function ovwLlmDistLanesHtml(models, rangeStartMs, rangeEndMs) {
  const span = Math.max(1, rangeEndMs - rangeStartMs)
  return models.map((m) => {
    const tasks = Array.isArray(m.tasks) ? m.tasks : []
    const blocks = tasks.map((task) => {
      const leftPct = Math.min(100, Math.max(0, ((Number(task.startMs) - rangeStartMs) / span) * 100))
      const widthPct = Math.min(100 - leftPct, Math.max(0.6, (Number(task.durationMs) / span) * 100))
      const color = ovwLlmDistColorFor(task.task || '')
      return `<button type="button" class="ovw-llmdist-block" data-status="${escapeHtml(task.status || 'ok')}"
        style="left:${leftPct.toFixed(2)}%;width:${widthPct.toFixed(2)}%;background:${color}"
        data-task="${escapeHtml(task.task || '')}" data-agent="${escapeHtml(task.agent || '')}"
        data-duration="${Number(task.durationMs) || 0}" data-tokens-in="${Number(task.tokensIn) || 0}"
        data-tokens-out="${Number(task.tokensOut) || 0}" data-tps-label="${escapeHtml(ovwLlmDistFormatTpsOrNa(task.tokensPerSec))}"
        data-status-label="${escapeHtml(ovwLlmDistStatusLabel(task.status))}"
      >${escapeHtml(task.task || '')}</button>`
    }).join('')
    return `<div class="ovw-llmdist-lane">
      <span class="ovw-llmdist-lane-label" title="${escapeHtml(m.model || '')}">${escapeHtml(m.model || '?')}</span>
      <div class="ovw-llmdist-lane-track">${blocks}</div>
    </div>`
  }).join('')
}

function ovwLlmDistLegendHtml() {
  if (!ovwLlmDistTaskColors.size) return ''
  const items = [...ovwLlmDistTaskColors.entries()].map(([task, color]) =>
    `<span class="ovw-llmdist-legend-item"><span class="ovw-llmdist-legend-swatch" style="background:${color}"></span>${escapeHtml(task)}</span>`
  ).join('')
  return `<div class="ovw-llmdist-legend" aria-label="${escapeHtml(t('overview.llmDist.legend_title'))}">${items}</div>`
}

function ovwLlmDistShowTooltip(target) {
  if (!ovwLlmDistTooltipEl) {
    ovwLlmDistTooltipEl = document.createElement('div')
    ovwLlmDistTooltipEl.className = 'ovw-llmdist-tooltip'
    ovwLlmDistTooltipEl.hidden = true
    document.body.appendChild(ovwLlmDistTooltipEl)
  }
  const task = target.dataset.task || ''
  const agent = target.dataset.agent || ''
  const duration = Number(target.dataset.duration) || 0
  const tokensIn = Number(target.dataset.tokensIn) || 0
  const tokensOut = Number(target.dataset.tokensOut) || 0
  const tpsLabel = target.dataset.tpsLabel || '—'
  const statusLabel = target.dataset.statusLabel || ''
  const el = ovwLlmDistTooltipEl
  el.innerHTML = `
    <div class="ovw-llmdist-tooltip-title">${escapeHtml(task)}</div>
    <div class="ovw-llmdist-tooltip-row"><span>${escapeHtml(t('overview.llmDist.tooltip.agent'))}</span><span>${escapeHtml(agent)}</span></div>
    <div class="ovw-llmdist-tooltip-row"><span>${escapeHtml(t('overview.llmDist.tooltip.duration'))}</span><span>${escapeHtml(ovwLlmDistFormatMs(duration))}</span></div>
    <div class="ovw-llmdist-tooltip-row"><span>${escapeHtml(t('overview.llmDist.tooltip.tokens'))}</span><span>${escapeHtml(t('overview.llmDist.tooltip.tokens_value', { total: tokensIn + tokensOut, in: tokensIn, out: tokensOut }))}</span></div>
    <div class="ovw-llmdist-tooltip-row"><span>${escapeHtml(t('overview.llmDist.tooltip.throughput'))}</span><span>${escapeHtml(tpsLabel)}</span></div>
    <div class="ovw-llmdist-tooltip-row"><span>${escapeHtml(t('overview.llmDist.tooltip.status'))}</span><span>${escapeHtml(statusLabel)}</span></div>
  `
  el.hidden = false
  const rect = target.getBoundingClientRect()
  const top = Math.max(8, rect.top - el.offsetHeight - 8)
  const maxLeft = window.innerWidth - el.offsetWidth - 8
  const left = Math.max(8, Math.min(rect.left, maxLeft))
  el.style.top = top + 'px'
  el.style.left = left + 'px'
}

function ovwLlmDistHideTooltip() {
  if (ovwLlmDistTooltipEl) ovwLlmDistTooltipEl.hidden = true
}

function ovwLlmDistWireTooltips(body) {
  body.querySelectorAll('.ovw-llmdist-block').forEach((el) => {
    el.addEventListener('mouseenter', () => ovwLlmDistShowTooltip(el))
    el.addEventListener('focus', () => ovwLlmDistShowTooltip(el))
    el.addEventListener('mouseleave', ovwLlmDistHideTooltip)
    el.addEventListener('blur', ovwLlmDistHideTooltip)
  })
}

async function loadLlmDistWidget() {
  const card = document.getElementById('ovwLlmDistCard')
  const kpisEl = document.getElementById('ovwLlmDistKpis')
  const body = document.getElementById('ovwLlmDistBody')
  const metaEl = document.getElementById('ovwLlmDistMeta')
  if (!card || !body) return
  const hours = 6
  const token = localStorage.getItem('marveen-dashboard-token') || ''
  try {
    const r = await fetch(`/api/local-llm/model-usage-buckets?hours=${hours}`, {
      headers: { 'Authorization': 'Bearer ' + token },
    })
    if (r.status === 404) { card.hidden = true; return }
    if (!r.ok) throw new Error('HTTP ' + r.status)
    const d = await r.json()
    if (metaEl) metaEl.textContent = t('overview.llmDist.meta', { hours: d.windowHours || hours })
    if (kpisEl) kpisEl.innerHTML = ovwLlmDistKpiHtml(d.kpi || {})
    const models = Array.isArray(d.models) ? d.models : []
    if (!models.length) {
      body.innerHTML = `<p class="ovw-llmdist-empty">${escapeHtml(t('overview.llmDist.empty'))}</p>`
      card.hidden = false
      return
    }
    ovwLlmDistTaskColors = new Map()
    models.forEach((m) => (Array.isArray(m.tasks) ? m.tasks : []).forEach((task) => ovwLlmDistColorFor(task.task || '')))
    const rangeEndMs = d.generatedAtMs || Date.now()
    const rangeStartMs = rangeEndMs - (d.windowHours || hours) * 3600000
    body.innerHTML = `
      <div class="ovw-llmdist-lanes">${ovwLlmDistLanesHtml(models, rangeStartMs, rangeEndMs)}</div>
      <div class="ovw-llmdist-axis">${ovwLlmDistAxisHtml(rangeStartMs, rangeEndMs)}</div>
      ${ovwLlmDistLegendHtml()}
    `
    ovwLlmDistWireTooltips(body)
    card.hidden = false
  } catch {
    body.innerHTML = `<p class="ovw-llmdist-error">${escapeHtml(t('overview.llmDist.error'))}</p>`
    card.hidden = false
  }
}

// Wiring for the Claude Limit panel's help modal + threshold sliders + local-LLM info
// help modal (cards f3248478, e7a26045). Runs once at script load -- the elements are
// static HTML, not re-created per navigation.
;(function wireQuotaThresholdControls() {
  const helpBtn = document.getElementById('quotaHelpBtn')
  const helpOverlay = document.getElementById('quotaHelpOverlay')
  const helpClose = document.getElementById('quotaHelpClose')
  if (helpBtn && helpOverlay) {
    helpBtn.addEventListener('click', () => openModal(helpOverlay))
  }
  if (helpClose && helpOverlay) {
    helpClose.addEventListener('click', () => closeModal(helpOverlay))
  }
  if (helpOverlay) {
    helpOverlay.addEventListener('click', (e) => { if (e.target === helpOverlay) closeModal(helpOverlay) })
  }

  const llmHelpBtn = document.getElementById('llmInfoHelpBtn')
  const llmHelpOverlay = document.getElementById('llmInfoHelpOverlay')
  const llmHelpClose = document.getElementById('llmInfoHelpClose')
  if (llmHelpBtn && llmHelpOverlay) {
    llmHelpBtn.addEventListener('click', () => openModal(llmHelpOverlay))
  }
  if (llmHelpClose && llmHelpOverlay) {
    llmHelpClose.addEventListener('click', () => closeModal(llmHelpOverlay))
  }
  if (llmHelpOverlay) {
    llmHelpOverlay.addEventListener('click', (e) => { if (e.target === llmHelpOverlay) closeModal(llmHelpOverlay) })
  }

  const toggle = document.getElementById('thresholdToggle')
  const body = document.getElementById('thresholdBody')
  if (toggle && body) {
    toggle.addEventListener('click', () => {
      const expanded = toggle.getAttribute('aria-expanded') === 'true'
      toggle.setAttribute('aria-expanded', String(!expanded))
      body.hidden = expanded
    })
  }

  // Card e7a26045 (+ d53c1e00's class of bug): redesigned from 3 day-dependent sliders to
  // 2 flat, day-independent levels (newDevStop <= testStop). Cascade the other slider on
  // drag so the pair can never be expressed out of order in the UI; the backend still
  // re-validates on save (defense in depth).
  const sliderIds = ['thrNewDevStop', 'thrTestStop']
  function enforceMonotonicSliders(changedId) {
    const els = {
      thrNewDevStop: document.getElementById('thrNewDevStop'),
      thrTestStop: document.getElementById('thrTestStop'),
    }
    if (!els.thrNewDevStop || !els.thrTestStop) return
    let n = Number(els.thrNewDevStop.value)
    let s = Number(els.thrTestStop.value)
    if (changedId === 'thrNewDevStop' && n > s) s = n
    if (changedId === 'thrTestStop' && s < n) n = s
    els.thrNewDevStop.value = n
    els.thrTestStop.value = s
    for (const id of sliderIds) {
      const label = document.getElementById(id + 'Val')
      if (label) label.textContent = els[id].value + '%'
      updateThresholdWarn(id, els[id].value)
    }
  }
  for (const id of sliderIds) {
    const input = document.getElementById(id)
    if (input) {
      input.addEventListener('input', () => enforceMonotonicSliders(id))
      updateThresholdWarn(id, input.value)
    }
  }

  const saveBtn = document.getElementById('thresholdSaveBtn')
  const statusEl = document.getElementById('thresholdStatus')
  // "Mentve." auto-dismisses after a few seconds so it reads as a transient toast, not a
  // permanent label sitting next to a still-active button (card bb5603cc); an error stays
  // until the user acts (rule 12).
  let statusHideTimer = null
  if (saveBtn) {
    saveBtn.addEventListener('click', async () => {
      const newDevStop = Number(document.getElementById('thrNewDevStop')?.value)
      const testStop = Number(document.getElementById('thrTestStop')?.value)
      saveBtn.disabled = true
      if (statusHideTimer) { clearTimeout(statusHideTimer); statusHideTimer = null }
      if (statusEl) { statusEl.hidden = true; statusEl.classList.remove('success', 'error') }
      try {
        const res = await fetch('/api/costs/weekly-thresholds', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ newDevStop, testStop }),
        })
        const data = await res.json()
        if (!res.ok) throw new Error(data.error || ('HTTP ' + res.status))
        if (statusEl) {
          statusEl.textContent = t('overview.quota.threshold.saved')
          statusEl.classList.add('success')
          statusEl.hidden = false
          statusHideTimer = setTimeout(() => { statusEl.hidden = true }, 3000)
        }
      } catch (err) {
        if (statusEl) {
          statusEl.textContent = String(err.message || err)
          statusEl.classList.add('error')
          statusEl.hidden = false
        }
      } finally {
        saveBtn.disabled = false
      }
    })
  }

  // Model-tier stepdown controls (card 5d2002b5 redesign): collapse toggle, live slider labels,
  // and save of the two %-thresholds (POST /api/costs/model-fallback). The model chain editor was
  // removed -- the ladder is the shared dynamic list and the per-agent state below is read-only.
  // The backend still re-validates (tier1 < tier2), so a bad pair returns a descriptive error.
  const mtToggle = document.getElementById('modelTierToggle')
  const mtBody = document.getElementById('modelTierBody')
  if (mtToggle && mtBody) {
    mtToggle.addEventListener('click', () => {
      const expanded = mtToggle.getAttribute('aria-expanded') === 'true'
      mtToggle.setAttribute('aria-expanded', String(!expanded))
      mtBody.hidden = expanded
    })
  }
  for (const id of ['mtTier1', 'mtTier2']) {
    const input = document.getElementById(id)
    if (input) {
      input.addEventListener('input', () => {
        const label = document.getElementById(id + 'Val')
        if (label) label.textContent = input.value + '%'
      })
    }
  }
  const mtSaveBtn = document.getElementById('mtSaveBtn')
  const mtStatus = document.getElementById('mtStatus')
  let mtStatusTimer = null
  if (mtSaveBtn) {
    mtSaveBtn.addEventListener('click', async () => {
      const enabled = !!document.getElementById('mtEnabled')?.checked
      const tier1 = Number(document.getElementById('mtTier1')?.value)
      const tier2 = Number(document.getElementById('mtTier2')?.value)
      mtSaveBtn.disabled = true
      if (mtStatusTimer) { clearTimeout(mtStatusTimer); mtStatusTimer = null }
      if (mtStatus) { mtStatus.hidden = true; mtStatus.classList.remove('success', 'error') }
      try {
        // Only the thresholds + enable flag are sent; the chain is no longer dashboard-editable,
        // so the config's banner chain is left untouched (the POST parser ignores absent fields).
        const res = await fetch('/api/costs/model-fallback', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ weeklyTierEnabled: enabled, weeklyTier1Percent: tier1, weeklyTier2Percent: tier2 }),
        })
        const data = await res.json()
        if (!res.ok) throw new Error(data.error || ('HTTP ' + res.status))
        if (mtStatus) {
          mtStatus.textContent = t('overview.quota.modeltier.saved')
          mtStatus.classList.add('success')
          mtStatus.hidden = false
          mtStatusTimer = setTimeout(() => { mtStatus.hidden = true }, 3000)
        }
        // A new threshold can change which tier the fleet is in -- refresh the read-only state.
        loadModelTierConfig()
      } catch (err) {
        if (mtStatus) {
          mtStatus.textContent = String(err.message || err)
          mtStatus.classList.add('error')
          mtStatus.hidden = false
        }
      } finally {
        mtSaveBtn.disabled = false
      }
    })
  }
})()

// Wire the "Részletek →" link in the cost widget footer to navigate to the costs page.
// The link uses data-page="costs" but is not a sidebar .sb-link, so it doesn't get
// the generic nav-link handler -- wire it explicitly here.
;(function wireCostDetailLink() {
  const link = document.querySelector('.ovw-cost-detail-link[data-page]')
  if (!link) return
  link.addEventListener('click', (e) => {
    e.preventDefault()
    const pageId = link.dataset.page
    if (pageId && typeof switchPage === 'function') switchPage(pageId)
  })
})()

// Brand mark + product-brand chrome: pull the configured brand from
// /api/marveen and apply it to the dashboard chrome (tab title, mobile topbar,
// sidebar name, updates subtitle). brandName is the product/system name and is
// distinct from the main agent's display name; the backend defaults brandName to
// BOT_NAME, so a brand-unaware install keeps showing the agent name. If the
// field is absent (legacy backend) the existing HTML default text is kept.
async function initSidebarBrand() {
  try {
    const img = document.createElement('img')
    img.src = '/api/marveen/avatar' + avatarBust()
    img.onload = () => {
      const mark = document.getElementById('sidebarBrandMark')
      if (mark) { mark.textContent = ''; mark.appendChild(img) }
    }
    const res = await fetch('/api/marveen')
    if (res.ok) {
      const m = await res.json()
      const brand = m.brandName || m.name
      // Publish the brand tokens so every t() call ({brand}/{bot}/{agentId})
      // renders the configured names, then re-apply the static i18n so any
      // label painted before this fetch resolved picks up the real brand.
      window._brandTokens = {
        brand: brand || 'Marveen',
        bot: m.name || brand || 'Marveen',
        agentId: m.agentId || 'marveen',
      }
      if (typeof renderStaticI18n === 'function') renderStaticI18n()
      if (brand) {
        document.title = brand
        const appleTitle = document.querySelector('meta[name="apple-mobile-web-app-title"]')
        if (appleTitle) appleTitle.setAttribute('content', brand)
        const topbar = document.getElementById('mobileTopbarTitle')
        if (topbar) topbar.textContent = brand
        const name = document.getElementById('sidebarBrandName')
        if (name) name.textContent = brand
        const subtitle = document.getElementById('updatesSubtitle')
        if (subtitle) subtitle.textContent = `${brand} ` + t('overview.updates_subtitle')
      }
    }
  } catch {}
}
initSidebarBrand()

// Sidebar version line (card 1bf4f8a4, Peti's correction: a bare commit hash says nothing on its
// own -- a real semver version is the point). /api/version reports what dist/.built-commit says
// is ACTUALLY running, not live git HEAD, which can be ahead of an un-rebuilt dist (the same
// stale-dist trap this fleet has hit before) -- see routes/version.ts for why that source was
// chosen. Refreshes automatically on the next page load after a service restart; no separate
// wiring needed since the sidebar re-runs its init on every load.
async function initSidebarVersion() {
  try {
    const res = await fetch('/api/version')
    if (!res.ok) return
    const v = await res.json()
    const el = document.getElementById('sidebarVersion')
    if (!el || !v.version) return
    el.textContent = v.commitHash ? `v${v.version} (${v.commitHash})` : `v${v.version}`
    el.hidden = false
  } catch {}
}
initSidebarVersion()

// In an installed (standalone) PWA, lock the zoom: iOS otherwise auto-zooms when
// a small-text input is focused and allows stray pinch-zoom, neither of which
// suits an app-like control panel. Left untouched in a normal browser tab so
// page zoom / accessibility still work there.
if (window.matchMedia('(display-mode: standalone)').matches || window.navigator.standalone) {
  const vp = document.querySelector('meta[name="viewport"]')
  if (vp) vp.setAttribute('content', 'width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no, viewport-fit=cover')
}


// Self-init: replaces the loadOverview() call in app.js Init section.
loadOverview()
