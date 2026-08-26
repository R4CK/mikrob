// app-archive-timeline.js -- Archived cards, Naplo (Audit Timeline), Kanban Gantt (slice 15).
// Loaded AFTER app.js in index.html; globals used from app.js:
//   t, escapeHtml, showToast, openModal, closeModal, switchPage
// openCardDetail used defensively (typeof check) -- defined elsewhere at runtime.
// === Archivalt kartyak ===
;(() => {
  let archivedInit = false

  const STATUS_LABELS = {
    planned:     () => t('kanban.status.planned'),
    in_progress: () => t('kanban.status.in_progress'),
    waiting:     () => t('kanban.status.waiting'),
    done:        () => t('kanban.status.done')
  }
  const STATUS_COLORS = { planned: '#6b7280', in_progress: '#3b82f6', waiting: '#f59e0b', done: '#10b981' }
  const PRIORITY_LABELS = {
    low:    () => t('kanban.priority.low'),
    normal: () => t('kanban.priority.normal'),
    high:   () => t('kanban.priority.high'),
    urgent: () => t('kanban.priority.urgent')
  }

  function fmtDate(unix) {
    if (!unix) return ''
    return new Date(unix * 1000).toLocaleString('hu-HU', { dateStyle: 'short', timeStyle: 'short' })
  }

  // Render an archived card with the same visual language as the live board:
  // project pill + #seq title + colored rounded priority/label chips, wrapped in
  // the .kanban-card frame. The whole card opens a read-only detail modal on
  // click; the restore button stops propagation so it doesn't also open it.
  function renderArchivedCard(card) {
    const prioLabel = PRIORITY_LABELS[card.priority]?.() ?? card.priority
    const seqHtml = card.seq != null
      ? `<span class="kanban-card-seq" style="font-family:monospace;font-size:11px;color:var(--text-muted);margin-right:5px">#${card.seq}</span>`
      : ''
    const projectHtml = card.project
      ? `<span class="kanban-card-project">${esc(card.project)}</span>`
      : ''
    let labelsHtml = ''
    if (Array.isArray(card.labels) && card.labels.length > 0) {
      const pills = card.labels
        .map(l => `<span class="kanban-card-label-pill" style="--label-color:${esc(l.color)}">#${esc(l.name)}</span>`)
        .join('')
      labelsHtml = `<div class="kanban-card-labels">${pills}</div>`
    }
    // Same .priority-badge as the live board (card e291e9c4) -- the old .archived-prio-pill used a
    // separate, low-contrast palette (translucent tint of the priority color, text IN that color),
    // exactly the class of problem Peti's screenshot flagged, just on a different page.
    const prioPill = `<span class="priority-badge priority-${esc(card.priority)}">${prioLabel}</span>`
    return `<div class="kanban-card archived-card" data-id="${esc(card.id)}" data-priority="${esc(card.priority)}">
      ${projectHtml}
      <div class="kanban-card-title">${seqHtml}${esc(card.title)}</div>
      <div class="kanban-card-footer">${prioPill}</div>
      ${labelsHtml}
      <div class="archived-card-foot">
        <span class="archived-date">${t('archived.label.archived_at', {date: fmtDate(card.archived_at)})}</span>
        <button class="btn-secondary btn-compact archived-restore-btn" data-id="${esc(card.id)}" title="${t('archived.btn.restore_to_board')}" style="white-space:nowrap;flex-shrink:0;">${t('archived.btn.restore')}</button>
      </div>
    </div>`
  }

  // Read-only detail modal for an archived card: meta grid, labels, description,
  // comments -- no editing affordances. Restore button mirrors the card button.
  async function showArchivedDetail(card) {
    const seqPrefix = card.seq != null ? `#${card.seq} ` : ''
    document.getElementById('archivedDetailTitle').textContent = `${seqPrefix}${card.title}`
    const meta = document.getElementById('archivedDetailMeta')
    const idLabel = (card.seq != null ? `#${card.seq} · ` : '') + card.id
    meta.innerHTML = `
      <div class="meta-item"><span class="meta-label">${t('kanban.meta.id')}</span><span class="meta-value" style="font-family:monospace">${esc(idLabel)}</span></div>
      <div class="meta-item"><span class="meta-label">${t('kanban.meta.status')}</span><span class="meta-value">${STATUS_LABELS[card.status]?.() ?? card.status}</span></div>
      <div class="meta-item"><span class="meta-label">${t('kanban.meta.assignee')}</span><span class="meta-value">${card.assignee ? esc(card.assignee) : t('kanban.meta.none')}</span></div>
      <div class="meta-item"><span class="meta-label">${t('kanban.meta.priority')}</span><span class="meta-value">${PRIORITY_LABELS[card.priority]?.() ?? card.priority}</span></div>
      <div class="meta-item"><span class="meta-label">${t('kanban.meta.project')}</span><span class="meta-value">${card.project ? esc(card.project) : t('kanban.meta.none')}</span></div>
      <div class="meta-item"><span class="meta-label">${t('archived.meta.archived_at')}</span><span class="meta-value">${fmtDate(card.archived_at)}</span></div>
    `
    const labelsWrap = document.getElementById('archivedDetailLabelsWrap')
    const labelsBox = document.getElementById('archivedDetailLabels')
    if (Array.isArray(card.labels) && card.labels.length > 0) {
      labelsBox.innerHTML = card.labels
        .map(l => `<span class="kanban-card-label-pill" style="--label-color:${esc(l.color)}">#${esc(l.name)}</span>`)
        .join('')
      labelsWrap.style.display = ''
    } else {
      labelsWrap.style.display = 'none'
    }
    document.getElementById('archivedDetailDesc').textContent = card.description || ''

    const commentsWrap = document.getElementById('archivedDetailCommentsWrap')
    const commentsBox = document.getElementById('archivedDetailComments')
    commentsBox.innerHTML = ''
    try {
      const res = await fetch(`/api/kanban/${encodeURIComponent(card.id)}/comments`)
      const comments = res.ok ? await res.json() : []
      if (Array.isArray(comments) && comments.length > 0) {
        for (const c of comments) {
          const date = new Date(c.created_at * 1000).toLocaleString('hu-HU')
          const div = document.createElement('div')
          div.className = 'comment-item'
          div.innerHTML = `<div><span class="comment-author">${esc(c.author)}</span><span class="comment-date">${date}</span></div><div class="comment-body">${esc(c.content)}</div>`
          commentsBox.appendChild(div)
        }
        commentsWrap.style.display = ''
      } else {
        commentsWrap.style.display = 'none'
      }
    } catch { commentsWrap.style.display = 'none' }

    const restoreBtn = document.getElementById('archivedDetailRestoreBtn')
    restoreBtn.disabled = false
    restoreBtn.textContent = t('archived.btn.restore_to_board')
    restoreBtn.onclick = async () => {
      restoreBtn.disabled = true
      restoreBtn.textContent = t('archived.btn.restoring')
      try {
        const resp = await fetch(`/api/kanban/${encodeURIComponent(card.id)}/unarchive`, { method: 'POST' })
        if (resp.ok) {
          closeModal(document.getElementById('archivedDetailOverlay'))
          doArchivedSearch()
        } else {
          restoreBtn.disabled = false
          restoreBtn.textContent = t('archived.btn.restore_to_board')
          showToast(t('archived.restore_error'))
        }
      } catch {
        restoreBtn.disabled = false
        restoreBtn.textContent = t('archived.btn.restore_to_board')
      }
    }
    openModal(document.getElementById('archivedDetailOverlay'))
  }

  async function populateArchivedProjects() {
    try {
      const r = await fetch('/api/kanban-projects')
      if (!r.ok) return
      const projects = await r.json()
      const sel = document.getElementById('archivedProject')
      const cur = sel.value
      sel.innerHTML = '<option value="">' + t('archived.filter.all_projects') + '</option>'
      for (const p of projects) {
        const opt = document.createElement('option')
        opt.value = p
        opt.textContent = p
        if (p === cur) opt.selected = true
        sel.appendChild(opt)
      }
    } catch { /* best-effort */ }
  }

  async function doArchivedSearch() {
    const list = document.getElementById('archivedList')
    const summary = document.getElementById('archivedSummary')
    list.className = ''
    list.innerHTML = '<p class="naplo-empty">' + t('common.loading') + '</p>'
    summary.textContent = ''

    const params = new URLSearchParams()
    const q = document.getElementById('archivedQ').value.trim()
    const project = document.getElementById('archivedProject').value
    const from = document.getElementById('archivedFrom').value
    const to = document.getElementById('archivedTo').value
    if (q) params.set('q', q)
    if (project) params.set('project', project)
    if (from) params.set('from', Math.floor(new Date(from).getTime() / 1000))
    if (to) params.set('to', Math.floor(new Date(to + 'T23:59:59').getTime() / 1000))

    try {
      const r = await fetch('/api/kanban/archived?' + params.toString())
      if (!r.ok) { list.innerHTML = '<p class="naplo-empty error">' + t('archived.error.http', {status: r.status}) + '</p>'; return }
      const data = await r.json()
      const cards = data.cards || []
      summary.textContent = t('archived.summary', {count: cards.length, limit: data.limit})
      if (cards.length === 0) { list.innerHTML = '<p class="naplo-empty">' + t('archived.empty') + '</p>'; return }
      list.className = 'archived-grid'
      list.innerHTML = cards.map(renderArchivedCard).join('')
      const byId = new Map(cards.map(c => [c.id, c]))
      // Whole card opens the read-only detail; restore button acts on its own.
      list.querySelectorAll('.archived-card').forEach(el => {
        el.addEventListener('click', () => {
          const card = byId.get(el.dataset.id)
          if (card) showArchivedDetail(card)
        })
      })
      list.querySelectorAll('.archived-restore-btn').forEach(btn => {
        btn.addEventListener('click', async (e) => {
          e.stopPropagation()
          const id = btn.dataset.id
          btn.disabled = true
          btn.textContent = '...'
          try {
            const resp = await fetch(`/api/kanban/${id}/unarchive`, { method: 'POST' })
            if (resp.ok) {
              const cardEl = btn.closest('.archived-card')
              if (cardEl) cardEl.style.opacity = '0.4'
              btn.textContent = t('archived.btn.restored')
            } else {
              btn.disabled = false
              btn.textContent = t('archived.btn.restore')
              showToast(t('archived.restore_error'))
            }
          } catch {
            btn.disabled = false
            btn.textContent = t('archived.btn.restore')
          }
        })
      })
    } catch (err) {
      list.innerHTML = '<p class="naplo-empty error">' + t('common.error_network', {msg: err.message}) + '</p>'
    }
  }

  function loadArchivedPage() {
    if (!archivedInit) {
      archivedInit = true
      document.getElementById('archivedSearchBtn').addEventListener('click', doArchivedSearch)
      document.getElementById('archivedRefreshBtn').addEventListener('click', doArchivedSearch)
      document.getElementById('archivedQ').addEventListener('keydown', e => { if (e.key === 'Enter') doArchivedSearch() })
      // Back button mirrors the kanban row's Archivaltak entry point; explicit
      // switchPage (not history.back) so it works on direct-link arrivals too.
      const backBtn = document.getElementById('archivedBackToKanban')
      if (backBtn) backBtn.addEventListener('click', () => switchPage('kanban'))
      const adOverlay = document.getElementById('archivedDetailOverlay')
      document.getElementById('archivedDetailClose').addEventListener('click', () => closeModal(adOverlay))
      attachOverlayCloseGuard(adOverlay)
    }
    populateArchivedProjects()
    doArchivedSearch()
  }

  window.loadArchivedPage = loadArchivedPage
})()

