// web/app-local-llm.js -- Local LLM (Ollama offload) page module
// Extracted from app.js as part of modularisation (card c4325698, slice 2/N).
// Loaded after app.js in index.html. Globals resolved at call time:
// t(), escapeHtml(), showToast(), openModal(), closeModal(), switchPage().
// Exposes: loadLocalLlm(), stopLocalLlmPoll() (called from switchPage in app.js).

// ============================================================
// === Local LLM (Ollama offload) page ===
// ============================================================

let _llmPollTimer = null
let _llmLogSource = 'bridge'
let _llmPullTimer = null

function stopLocalLlmPoll() {
  if (_llmPollTimer) { clearInterval(_llmPollTimer); _llmPollTimer = null }
}

function fmtBytes(n) {
  if (!n || n <= 0) return '0 B'
  const u = ['B', 'KB', 'MB', 'GB', 'TB']
  let i = 0, v = n
  while (v >= 1024 && i < u.length - 1) { v /= 1024; i++ }
  return `${v.toFixed(i === 0 ? 0 : 1)} ${u[i]}`
}

let _llmOffloadBound = false
let _llmOffloadTimer = null

function llmOffloadMsg(text, cls) {
  const m = document.getElementById('llmOffloadMsg')
  if (!m) return
  m.textContent = text || ''
  m.className = 'llm-offload-msg' + (cls ? ' ' + cls : '')
}

async function llmPostOffload(value) {
  try {
    const res = await fetch('/api/local-llm/offload-config', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ aggressiveness: value }),
    })
    if (!res.ok) throw new Error('HTTP ' + res.status)
    const d = await res.json()
    // The threshold may follow the slider (when on "auto"); refresh the dropdown hint too.
    llmRenderDifficulty(d)
    // A manual drag flips the source to 'manual' -- reflect that + offer "back to Auto".
    llmRenderRamp(d)
    llmOffloadMsg(t('localLlm.offload.saved', { value: d.aggressiveness }), 'ok')
  } catch (e) {
    // Rule 12: speak the failure in the flow (not a silent no-op) with a retry-able message.
    llmOffloadMsg(t('localLlm.offload.save_error'), 'bad')
  }
}

// Render the coding-difficulty dropdown + hint from an offload-config response (card afcfe93e).
// When the operator has not picked an explicit level, the select shows "auto" and the hint states
// the level DERIVED from the slider. Levels beyond the 7B's reliable ceiling get a caution note.
function llmRenderDifficulty(d) {
  const sel = document.getElementById('llmOffloadDifficulty')
  const hint = document.getElementById('llmOffloadDifficultyHint')
  if (!sel || !d) return
  // The threshold is capped at the reliable ceiling (module), so it is always a selectable option.
  sel.value = d.codingDifficultyExplicit ? String(d.codingDifficultyThreshold) : 'auto'
  if (!hint) return
  const eff = String(d.codingDifficultyThreshold || '')
  const label = t('localLlm.offload.difficulty.level.' + eff) || eff
  hint.textContent = d.codingDifficultyExplicit
    ? t('localLlm.offload.difficulty.hint_explicit', { level: label })
    : t('localLlm.offload.difficulty.hint_auto', { level: label })
}

// Render the auto-ramp status (card 8b4ddcf0, 346d3933 contract): whether the slider is under
// automatic (weekly-quota-driven) or manual control, the live weekly %/auto value when known, and
// a "back to Auto" action once the operator has taken manual control. Degrades gracefully when the
// backend predates 346d3933 and returns no `aggressivenessSource`/`ramp` (stale dist): the whole
// block simply stays hidden rather than showing a broken/empty shell.
function llmRenderRamp(d) {
  const box = document.getElementById('llmOffloadRamp')
  const srcEl = document.getElementById('llmRampSource')
  const detailEl = document.getElementById('llmRampDetail')
  const numbersEl = document.getElementById('llmRampNumbers')
  const autoBtn = document.getElementById('llmRampAutoBtn')
  if (!box || !srcEl || !detailEl || !numbersEl || !autoBtn) return

  // No contract from this backend (pre-346d3933 build) -> nothing honest to show; hide the block.
  if (d.aggressivenessSource == null && d.ramp == null) {
    box.hidden = true
    return
  }
  box.hidden = false

  const source = d.aggressivenessSource === 'manual' ? 'manual' : 'auto'

  srcEl.textContent =
    source === 'auto'
      ? t('localLlm.offload.ramp.source_auto')
      : t('localLlm.offload.ramp.source_manual')
  srcEl.className = 'llm-ramp-source llm-ramp-source--' + source

  // Contract (card e93a1dff): `ramp` is null when there is no live weekly reading; when present it
  // is { active, weeklyPercent, newDevStop, current, target, reason } where `reason` is an i18n KEY
  // the backend chose for the current state (manual | atThreshold | ramping | floor). We render the
  // BE's reason key -- not our own restated logic -- so the explanation stays server-authoritative.
  const ramp = d.ramp
  if (ramp && typeof ramp.reason === 'string') {
    const nums = {
      weekly: typeof ramp.weeklyPercent === 'number' ? Math.round(ramp.weeklyPercent) : '?',
      threshold: typeof ramp.newDevStop === 'number' ? Math.round(ramp.newDevStop) : '?',
      target: typeof ramp.target === 'number' ? Math.round(ramp.target) : '?',
      current: typeof ramp.current === 'number' ? Math.round(ramp.current) : '?',
    }
    // Reason line: the BE's own i18n key for the state (server-authoritative, qualitative).
    detailEl.textContent = t(ramp.reason, nums)
    detailEl.hidden = false
    // Numbers line: the quantitative state the contract carries (weekly% / threshold / target /
    // current) -- shows the operator BY HOW MUCH, which the reason sentence alone doesn't.
    numbersEl.textContent = t('localLlm.offload.ramp.numbers', nums)
    numbersEl.hidden = false
  } else {
    // ramp === null: source is known but no live weekly reading yet (empty state, rule 12) -- say so
    // plainly rather than implying a value we do not have.
    detailEl.textContent = t('localLlm.offload.ramp.no_reading')
    detailEl.hidden = false
    numbersEl.textContent = ''
    numbersEl.hidden = true
  }

  // "Back to Auto" only makes sense in manual mode; offer it whenever the operator has taken over.
  if (source === 'manual') {
    autoBtn.hidden = false
    autoBtn.textContent = t('localLlm.offload.ramp.back_to_auto')
  } else {
    autoBtn.hidden = true
  }
}

async function llmLoadOffload() {
  const slider = document.getElementById('llmOffloadSlider')
  const out = document.getElementById('llmOffloadValue')
  const opt = document.getElementById('llmOffloadOptimal')
  if (!slider) return
  try {
    const res = await fetch('/api/local-llm/offload-config')
    const d = await res.json()
    slider.value = String(d.aggressiveness)
    if (out) out.textContent = String(d.aggressiveness)
    if (opt) opt.textContent = String(d.optimal)
    slider.dataset.optimal = String(d.optimal)
    llmRenderDifficulty(d)
    llmRenderRamp(d)
    llmOffloadMsg('')
  } catch (e) {
    llmOffloadMsg(t('localLlm.offload.load_error'), 'bad')
  }
}

// Hand control back to the weekly auto-ramp (POST {aggressiveness:'auto'} -> clears the manual flag).
async function llmBackToAuto() {
  try {
    const res = await fetch('/api/local-llm/offload-config', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ aggressiveness: 'auto' }),
    })
    if (!res.ok) throw new Error('HTTP ' + res.status)
    // Re-load so the slider value, source badge, and ramp detail all reflect the resumed auto value.
    await llmLoadOffload()
    llmOffloadMsg(t('localLlm.offload.ramp.back_to_auto_done'), 'ok')
  } catch (e) {
    llmOffloadMsg(t('localLlm.offload.save_error'), 'bad')
  }
}

// Persist the coding-difficulty threshold ('auto' clears the explicit override -> follows slider).
async function llmPostDifficulty(value) {
  try {
    const res = await fetch('/api/local-llm/offload-config', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ codingDifficultyThreshold: value }),
    })
    if (!res.ok) throw new Error('HTTP ' + res.status)
    const d = await res.json()
    llmRenderDifficulty(d)
    const eff = t('localLlm.offload.difficulty.level.' + String(d.codingDifficultyThreshold)) || d.codingDifficultyThreshold
    llmOffloadMsg(t('localLlm.offload.difficulty.saved', { level: eff }), 'ok')
  } catch (e) {
    // Rule 12: speak the failure in the flow with a retry-able message.
    llmOffloadMsg(t('localLlm.offload.save_error'), 'bad')
  }
}

