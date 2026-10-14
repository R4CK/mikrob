// app-gemini-calls.js -- Gemini (agy) calls panel: dedicated page + Overview tile (card 57da740c).
// Loaded AFTER app-overview.js in index.html. Globals used: t, escapeHtml, switchPage.
//
// CONTRACT-FIRST (contract-first-codev skill): GET /api/gemini-calls is Pair-BE 64788453, not
// landed yet at the time this file was written. Contract confirmed by backend (inter-agent
// msg_id 11816, src/web/routes/gemini-calls.ts tryHandleGeminiCalls):
//   { quota: { used, limit:5, windowStart, nextFreeAt: number|null },
//     stop:  { active, reason: string|null },
//     calls: [{ ts, model, caller, cardId, taskType,
//               status: 'ok'|'error'|'blocked'|'timeout'|'started',
//               durationS, tokens,
//               rating: { result: 'elfogadva'|'javitva'|'eldobva', score, opinion } | null }],
//       -- calls sorted newest-first by the backend, rendered as given.
//     summary: { byModel: { [model]: {calls,ok,error,blocked} },
//                byTaskType: { [taskType]: {calls,ok,error,blocked} } } }
// summary does NOT carry avgScore/unrated (the card wants both in the "összesítő" table) --
// geminiSummaryEntries() below derives them per bucket from the calls array itself, so the two
// tables can never disagree with the call log underneath them. The prompt's content never
// reaches this endpoint (sha256 only, per the card) -- nothing here reads or displays prompt text.
//
// 404 (endpoint not landed yet) renders an honest "not available yet" state on the dedicated
// page (rule 12: no invented data) and hides the Overview tile gracefully, same convention as
// loadCostEstimatesWidget() in app-overview.js.

function geminiFmtTime(epochMs) {
  const d = new Date(epochMs)
  return d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })
}

function geminiFmtDuration(s) {
  if (s == null) return '—'
  return s >= 60 ? `${Math.floor(s / 60)}m ${Math.round(s % 60)}s` : `${s.toFixed(1)}s`
}

function geminiFmtTokens(n) {
  if (n == null) return '—'
  return n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n)
}

function geminiStatusLabel(status) {
  const key = 'geminiCalls.status.' + (status || 'unknown')
  const label = t(key)
  return label === key ? (status || '—') : label
}

function geminiRatingHtml(rating) {
  if (!rating) {
    return `<span class="gemini-unrated" title="${escapeHtml(t('geminiCalls.rating.unrated_title'))}">${escapeHtml(t('geminiCalls.rating.unrated'))}</span>`
  }
  // rating.result is the backend's own raw enum value ('elfogadva'/'javitva'/'eldobva', per
  // backend msg 11816) -- used directly as the i18n key suffix, with a translation-miss fallback
  // to the raw value so an unexpected future enum member still shows something, not a blank.
  const resultKey = 'geminiCalls.rating.result.' + (rating.result || 'unknown')
  const resultLabel = t(resultKey) === resultKey ? (rating.result || '—') : t(resultKey)
  const scoreCls = (rating.score || 0) >= 7 ? 'good' : (rating.score || 0) >= 4 ? 'mid' : 'bad'
  return `<span class="gemini-rating">
    <span class="gemini-rating-result">${escapeHtml(resultLabel)}</span>
    <span class="gemini-rating-score gemini-rating-score--${scoreCls}">${rating.score ?? '—'}/10</span>
  </span>${rating.opinion ? `<span class="gemini-rating-opinion" title="${escapeHtml(rating.opinion)}">${escapeHtml(rating.opinion)}</span>` : ''}`
}

// Converts the backend's object-keyed bucket (e.g. summary.byModel) into the row shape
// geminiSummaryTableHtml renders, deriving avgScore/unrated from the calls array itself
// (field = 'model' or 'taskType') rather than trusting a second, potentially-stale count.
function geminiSummaryEntries(bucket, calls, field) {
  if (!bucket || typeof bucket !== 'object') return []
  const callList = Array.isArray(calls) ? calls : []
  return Object.keys(bucket).map((key) => {
    const b = bucket[key] || {}
    const rated = callList.filter((c) => c[field] === key && c.rating)
    const unrated = callList.filter((c) => c[field] === key && !c.rating).length
    const avgScore = rated.length
      ? rated.reduce((sum, c) => sum + (c.rating.score || 0), 0) / rated.length
      : null
    return { key, total: b.calls || 0, ok: b.ok || 0, avgScore, unrated }
  })
}