// === Naplo (Audit Timeline) ===
;(() => {
  let naploInitialized = false
  let naploActiveSource = ''

  const SOURCE_LABELS = { config: () => t('naplo.source.config'), idea: () => t('naplo.source.idea'), store: () => t('naplo.source.store'), diary: () => t('naplo.source.diary') }
  const SOURCE_COLORS = { config: '#3b82f6', idea: '#10b981', store: '#f59e0b', diary: '#8b5cf6' }
  const DIARY_ENTRY_LABELS = { log: () => t('naplo.diary.log_badge'), memory: () => t('naplo.diary.memory_badge') }
  const DIARY_ENTRY_COLORS = { log: '#6b7280', memory: '#a78bfa' }

  function fmtTs(unix) {
    return new Date(unix * 1000).toLocaleString('hu-HU', { dateStyle: 'short', timeStyle: 'short' })
  }

  function renderEntry(e) {
    const sourceColor = SOURCE_COLORS[e.source] || '#6b7280'
    const sourceLabelRaw = SOURCE_LABELS[e.source]; const sourceLabel = sourceLabelRaw ? (typeof sourceLabelRaw === 'function' ? sourceLabelRaw() : sourceLabelRaw) : e.source
    const badge = `<span class="naplo-badge" style="background:${sourceColor}">${sourceLabel}</span>`
    const ts = `<span class="naplo-ts">${fmtTs(e.created_at)}</span>`
    let detail = ''
    if (e.source === 'config') {
      const oldV = e.old_value != null ? `<code>${esc(e.old_value)}</code>` : '<em>nincs</em>'
      const newV = e.new_value != null ? `<code>${esc(e.new_value)}</code>` : '<em>nincs</em>'
      detail = `<strong>${esc(e.key)}</strong> ${oldV} &rarr; ${newV} <span class="naplo-actor">${esc(e.actor || '')}</span>`
    } else if (e.source === 'idea') {
      const from = e.from_status ? `<code>${esc(e.from_status)}</code> &rarr; ` : ''
      detail = `<strong>${esc(e.idea_id)}</strong> ${from}<code>${esc(e.to_status)}</code>`
      if (e.note) detail += ` <span class="naplo-note">${esc(e.note)}</span>`
      if (e.actor) detail += ` <span class="naplo-actor">${esc(e.actor)}</span>`
    } else if (e.source === 'store') {
      const sizeStr = e.file_size != null ? ` (${(e.file_size / 1024).toFixed(1)} KB)` : ''
      const agentStr = e.agent ? ` <span class="naplo-actor">${esc(e.agent)}</span>` : ''
      const sens = e.is_sensitive ? ` <span class="naplo-sensitive">${t('naplo.entry.sensitive')}</span>` : ''
      detail = `<code>${esc(e.rel_path)}</code> <span class="naplo-event-type">${esc(e.event_type)}</span>${sizeStr}${agentStr}${sens}`
    } else if (e.source === 'diary') {
      const entryColor = DIARY_ENTRY_COLORS[e.entry_type] || '#6b7280'
      const entryLabelRaw = DIARY_ENTRY_LABELS[e.entry_type]; const entryLabel = entryLabelRaw ? (typeof entryLabelRaw === 'function' ? entryLabelRaw() : entryLabelRaw) : e.entry_type
      const entryBadge = `<span class="naplo-badge" style="background:${entryColor};font-size:10px">${entryLabel}</span>`
      const agentStr = e.agent_id ? ` <span class="naplo-actor">${esc(e.agent_id)}</span>` : ''
      let contentSnippet = esc(e.content || '').replace(/\n/g, ' ').slice(0, 200)
      if ((e.content || '').length > 200) contentSnippet += '…'
      const keywordsStr = e.keywords ? `<div class="naplo-note" style="margin-top:2px">Kulcsszavak: ${esc(e.keywords)}</div>` : ''
      const catStr = e.category ? ` <span class="naplo-event-type">${esc(e.category)}</span>` : ''
      detail = `${entryBadge}${catStr}${agentStr}<div class="naplo-diary-content">${contentSnippet}</div>${keywordsStr}`
    }
    return `<div class="naplo-entry"><div class="naplo-entry-meta">${ts}${badge}</div><div class="naplo-entry-detail">${detail}</div></div>`
  }

  async function doNaplo() {
    const timeline = document.getElementById('naplo-timeline')
    const summary = document.getElementById('naplo-summary')
    timeline.innerHTML = `<p class="naplo-empty">${t('naplo.loading')}</p>`
    summary.textContent = ''

    const params = new URLSearchParams()
    if (naploActiveSource) params.set('source', naploActiveSource)
    const from = document.getElementById('naplo-from').value
    const to = document.getElementById('naplo-to').value
    const q = document.getElementById('naplo-q').value.trim()
    const agentEl = document.getElementById('naplo-agent')
    const agentVal = agentEl ? agentEl.value.trim() : ''
    if (from) params.set('from', Math.floor(new Date(from).getTime() / 1000))
    if (to)   params.set('to', Math.floor(new Date(to + 'T23:59:59').getTime() / 1000))
    if (q)    params.set('q', q)
    if (agentVal) params.set('agent', agentVal)
    params.set('limit', '200')

    try {
      const res = await fetch('/api/audit-log?' + params.toString())
      if (!res.ok) { timeline.innerHTML = `<p class="naplo-empty error">Hiba: ${res.status}</p>`; return }
      const data = await res.json()
      const entries = data.entries || []
      summary.textContent = t('naplo.summary', { n: entries.length })
      if (entries.length === 0) { timeline.innerHTML = `<p class="naplo-empty">${t('naplo.empty')}</p>`; return }
      timeline.innerHTML = entries.map(renderEntry).join('')
    } catch (err) {
      timeline.innerHTML = `<p class="naplo-empty error">${t('naplo.error', { msg: err.message })}</p>`
    }
  }

  function loadNaplo() {
    if (!naploInitialized) {
      naploInitialized = true
      document.querySelectorAll('#naplo-source-tabs .naplo-tab').forEach((btn) => {
        btn.addEventListener('click', () => {
          document.querySelectorAll('#naplo-source-tabs .naplo-tab').forEach((b) => b.classList.remove('active'))
          btn.classList.add('active')
          naploActiveSource = btn.dataset.source
          const agentFilter = document.getElementById('naplo-agent-wrap')
          if (agentFilter) agentFilter.style.display = naploActiveSource === 'diary' ? '' : 'none'
          doNaplo()
        })
      })
      document.getElementById('naplo-search-btn').addEventListener('click', doNaplo)
      document.getElementById('naplo-q').addEventListener('keydown', (e) => { if (e.key === 'Enter') doNaplo() })
      document.getElementById('naplo-refresh-btn').addEventListener('click', doNaplo)
    }
    doNaplo()
  }

  window.loadNaplo = loadNaplo
})()