function llmSetupOffload() {
  const slider = document.getElementById('llmOffloadSlider')
  const out = document.getElementById('llmOffloadValue')
  if (slider && !_llmOffloadBound) {
    _llmOffloadBound = true
    slider.addEventListener('input', () => {
      if (out) out.textContent = slider.value
    })
    slider.addEventListener('change', () => {
      if (_llmOffloadTimer) clearTimeout(_llmOffloadTimer)
      _llmOffloadTimer = setTimeout(() => llmPostOffload(Number(slider.value)), 150)
    })
    const optBtn = document.getElementById('llmOffloadOptimalBtn')
    if (optBtn) {
      optBtn.addEventListener('click', () => {
        const optimal = Number(slider.dataset.optimal || '75')
        slider.value = String(optimal)
        if (out) out.textContent = String(optimal)
        llmPostOffload(optimal)
      })
    }
    const diffSel = document.getElementById('llmOffloadDifficulty')
    if (diffSel) {
      diffSel.addEventListener('change', () => llmPostDifficulty(diffSel.value))
    }
    const autoBtn = document.getElementById('llmRampAutoBtn')
    if (autoBtn) {
      autoBtn.addEventListener('click', () => llmBackToAuto())
    }
  }
  llmLoadOffload()
}

// Card a05c39c9: an entrance animation is a nice touch ONCE, but llmRefreshStatus/Queue/Usage all
// run on a 5s poll (see the setInterval below) and fully replace their container's innerHTML every
// tick -- a CSS `animation` (unlike `transition`) restarts on every fresh element, so attaching it
// unconditionally would flash the whole section on every single poll instead of just on arrival.
// Tracked per section-key, consumed once.
const _llmAnimDone = { status: false, queue: false, usage: false, models: false }
function llmAnimCls(key) {
  return _llmAnimDone[key] ? '' : ' llm-anim-in'
}
function llmAnimMark(key) {
  _llmAnimDone[key] = true
}

async function loadLocalLlm() {
  await llmRefreshStatus()
  await llmRefreshRecs()
  await llmRefreshLogs()
  await llmRefreshUsage()
  await llmRefreshQueue()
  await llmRefreshCategories()
  llmSetupOffload()
  llmSetupQueueFilter()
  stopLocalLlmPoll()
  // Live refresh of status + terminal + usage + queue while the page is open. The queue is the
  // fastest-changing of these (pending -> running -> done can happen within seconds), so it shares
  // the same 5s tick rather than a slower one.
  _llmPollTimer = setInterval(() => {
    if (document.getElementById('localLlmPage').hidden) { stopLocalLlmPoll(); return }
    llmRefreshStatus()
    llmRefreshLogs()
    llmRefreshUsage()
    llmRefreshQueue()
  }, 5000)
}

function llmCategoriesMsg(text, cls) {
  const m = document.getElementById('llmCategoriesMsg')
  if (!m) return
  m.textContent = text || ''
  m.className = 'llm-offload-msg' + (cls ? ' ' + cls : '')
}

// Categories (card 0c054ebf): all --task presets from GET /api/local-llm/categories, sourced
// on the backend from store/local-llm-skills/*.txt (never a hardcoded UI list). Each row shows
// name, description, call count, last-used, and a real enable/disable toggle -- store/local-llm.sh
// reads the same disabledCategories config before running any --task, so this is not decorative.
async function llmRefreshCategories() {
  const listEl = document.getElementById('llmCategoriesList')
  if (!listEl) return
  try {
    const res = await fetch('/api/local-llm/categories')
    if (!res.ok) throw new Error('HTTP ' + res.status)
    const d = await res.json()
    const categories = Array.isArray(d.categories) ? d.categories : []
    if (categories.length === 0) {
      listEl.innerHTML = `<div class="llm-empty">${t('localLlm.categories.empty')}</div>`
      return
    }
    // Card a05c39c9 originally gave this an entrance animation too, but Peti reported it
    // "vibrál" (visible jitter) -- this list commonly has ~80 rows, so even a staggered
    // animation puts a large batch of elements through opacity/transform in the same handful
    // of delay buckets at once, which is visual noise on a list this size, not polish. No
    // animation here; kept for the small tile grids (Status/Usage/Queue, <=5 items) where a
    // stagger genuinely reads as a reveal rather than a pile-up.
    listEl.innerHTML = categories.map((c, i) => {
      const meta = c.count > 0
        ? t('localLlm.categories.meta_used', { count: c.count, when: llmFmtTime(c.lastTs) })
        : t('localLlm.categories.meta_unused')
      const tipId = `llmCatTip${i}`
      return `<div class="llm-category-row${c.enabled ? '' : ' disabled'}">
        <div class="llm-category-info">
          <span class="llm-category-name">${escapeHtml(c.name)}</span>
          <button type="button" class="llm-category-info-btn" data-tip="${tipId}" aria-expanded="false" aria-describedby="${tipId}" aria-label="${escapeHtml(t('localLlm.categories.infoAria', { task: c.name }))}">&#9432;</button>
        </div>
        <div class="llm-category-tooltip" id="${tipId}" role="tooltip" hidden>${escapeHtml(c.description)}</div>
        <span class="llm-category-meta">${escapeHtml(meta)}</span>
        <button type="button" class="llm-category-toggle${c.enabled ? ' on' : ' off'}" data-task="${escapeHtml(c.name)}" data-enabled="${c.enabled ? '1' : '0'}" aria-pressed="${c.enabled ? 'true' : 'false'}">
          ${c.enabled ? t('localLlm.categories.on') : t('localLlm.categories.off')}
        </button>
      </div>`
    }).join('')
    listEl.querySelectorAll('.llm-category-toggle').forEach(btn =>
      btn.addEventListener('click', () => llmToggleCategory(btn.dataset.task, btn.dataset.enabled !== '1')))
    // Tap/click-to-open info tooltip (card 8b4ddcf0): hover alone would be invisible on touch/PWA.
    // Only one open at a time; closes on a second click, an outside click, or Escape.
    listEl.querySelectorAll('.llm-category-info-btn').forEach(btn =>
      btn.addEventListener('click', (e) => {
        e.stopPropagation()
        const tip = document.getElementById(btn.dataset.tip)
        const opening = tip.hidden
        listEl.querySelectorAll('.llm-category-tooltip').forEach(t => { t.hidden = true })
        listEl.querySelectorAll('.llm-category-info-btn').forEach(b => b.setAttribute('aria-expanded', 'false'))
        if (opening) {
          tip.hidden = false
          btn.setAttribute('aria-expanded', 'true')
        }
      }))
    llmCategoriesMsg('')
  } catch (err) {
    // Rule 12: speak the failure honestly, no raw status code -- llmRefreshBtn re-fetches.
    listEl.innerHTML = `<div class="llm-empty">${t('localLlm.load_error')}</div>`
  }
}

async function llmToggleCategory(task, enabled) {
  try {
    const res = await fetch('/api/local-llm/categories', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ task, enabled }),
    })
    const d = await res.json()
    if (!res.ok) throw new Error(d.message || ('HTTP ' + res.status))
    await llmRefreshCategories()
    llmCategoriesMsg(enabled ? t('localLlm.categories.enabled_msg', { task }) : t('localLlm.categories.disabled_msg', { task }), 'ok')
  } catch (err) {
    llmCategoriesMsg(t('localLlm.categories.save_error'), 'bad')
  }
}