function geminiSummaryTableHtml(rows, keyLabelPrefix) {
  if (!Array.isArray(rows) || rows.length === 0) {
    return `<p class="gemini-empty">${escapeHtml(t('geminiCalls.summary.empty'))}</p>`
  }
  const body = rows.map((r) => {
    const total = r.total || 0
    const okPct = total > 0 ? Math.round(((r.ok || 0) / total) * 100) : 0
    const avgScoreText = r.avgScore == null ? '—' : r.avgScore.toFixed(1)
    const label = t(keyLabelPrefix + '.' + r.key) === (keyLabelPrefix + '.' + r.key) ? r.key : t(keyLabelPrefix + '.' + r.key)
    return `<tr>
      <td>${escapeHtml(label)}</td>
      <td class="gemini-num">${total}</td>
      <td class="gemini-num">${okPct}%</td>
      <td class="gemini-num">${escapeHtml(avgScoreText)}</td>
      <td class="gemini-num">${r.unrated || 0}</td>
    </tr>`
  }).join('')
  return `<table class="gemini-summary-table">
    <thead><tr>
      <th>${t('geminiCalls.summary.col_key')}</th>
      <th class="gemini-num">${t('geminiCalls.summary.col_total')}</th>
      <th class="gemini-num">${t('geminiCalls.summary.col_ok_pct')}</th>
      <th class="gemini-num">${t('geminiCalls.summary.col_avg_score')}</th>
      <th class="gemini-num">${t('geminiCalls.summary.col_unrated')}</th>
    </tr></thead>
    <tbody>${body}</tbody>
  </table>`
}

function geminiRenderQuota(quota) {
  const bar = document.getElementById('geminiQuotaBar')
  const fill = document.getElementById('geminiQuotaBarFill')
  const label = document.getElementById('geminiQuotaLabel')
  const nextFree = document.getElementById('geminiQuotaNextFree')
  if (!bar || !quota) return
  const used = quota.used || 0
  const limit = quota.limit || 5
  const pct = Math.max(0, Math.min(100, Math.round((used / limit) * 100)))
  if (fill) {
    fill.style.width = pct + '%'
    fill.style.background = pct >= 100 ? 'var(--danger)' : pct >= 60 ? 'var(--accent)' : 'var(--success)'
  }
  if (label) label.textContent = t('geminiCalls.quota.label', { used, limit })
  if (nextFree) {
    nextFree.textContent = used >= limit && quota.nextFreeAt
      ? t('geminiCalls.quota.next_free', { at: geminiFmtTime(quota.nextFreeAt) })
      : ''
  }
}

function geminiRenderStop(stop) {
  const banner = document.getElementById('geminiStopBanner')
  const reasonEl = document.getElementById('geminiStopReason')
  if (!banner) return
  if (stop && stop.active) {
    if (reasonEl) reasonEl.textContent = stop.reason || t('geminiCalls.stop.reason_unknown')
    banner.hidden = false
  } else {
    banner.hidden = true
  }
}

function geminiRenderCallsTable(calls) {
  const wrap = document.getElementById('geminiCallsTableWrap')
  if (!wrap) return
  if (!Array.isArray(calls) || calls.length === 0) {
    wrap.innerHTML = `<p class="gemini-empty">${escapeHtml(t('geminiCalls.list.empty'))}</p>`
    return
  }
  const body = calls.map((c) => `<tr>
    <td>${escapeHtml(geminiFmtTime(c.ts))}</td>
    <td>${escapeHtml(c.model || '—')}</td>
    <td>${escapeHtml(c.caller || '—')}</td>
    <td>${c.cardId ? escapeHtml(c.cardId) : '—'}</td>
    <td>${escapeHtml(c.taskType || '—')}</td>
    <td><span class="gemini-status gemini-status--${escapeHtml(c.status || 'unknown')}">${escapeHtml(geminiStatusLabel(c.status))}</span></td>
    <td class="gemini-num">${escapeHtml(geminiFmtDuration(c.durationS))}</td>
    <td class="gemini-num">${escapeHtml(geminiFmtTokens(c.tokens))}</td>
    <td>${geminiRatingHtml(c.rating)}</td>
  </tr>`).join('')
  wrap.innerHTML = `<table class="gemini-calls-table">
    <thead><tr>
      <th>${t('geminiCalls.list.col_time')}</th>
      <th>${t('geminiCalls.list.col_model')}</th>
      <th>${t('geminiCalls.list.col_caller')}</th>
      <th>${t('geminiCalls.list.col_card')}</th>
      <th>${t('geminiCalls.list.col_task')}</th>
      <th>${t('geminiCalls.list.col_status')}</th>
      <th class="gemini-num">${t('geminiCalls.list.col_duration')}</th>
      <th class="gemini-num">${t('geminiCalls.list.col_tokens')}</th>
      <th>${t('geminiCalls.list.col_rating')}</th>
    </tr></thead>
    <tbody>${body}</tbody>
  </table>`
}

