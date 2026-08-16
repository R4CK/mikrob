// === app-import-migration.js ===
// CostOps cost ledger, Memory Import, Agent Migration (Költöztetés), Fleet Migration.
// Extracted from app.js as part of modularisation (slice 19/N).
// This file is loaded AFTER app.js via a synchronous <script> tag in index.html.
//
// Globals used from app.js: t, escapeHtml, showToast, openModal, closeModal
// Functions callable from app.js (event-time only): loadCosts, loadMigrateAgents

// ============================================================
// === CostOps (v0.1, PR #524): local cost ledger summary ===
// ============================================================

document.getElementById('refreshCostsBtn').addEventListener('click', loadCosts)

async function loadCosts() {
  const el = document.getElementById('costsContent')
  const mutedStyle = 'color:var(--text-muted);font-size:13px'
  el.innerHTML = `<div style="${mutedStyle}">${t('costs.loading')}</div>`
  try {
    const res = await fetch('/api/costs/summary')
    const s = await res.json()
    if (!res.ok) throw new Error(s?.error || 'request failed')

    const fmtMoney = (n) => (typeof n === 'number' ? n.toLocaleString('hu-HU') : '—') + ' ' + escapeHtml(s.currency || '')

    let html = ''

    if (!s.config_present) {
      html += `<div style="${mutedStyle};margin-bottom:12px">${t('costs.no_config')}</div>`
    }

    html += `<div class="overview-stats">
      <div class="overview-stat"><div class="overview-stat-value">${fmtMoney(s.current_spend)}</div><div class="overview-stat-label">${t('costs.current_spend')}</div></div>
      <div class="overview-stat"><div class="overview-stat-value">${fmtMoney(s.forecast_month_end)}</div><div class="overview-stat-label">${t('costs.forecast')}</div></div>
      <div class="overview-stat"><div class="overview-stat-value">${escapeHtml(s.month || '—')}</div><div class="overview-stat-label">${t('costs.month')}</div></div>
    </div>`

    if (s.budget) {
      const pct = Math.round((s.budget.used_pct || 0) * 100)
      const color = s.budget.status === 'hard' ? 'var(--danger,#e74c3c)' : s.budget.status === 'warning' ? 'var(--warn,#e0a800)' : 'var(--text-muted)'
      html += `<div style="margin-top:16px;padding:12px 16px;border:1px solid var(--border,#333);border-radius:8px">
        <div style="font-weight:600;margin-bottom:6px">${t('costs.budget_title')}: ${escapeHtml(s.budget.id)} (${fmtMoney(s.budget.amount)})</div>
        <div style="${mutedStyle}">${t('costs.budget_used')}: <strong style="color:${color}">${pct}%</strong></div>
      </div>`
    }

    const sources = Array.isArray(s.all_sources) ? s.all_sources : []
    if (sources.length === 0) {
      html += `<div style="${mutedStyle};margin-top:12px">${t('costs.no_sources')}</div>`
    } else {
      html += `<div style="overflow-x:auto;margin-top:16px"><table style="width:100%;border-collapse:collapse">
        <thead><tr style="text-align:left;border-bottom:1px solid var(--border,#333)">
          <th style="padding:6px 8px">${t('costs.source_name')}</th><th style="padding:6px 8px">${t('costs.source_provider')}</th><th style="padding:6px 8px">${t('costs.source_spend')}</th>
        </tr></thead>
        <tbody>${sources.map((src) => `<tr style="border-bottom:1px solid var(--border,#222)">
          <td style="padding:6px 8px">${escapeHtml(src.name)}</td>
          <td style="padding:6px 8px;${mutedStyle}">${escapeHtml(src.provider)}</td>
          <td style="padding:6px 8px">${fmtMoney(src.spend)}</td>
        </tr>`).join('')}</tbody>
      </table></div>`
    }

    html += `<p style="${mutedStyle};margin-top:16px">${t('costs.token_usage_note')} (${(s.token_usage?.calls ?? 0)} ${t('costs.calls')}, ${(s.token_usage?.input_tokens ?? 0) + (s.token_usage?.output_tokens ?? 0)} tokens)</p>`

    el.innerHTML = html
  } catch (err) {
    el.innerHTML = `<div style="${mutedStyle}">${t('costs.load_failed')}</div>`
  }
}

// ============================================================
// === Memory Import ===
// ============================================================

const memImportOverlay = document.getElementById('memImportOverlay')
const memImportFileInput = document.getElementById('memImportFile')
const memImportFileArea = document.getElementById('memImportFileArea')
const memImportFileNames = document.getElementById('memImportFileNames')
const memImportSaveBtn = document.getElementById('memImportSaveBtn')
const memImportProgress = document.getElementById('memImportProgress')
const memImportStatus = document.getElementById('memImportStatus')
const memImportResult = document.getElementById('memImportResult')
let memImportFiles = []