async function llmRefreshStatus() {
  const grid = document.getElementById('llmStatusGrid')
  const modelsEl = document.getElementById('llmModels')
  const runningEl = document.getElementById('llmRunning')
  try {
    const [statusRes, catRes] = await Promise.all([
      fetch('/api/local-llm/status'),
      fetch('/api/local-llm/catalog').catch(() => null),
    ])
    const d = await statusRes.json()
    // Build trusted-by-name lookup from catalog (card 3d923ef5: trusted = publisher claim from
    // catalog, benchmarked = measured-on-this-machine from bench.sh -- two SEPARATE facts).
    const trustedByName = new Map()
    if (catRes && catRes.ok) {
      const cat = await catRes.json().catch(() => null)
      const catModels = cat && Array.isArray(cat.models) ? cat.models : []
      for (const cm of catModels) {
        if (cm.installRef) trustedByName.set(cm.installRef, !!cm.trusted)
      }
    }

    // Status tiles
    const tiles = []
    tiles.push(llmTile(
      t('localLlm.status.ollama'),
      d.ollama_up ? t('localLlm.status.up') : t('localLlm.status.down'),
      d.ollama_up ? 'ok' : 'bad',
    ))
    // Code/offload model tile (qwen2.5-coder or whatever is active)
    const codeRunning = (Array.isArray(d.running) ? d.running : []).find(r => r.name === d.active_model || r.model === d.active_model)
    tiles.push(llmTile(
      t('localLlm.status.code_model'),
      d.active_model ? escapeHtml(d.active_model) : '—',
      d.active_model ? (d.active_present === false ? 'warn' : (d.active_present === null ? 'muted' : 'ok')) : 'muted',
      d.active_model && d.active_present === false
        ? t('localLlm.status.not_pulled')
        : (d.active_model && d.active_present === null
          ? t('localLlm.status.unknown_ollama_down')
          : (codeRunning ? t('localLlm.status.in_vram') : (d.active_model ? t('localLlm.status.not_in_vram') : ''))),
      t('localLlm.status.code_model_role'),
    ))
    // Embedding model tile (nomic-embed-text — memory/RAG only, never gets code tasks)
    const embedRunning = (Array.isArray(d.running) ? d.running : []).find(r => r.name === d.embed_model || r.model === d.embed_model)
    tiles.push(llmTile(
      t('localLlm.status.embed_model'),
      d.embed_model ? escapeHtml(d.embed_model) : '—',
      d.embed_model ? (d.embed_present === false ? 'warn' : (d.embed_present === null ? 'muted' : 'ok')) : 'muted',
      d.embed_model && d.embed_present === false
        ? t('localLlm.status.not_pulled')
        : (d.embed_model && d.embed_present === null
          ? t('localLlm.status.unknown_ollama_down')
          : (embedRunning ? t('localLlm.status.in_vram') : (d.embed_model ? t('localLlm.status.not_in_vram') : ''))),
      t('localLlm.status.embed_model_role'),
    ))
    tiles.push(llmTile(
      t('localLlm.status.bridge'),
      d.bridge_active ? t('localLlm.status.running') : t('localLlm.status.stopped'),
      d.bridge_active ? 'ok' : 'muted',
    ))
    if (d.gpu) {
      const used = d.gpu.mem_total_mb ? `${d.gpu.mem_used_mb} / ${d.gpu.mem_total_mb} MB` : `${d.gpu.mem_used_mb} MB`
      tiles.push(llmTile(
        `${t('localLlm.status.gpu')} · ${escapeHtml(d.gpu.name)}`,
        `${used} · ${d.gpu.util_pct}%`,
        'ok',
      ))
    } else {
      tiles.push(llmTile(t('localLlm.status.gpu'), t('localLlm.status.no_gpu'), 'muted'))
    }
    grid.innerHTML = llmAnimateBatch(tiles.join(''), 'status', 'llm-tile')

    // Models list
    const models = Array.isArray(d.models) ? d.models : []
    if (!d.ollama_up) {
      modelsEl.innerHTML = `<div class="llm-empty">${t('localLlm.status.down')}</div>`
    } else if (models.length === 0) {
      modelsEl.innerHTML = `<div class="llm-empty">${t('localLlm.models.empty')}</div>`
    } else {
      modelsEl.innerHTML = llmAnimateBatch(models.map(m => {
        const active = m.name === d.active_model
        // BENCH BADGE (card 3d923ef5, d730070e): measured on this hardware.
        // evalTps is ALWAYS shown with benchCtx -- a tok/s figure without context size is not
        // comparable between models or even between runs of the same model (larger ctx = slower).
        const tpsHtml = m.benchmarked && typeof m.evalTps === 'number'
          ? (() => {
              const ctx = typeof m.benchCtx === 'number' ? ` @ ${m.benchCtx}` : ''
              const benchDate = m.benchmarkedAt ? new Date(m.benchmarkedAt).toLocaleDateString(dateLocale) : ''
              const tip = benchDate ? t('localLlm.models.bench.tip', { date: benchDate }) : t('localLlm.rec.tps_tip')
              return `<span class="llm-rec-tps" title="${escapeHtml(tip)}">⚡ ${llmFmtCount(Math.round(m.evalTps))} tok/s${escapeHtml(ctx)}</span>`
            })()
          : `<span class="llm-rec-tps unmeasured" title="${escapeHtml(t('localLlm.models.bench.unmeasured_tip'))}">${t('localLlm.rec.tps_unmeasured')}</span>`
        // TRUST BADGE (card 3d923ef5): publisher claim from catalog, separate from bench.
        // trustedByName may be empty (catalog unavailable) -- in that case the badge is omitted,
        // not fabricated; a missing datum is never shown as trusted/unverified.
        const trustHtml = trustedByName.has(m.name)
          ? `<span class="llm-trust-badge ${trustedByName.get(m.name) ? 'trusted' : 'unverified'}" title="${escapeHtml(t(trustedByName.get(m.name) ? 'localLlm.rec.trust.trusted_tip' : 'localLlm.rec.trust.unverified_tip'))}">${t(trustedByName.get(m.name) ? 'localLlm.rec.trust.trusted' : 'localLlm.rec.trust.unverified')}</span>`
          : ''
        // "installed but not yet benchmarked" gets a distinct row class + inline hint (rule 12:
        // actionable message, not silent). No UI button -- the only writer is store/local-llm-bench.sh.
        const notBenched = !m.benchmarked
        const benchHintHtml = notBenched
          ? `<span class="llm-bench-hint">${t('localLlm.models.bench.unmeasured_hint')}</span>`
          : ''
        return `<div class="llm-model-row${active ? ' active' : ''}${notBenched && !active ? ' not-benchmarked' : ''}">
          <div class="llm-model-info">
            <span class="llm-model-name">${escapeHtml(m.name)}</span>
            <span class="llm-rec-meta">
              <span class="llm-model-size">${fmtBytes(m.size)}</span>
              ${tpsHtml}
              ${trustHtml}
            </span>
            ${benchHintHtml}
          </div>
          <div class="llm-model-actions">
            ${active
              ? `<span class="llm-badge-active">${t('localLlm.models.active')}</span>`
              : `<button class="btn-secondary btn-compact llm-use-btn" data-model="${escapeHtml(m.name)}">${t('localLlm.models.use')}</button>`}
            <button class="btn-secondary btn-compact llm-update-btn" data-model="${escapeHtml(m.name)}">${t('localLlm.models.update')}</button>
          </div>
        </div>`
      }).join(''), 'models', 'llm-model-row')
      // Card 29b68fba (Cybersec LOW/INFO, a05c39c9 gate): this used to POST straight to
      // /api/local-llm/model and just toast a raw 403 -- but that endpoint is the SAME
      // trust-gated resource the Recommendations "Use" button hits (card fa8959cd/eb843c46's
      // two-door fix made the decision one implementation either caller reaches). Reusing the
      // existing llmActivateModelClick keeps both entry points on one curated-error toast path
      // (card d297f26f removed the confirm-and-retry modal both used to share) instead of
      // inventing a second copy of the same gate here.
      modelsEl.querySelectorAll('.llm-use-btn').forEach(b =>
        b.addEventListener('click', () => llmActivateModelClick(b.dataset.model, b)))
      modelsEl.querySelectorAll('.llm-update-btn').forEach(b =>
        b.addEventListener('click', () => { document.getElementById('llmPullInput').value = b.dataset.model; llmStartPull(b.dataset.model) }))
    }

    // Running generations
    const running = Array.isArray(d.running) ? d.running : []
    if (running.length === 0) {
      runningEl.innerHTML = `<div class="llm-running-empty">${t('localLlm.running.none')}</div>`
    } else {
      runningEl.innerHTML = running.map(r => {
        const vram = r.size_vram ? ` · ${t('localLlm.running.vram')}: ${fmtBytes(r.size_vram)}` : ''
        return `<div class="llm-running-row"><span class="llm-run-dot"></span><span class="llm-model-name">${escapeHtml(r.name || r.model || '?')}</span><span class="llm-model-size">${fmtBytes(r.size)}${vram}</span></div>`
      }).join('')
    }
  } catch (err) {
    grid.innerHTML = `<div class="llm-empty">${t('localLlm.load_error')}</div>`
  }
}

