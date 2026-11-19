// web/app-llm-ledger.js -- LLM usage ledger dashboard (card 52c48470)
// API: GET /api/llm-ledger/summary?days=N
//      GET/PUT /api/llm-ledger/budget/:agentId
// Globals resolved at call time: t(), escapeHtml(), showToast()
// Exposes: initLlmLedgerPage() (called from switchPage in app-page-switch.js)

let _llmLedgerDays = 7
let _llmLedgerBound = false
let _llmLedgerLastData = null

function llmLedgerFmt(n) {
  if (n == null || isNaN(n)) return '—'
  return Number(n).toLocaleString()
}

function llmLedgerPct(ok, total) {
  if (!total) return '—'
  return Math.round((ok / total) * 100) + '%'
}

function llmLedgerAcceptPct(accepted, ok) {
  if (!ok) return '—'
  return Math.round((accepted / ok) * 100) + '%'
}

function llmLedgerLatency(ms) {
  if (ms == null || isNaN(ms)) return '—'
  if (ms < 1000) return Math.round(ms) + ' ms'
  return (ms / 1000).toFixed(1) + ' s'
}

function llmLedgerSetLoading(on) {
  const el = document.getElementById('llmLedgerLoading')
  if (el) el.hidden = !on
}

function llmLedgerSetError(msg) {
  const el = document.getElementById('llmLedgerError')
  if (!el) return
  if (msg) {
    el.hidden = false
    el.textContent = msg
  } else {
    el.hidden = true
    el.textContent = ''
  }
}

function llmLedgerSetEmpty(on) {
  const el = document.getElementById('llmLedgerEmpty')
  if (el) el.hidden = !on
}

function llmLedgerRenderProviders(providers) {
  const tbody = document.getElementById('llmLedgerProvidersTbody')
  if (!tbody) return
  if (!providers || providers.length === 0) {
    tbody.innerHTML = `<tr><td colspan="6" class="llm-ledger-no-data">${escapeHtml(t('llmLedger.table.no_data'))}</td></tr>`
    return
  }
  tbody.innerHTML = providers.map((r) => `
    <tr>
      <td class="llm-ledger-provider-name">${escapeHtml(r.provider)}</td>
      <td class="llm-ledger-num">${escapeHtml(llmLedgerFmt(r.calls))}</td>
      <td class="llm-ledger-num">${llmLedgerPct(r.ok, r.calls)}</td>
      <td class="llm-ledger-num">${llmLedgerAcceptPct(r.accepted, r.ok)}</td>
      <td class="llm-ledger-num">${llmLedgerLatency(r.avg_latency_ms)}</td>
      <td class="llm-ledger-num llm-ledger-tokens-saved">${escapeHtml(llmLedgerFmt(r.claude_token_equiv_saved))}</td>
    </tr>
  `).join('')
}

function llmLedgerRenderTaskTypes(taskTypes) {
  const tbody = document.getElementById('llmLedgerTaskTypesTbody')
  if (!tbody) return
  if (!taskTypes || taskTypes.length === 0) {
    tbody.innerHTML = `<tr><td colspan="4" class="llm-ledger-no-data">${escapeHtml(t('llmLedger.table.no_data'))}</td></tr>`
    return
  }
  tbody.innerHTML = taskTypes.map((r) => `
    <tr>
      <td class="llm-ledger-provider-name">${escapeHtml(r.task_type)}</td>
      <td class="llm-ledger-num">${escapeHtml(llmLedgerFmt(r.calls))}</td>
      <td class="llm-ledger-num">${llmLedgerPct(r.ok, r.calls)}</td>
      <td class="llm-ledger-num llm-ledger-tokens-saved">${escapeHtml(llmLedgerFmt(r.claude_token_equiv_saved))}</td>
    </tr>
  `).join('')
}