// Open import modal
document.getElementById('memImportOpenBtn').addEventListener('click', () => {
  memImportFiles = []
  memImportFileInput.value = ''
  memImportFileNames.textContent = ''
  memImportProgress.hidden = true
  memImportResult.hidden = true
  memImportSaveBtn.querySelector('.btn-text').hidden = false
  memImportSaveBtn.querySelector('.btn-loading').hidden = true
  memImportSaveBtn.disabled = false

  // Populate agent dropdown from existing agents
  const importAgentSel = document.getElementById('memImportAgent')
  const memAgentSel = document.getElementById('memAgent')
  importAgentSel.innerHTML = memAgentSel.innerHTML
  openModal(memImportOverlay)
})

// Close import modal
document.getElementById('memImportClose').addEventListener('click', () => closeModal(memImportOverlay))
memImportOverlay.addEventListener('click', (e) => { if (e.target === memImportOverlay) closeModal(memImportOverlay) })

// File area click -> trigger file input
memImportFileArea.addEventListener('click', () => memImportFileInput.click())

// Drag and drop
memImportFileArea.addEventListener('dragover', (e) => {
  e.preventDefault()
  memImportFileArea.style.borderColor = 'var(--accent)'
})
memImportFileArea.addEventListener('dragleave', () => {
  memImportFileArea.style.borderColor = ''
})
memImportFileArea.addEventListener('drop', (e) => {
  e.preventDefault()
  memImportFileArea.style.borderColor = ''
  const files = Array.from(e.dataTransfer.files).filter(f =>
    f.name.endsWith('.md') || f.name.endsWith('.txt') || f.name.endsWith('.json')
  )
  if (files.length) {
    memImportFiles = files
    memImportFileNames.textContent = files.map(f => f.name).join(', ')
  }
})

// File input change
memImportFileInput.addEventListener('change', () => {
  memImportFiles = Array.from(memImportFileInput.files)
  memImportFileNames.textContent = memImportFiles.map(f => f.name).join(', ')
})

// Parse file into chunks (client-side)
async function parseFileToChunks(file) {
  const text = await file.text()
  const ext = file.name.split('.').pop().toLowerCase()

  if (ext === 'json') {
    try {
      const data = JSON.parse(text)
      if (Array.isArray(data)) {
        return data.map(item => {
          if (typeof item === 'object' && item !== null) return item.content || item.text || item.value || JSON.stringify(item)
          return String(item)
        }).filter(s => s.length > 20).map(s => s.slice(0, 2000))
      }
      return Object.entries(data).map(([k, v]) => `${k}: ${v}`).filter(s => s.length > 20).map(s => s.slice(0, 2000))
    } catch {
      return [text.slice(0, 2000)]
    }
  }

  // .md or .txt: split on double newlines or section headers
  const chunks = text
    .split(/\n{2,}|(?=^#{1,3} )/m)
    .map(s => s.trim())
    .filter(s => s.length > 20)
    .map(s => s.slice(0, 2000))
  return chunks.length ? chunks : [text.slice(0, 2000)]
}

// Save
memImportSaveBtn.addEventListener('click', async () => {
  if (!memImportFiles.length) {
    showToast(t('memories.toast.select_files'))
    return
  }
  const agentId = document.getElementById('memImportAgent').value
  const category = document.getElementById('memImportCategory').value
  const keywords = document.getElementById('memImportKeywords').value.trim()

  memImportSaveBtn.querySelector('.btn-text').hidden = true
  memImportSaveBtn.querySelector('.btn-loading').hidden = false
  memImportSaveBtn.disabled = true
  memImportProgress.hidden = false
  memImportStatus.textContent = t('memories.import.processing')
  memImportResult.hidden = true

  let totalChunks = 0
  let savedChunks = 0
  let failedChunks = 0
  const allChunks = []

  for (const file of memImportFiles) {
    const chunks = await parseFileToChunks(file)
    allChunks.push(...chunks)
  }
  totalChunks = allChunks.length

  for (let i = 0; i < allChunks.length; i++) {
    memImportStatus.textContent = t('memories.import.importing', { n: i + 1 }) + ` / ${totalChunks}...`
    try {
      const res = await fetch('/api/memories', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          agent_id: agentId || undefined,
          content: allChunks[i],
          category: category,
          keywords: keywords || undefined,
        }),
      })
      if (!res.ok) {
        const err = await res.json().catch(() => ({}))
        throw new Error(err.error || 'save failed')
      }
      savedChunks++
    } catch (err) {
      failedChunks++
    }
  }

  memImportSaveBtn.querySelector('.btn-text').hidden = false
  memImportSaveBtn.querySelector('.btn-loading').hidden = true
  memImportSaveBtn.disabled = false
  memImportStatus.textContent = ''
  memImportResult.hidden = false
  memImportResult.innerHTML = `<div style="color:var(--success,#27ae60)">${t('memories.toast.imported', { n: savedChunks })}</div>${failedChunks ? `<div style="color:var(--danger,#e74c3c)">${t('memories.toast.import_error')} (${failedChunks})</div>` : ''}`
})