// CALLER MUST ESCAPE (Cybersec LOW/INFO, card 29b68fba, a05c39c9 gate): this function does NOT
// escape label/value/note/role -- every current caller already passes escapeHtml()'d or purely
// static/numeric content, but nothing enforced that, so a future caller could silently open an
// XSS hole by passing raw text through. Escape before calling this, not inside it (some callers
// legitimately pass pre-built HTML, e.g. a nested <span>, so escaping here would double-encode).
function llmTile(label, value, kind, note, role) {
  return `<div class="llm-tile ${kind}">
    <div class="llm-tile-label">${label}</div>
    <div class="llm-tile-value">${value}</div>
    ${note ? `<div class="llm-tile-note">${note}</div>` : ''}
    ${role ? `<div class="llm-tile-role">${role}</div>` : ''}
  </div>`
}

// Applies the once-only entrance class to a batch of freshly-built `.llm-tile`/row HTML (see
// llmAnimCls above) without threading an `animate` param through every individual tile-builder
// call site. `cls` is the tile/row's own class name (e.g. "llm-tile", "llm-category-row").
function llmAnimateBatch(html, key, cls) {
  if (_llmAnimDone[key]) return html
  llmAnimMark(key)
  // Matched only when followed by `"` or whitespace -- some templates append a modifier suffix
  // directly (e.g. `class="llm-category-row${enabled ? '' : ' disabled'}"`, no guaranteed space),
  // so the match can't require a trailing space; but WITHOUT this boundary check, "llm-tile" would
  // also match "llm-tile-label"/"llm-tile-value" and corrupt those class names.
  return html.replace(new RegExp(`class="${cls}(?=["\\s])`, 'g'), `class="${cls} llm-anim-in`)
}

// Local (Europe/Budapest) short timestamp for the usage table.
function llmFmtTime(epochSec) {
  if (!Number.isFinite(epochSec)) return '—'
  try {
    return new Date(epochSec * 1000).toLocaleString([], {
      timeZone: 'Europe/Budapest', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit',
    })
  } catch {
    return '—'
  }
}

// Usage metrics: how often the fleet invokes the local model, by agent / source
// / task / day, plus the most recent calls. Read-only; refreshed with the page.
async function llmRefreshUsage() {
  const tilesEl = document.getElementById('llmUsageTiles')
  if (!tilesEl) return
  try {
    // Parallel: usage stats + queue aggregate stats + today's activity rows
    const [usageRes, qStatsRes, qListRes] = await Promise.all([
      fetch('/api/local-llm/usage'),
      fetch('/api/local-llm/queue'),
      fetch('/api/local-llm/queue/list?limit=500'),
    ])
    const d = await usageRes.json()
    const s = await qStatsRes.json()
    const l = await qListRes.json()

    // 8 stat tiles: 3 usage + 5 queue (Pending/Running/Done/Failed/Avg latency)
    const latency = s.avgLatencyMs != null ? (Math.round(s.avgLatencyMs / 100) / 10) + 's' : '—'
    tilesEl.innerHTML = llmAnimateBatch([
      llmTile(t('localLlm.usage.total'), String(d.total || 0), 'ok'),
      llmTile(t('localLlm.usage.today'), String(d.today || 0), 'ok'),
      llmTile(t('localLlm.usage.last_7d'), String(d.last_7d || 0), 'ok'),
      llmTile(t('localLlm.queue.tile.pending'), s.pending ?? 0, 'muted'),
      llmTile(t('localLlm.queue.tile.running'), s.running ?? 0, 'ok'),
      llmTile(t('localLlm.queue.tile.done'), s.done ?? 0, 'ok'),
      llmTile(t('localLlm.queue.tile.failed'), s.failed ?? 0, (s.failed ?? 0) > 0 ? 'bad' : 'muted'),
      llmTile(t('localLlm.queue.tile.latency'), latency, 'muted'),
    ].join(''), 'usage', 'llm-tile')

    // By agent -- horizontal bars, already sorted count-desc by the backend
    const callerEl = document.getElementById('llmUsageByCaller')
    if (callerEl) {
      const callers = Array.isArray(d.by_caller) ? d.by_caller : []
      if (callers.length === 0) {
        callerEl.innerHTML = `<div class="llm-empty">${t('localLlm.usage.none')}</div>`
      } else {
        const max = callers[0].count || 1
        callerEl.innerHTML = callers.map(c => `<div class="llm-usage-bar-row">
          <span class="llm-usage-bar-label" title="${escapeHtml(c.caller)}">${escapeHtml(c.caller)}</span>
          <span class="llm-usage-bar-track"><span class="llm-usage-bar-fill" data-pct="${Math.round((c.count / max) * 100)}"></span></span>
          <span class="llm-usage-bar-count">${c.count}</span>
        </div>`).join('')
        // rAF-deferred, not set inline: the bars start at their CSS default (--w unset -> 0%,
        // see .llm-usage-bar-fill), and setting the real value one frame later -- after that 0%
        // state has actually painted -- is what makes the width `transition` (style.css) have a
        // real before/after to animate between. Setting it in the same synchronous tick as the
        // innerHTML write can get batched into a single paint with no visible motion.
        requestAnimationFrame(() => {
          callerEl.querySelectorAll('.llm-usage-bar-fill').forEach(el =>
            el.style.setProperty('--w', (el.dataset.pct || 0) + '%'))
        })
      }
    }

    // By source + task highlight (code) + status
    const srcEl = document.getElementById('llmUsageBySource')
    if (srcEl) {
      const bySrc = d.by_source || { bare: 0, rag: 0 }
      const tasks = Array.isArray(d.by_task) ? d.by_task : []
      const codeTask = tasks.find(x => x.task === 'code')
      const codeCount = codeTask ? codeTask.count : 0
      const st = d.by_status || { ok: 0, err: 0 }
      srcEl.innerHTML = `
        <div class="llm-usage-kv"><span>${t('localLlm.usage.source_bare')}</span><span>${bySrc.bare || 0}</span></div>
        <div class="llm-usage-kv"><span>${t('localLlm.usage.source_rag')}</span><span>${bySrc.rag || 0}</span></div>
        <div class="llm-usage-kv highlight"><span>${t('localLlm.usage.code_calls')}</span><span>${codeCount}</span></div>
        <div class="llm-usage-kv"><span>${t('localLlm.usage.status_ok')}</span><span>${st.ok || 0}</span></div>
        <div class="llm-usage-kv"><span>${t('localLlm.usage.status_err')}</span><span class="${(st.err || 0) > 0 ? 'llm-usage-err' : ''}">${st.err || 0}</span></div>
        <div class="llm-usage-kv muted"><span>${t('localLlm.usage.ui_probes')}</span><span>${d.ui_probes || 0}</span></div>`
    }

    // By day -- compact 14-day mini bar chart (heights via --h custom property)
    const dayEl = document.getElementById('llmUsageByDay')
    if (dayEl) {
      const days = Array.isArray(d.by_day) ? d.by_day : []
      const dmax = days.reduce((m, x) => Math.max(m, x.count || 0), 0) || 1
      dayEl.innerHTML = days.map(x => {
        const pct = Math.round(((x.count || 0) / dmax) * 100)
        return `<div class="llm-usage-day" title="${escapeHtml(x.date)} · ${x.count || 0}">
          <span class="llm-usage-day-track"><span class="llm-usage-day-bar${(x.count || 0) === 0 ? ' zero' : ''}" data-pct="${pct}"></span></span>
          <span class="llm-usage-day-x">${escapeHtml((x.date || '').slice(5))}</span>
        </div>`
      }).join('')
      // Same rAF-deferral as the caller bars above, so the height `transition` has a real 0% ->
      // target frame to animate across instead of painting straight to the final height.
      requestAnimationFrame(() => {
        dayEl.querySelectorAll('.llm-usage-day-bar').forEach(el =>
          el.style.setProperty('--h', (el.dataset.pct || 0) + '%'))
      })
    }

    // Unified activity list: queue/list rows, today only (FE daily window), max 35, 9 columns.
    // source of truth is the queue DB (covers direct-sync + async; the old log-file "recent" is
    // redundant now that every invocation lands in the queue table).
    const recEl = document.getElementById('llmUsageRecent')
    if (recEl) {
      const todayStart = new Date(); todayStart.setHours(0, 0, 0, 0)
      const todayStartMs = todayStart.getTime()
      let rows = Array.isArray(l.rows) ? l.rows : []
      rows = rows.filter(r => r.created_at >= todayStartMs)
      if (_llmQueueFilter) rows = rows.filter(r => r.status === _llmQueueFilter)
      rows = rows.slice(0, 35)

      if (rows.length === 0) {
        recEl.innerHTML = `<div class="llm-empty">${t('localLlm.queue.none')}</div>`
      } else {
        const body = rows.map(r => {
          const ms = (r.finished_at && r.started_at) ? (r.finished_at - r.started_at) : null
          const canView = r.status === 'done' || r.status === 'failed'
          const stateText = r.error ? `${r.attempts}x, err` : `${r.attempts}x`
          return `<tr>
            <td>${escapeHtml(llmFmtTime(Math.floor(r.created_at / 1000)))}</td>
            <td>${escapeHtml(r.agent || '')}</td>
            <td>${escapeHtml(r.source || '')}</td>
            <td>${escapeHtml(r.template || r.task_type || '—')}</td>
            <td>${escapeHtml(r.priority || '')}</td>
            <td class="llm-usage-num">${ms !== null ? ms : '—'}</td>
            <td><span class="llm-queue-status ${escapeHtml(r.status || '')}">${escapeHtml(llmQueueStatusLabel(r.status))}</span></td>
            <td class="llm-usage-muted">${escapeHtml(stateText)}</td>
            <td>${canView ? `<button type="button" class="btn-secondary btn-compact llm-queue-view-btn" data-id="${r.id}">${t('localLlm.queue.view_btn')}</button>` : '—'}</td>
          </tr>`
        }).join('')
        recEl.innerHTML = `<table class="llm-usage-table">
          <thead><tr>
            <th>${t('localLlm.queue.col_time')}</th>
            <th>${t('localLlm.queue.col_agent')}</th>
            <th>${t('localLlm.queue.col_source')}</th>
            <th>${t('localLlm.queue.col_task')}</th>
            <th>${t('localLlm.queue.col_priority')}</th>
            <th class="llm-usage-num">${t('localLlm.queue.col_ms')}</th>
            <th>${t('localLlm.queue.col_status')}</th>
            <th>${t('localLlm.queue.col_state')}</th>
            <th>${t('localLlm.queue.col_action')}</th>
          </tr></thead>
          <tbody>${body}</tbody>
        </table>`
        recEl.querySelectorAll('.llm-queue-view-btn').forEach(btn => {
          btn.addEventListener('click', () => llmQueueOpenDetail(Number(btn.dataset.id)))
        })
      }
    }
  } catch {
    tilesEl.innerHTML = `<div class="llm-empty">${t('localLlm.load_error')}</div>`
  }
}