function llmLedgerRenderAgents(agents) {
  const tbody = document.getElementById('llmLedgerAgentsTbody')
  if (!tbody) return
  if (!agents || agents.length === 0) {
    tbody.innerHTML = `<tr><td colspan="5" class="llm-ledger-no-data">${escapeHtml(t('llmLedger.table.no_data'))}</td></tr>`
    return
  }
  tbody.innerHTML = agents.map((r) => `
    <tr data-agent-id="${escapeHtml(r.agent_id)}">
      <td class="llm-ledger-provider-name">${escapeHtml(r.agent_id)}</td>
      <td class="llm-ledger-num">${escapeHtml(llmLedgerFmt(r.calls))}</td>
      <td class="llm-ledger-num">${llmLedgerPct(r.ok, r.calls)}</td>
      <td class="llm-ledger-num llm-ledger-tokens-saved">${escapeHtml(llmLedgerFmt(r.claude_token_equiv_saved))}</td>
      <td class="llm-ledger-budget-cell">
        <span class="llm-ledger-budget-view" data-role="budget-view">${escapeHtml(llmLedgerFmt(r.daily_budget))}<span class="llm-ledger-budget-source ${escapeHtml(r.budget_source)}">${escapeHtml(t('llmLedger.budget.source.' + r.budget_source))}</span></span>
        <input type="number" class="llm-ledger-budget-input" data-role="budget-input" value="${Number(r.daily_budget)}" min="0" step="1000" hidden aria-label="${escapeHtml(t('llmLedger.budget.input_label', { agent: r.agent_id }))}">
        <div class="llm-ledger-budget-actions" data-role="budget-actions">
          <button class="btn-secondary btn-compact" data-act="edit-budget">${escapeHtml(t('llmLedger.budget.edit'))}</button>
          <button class="btn-primary btn-compact" data-act="save-budget" hidden>${escapeHtml(t('llmLedger.budget.save'))}</button>
          <button class="btn-secondary btn-compact" data-act="cancel-budget" hidden>${escapeHtml(t('llmLedger.budget.cancel'))}</button>
        </div>
      </td>
    </tr>
  `).join('')
}

function llmLedgerRenderTotals(totals) {
  const el = document.getElementById('llmLedgerTotals')
  if (!el || !totals) return
  el.hidden = false
  el.innerHTML = `
    <span class="llm-ledger-total-item">
      <span class="llm-ledger-total-label">${escapeHtml(t('llmLedger.totals.calls'))}</span>
      <span class="llm-ledger-total-value">${escapeHtml(llmLedgerFmt(totals.calls))}</span>
    </span>
    <span class="llm-ledger-total-item">
      <span class="llm-ledger-total-label">${escapeHtml(t('llmLedger.totals.ok'))}</span>
      <span class="llm-ledger-total-value">${llmLedgerPct(totals.ok, totals.calls)}</span>
    </span>
    <span class="llm-ledger-total-item llm-ledger-tokens-saved">
      <span class="llm-ledger-total-label">${escapeHtml(t('llmLedger.totals.saved_tokens'))}</span>
      <span class="llm-ledger-total-value">${escapeHtml(llmLedgerFmt(totals.claude_token_equiv_saved))}</span>
    </span>
  `
}

async function loadLlmLedger() {
  llmLedgerSetLoading(true)
  llmLedgerSetError(null)
  llmLedgerSetEmpty(false)
  const totalsEl = document.getElementById('llmLedgerTotals')
  if (totalsEl) totalsEl.hidden = true

  try {
    const res = await fetch('/api/llm-ledger/summary?days=' + _llmLedgerDays)
    if (!res.ok) throw new Error('HTTP ' + res.status)
    const data = await res.json()
    _llmLedgerLastData = data

    const hasData = (data.totals?.calls ?? 0) > 0
    llmLedgerSetEmpty(!hasData)

    llmLedgerRenderProviders(data.providers)
    llmLedgerRenderTaskTypes(data.task_types)
    llmLedgerRenderAgents(data.agents)
    if (hasData) llmLedgerRenderTotals(data.totals)
  } catch (err) {
    console.error('loadLlmLedger failed:', err)
    llmLedgerSetError(t('llmLedger.load_error'))
  } finally {
    llmLedgerSetLoading(false)
  }
}