// ============================================================
// === Költöztetés (Migration) ===
// ============================================================

let migrateFindings = []

async function loadMigrateAgents() {
  try {
    const res = await fetch('/api/schedules/agents')
    const agents = await res.json()
    const sel = document.getElementById('migrateAgent')
    sel.innerHTML = ''
    for (const a of agents) {
      const opt = document.createElement('option')
      opt.value = a.name
      opt.textContent = a.label || a.name
      sel.appendChild(opt)
    }
  } catch {}
}

// Step 1: Scan
document.getElementById('migrateScanBtn').addEventListener('click', async () => {
  const path = document.getElementById('migratePath').value.trim()
  if (!path) { document.getElementById('migratePath').focus(); return }

  const btn = document.getElementById('migrateScanBtn')
  btn.disabled = true
  btn.querySelector('.btn-text').hidden = true
  btn.querySelector('.btn-loading').hidden = false

  try {
    const res = await fetch('/api/migrate/scan', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sourcePath: path }),
    })
    const data = await res.json()
    if (!res.ok) throw new Error(data.error || 'Hiba')

    migrateFindings = data.findings
    renderMigrateFindings(data)

    document.getElementById('migrateStep1').hidden = true
    document.getElementById('migrateStep2').hidden = false
  } catch (err) {
    showToast(`Hiba: ${err.message}`)
  } finally {
    btn.disabled = false
    btn.querySelector('.btn-text').hidden = false
    btn.querySelector('.btn-loading').hidden = true
  }
})

function renderMigrateFindings(data) {
  const findingsEl = document.getElementById('migrateFindings')
  const summaryEl = document.getElementById('migrateSummary')

  const typeIcons = {
    'personality': '🎭',
    'skills': '📚',
    'channels': '📱',
    'memory': '🧠',
    'schedules': '🕒',
    'kanban': '📋',
  }

  summaryEl.innerHTML = `<strong>${data.agent_name || ''}</strong> &bull; ${data.findings?.length || 0} ${t('migrate.items_found')} &bull; ${data.source_type || ''}`

  if (!data.findings?.length) {
    findingsEl.innerHTML = `<div style="color:var(--text-muted);font-size:13px">${t('migrate.no_findings')}</div>`
    return
  }

  findingsEl.innerHTML = data.findings.map((f, i) =>
    `<label class="migrate-finding-row">
      <input type="checkbox" class="migrate-chk" data-idx="${i}" checked>
      <span class="migrate-type-icon">${typeIcons[f.type] || '⚙️'}</span>
      <span class="migrate-finding-type">${escapeHtml(f.type)}</span>
      <span class="migrate-finding-desc">${escapeHtml(f.description || '')}</span>
    </label>`
  ).join('')

  document.getElementById('migrateSelectAll').onclick = () => {
    document.querySelectorAll('.migrate-chk').forEach(c => c.checked = true)
  }
  document.getElementById('migrateDeselectAll').onclick = () => {
    document.querySelectorAll('.migrate-chk').forEach(c => c.checked = false)
  }
}

// Step 2: Import selected
document.getElementById('migrateImportBtn').addEventListener('click', async () => {
  const agentTarget = document.getElementById('migrateAgent').value
  const selected = Array.from(document.querySelectorAll('.migrate-chk:checked'))
    .map(c => migrateFindings[parseInt(c.dataset.idx)])
    .filter(Boolean)

  if (!selected.length) { showToast(t('migrate.none_selected')); return }

  const btn = document.getElementById('migrateImportBtn')
  btn.disabled = true
  btn.querySelector('.btn-text').hidden = true
  btn.querySelector('.btn-loading').hidden = false

  try {
    const path = document.getElementById('migratePath').value.trim()
    const res = await fetch('/api/migrate/run', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sourcePath: path, targetAgent: agentTarget, findings: selected }),
    })
    const data = await res.json()
    if (!res.ok) throw new Error(data.error || 'Hiba')
    showToast(t('migrate.success') + ': ' + (data.imported || 0))
    document.getElementById('migrateStep2').hidden = true
    document.getElementById('migrateStep1').hidden = false
    document.getElementById('migratePath').value = ''
  } catch (err) {
    showToast(`Hiba: ${err.message}`)
  } finally {
    btn.disabled = false
    btn.querySelector('.btn-text').hidden = false
    btn.querySelector('.btn-loading').hidden = true
  }
})