// --- Async work queue (card 48aacf56 item 5) --------------------------------
// The list view (GET /api/local-llm/queue/list) is metadata-only by design --
// no prompt/context/result -- so a row's full content is fetched on demand via
// GET /api/local-llm/queue/<id> when the operator opens it (llmQueueOpenDetail).

let _llmQueueFilter = ''

function llmQueueStatusLabel(status) {
  const key = {
    pending: 'localLlm.queue.status.pending',
    running: 'localLlm.queue.status.running',
    done: 'localLlm.queue.status.done',
    failed: 'localLlm.queue.status.failed',
  }[status]
  return key ? t(key) : (status || '—')
}

// llmRefreshQueue is now a no-op: the queue tiles and activity list are rendered
// by llmRefreshUsage (unified Aktivitás section, card 88c00f5e).
async function llmRefreshQueue() {
  return llmRefreshUsage()
}

async function llmQueueOpenDetail(id) {
  const body = document.getElementById('llmQueueDetailBody')
  if (!body) return
  body.innerHTML = `<div class="llm-loading">${t('common.loading')}</div>`
  openModal(llmQueueDetailOverlay)
  try {
    const res = await fetch('/api/local-llm/queue/' + id)
    const d = await res.json()
    if (!res.ok) { body.innerHTML = `<div class="llm-empty">${t('localLlm.queue.detail.load_error')}</div>`; return }
    const kvRows = [
      [t('localLlm.queue.detail.agent'), d.agent],
      [t('localLlm.queue.detail.task'), d.task_type || '—'],
      [t('localLlm.queue.detail.template'), d.template || '—'],
      [t('localLlm.queue.detail.priority'), d.priority],
      [t('localLlm.queue.detail.status'), llmQueueStatusLabel(d.status)],
      [t('localLlm.queue.detail.attempts'), d.attempts],
      [t('localLlm.queue.detail.card'), d.card_id || '—'],
      [t('localLlm.queue.detail.created'), llmFmtTime(Math.floor((d.created_at || 0) / 1000))],
      [t('localLlm.queue.detail.started'), d.started_at ? llmFmtTime(Math.floor(d.started_at / 1000)) : '—'],
      [t('localLlm.queue.detail.finished'), d.finished_at ? llmFmtTime(Math.floor(d.finished_at / 1000)) : '—'],
    ]
    const kv = kvRows
      .map(([k, v]) => `<div class="llm-usage-kv"><span>${escapeHtml(k)}</span><span>${escapeHtml(String(v ?? '—'))}</span></div>`)
      .join('')
    const resultBlock = d.status === 'failed'
      ? `<h3 class="llm-usage-subtitle">${t('localLlm.queue.detail.error')}</h3><pre class="llm-queue-detail-text llm-usage-err">${escapeHtml(d.error || '')}</pre>`
      : `<h3 class="llm-usage-subtitle">${t('localLlm.queue.detail.result')}</h3><pre class="llm-queue-detail-text">${d.result ? escapeHtml(d.result) : escapeHtml(t('localLlm.queue.detail.no_result'))}</pre>`
    body.innerHTML = `<div class="llm-usage-cols">${kv}</div>${resultBlock}`
  } catch {
    body.innerHTML = `<div class="llm-empty">${t('localLlm.queue.detail.load_error')}</div>`
  }
}

function llmSetupQueueFilter() {
  document.querySelectorAll('.llm-queue-filter-btn').forEach(btn => {
    if (btn.dataset.bound) return
    btn.dataset.bound = '1'
    btn.addEventListener('click', () => {
      _llmQueueFilter = btn.dataset.status || ''
      document.querySelectorAll('.llm-queue-filter-btn').forEach(b => b.classList.toggle('active', b === btn))
      llmRefreshQueue()
    })
  })
}

// --- GPU-filtered model catalogue (card 61a4a85f, EPIC ebc7b4dd T4) --------
// Sourced from GET /api/local-llm/catalog (store/llm-catalog.py): real GPU/VRAM math, trust
// labels (allowlisted-publisher vs unverified, card 87d7c86f), never a hardcoded/guessed
// throughput. Replaces the old static-hint "Ajánlott modellek" list -- same section, same
// element ids, real (and validated) data instead of a curated guess.
const LLM_TIER_FIT_KEY = { fits: 'localLlm.rec.fit_fits', partial: 'localLlm.rec.fit_tight' }

function llmFmtVram(mib) {
  if (typeof mib !== 'number' || !Number.isFinite(mib)) return '?'
  return (mib / 1024).toFixed(1).replace(/\.0$/, '') + ' GB'
}

// Family grouping (card 88ea5050, Peti direktiva 2026-08-14): the flat catalogue is one row per
// QUANT, and a single HF repo commonly ships 10-20 of those (the real cache on this host: 448
// rows across 37 repos). Grouped by `repo` -- already the exact granularity Peti asked for
// ("Qwen2.5-Coder csalad egy csoport"), and the ONLY key that groups quants of the same model
// without re-deriving it: downloads/trust are already repo-level facts (see the sort comment
// above), so every variant in a group shares them and only quant/size/fit/digest/tokensPerSecond
// vary per row. `_llmRecGroups` is kept module-scope so the variant <select> can re-render its
// own group body without a re-fetch -- the data is already in hand.
let _llmRecGroups = []
let _llmRecActiveModel = null
let _llmRecInstalledNames = new Set()