// === Kanban Gantt / timeline view ===
;(function () {
  // --- State ---
  let ganttPeriod = 'week'  // 'week' | 'month' | 'quarter'
  let ganttPeriodOffset = 0  // periods stepped from the current one (0 = current, -1 = prev, +1 = next)
  let ganttOverdueOnly = false
  let _initialized = false

  // --- Color map by status (vars from theme) ---
  const STATUS_COLOR = {
    planned:     { bg: 'var(--accent)',  border: 'var(--accent)' },
    in_progress: { bg: '#4f8ef7',        border: '#3a7be0' },
    waiting:     { bg: '#e8a838',        border: '#c88c20' },
    done:        { bg: '#3dbf79',        border: '#28a560' },
  }

  // Period window: returns { rangeStart: Date, rangeEnd: Date } (midnight boundaries)
  function periodWindow() {
    const now = new Date()
    const start = new Date(now)
    start.setHours(0, 0, 0, 0)
    const end = new Date(start)
    if (ganttPeriod === 'week') {
      // Mon..Sun of current week, shifted by ganttPeriodOffset weeks
      const dow = (start.getDay() + 6) % 7  // Mon=0
      start.setDate(start.getDate() - dow + ganttPeriodOffset * 7)
      end.setTime(start.getTime())
      end.setDate(start.getDate() + 7)
    } else if (ganttPeriod === 'month') {
      start.setDate(1)
      start.setMonth(start.getMonth() + ganttPeriodOffset)
      end.setFullYear(start.getFullYear(), start.getMonth() + 1, 1)
    } else {  // quarter
      const qStart = Math.floor(start.getMonth() / 3) * 3 + ganttPeriodOffset * 3
      start.setMonth(qStart, 1)
      end.setFullYear(start.getFullYear(), start.getMonth() + 3, 1)
    }
    return { rangeStart: start, rangeEnd: end }
  }

  // Format date as short label (e.g. "jún 15" / "Jun 15")
  function fmtDateShort(d) {
    return d.toLocaleDateString(typeof _lang !== 'undefined' && _lang === 'en' ? 'en-US' : 'hu-HU', { month: 'short', day: 'numeric' })
  }

  // Return header tick labels for the visible range
  function buildHeaderTicks(rangeStart, rangeEnd) {
    const ticks = []
    const totalMs = rangeEnd - rangeStart
    // Aim for ~5-8 ticks; snap to day boundaries
    let stepDays = 1
    if (ganttPeriod === 'month') stepDays = 7
    else if (ganttPeriod === 'quarter') stepDays = 14
    const cur = new Date(rangeStart)
    while (cur < rangeEnd) {
      ticks.push({
        date: new Date(cur),
        pct: (cur - rangeStart) / totalMs * 100,
      })
      cur.setDate(cur.getDate() + stepDays)
    }
    return ticks
  }

  // Group visible cards by project (or 'Nincs projekt' for null)
  function groupCardsByProject(cards) {
    const map = new Map()
    for (const c of cards) {
      const key = c.project || t('kanban.gantt.no_project')
      if (!map.has(key)) map.set(key, [])
      map.get(key).push(c)
    }
    return map
  }

  // Build and inject the Gantt DOM into #kanbanGanttView
  function renderGantt() {
    const container = document.getElementById('kanbanGanttView')
    if (!container) return
    container.innerHTML = ''

    const { rangeStart, rangeEnd } = periodWindow()
    const totalMs = rangeEnd - rangeStart
    const nowMs = Date.now()
    const todayPct = Math.max(0, Math.min(100, (nowMs - rangeStart) / totalMs * 100))

    // Filter: cards that have a due_date
    let cards = (Array.isArray(kanbanCards) ? kanbanCards : []).filter(c => c.due_date)

    if (ganttOverdueOnly) {
      // Keep cards that are overdue OR due within 7 days
      const cutoff = (nowMs + 7 * 86400000) / 1000
      cards = cards.filter(c => c.due_date <= cutoff / 1 && c.status !== 'done')
    }

    // Exclude cards whose entire bar lies outside the window
    cards = cards.filter(c => {
      const barStart = c.created_at ? c.created_at * 1000 : rangeStart.getTime()
      const barEnd   = c.due_date * 1000
      return barEnd >= rangeStart && barStart <= rangeEnd
    })

    if (cards.length === 0) {
      container.innerHTML = `<p style="color:var(--muted);padding:24px 0;text-align:center;">${t('kanban.gantt.no_cards')}</p>`
      return
    }

    const grouped = groupCardsByProject(cards)

    // --- Outer layout ---
    const wrap = document.createElement('div')
    wrap.className = 'gantt-wrap'
    wrap.style.cssText = 'display:flex;flex-direction:column;overflow:hidden;'

    // --- Header row: left label + tick strip ---
    const headerRow = document.createElement('div')
    headerRow.style.cssText = 'display:flex;border-bottom:1px solid var(--border);margin-bottom:4px;'

    const headerLabel = document.createElement('div')
    headerLabel.style.cssText = 'width:220px;min-width:220px;font-size:12px;color:var(--muted);padding:4px 8px;border-right:1px solid var(--border);'
    headerLabel.textContent = t('kanban.gantt.col_label')
    headerRow.appendChild(headerLabel)

    const headerTrack = document.createElement('div')
    headerTrack.style.cssText = 'flex:1;position:relative;height:28px;overflow:hidden;'
    const ticks = buildHeaderTicks(rangeStart, rangeEnd)
    for (const tick of ticks) {
      const el = document.createElement('div')
      el.style.cssText = `position:absolute;left:${tick.pct.toFixed(2)}%;transform:translateX(-50%);font-size:11px;color:var(--muted);top:6px;white-space:nowrap;`
      el.textContent = fmtDateShort(tick.date)
      headerTrack.appendChild(el)
    }
    // Today marker in header
    if (todayPct >= 0 && todayPct <= 100) {
      const todayHead = document.createElement('div')
      todayHead.style.cssText = `position:absolute;left:${todayPct.toFixed(2)}%;top:0;bottom:0;width:2px;background:var(--danger,#e05252);opacity:0.6;`
      headerTrack.appendChild(todayHead)
    }
    headerRow.appendChild(headerTrack)
    wrap.appendChild(headerRow)

    // --- Body rows ---
    const body = document.createElement('div')
    body.style.cssText = 'overflow-y:auto;max-height:70vh;'

    for (const [project, projCards] of grouped) {
      // Group header
      const groupHeader = document.createElement('div')
      groupHeader.style.cssText = 'display:flex;align-items:center;background:var(--bg2,var(--sidebar-bg));border-bottom:1px solid var(--border);'
      const ghLabel = document.createElement('div')
      ghLabel.style.cssText = 'width:220px;min-width:220px;font-size:12px;font-weight:600;color:var(--fg);padding:5px 8px;border-right:1px solid var(--border);'
      ghLabel.textContent = `${project} (${projCards.length})`
      groupHeader.appendChild(ghLabel)
      const ghStripe = document.createElement('div')
      ghStripe.style.cssText = 'flex:1;height:26px;background:var(--bg2,var(--sidebar-bg));'
      groupHeader.appendChild(ghStripe)
      body.appendChild(groupHeader)

      // Card rows
      for (const card of projCards) {
        const barStartMs = card.created_at ? card.created_at * 1000 : rangeStart.getTime()
        const barEndMs   = card.due_date * 1000
        const isOverdue  = card.status !== 'done' && barEndMs < nowMs

        // Clamp to window
        const clampedStart = Math.max(barStartMs, rangeStart.getTime())
        const clampedEnd   = Math.min(barEndMs,   rangeEnd.getTime())
        const leftPct  = (clampedStart - rangeStart) / totalMs * 100
        const widthPct = Math.max(0.5, (clampedEnd - clampedStart) / totalMs * 100)

        const col = isOverdue ? { bg: 'var(--danger,#e05252)', border: '#b83030' }
                              : (STATUS_COLOR[card.status] || STATUS_COLOR.planned)

        const row = document.createElement('div')
        row.style.cssText = 'display:flex;align-items:center;border-bottom:1px solid var(--border);min-height:32px;'

        const rowLabel = document.createElement('div')
        rowLabel.style.cssText = 'width:220px;min-width:220px;font-size:12px;color:var(--fg);padding:4px 8px;border-right:1px solid var(--border);overflow:hidden;white-space:nowrap;text-overflow:ellipsis;cursor:pointer;'
        rowLabel.title = card.title
        // Show the running display number (#N, card.seq) like the board, not the hex id.
        const seqLabel = card.seq != null ? `#${card.seq}` : `#${card.id}`
        rowLabel.textContent = `${seqLabel} ${card.title}`
        rowLabel.addEventListener('click', () => { if (typeof openCardDetail === 'function') openCardDetail(card.id) })

        const rowTrack = document.createElement('div')
        rowTrack.style.cssText = 'flex:1;position:relative;height:32px;overflow:hidden;'

        // Today line (in each row)
        if (todayPct >= 0 && todayPct <= 100) {
          const tl = document.createElement('div')
          tl.style.cssText = `position:absolute;left:${todayPct.toFixed(2)}%;top:0;bottom:0;width:2px;background:var(--danger,#e05252);z-index:1;pointer-events:none;`
          rowTrack.appendChild(tl)
        }

        const bar = document.createElement('div')
        bar.style.cssText = [
          `position:absolute`,
          `left:${leftPct.toFixed(2)}%`,
          `width:${widthPct.toFixed(2)}%`,
          `top:5px`,
          `bottom:5px`,
          `background:${col.bg}`,
          `border:1px solid ${col.border}`,
          `border-radius:4px`,
          `overflow:hidden`,
          `white-space:nowrap`,
          `font-size:11px`,
          `color:#fff`,
          `display:flex`,
          `align-items:center`,
          `padding:0 6px`,
          `box-sizing:border-box`,
          `cursor:pointer`,
          `z-index:2`,
          isOverdue ? 'background-image:repeating-linear-gradient(45deg,rgba(0,0,0,.12) 0px,rgba(0,0,0,.12) 4px,transparent 4px,transparent 8px)' : '',
        ].filter(Boolean).join(';')
        bar.title = `${seqLabel} ${card.title}\n${fmtDateShort(new Date(barStartMs))} - ${fmtDateShort(new Date(barEndMs))}`
        bar.textContent = `${seqLabel} ${card.title}`
        bar.addEventListener('click', () => { if (typeof openCardDetail === 'function') openCardDetail(card.id) })
        rowTrack.appendChild(bar)
        row.appendChild(rowLabel)
        row.appendChild(rowTrack)
        body.appendChild(row)
      }
    }

    wrap.appendChild(body)

    // --- Legend ---
    const legend = document.createElement('div')
    legend.style.cssText = 'display:flex;align-items:center;gap:16px;margin-top:10px;font-size:12px;flex-wrap:wrap;'
    const legendItems = [
      { key: 'planned',     color: STATUS_COLOR.planned.bg },
      { key: 'in_progress', color: STATUS_COLOR.in_progress.bg },
      { key: 'waiting',     color: STATUS_COLOR.waiting.bg },
      { key: 'done',        color: STATUS_COLOR.done.bg },
      { key: 'overdue',     color: 'var(--danger,#e05252)' },
    ]
    for (const item of legendItems) {
      const dot = document.createElement('span')
      dot.innerHTML = `<span style="display:inline-block;width:12px;height:12px;border-radius:2px;background:${item.color};vertical-align:middle;margin-right:4px;"></span>${t('kanban.gantt.legend.' + item.key)}`
      legend.appendChild(dot)
    }
    const todayLegend = document.createElement('span')
    todayLegend.style.cssText = 'margin-left:auto;color:var(--muted);'
    todayLegend.innerHTML = `<span style="display:inline-block;width:12px;height:2px;background:var(--danger,#e05252);vertical-align:middle;margin-right:4px;"></span>${t('kanban.gantt.legend.today')}`
    legend.appendChild(todayLegend)
    wrap.appendChild(legend)

    container.appendChild(wrap)

    // --- Period stepper (below the timeline): step back/forward by one period unit ---
    const nav = document.createElement('div')
    nav.style.cssText = 'display:flex;align-items:center;justify-content:center;gap:10px;margin-top:12px;'
    const prevBtn = document.createElement('button')
    prevBtn.className = 'view-btn'
    prevBtn.style.cssText = 'width:auto;padding:0 14px;'
    prevBtn.textContent = '‹ ' + t('kanban.gantt.nav_prev')
    prevBtn.addEventListener('click', () => { ganttPeriodOffset--; renderGantt() })
    const rangeLbl = document.createElement('span')
    rangeLbl.style.cssText = 'font-size:12px;color:var(--muted);min-width:130px;text-align:center;'
    rangeLbl.textContent = `${fmtDateShort(rangeStart)} - ${fmtDateShort(new Date(rangeEnd.getTime() - 1))}`
    const nextBtn = document.createElement('button')
    nextBtn.className = 'view-btn'
    nextBtn.style.cssText = 'width:auto;padding:0 14px;'
    nextBtn.textContent = t('kanban.gantt.nav_next') + ' ›'
    nextBtn.addEventListener('click', () => { ganttPeriodOffset++; renderGantt() })
    nav.append(prevBtn, rangeLbl, nextBtn)
    container.appendChild(nav)
  }

  // --- View switcher init (called once after DOM ready) ---
  function initGanttViewSwitcher() {
    if (_initialized) return
    _initialized = true

    const boardBtn  = document.getElementById('kanbanViewBoard')
    const ganttBtn  = document.getElementById('kanbanViewGantt')
    const boardFilters = document.getElementById('kanbanBoardFilters')
    const ganttFilters = document.getElementById('kanbanGanttFilters')
    const boardEls  = [document.getElementById('kanbanBoard'), document.getElementById('kanbanSwimlaneBoard')]
    const ganttEl   = document.getElementById('kanbanGanttView')

    function activateBoard() {
      boardBtn.classList.add('active')
      ganttBtn.classList.remove('active')
      boardFilters.style.display = 'flex'
      ganttFilters.style.display = 'none'
      boardEls.forEach(el => { if (el) el.style.removeProperty('display') })
      ganttEl.style.display = 'none'
    }

    function activateGantt() {
      ganttBtn.classList.add('active')
      boardBtn.classList.remove('active')
      ganttFilters.style.display = 'flex'
      boardFilters.style.display = 'none'
      boardEls.forEach(el => { if (el) el.style.display = 'none' })
      ganttEl.style.display = 'block'
      renderGantt()
    }

    boardBtn.addEventListener('click', activateBoard)
    ganttBtn.addEventListener('click', activateGantt)

    // Archived button: navigates AWAY to the archived page (its sidebar entry
    // was removed -- this button is now the entry point). It never takes the
    // 'active' state here because leaving the kanban page hides the row.
    const archivedBtn = document.getElementById('kanbanViewArchived')
    if (archivedBtn) archivedBtn.addEventListener('click', () => switchPage('archived'))

    // Period buttons
    document.querySelectorAll('#kanbanGanttFilters [data-period]').forEach(btn => {
      btn.addEventListener('click', () => {
        ganttPeriod = btn.dataset.period
        ganttPeriodOffset = 0  // recenter on the current period when switching granularity
        document.querySelectorAll('#kanbanGanttFilters [data-period]').forEach(b => b.classList.remove('active'))
        btn.classList.add('active')
        renderGantt()
      })
    })

    // Overdue toggle
    const overdueChk = document.getElementById('ganttOverdueOnly')
    if (overdueChk) {
      overdueChk.addEventListener('change', () => {
        ganttOverdueOnly = overdueChk.checked
        renderGantt()
      })
    }

    // Re-render on data refresh (hook into global loadKanban completion)
    const _origRenderKanban = window.renderKanban
    if (typeof _origRenderKanban === 'function') {
      window.renderKanban = function () {
        _origRenderKanban.apply(this, arguments)
        if (ganttEl.style.display !== 'none') renderGantt()
      }
    }
  }

  window._initGanttViewSwitcher = initGanttViewSwitcher
  window.renderGantt = renderGantt
})()
