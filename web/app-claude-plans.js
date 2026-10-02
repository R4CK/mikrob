// app-claude-plans.js -- Settings "Claude plans" tab: plan-list + add-form widget
// over store/claude-plans.json, plus GET /api/claude-plans/state for the
// active-plan / last-known-usage badges (app.js modularisation, ported alongside
// upstream batch 3, card c6e8a919).
// Globals from app.js/app-helpers.js: t, escapeHtml
// Globals from app-auth-bootstrap.js: mainAgentId
// Called from app-device-keys.js: loadSettings (tab registration), activateSettingsTab

// The "active" dot reflects the MAIN agent's entry in activePlanByAgent (PR2c,
// design decision #1: the state is per-agent, but this tab only shows the one
// that also drives the dashboard header). There is still no manual rotate
// button here: this tab lets the operator view and hand-edit the registry, the
// same way it already lets them for store/claude-plans.json by hand; actual
// rotation is triggered by the heartbeat script or POST /api/claude-plans/rotate
// directly.
async function renderClaudePlansPanel(body) {
  body.innerHTML = `
    <p style="color:var(--text-muted);font-size:13px;margin:0 0 16px">${t('settings.claude_plans.intro')}</p>
    <div id="claudePlansList"></div>
    <div class="claude-plans-add-form">
      <div class="form-row">
        <div class="form-group" style="flex:1">
          <label>${t('settings.claude_plans.form.id')}</label>
          <input class="input" id="cpFormId" placeholder="personal-2">
        </div>
        <div class="form-group" style="flex:1">
          <label>${t('settings.claude_plans.form.label')}</label>
          <input class="input" id="cpFormLabel" placeholder="Second Pro">
        </div>
      </div>
      <div class="form-row">
        <div class="form-group" style="flex:2">
          <label>${t('settings.claude_plans.form.config_dir')}</label>
          <input class="input" id="cpFormConfigDir" placeholder="~/.claude-second">
        </div>
        <div class="form-group" style="flex:1">
          <label>${t('settings.claude_plans.form.type')}</label>
          <select class="input" id="cpFormType">
            <option value="personal">${t('settings.claude_plans.form.type_personal')}</option>
            <option value="team">${t('settings.claude_plans.form.type_team')}</option>
          </select>
        </div>
      </div>
      <label class="claude-plans-checkbox-row">
        <input type="checkbox" id="cpFormChannelsAllowed" checked>
        <span>${t('settings.claude_plans.form.channels_allowed')}</span>
      </label>
      <div id="cpFormError" class="settings-row-error" hidden></div>
      <button class="btn-secondary btn-compact" id="cpFormAddBtn" style="margin-top:12px">${t('settings.claude_plans.form.add_btn')}</button>
    </div>
  `

  document.getElementById('cpFormAddBtn').addEventListener('click', () => addClaudePlan())
  for (const id of ['cpFormId', 'cpFormLabel', 'cpFormConfigDir']) {
    document.getElementById(id).addEventListener('keydown', (e) => { if (e.key === 'Enter') addClaudePlan() })
  }

  await loadClaudePlansList()
}

async function addClaudePlan() {
  const errEl = document.getElementById('cpFormError')
  errEl.hidden = true
  const id = document.getElementById('cpFormId').value.trim()
  const label = document.getElementById('cpFormLabel').value.trim()
  const configDir = document.getElementById('cpFormConfigDir').value.trim()
  const planType = document.getElementById('cpFormType').value
  const channelsAllowed = document.getElementById('cpFormChannelsAllowed').checked

  if (!id || !label || !configDir) {
    errEl.textContent = t('settings.claude_plans.form.error_required')
    errEl.hidden = false
    return
  }

  try {
    const res = await fetch('/api/claude-plans', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id, label, configDir, planType, channelsAllowed }),
    })
    const data = await res.json()
    if (!res.ok) {
      errEl.textContent = data.error || t('settings.claude_plans.form.error_generic')
      errEl.hidden = false
      return
    }
    document.getElementById('cpFormId').value = ''
    document.getElementById('cpFormLabel').value = ''
    document.getElementById('cpFormConfigDir').value = ''
    document.getElementById('cpFormChannelsAllowed').checked = true
    await loadClaudePlansList()
  } catch {
    errEl.textContent = t('settings.claude_plans.form.error_generic')
    errEl.hidden = false
  }
}

async function deleteClaudePlan(id) {
  if (!confirm(t('settings.claude_plans.confirm_delete', { id }))) return
  await fetch(`/api/claude-plans/${encodeURIComponent(id)}`, { method: 'DELETE' })
  await loadClaudePlansList()
}

async function loadClaudePlansList() {
  const list = document.getElementById('claudePlansList')
  if (!list) return
  list.innerHTML = `<p style="color:var(--text-muted);font-size:13px">${t('common.loading')}</p>`
  try {
    const [plansRes, stateRes] = await Promise.all([
      fetch('/api/claude-plans'),
      fetch('/api/claude-plans/state'),
    ])
    const plans = plansRes.ok ? await plansRes.json() : []
    const state = stateRes.ok ? await stateRes.json() : { activePlanByAgent: {}, plans: {} }

    if (!plans.length) {
      list.innerHTML = `<p style="color:var(--text-muted);font-size:13px">${t('settings.claude_plans.empty')}</p>`
      return
    }

    list.innerHTML = ''
    for (const plan of plans) {
      const observed = state.plans?.[plan.id]
      const fiveHour = observed?.windows?.five_hour
      const isActive = state.activePlanByAgent?.[mainAgentId()] === plan.id

      const row = document.createElement('div')
      row.className = 'claude-plan-row'

      const main = document.createElement('div')
      main.style.flex = '1'
      const mainLine = document.createElement('div')
      mainLine.className = 'claude-plan-row-main'
      mainLine.innerHTML = `
        ${isActive ? `<span class="claude-plan-active-dot" title="${t('settings.claude_plans.active')}"></span>` : ''}
        <strong>${escapeHtml(plan.label)}</strong>
        <span class="claude-plan-badge">${plan.planType === 'team' ? t('settings.claude_plans.form.type_team') : t('settings.claude_plans.form.type_personal')}</span>
        ${!plan.channelsAllowed ? `<span class="claude-plan-badge claude-plan-badge-muted">${t('settings.claude_plans.no_channels')}</span>` : ''}
        ${fiveHour ? `<span class="claude-plan-badge">${t('settings.claude_plans.last_known', { pct: Math.round(fiveHour.usedPercent) })}</span>` : ''}
      `
      main.appendChild(mainLine)

      const meta = document.createElement('div')
      meta.className = 'claude-plan-row-meta'
      meta.textContent = `${plan.id} · ${plan.configDir}`
      main.appendChild(meta)

      row.appendChild(main)

      const delBtn = document.createElement('button')
      delBtn.className = 'claude-plan-delete'
      delBtn.title = t('common.btn.delete')
      delBtn.textContent = '×'
      delBtn.addEventListener('click', () => deleteClaudePlan(plan.id))
      row.appendChild(delBtn)

      list.appendChild(row)
    }
  } catch {
    list.innerHTML = `<p style="color:var(--danger);font-size:13px">${t('settings.error')}</p>`
  }
}