function llmGroupRecModels(models) {
  const order = []
  const byRepo = new Map()
  for (const m of models) {
    const key = m.repo || m.id
    if (!byRepo.has(key)) { byRepo.set(key, []); order.push(key) }
    byRepo.get(key).push(m)
  }
  // Each group's variants arrive already sorted by the backend (fits > trusted > downloads >
  // quant-quality, see llm-catalog.py) -- variants[0] is therefore that group's own best offer,
  // used as the default selection and the source of the header's repo-level facts.
  return order.map(key => byRepo.get(key))
}

function llmRecTpsHtml(m) {
  // NEVER INVENTED (mirrors the producer's own contract, store/llm-catalog.py): a measured
  // number is shown as-is, a missing measurement is its own explicit state -- never rendered as
  // 0 or omitted (card 88ea5050, backend2/MikroB finding: this field did not appear at all).
  return typeof m.tokensPerSecond === 'number'
    ? `<span class="llm-rec-tps" title="${escapeHtml(t('localLlm.rec.tps_tip'))}">⚡ ${llmFmtCount(Math.round(m.tokensPerSecond))} tok/s</span>`
    : `<span class="llm-rec-tps unmeasured" title="${escapeHtml(t('localLlm.rec.tps_unmeasured_tip'))}">${t('localLlm.rec.tps_unmeasured')}</span>`
}

function llmRecActionHtml(m) {
  const isActive = m.installRef === _llmRecActiveModel
  const isInstalled = _llmRecInstalledNames.has(m.installRef)
  if (isActive) return `<span class="llm-badge-active">${t('localLlm.models.active')}</span>`
  if (isInstalled) return `<button class="btn-secondary btn-compact llm-rec-use-btn" data-model="${escapeHtml(m.installRef)}">${t('localLlm.rec.use_btn')}</button>`
  return `<button class="btn-secondary btn-compact llm-rec-pull-btn" data-model="${escapeHtml(m.installRef)}">${t('localLlm.rec.pull_btn')}</button>`
}

function llmRecVariantBodyHtml(m) {
  const fitKey = LLM_TIER_FIT_KEY[m.tier] || 'localLlm.rec.fit_fits'
  const isActive = m.installRef === _llmRecActiveModel
  // SECURITY: only an 8-char prefix of the first part's digest is shown here -- the full value is
  // still available where a real comparison happens (the trust-confirm modal, card fa8959cd);
  // shortening it here is a display convenience, not the verification surface.
  const digest = m.parts && m.parts[0] && m.parts[0].sha256 ? String(m.parts[0].sha256).slice(0, 8) : null
  // Card 3ff05447: a missing digest was pure ABSENCE (the span simply didn't render), which reads
  // identically to "nobody checked" -- there was no way to tell "no digest exists to show" from
  // "we forgot to show it". Says so explicitly instead.
  const digestHtml = digest
    ? `<span class="llm-rec-digest" title="${escapeHtml(t('localLlm.rec.digest_tip'))}">${escapeHtml(digest)}</span>`
    : `<span class="llm-rec-digest llm-rec-digest-missing">${escapeHtml(t('localLlm.rec.digest_missing'))}</span>`
  const note = Array.isArray(m.notes) && m.notes.length ? m.notes.join(' ') : ''
  return `<div class="llm-model-row llm-rec-row${isActive ? ' active' : ''}">
    <div class="llm-model-info">
      <span class="llm-rec-meta">
        <span class="llm-rec-params">${escapeHtml(m.quant || '')}</span>
        <span class="llm-model-size">${escapeHtml((m.fileMib != null ? (m.fileMib / 1024).toFixed(1) : '?') + ' GB')}</span>
        <span class="llm-fit-badge ${escapeHtml(m.tier || '')}">${t(fitKey)}</span>
        ${digestHtml}
        ${llmRecTpsHtml(m)}
      </span>
      ${note ? `<span class="llm-rec-note">${escapeHtml(note)}</span>` : ''}
      <span class="llm-rec-installref">${escapeHtml(m.installRef || '')}</span>
    </div>
    <div class="llm-model-actions">${llmRecActionHtml(m)}</div>
  </div>`
}

function llmRecGroupHtml(variants, groupIdx, isTop) {
  const head = variants[0]
  const variantOptions = variants.map((v, i) =>
    `<option value="${i}">${escapeHtml(v.quant || '?')} — ${escapeHtml((v.fileMib != null ? (v.fileMib / 1024).toFixed(1) : '?') + ' GB')} (${escapeHtml(t(LLM_TIER_FIT_KEY[v.tier] || 'localLlm.rec.fit_fits'))})</option>`
  ).join('')
  return `<div class="llm-rec-group${isTop ? ' recommended' : ''}" data-group-idx="${groupIdx}">
    <div class="llm-rec-group-head">
      ${isTop ? `<span class="llm-rec-badge-star" title="${escapeHtml(t('localLlm.rec.recommended_tip'))}">${t('localLlm.rec.recommended')}</span>` : ''}
      <span class="llm-model-name">${escapeHtml(head.displayName || head.repo || head.id)}</span>
      <span class="llm-trust-badge ${head.trusted ? 'trusted' : 'unverified'}" title="${escapeHtml(t(head.trusted ? 'localLlm.rec.trust.trusted_tip' : 'localLlm.rec.trust.unverified_tip'))}">${t(head.trusted ? 'localLlm.rec.trust.trusted' : 'localLlm.rec.trust.unverified')}</span>
      ${typeof head.downloads === 'number' ? `<span class="llm-rec-downloads" title="${escapeHtml(t('localLlm.rec.downloads_tip'))}">↓ ${llmFmtCount(head.downloads)}</span>` : ''}
      ${variants.length > 1
        ? `<select class="llm-select llm-rec-variant-select" data-group-idx="${groupIdx}" aria-label="${escapeHtml(t('localLlm.rec.variant_select_aria', { name: head.displayName || head.repo }))}">${variantOptions}</select>`
        : ''}
    </div>
    <div class="llm-rec-group-body">${llmRecVariantBodyHtml(head)}</div>
  </div>`
}

function llmWireRecActionButtons(root) {
  root.querySelectorAll('.llm-rec-pull-btn').forEach(b =>
    b.addEventListener('click', () => {
      const input = document.getElementById('llmPullInput')
      if (input) input.value = b.dataset.model
      llmStartPull(b.dataset.model)
    }))
  // "Use this" (card first-run-llm.sh philosophy: a finished download never silently becomes
  // the fleet default -- activation is its own explicit, logged step).
  root.querySelectorAll('.llm-rec-use-btn').forEach(b =>
    b.addEventListener('click', () => llmActivateModelClick(b.dataset.model, b)))
}

function llmRecSwapVariant(selectEl) {
  const group = _llmRecGroups[Number(selectEl.dataset.groupIdx)]
  const variant = group && group[Number(selectEl.value)]
  if (!variant) return
  const bodyEl = selectEl.closest('.llm-rec-group').querySelector('.llm-rec-group-body')
  bodyEl.innerHTML = llmRecVariantBodyHtml(variant)
  llmWireRecActionButtons(bodyEl)
}