// --- Dedicated page (sidebar: STATISZTIKÁK > Gemini hívások) ---------------------------------
async function loadGeminiCalls() {
  const statusEl = document.getElementById('geminiPageStatus')
  const bodyEl = document.getElementById('geminiPageBody')
  if (!bodyEl) return
  if (statusEl) { statusEl.hidden = false; statusEl.textContent = t('common.loading'); statusEl.className = 'gemini-page-status' }
  const token = localStorage.getItem('marveen-dashboard-token') || ''
  try {
    const res = await fetch('/api/gemini-calls', { headers: { Authorization: 'Bearer ' + token } })
    if (res.status === 404) {
      if (statusEl) { statusEl.textContent = t('geminiCalls.not_available'); statusEl.className = 'gemini-page-status gemini-page-status--muted' }
      bodyEl.hidden = true
      return
    }
    if (!res.ok) throw new Error('HTTP ' + res.status)
    const d = await res.json()
    if (statusEl) statusEl.hidden = true
    bodyEl.hidden = false

    geminiRenderQuota(d.quota)
    geminiRenderStop(d.stop)

    const byModelEl = document.getElementById('geminiSummaryByModel')
    if (byModelEl) {
      const rows = geminiSummaryEntries(d.summary && d.summary.byModel, d.calls, 'model')
      byModelEl.innerHTML = geminiSummaryTableHtml(rows, 'geminiCalls.model')
    }
    const byTaskEl = document.getElementById('geminiSummaryByTaskType')
    if (byTaskEl) {
      const rows = geminiSummaryEntries(d.summary && d.summary.byTaskType, d.calls, 'taskType')
      byTaskEl.innerHTML = geminiSummaryTableHtml(rows, 'geminiCalls.taskType')
    }

    geminiRenderCallsTable(d.calls)
  } catch (err) {
    if (statusEl) { statusEl.hidden = false; statusEl.textContent = t('geminiCalls.load_error'); statusEl.className = 'gemini-page-status gemini-page-status--error' }
    bodyEl.hidden = true
  }
}

// --- Overview tile (card 57da740c, Peti 11285) -----------------------------------------------
// Mirrors loadCostEstimatesWidget()'s hide-on-404 convention: the tile is optional context, the
// dedicated page is where an honest "not available yet" message belongs.
async function loadGeminiOverviewTile() {
  const card = document.getElementById('ovwGeminiCard')
  if (!card) return
  const token = localStorage.getItem('marveen-dashboard-token') || ''
  try {
    const res = await fetch('/api/gemini-calls', { headers: { Authorization: 'Bearer ' + token } })
    if (res.status === 404) { card.hidden = true; return }
    if (!res.ok) throw new Error('HTTP ' + res.status)
    const d = await res.json()

    const quota = d.quota || {}
    const used = quota.used || 0
    const limit = quota.limit || 5
    const fillEl = document.getElementById('ovwGeminiBarFill')
    if (fillEl) {
      const pct = Math.max(0, Math.min(100, Math.round((used / limit) * 100)))
      fillEl.style.width = pct + '%'
      fillEl.style.background = pct >= 100 ? 'var(--danger)' : pct >= 60 ? 'var(--accent)' : 'var(--success)'
    }
    const labelEl = document.getElementById('ovwGeminiQuotaLabel')
    if (labelEl) labelEl.textContent = t('geminiCalls.quota.label', { used, limit })

    const todayStart = new Date(); todayStart.setHours(0, 0, 0, 0)
    const todayCount = Array.isArray(d.calls) ? d.calls.filter((c) => c.ts >= todayStart.getTime()).length : 0
    const todayEl = document.getElementById('ovwGeminiToday')
    if (todayEl) todayEl.textContent = t('geminiCalls.overview.today', { n: todayCount })

    const stopBadge = document.getElementById('ovwGeminiStopBadge')
    if (stopBadge) stopBadge.hidden = !(d.stop && d.stop.active)

    card.hidden = false
  } catch {
    card.hidden = true
  }
}