async function llmLedgerSaveBudget(row, agentId, newBudget) {
  const saveBtn = row.querySelector('[data-act="save-budget"]')
  if (saveBtn) { saveBtn.disabled = true; saveBtn.textContent = t('llmLedger.budget.saving') }
  try {
    const res = await fetch('/api/llm-ledger/budget/' + encodeURIComponent(agentId), {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ daily_budget: newBudget }),
    })
    if (!res.ok) {
      const body = await res.json().catch(() => ({}))
      throw new Error(body.error || 'HTTP ' + res.status)
    }
    const data = await res.json()

    // Update view
    const view = row.querySelector('[data-role="budget-view"]')
    const input = row.querySelector('[data-role="budget-input"]')
    if (view) view.innerHTML = escapeHtml(llmLedgerFmt(data.daily_budget)) + `<span class="llm-ledger-budget-source override">${escapeHtml(t('llmLedger.budget.source.override'))}</span>`
    if (input) input.value = data.daily_budget
    llmLedgerToggleBudgetEdit(row, false)
    showToast(t('common.saved'))
  } catch (err) {
    if (saveBtn) { saveBtn.disabled = false; saveBtn.textContent = t('llmLedger.budget.save') }
    showToast(t('llmLedger.budget.save_error') + ' ' + err.message)
  }
}

function llmLedgerToggleBudgetEdit(row, editing) {
  const view = row.querySelector('[data-role="budget-view"]')
  const input = row.querySelector('[data-role="budget-input"]')
  const editBtn = row.querySelector('[data-act="edit-budget"]')
  const saveBtn = row.querySelector('[data-act="save-budget"]')
  const cancelBtn = row.querySelector('[data-act="cancel-budget"]')
  if (!view || !input || !editBtn || !saveBtn || !cancelBtn) return
  view.hidden = editing
  input.hidden = !editing
  editBtn.hidden = editing
  saveBtn.hidden = !editing
  cancelBtn.hidden = !editing
  if (editing) {
    input.focus()
    if (saveBtn.disabled) { saveBtn.disabled = false; saveBtn.textContent = t('llmLedger.budget.save') }
  }
}

let _llmLedgerTableBound = false
function setupLlmLedgerTableClick() {
  if (_llmLedgerTableBound) return
  _llmLedgerTableBound = true
  document.getElementById('llmLedgerAgentsTbody')?.addEventListener('click', async (e) => {
    const row = e.target.closest('tr[data-agent-id]')
    if (!row) return
    const agentId = row.dataset.agentId

    if (e.target.closest('[data-act="edit-budget"]')) {
      llmLedgerToggleBudgetEdit(row, true)
      return
    }
    if (e.target.closest('[data-act="cancel-budget"]')) {
      llmLedgerToggleBudgetEdit(row, false)
      return
    }
    if (e.target.closest('[data-act="save-budget"]')) {
      const input = row.querySelector('[data-role="budget-input"]')
      if (!input) return
      const val = parseInt(input.value, 10)
      if (isNaN(val) || val < 0) {
        showToast(t('llmLedger.budget.invalid'))
        return
      }
      await llmLedgerSaveBudget(row, agentId, val)
    }
  })
}

let _llmLedgerDaysBound = false
function setupLlmLedgerDaysFilter() {
  if (_llmLedgerDaysBound) return
  _llmLedgerDaysBound = true
  document.getElementById('llmLedgerDays7')?.addEventListener('click', () => {
    if (_llmLedgerDays === 7) return
    _llmLedgerDays = 7
    llmLedgerSyncDaysBtns()
    loadLlmLedger()
  })
  document.getElementById('llmLedgerDays30')?.addEventListener('click', () => {
    if (_llmLedgerDays === 30) return
    _llmLedgerDays = 30
    llmLedgerSyncDaysBtns()
    loadLlmLedger()
  })
  document.getElementById('llmLedgerRefreshBtn')?.addEventListener('click', () => loadLlmLedger())
}

function llmLedgerSyncDaysBtns() {
  const btn7 = document.getElementById('llmLedgerDays7')
  const btn30 = document.getElementById('llmLedgerDays30')
  if (btn7) btn7.classList.toggle('active', _llmLedgerDays === 7)
  if (btn30) btn30.classList.toggle('active', _llmLedgerDays === 30)
}

function initLlmLedgerPage() {
  if (!_llmLedgerBound) {
    _llmLedgerBound = true
    setupLlmLedgerDaysFilter()
    setupLlmLedgerTableClick()
    llmLedgerSyncDaysBtns()
  }
  loadLlmLedger()
}