document.getElementById('migrateBackBtn').addEventListener('click', () => {
  document.getElementById('migrateStep2').hidden = true
  document.getElementById('migrateStep1').hidden = false
})

// ============================================================
// === Fleet Migration ===
// ============================================================

// Holds the last successfully parsed fleet JSON text (for apply after dry-run)
let fleetLastBody = null

document.getElementById('fleetExportBtn').addEventListener('click', async () => {
  const btn = document.getElementById('fleetExportBtn')
  const password = document.getElementById('fleetExportPassword').value.trim()

  btn.disabled = true
  btn.querySelector('.btn-text').hidden = true
  btn.querySelector('.btn-loading').hidden = false

  try {
    const headers = {}
    if (password) headers['X-Vault-Password'] = password

    const res = await fetch('/api/fleet/export', { headers })
    if (!res.ok) {
      const data = await res.json().catch(() => ({}))
      showToast(data.error || t('fleet.export.error'))
      return
    }

    const blob = await res.blob()
    const cd = res.headers.get('Content-Disposition') || ''
    const nameMatch = cd.match(/filename="?([^";\s]+)"?/)
    const filename = nameMatch ? nameMatch[1] : `fleet-export-${new Date().toISOString().slice(0, 10)}.json`

    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = filename
    document.body.appendChild(a)
    a.click()
    a.remove()
    URL.revokeObjectURL(url)

    showToast(t('fleet.export.success'))
  } catch (err) {
    showToast(`${t('fleet.export.error')}: ${err.message}`)
  } finally {
    btn.disabled = false
    btn.querySelector('.btn-text').hidden = false
    btn.querySelector('.btn-loading').hidden = true
  }
})

document.getElementById('fleetDryRunBtn').addEventListener('click', async () => {
  const fileInput = document.getElementById('fleetImportFile')
  if (!fileInput.files.length) {
    showToast(t('fleet.import.no_file'))
    return
  }

  const btn = document.getElementById('fleetDryRunBtn')
  btn.disabled = true
  btn.querySelector('.btn-text').hidden = true
  btn.querySelector('.btn-loading').hidden = false

  try {
    const text = await fileInput.files[0].text()
    JSON.parse(text) // validate JSON
    fleetLastBody = text

    const res = await fetch('/api/fleet/import', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Dry-Run': '1' },
      body: text,
    })
    const data = await res.json()
    if (!res.ok) throw new Error(data.error || t('fleet.import.error'))

    const el = document.getElementById('fleetDryRunResult')
    el.hidden = false
    el.innerHTML = `<div style="color:var(--success,#27ae60);font-weight:600">${t('fleet.import.dry_run_ok')}: ${data.wouldCreate?.agents?.length || 0} ${t('fleet.import.agents')}</div>
      ${(data.warnings || []).map(w => `<div style="color:var(--warn,#e0a800);font-size:13px">${escapeHtml(w)}</div>`).join('')}
      <div style="margin-top:8px;font-size:13px;color:var(--text-muted)">${(data.wouldCreate?.agents || []).map(a => escapeHtml(a)).join(', ')}</div>`

    document.getElementById('fleetApplyBtn').hidden = false
  } catch (err) {
    showToast(`${t('fleet.import.error')}: ${err.message}`)
  } finally {
    btn.disabled = false
    btn.querySelector('.btn-text').hidden = false
    btn.querySelector('.btn-loading').hidden = true
  }
})

document.getElementById('fleetApplyBtn').addEventListener('click', async () => {
  if (!fleetLastBody) return
  if (!confirm(t('fleet.import.apply_confirm'))) return
  const btn = document.getElementById('fleetApplyBtn')
  const password = document.getElementById('fleetImportPassword').value.trim()
  btn.disabled = true
  btn.querySelector('.btn-text').hidden = true
  btn.querySelector('.btn-loading').hidden = false

  try {
    const headers = { 'Content-Type': 'application/json' }
    if (password) headers['X-Vault-Password'] = password

    const res = await fetch('/api/fleet/import?apply=true', {
      method: 'POST',
      headers,
      body: fleetLastBody,
    })
    const data = await res.json()
    if (!res.ok) throw new Error(data.error || t('fleet.import.error'))
    const agentCount = data.imported?.agents?.length || 0
    showToast(t('fleet.import.success') + ': ' + agentCount)
    document.getElementById('fleetDryRunResult').hidden = true
    document.getElementById('fleetApplyBtn').hidden = true
    document.getElementById('fleetImportFile').value = ''
    fleetLastBody = null
  } catch (err) {
    showToast(`${t('fleet.import.error')}: ${err.message}`)
  } finally {
    btn.disabled = false
    btn.querySelector('.btn-text').hidden = false
    btn.querySelector('.btn-loading').hidden = true
  }
})