async function llmRefreshRecs() {
  const el = document.getElementById('llmRecs')
  const gpuHint = document.getElementById('llmRecsGpuHint')
  const staleBanner = document.getElementById('llmRecsStaleBanner')
  if (!el) return
  try {
    const [catRes, statusRes] = await Promise.all([
      fetch('/api/local-llm/catalog'),
      fetch('/api/local-llm/status').then(r => r.ok ? r.json() : null).catch(() => null),
    ])
    const d = await catRes.json()
    if (!catRes.ok) { el.innerHTML = `<div class="llm-empty">${t('localLlm.rec.load_error')}</div>`; return }

    const gpu = d.host && d.host.gpu
    if (gpuHint) {
      gpuHint.textContent = gpu && !gpu.cpuOnly && gpu.vramTotalMib
        ? t('localLlm.rec.gpu_hint', { name: gpu.name || t('localLlm.rec.gpu_unknown'), vram: llmFmtVram(gpu.vramTotalMib) })
        : t('localLlm.rec.cpu_only_hint')
    }
    if (staleBanner) {
      if (d.stale) {
        staleBanner.hidden = false
        staleBanner.textContent = t('localLlm.rec.stale_banner')
      } else {
        staleBanner.hidden = true
      }
    }

    // The producer (llm-catalog.py + the route's own tiered fallback, card 4117f98e) can put
    // specific, actionable reasons in warnings[] -- e.g. "this build cannot read the cached
    // catalogue's schema, run ./update.sh" or "no GPU sized, filtering against system RAM". An
    // empty models[] with a warning behind it is a DIFFERENT situation from a genuinely empty
    // catalogue, and showing only the generic empty text hid that reason (Cybered finding,
    // 4117f98e kovetkezmenye, card 335a6a62). Rendered the same way as per-model `notes` already
    // are in this function: raw operator-facing text from the producer, not routed through i18n.
    const warnings = Array.isArray(d.warnings) ? d.warnings : []
    const warningsHtml = warnings.length
      ? `<div class="llm-rec-warnings">${warnings.map(w => `<div class="llm-rec-warning">${escapeHtml(w)}</div>`).join('')}</div>`
      : ''

    const models = Array.isArray(d.models) ? d.models : []
    if (models.length === 0) {
      el.innerHTML = warningsHtml + `<div class="llm-empty">${t('localLlm.rec.empty')}</div>`
      return
    }

    _llmRecActiveModel = statusRes && statusRes.active_model
    _llmRecInstalledNames = new Set((statusRes && Array.isArray(statusRes.models) ? statusRes.models : []).map(m => m.name))
    _llmRecGroups = llmGroupRecModels(models)

    // Card 3ff05447 (Cybered-derived): the sort already puts trusted publishers first WITHIN a
    // size tier (see llm-catalog.py's own sort comment), so an untrusted GROUP appearing means
    // nothing reviewed was left at that tier -- today that was only visible as an absence (the
    // per-group "Nem ellenőrzött" badge), with no explanation of what the absence means. Counts
    // the ACTUALLY RENDERED groups (not an assumed top-N -- this view has never sliced the list),
    // so the number always matches what the operator can see. Omitted entirely when zero, so the
    // line never becomes permanent decoration with no information value.
    const unverifiedCount = _llmRecGroups.filter(variants => !variants[0].trusted).length
    const unverifiedNoteHtml = unverifiedCount > 0
      ? `<div class="llm-rec-unverified-note">${escapeHtml(t('localLlm.rec.unverified_note', { count: unverifiedCount }))}</div>`
      : ''

    el.innerHTML = warningsHtml + unverifiedNoteHtml + _llmRecGroups.map((variants, i) => llmRecGroupHtml(variants, i, i === 0)).join('')
    llmWireRecActionButtons(el)
    el.querySelectorAll('.llm-rec-variant-select').forEach(sel =>
      sel.addEventListener('change', () => llmRecSwapVariant(sel)))
  } catch {
    el.innerHTML = `<div class="llm-empty">${t('localLlm.rec.load_error')}</div>`
  }
}

async function llmActivateModelClick(model, btn) {
  // Card 29b68fba: single activation path for both installed-models "Használd" and
  // Recommendations "Use" button. Backend always enforces trust (no UI gate needed --
  // the modal was removed: d297f26f decision, the iTrust field is not read server-side).
  btn.disabled = true
  try {
    const res = await fetch('/api/local-llm/model', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model }),
    })
    const data = await res.json().catch(() => ({}))
    if (res.ok) {
      showToast(t('localLlm.models.swapped', { model }))
      await llmRefreshRecs()
      await llmRefreshStatus()
      return
    }
    btn.disabled = false
    showToast(data.error || t('localLlm.rec.activate_error'))
  } catch {
    btn.disabled = false
    showToast(t('localLlm.rec.activate_error'))
  }
}


// --- HuggingFace GGUF model search (Ollama-pullable) -----------------------
function llmFmtCount(n) {
  const v = Number(n)
  if (!Number.isFinite(v) || v <= 0) return '0'
  if (v >= 1e6) return (v / 1e6).toFixed(1).replace(/\.0$/, '') + 'M'
  if (v >= 1e3) return (v / 1e3).toFixed(1).replace(/\.0$/, '') + 'k'
  return String(v)
}

async function llmHfSearch() {
  const el = document.getElementById('llmHfResults')
  const btn = document.getElementById('llmHfSearchBtn')
  if (!el) return
  const query = (document.getElementById('llmHfQuery')?.value || '').trim()
  const task = document.getElementById('llmHfTask')?.value ?? 'text-generation'
  const sort = document.getElementById('llmHfSort')?.value || 'downloads'
  const gguf = document.getElementById('llmHfGguf')?.checked ? 'true' : 'false'
  el.innerHTML = `<div class="llm-empty">${t('localLlm.hf.searching')}</div>`
  if (btn) btn.disabled = true
  try {
    const params = new URLSearchParams({ query, task, sort, gguf, limit: '20' })
    const res = await fetch(`/api/local-llm/hf-search?${params.toString()}`)
    const d = await res.json()
    if (!res.ok) { el.innerHTML = `<div class="llm-empty">${escapeHtml(d.error || t('localLlm.hf.error'))}</div>`; return }
    const results = Array.isArray(d.results) ? d.results : []
    if (results.length === 0) { el.innerHTML = `<div class="llm-empty">${t('localLlm.hf.empty')}</div>`; return }
    const count = `<div class="llm-hf-count">${t('localLlm.hf.result_count', { count: results.length })}</div>`
    const rows = results.map(r => {
      const dl = `<span class="llm-hf-stat" title="${t('localLlm.hf.dl')}">↓ ${llmFmtCount(r.downloads)}</span>`
      const lk = `<span class="llm-hf-stat" title="${t('localLlm.hf.likes')}">♥ ${llmFmtCount(r.likes)}</span>`
      const badge = r.gguf ? `<span class="llm-fit-badge fits">${t('localLlm.hf.gguf_badge')}</span>` : ''
      const pullTarget = r.ollama_pull ? String(r.ollama_pull).replace(/^ollama pull /, '') : ''
      const action = (r.gguf && pullTarget)
        ? `<button class="btn-secondary btn-compact llm-hf-pull-btn" data-model="${escapeHtml(pullTarget)}">${t('localLlm.hf.pull_btn')}</button>`
        : `<span class="llm-hf-nogguf">${t('localLlm.hf.not_gguf')}</span>`
      return `<div class="llm-model-row llm-hf-row">
        <div class="llm-model-info">
          <a class="llm-model-name llm-hf-link" href="${escapeHtml(r.hf_url || '#')}" target="_blank" rel="noopener noreferrer">${escapeHtml(r.id || '?')}</a>
          <span class="llm-rec-meta">${dl}${lk}${badge}</span>
        </div>
        <div class="llm-model-actions">${action}</div>
      </div>`
    }).join('')
    el.innerHTML = count + rows
    el.querySelectorAll('.llm-hf-pull-btn').forEach(b =>
      b.addEventListener('click', () => {
        const input = document.getElementById('llmPullInput')
        if (input) input.value = b.dataset.model
        llmStartPull(b.dataset.model)
      }))
  } catch {
    el.innerHTML = `<div class="llm-empty">${t('localLlm.hf.error')}</div>`
  } finally {
    if (btn) btn.disabled = false
  }
}

async function llmStartPull(modelArg) {
  const input = document.getElementById('llmPullInput')
  const model = (modelArg || input.value || '').trim()
  const prog = document.getElementById('llmPullProgress')
  if (!model) { showToast(t('localLlm.models.pull_empty')); return }
  prog.hidden = false
  prog.textContent = t('localLlm.models.pull_starting')
  try {
    const res = await fetch('/api/local-llm/pull', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model }),
    })
    const d = await res.json()
    if (!res.ok) { prog.textContent = d.error || t('localLlm.load_error'); return }
    llmPollPull(d.job_id)
  } catch {
    prog.textContent = t('localLlm.load_error')
  }
}

function llmPollPull(jobId) {
  const prog = document.getElementById('llmPullProgress')
  if (_llmPullTimer) clearInterval(_llmPullTimer)
  _llmPullTimer = setInterval(async () => {
    try {
      const res = await fetch(`/api/local-llm/pull-status?job_id=${encodeURIComponent(jobId)}`)
      const d = await res.json()
      if (!res.ok) { prog.textContent = d.error || t('localLlm.load_error'); clearInterval(_llmPullTimer); return }
      if (d.done) {
        clearInterval(_llmPullTimer)
        if (d.ok) {
          prog.textContent = t('localLlm.models.pull_done', { model: d.model })
          showToast(t('localLlm.models.pull_done', { model: d.model }))
          llmRefreshStatus()
          llmRefreshRecs()
        } else {
          prog.textContent = (d.error || t('localLlm.models.pull_failed'))
        }
      } else {
        prog.textContent = `${t('localLlm.models.pulling')}: ${d.last_line || ''}`
      }
    } catch {
      prog.textContent = t('localLlm.load_error')
      clearInterval(_llmPullTimer)
    }
  }, 1500)
}

async function llmRunTest() {
  const promptEl = document.getElementById('llmTestPrompt')
  const out = document.getElementById('llmTestOutput')
  const btn = document.getElementById('llmTestBtn')
  const prompt = (promptEl.value || '').trim()
  if (!prompt) { showToast(t('localLlm.test.empty')); return }
  out.hidden = false
  out.className = 'llm-test-output'
  out.textContent = t('localLlm.test.running')
  btn.disabled = true
  try {
    const res = await fetch('/api/local-llm/run', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ prompt }),
    })
    const d = await res.json()
    if (!res.ok) {
      out.className = 'llm-test-output error'
      out.textContent = d.error || t('localLlm.load_error')
    } else {
      out.className = 'llm-test-output'
      out.textContent = d.response || t('localLlm.test.no_output')
    }
  } catch {
    out.className = 'llm-test-output error'
    out.textContent = t('localLlm.load_error')
  } finally {
    btn.disabled = false
  }
}

async function llmRefreshLogs() {
  const term = document.getElementById('llmTerminal')
  if (!term) return
  try {
    const res = await fetch(`/api/local-llm/logs?source=${_llmLogSource}&lines=200`)
    const d = await res.json()
    if (d.note && (!d.lines || d.lines.length === 0)) {
      term.innerHTML = `<span class="llm-muted">${escapeHtml(d.note)}</span>`
      return
    }
    const lines = Array.isArray(d.lines) ? d.lines : []
    // Preserve scroll-at-bottom behaviour.
    const atBottom = term.scrollHeight - term.scrollTop - term.clientHeight < 40
    term.textContent = lines.length ? lines.join('\n') : t('localLlm.logs.empty')
    if (atBottom) term.scrollTop = term.scrollHeight
  } catch {
    term.innerHTML = `<span class="llm-muted">${t('localLlm.load_error')}</span>`
  }
}

// Wire the local-llm page controls once at load.
;(function initLocalLlm() {
  const refreshBtn = document.getElementById('llmRefreshBtn')
  if (refreshBtn) refreshBtn.addEventListener('click', () => { llmRefreshStatus(); llmRefreshRecs(); llmRefreshLogs(); llmRefreshUsage(); llmRefreshQueue(); llmRefreshCategories() })
  // Close any open category info-tooltip (card 8b4ddcf0) on outside click or Escape. Bound once
  // here rather than per-render, since llmRefreshCategories() re-renders the list on every poll.
  document.addEventListener('click', (e) => {
    const list = document.getElementById('llmCategoriesList')
    if (!list || list.contains(e.target)) return
    list.querySelectorAll('.llm-category-tooltip').forEach(t => { t.hidden = true })
    list.querySelectorAll('.llm-category-info-btn').forEach(b => b.setAttribute('aria-expanded', 'false'))
  })
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return
    const list = document.getElementById('llmCategoriesList')
    if (!list) return
    list.querySelectorAll('.llm-category-tooltip').forEach(t => { t.hidden = true })
    list.querySelectorAll('.llm-category-info-btn').forEach(b => b.setAttribute('aria-expanded', 'false'))
  })
  const hfBtn = document.getElementById('llmHfSearchBtn')
  if (hfBtn) hfBtn.addEventListener('click', () => llmHfSearch())
  const hfQuery = document.getElementById('llmHfQuery')
  if (hfQuery) hfQuery.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); llmHfSearch() } })
  const pullBtn = document.getElementById('llmPullBtn')
  if (pullBtn) pullBtn.addEventListener('click', () => llmStartPull())
  const testBtn = document.getElementById('llmTestBtn')
  if (testBtn) testBtn.addEventListener('click', llmRunTest)
  const promptEl = document.getElementById('llmTestPrompt')
  const countEl = document.getElementById('llmTestCount')
  if (promptEl && countEl) {
    const upd = () => { countEl.textContent = `${promptEl.value.length} / 4000` }
    promptEl.addEventListener('input', upd)
    upd()
  }
  document.querySelectorAll('.llm-log-tab').forEach(tab => {
    tab.addEventListener('click', () => {
      document.querySelectorAll('.llm-log-tab').forEach(x => x.classList.remove('active'))
      tab.classList.add('active')
      _llmLogSource = tab.dataset.source === 'ollama' ? 'ollama' : 'bridge'
      llmRefreshLogs()
    })
  })
})()

document.getElementById('refreshStatusBtn').addEventListener('click', loadStatus)

async function loadStatus() {
  const overallEl = document.getElementById('statusOverall')
  const gridEl = document.getElementById('statusServiceGrid')
  const listEl = document.getElementById('statusIncidentList')

  overallEl.className = 'status-overall unknown'
  overallEl.textContent = t('status.loading')
  gridEl.innerHTML = ''
  listEl.innerHTML = ''

  try {
    const res = await fetch('/api/status')
    const data = await res.json()

    // Overall status
    const overallLabels = {
      operational: () => t('status.overall.operational'),
      degraded: () => t('status.overall.degraded'),
      unknown: () => t('status.overall.unknown'),
    }
    overallEl.className = `status-overall ${data.overall}`
    const overallLabelRaw = overallLabels[data.overall]
    overallEl.textContent = overallLabelRaw ? (typeof overallLabelRaw === 'function' ? overallLabelRaw() : overallLabelRaw) : data.overall

    // Services grid: real per-service status from the Statuspage components API
    // (data.components). No more inventing a service list and substring-matching
    // incident text -- if the components feed is unavailable we say so honestly
    // instead of rendering a fake all-green grid.
    const components = Array.isArray(data.components) ? data.components : []
    if (components.length === 0) {
      gridEl.innerHTML = `<div class="status-service-empty" style="color:var(--text-muted);font-size:13px">${t('status.no_components')}</div>`
    } else {
      for (const c of components) {
        const ok = c.status === 'operational'
        const div = document.createElement('div')
        div.className = 'status-service'
        div.innerHTML = `
          <div class="status-service-dot ${ok ? 'operational' : 'degraded'}"></div>
          <span class="status-service-name">${escapeHtml(c.name)}</span>
          ${ok ? '' : `<span class="status-service-state" style="margin-left:auto;font-size:11px;color:var(--text-muted)">${escapeHtml((typeof STATUS_COMPONENT_LABELS[c.status] === 'function' ? STATUS_COMPONENT_LABELS[c.status]() : STATUS_COMPONENT_LABELS[c.status]) || c.status)}</span>`}
        `
        gridEl.appendChild(div)
      }
    }

    // Incidents
    if (data.incidents.length === 0) {
      listEl.innerHTML = `<div class="status-loading">${t('status.no_incidents')}</div>`
    } else {
      for (const inc of data.incidents) {
        const statusLabels = {
          resolved: () => t('status.incident.resolved'),
          monitoring: () => t('status.incident.monitoring'),
          identified: () => t('status.incident.identified'),
          investigating: () => t('status.incident.investigating'),
        }
        const div = document.createElement('div')
        div.className = `status-incident ${inc.status}`
        const date = new Date(inc.pubDate).toLocaleString('hu-HU', { timeZone: 'Europe/Budapest' })
        div.innerHTML = `
          <div class="status-incident-header">
            <span class="status-incident-title">${escapeHtml(inc.title)}</span>
            <span class="status-incident-badge ${inc.status}">${(typeof statusLabels[inc.status] === 'function' ? statusLabels[inc.status]() : statusLabels[inc.status]) || inc.status}</span>
          </div>
          <div class="status-incident-desc">${escapeHtml(inc.description.slice(0, 300))}</div>
          <div class="status-incident-date">${date}</div>
        `
        listEl.appendChild(div)
      }
    }
  } catch (err) {
    overallEl.className = 'status-overall unknown'
    overallEl.textContent = 'Nem sikerult betolteni a statuszt'
  }
}
