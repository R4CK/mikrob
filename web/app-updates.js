// app-updates.js -- Updates page helpers (app.js modularisation slice 25).
// Globals from app.js: t, showToast, loadUpdates (stays in app.js: fork-overlay seam),
//   renderUpdatesVersion (stays in app.js: upstream function called by fork-updates.js)
// Globals from here used by app-device-keys.js: wireBranchDriftBanner
// Globals from here used by fork-updates.js: escapeHtmlUpdates, renderUpdatesBadge,
//   renderBranchNotice, renderCliUpdateOffer (CLIFRISSAJANLAS923)

function escapeHtmlUpdates(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]))
}

function renderUpdatesBadge(status) {
  const badge = document.getElementById('updatesBadge')
  if (!badge) return
  // Version-centric: show the number of NEW VERSIONS, not raw commits. Fall back
  // to the behind count only in the rare pre-release state (unreleased commits
  // but no new version tag yet).
  const versionCount = status && Array.isArray(status.releases)
    ? status.releases.filter((r) => r.version).length : 0
  const count = versionCount > 0 ? versionCount : ((status && status.behind) || 0)
  if (count > 0) {
    badge.textContent = String(count)
    badge.hidden = false
  } else {
    badge.hidden = true
  }
}

// === Branch-drift warning ===
// Installs that landed on a non-main branch (e.g. a branchless clone before
// the --branch main pin) keep receiving unreleased code from update.sh, which
// pulls the tracked branch. Two surfaces, both non-blocking: a dismissible
// top banner (dismissal persists per browser AND per branch, so a later switch
// to yet another branch re-warns) and a permanent notice on the Updates page.
// Dev machines follow develop on purpose; one dismissal silences the banner
// for them while the Updates-page notice stays as the quiet ground truth.
const BRANCH_DRIFT_DISMISS_PREFIX = 'marveen.branch-drift-dismissed.'
// The heal command has to work in BOTH states, and `git checkout main` works in
// neither of them reliably here: with two remotes that both carry main (origin
// and a fork) git cannot infer the branch to follow and exits 128, and
// `checkout -b main --track origin/main` only works the FIRST time -- run it
// again on an install that already has a local main and it exits 128 with
// "a branch named 'main' already exists". Measured 2026-09-25 upstream in an
// isolated two-remote repo, git 2.53.0 (adopted, card d87adb90). `switch` then
// `switch -c` covers both, and the `(A || B) && C` precedence is what keeps
// update.sh from running when neither switch succeeded.
const BRANCH_HEAL_COMMAND = 'git switch main || git switch -c main --track origin/main && bash update.sh'

function branchDriftDismissed(branch) {
  try { return localStorage.getItem(BRANCH_DRIFT_DISMISS_PREFIX + branch) === '1' } catch { return false }
}

function updateBranchDriftUI(status) {
  const banner = document.getElementById('branchDriftBanner')
  if (!banner) return
  const branch = status && status.branch
  const drifted = !!branch && branch !== 'main'
  if (!drifted || branchDriftDismissed(branch)) {
    banner.hidden = true
    return
  }
  const textEl = document.getElementById('branchDriftBannerText')
  if (textEl) {
    textEl.innerHTML =
      `${t('branch_drift.banner.text', { branch: `<strong>${escapeHtmlUpdates(branch)}</strong>` })} ` +
      `<code>${BRANCH_HEAL_COMMAND}</code>`
  }
  banner.hidden = false
}

function wireBranchDriftBanner() {
  const dismiss = document.getElementById('branchDriftDismiss')
  if (!dismiss) return
  dismiss.addEventListener('click', () => {
    const banner = document.getElementById('branchDriftBanner')
    const branch = (window._updatesStatus && window._updatesStatus.branch) || ''
    try { if (branch) localStorage.setItem(BRANCH_DRIFT_DISMISS_PREFIX + branch, '1') } catch { /* storage blocked */ }
    if (banner) banner.hidden = true
  })
}

function renderBranchNotice(status) {
  const el = document.getElementById('updatesBranchNotice')
  if (!el) return
  const branch = status && status.branch
  if (!branch) { el.hidden = true; return }
  if (branch === 'main') {
    el.className = 'updates-branch-notice ok'
    el.innerHTML = `${t('branch_drift.notice.on_main')} (<code>main</code>)`
  } else {
    el.className = 'updates-branch-notice warn'
    el.innerHTML =
      `${t('branch_drift.notice.off_main', { branch: `<code>${escapeHtmlUpdates(branch)}</code>` })}<br>` +
      `${t('branch_drift.notice.heal')} <code>${BRANCH_HEAL_COMMAND}</code>`
  }
  el.hidden = false
}

async function pollUpdatesBadge() {
  try {
    const res = await fetch('/api/updates')
    if (!res.ok) return
    const data = await res.json()
    window._updatesStatus = data
    renderUpdatesBadge(data)
    updateBranchDriftUI(data)
  } catch {}
}

// Claude Code CLI update OFFER (CLIFRISSAJANLAS923). Reads /api/updates/cli:
// installed vs offered target (latest, or the AVX-safe pin on an AVX-less
// host), a button that only POSTs the exact offered target, and the note that
// running sessions keep the old binary until their next start.
let _cliUpdatePoll = null
async function renderCliUpdateOffer(fresh) {
  const box = document.getElementById('updatesCli')
  if (!box) return
  let d
  try { d = await (await fetch('/api/updates/cli' + (fresh ? '?fresh=1' : ''))).json() } catch { box.hidden = true; return }
  const esc = escapeHtmlUpdates
  const lines = []
  lines.push(`<strong>${esc(t('updates.cli.title'))}</strong>`)
  lines.push(`<p>${esc(t('updates.cli.installed', { v: d.installed || t('updates.cli.unmeasured') }))}`
    + (d.avxLess
      ? ` · ${esc(t('updates.cli.avx_target', { v: d.avxSafePin || '—' }))}`
      : ` · ${esc(t('updates.cli.latest', { v: d.latest || (d.latestError ? t('updates.cli.unknown') : '…') }))}`)
    + `</p>`)
  if (d.avxLess) lines.push(`<p class="muted">${esc(t('updates.cli.avx_note'))}</p>`)
  const job = d.job || {}
  if (job.running) {
    lines.push(`<p><span class="spinner"></span> ${esc(t('updates.cli.running', { v: (job.result && job.result.target) || d.target || '' }))}</p>`)
  } else if (job.result && job.result.status === 'done' && job.result.installedAfter === d.installed) {
    lines.push(`<p class="updates-cli-done">${esc(t('updates.cli.done', { v: job.result.installedAfter || '' }))}</p>`)
    lines.push(`<p class="muted">${esc(t('updates.cli.sessions_note'))}</p>`)
  } else if (job.result && job.result.status === 'failed' && !d.offer) {
    lines.push(`<p class="updates-cli-failed">${esc(t('updates.cli.failed', { msg: job.result.message || '' }))}</p>`)
  }
  if (d.offer && !job.running) {
    lines.push(`<p>${esc(t('updates.cli.offer', { v: d.target }))}</p>`)
    lines.push(`<p class="muted">${esc(t('updates.cli.sessions_note'))}</p>`)
    lines.push(`<button class="btn-secondary btn-compact" id="updatesCliBtn">${esc(t('updates.cli.btn', { v: d.target }))}</button>`)
    if (d.manualCommand) lines.push(`<p class="muted">${esc(t('updates.cli.manual'))} <code>${esc(d.manualCommand)}</code></p>`)
  } else if (!d.offer && !job.running && d.installed && (d.avxLess ? d.avxSafePin : d.latest)) {
    if (!(job.result && job.result.status === 'done' && job.result.installedAfter === d.installed)) lines.push(`<p class="muted">${esc(t('updates.cli.up_to_date'))}</p>`)
  }
  box.hidden = false
  box.className = 'updates-diagnose updates-cli'
  box.innerHTML = lines.join('')
  const btn = document.getElementById('updatesCliBtn')
  if (btn) btn.addEventListener('click', () => applyCliUpdate(d.target))
  if (job.running) {
    if (!_cliUpdatePoll) _cliUpdatePoll = setTimeout(() => { _cliUpdatePoll = null; renderCliUpdateOffer(true) }, 5000)
  }
}

async function applyCliUpdate(target) {
  if (!target) return
  if (!confirm(t('updates.cli.confirm', { v: target }))) return
  const btn = document.getElementById('updatesCliBtn')
  if (btn) btn.disabled = true
  try {
    const res = await fetch('/api/updates/cli/apply', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ target }),
    })
    const data = await res.json().catch(() => ({}))
    if (!res.ok) {
      if (btn) btn.disabled = false
      showToast(t('updates.cli.failed', { msg: data.error || ('HTTP ' + res.status) }))
      return
    }
    showToast(t('updates.cli.started', { v: target }))
    renderCliUpdateOffer(true)
  } catch (err) {
    if (btn) btn.disabled = false
    showToast(t('updates.cli.failed', { msg: err.message || err }))
  }
}

// Post-rollback diagnosis offer (PR-D). Reads /api/updates/status: if the last
// update failed/rolled-back and this host can run a Claude agent, offer the
// opt-in fixer; if it cannot (AVX), show a manual-intervention note instead.
async function renderDiagnoseOffer() {
  const box = document.getElementById('updatesDiagnose')
  if (!box) return
  let data
  try { data = await (await fetch('/api/updates/status')).json() } catch { box.hidden = true; return }
  if (data.needsHuman) {
    box.hidden = false
    box.className = 'updates-diagnose needs-human'
    box.innerHTML = `<strong>${escapeHtmlUpdates(t('updates.diagnose.title'))}</strong><p>${escapeHtmlUpdates(t('updates.diagnose.needs_human'))}</p>`
    return
  }
  if (!data.canDiagnose) { box.hidden = true; box.innerHTML = ''; return }
  box.hidden = false
  box.className = 'updates-diagnose'
  box.innerHTML = `<strong>${escapeHtmlUpdates(t('updates.diagnose.title'))}</strong>`
    + `<p>${escapeHtmlUpdates(t('updates.diagnose.body'))}</p>`
    + `<button class="btn-secondary btn-compact" id="updatesDiagnoseBtn">${escapeHtmlUpdates(t('updates.diagnose.btn'))}</button>`
  document.getElementById('updatesDiagnoseBtn').addEventListener('click', runDiagnose)
}

async function runDiagnose() {
  if (!confirm(t('updates.diagnose.consent'))) return
  const btn = document.getElementById('updatesDiagnoseBtn')
  if (btn) btn.disabled = true
  try {
    const res = await fetch('/api/updates/diagnose', { method: 'POST' })
    const data = await res.json().catch(() => ({}))
    if (!res.ok) {
      if (btn) btn.disabled = false
      showToast(t('updates.diagnose.failed', { msg: data.error || ('HTTP ' + res.status) }))
      return
    }
    showToast(data.already ? t('updates.diagnose.already') : t('updates.diagnose.started'))
    if (btn) { btn.hidden = true }
  } catch (err) {
    if (btn) btn.disabled = false
    showToast(t('updates.diagnose.failed', { msg: err.message || err }))
  }
}

document.getElementById('updatesCheckBtn').addEventListener('click', async () => {
  const btn = document.getElementById('updatesCheckBtn')
  btn.disabled = true
  try { await fetch('/api/updates/check', { method: 'POST' }) } catch {}
  await loadUpdates()
  btn.disabled = false
})

async function runUpdate(autoStash) {
  const btn = document.getElementById('updatesApplyBtn')
  btn.disabled = true
  btn.querySelector('.btn-text').hidden = true
  btn.querySelector('.btn-loading').hidden = false
  const resetBtn = () => {
    btn.disabled = false
    btn.querySelector('.btn-text').hidden = false
    btn.querySelector('.btn-loading').hidden = true
  }
  try {
    const res = await fetch('/api/updates/apply', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ autoStash: autoStash === true }),
    })
    // Parse the body regardless of status so preflight reasons
    // (not-on-main / dirty-tree / detached-head returned as 409 by
    // the backend) land in the toast instead of a bare "HTTP 409".
    const data = await res.json().catch(() => ({}))
    if (!res.ok) {
      resetBtn()
      // dirty-tree without autoStash: offer the auto-stash retry inline.
      if (data.reason === 'dirty-tree' && !autoStash) {
        if (confirm(t('updates.confirm.stash'))) {
          await runUpdate(true)
        }
        return
      }
      showToast(t('updates.toast.not_started', { msg: data.error || ('HTTP ' + res.status) }))
      return
    }
    showToast(t('updates.toast.applying'))
    // Poll the real outcome instead of a blind timed reload. update.sh (and its
    // detached finalizer) write store/update.last-result on exit, so we surface
    // success / rolled-back / failed rather than a false "done" that reloads
    // into an unchanged (or dead) dashboard.
    await pollUpdateOutcome(resetBtn)
  } catch (err) {
    resetBtn()
    showToast(t('updates.toast.error', {msg: err.message || err}))
  }
}

// Poll /api/updates/status until the run finishes (pidfile gone AND a fresh
// result is present), then show the true outcome. Reload only on success.
async function pollUpdateOutcome(resetBtn) {
  const startedAt = Date.now()
  const deadline = startedAt + 5 * 60_000   // hard cap: 5 min
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 3000))
    let data
    try {
      const res = await fetch('/api/updates/status')
      data = await res.json()
    } catch {
      // Dashboard is mid-restart (expected): keep polling.
      continue
    }
    const result = data && data.result
    const fresh = result && typeof result.ts === 'number' && result.ts * 1000 >= startedAt - 5000
    if (data && !data.running && fresh) {
      const st = result.status
      if (st === 'success') {
        showToast(t('updates.toast.success', { old: result.old || '', new: result.new || '' }))
        setTimeout(() => window.location.reload(), 2000)
        return
      }
      if (st === 'rolled-back') {
        if (resetBtn) resetBtn()
        showToast(t('updates.toast.rolled_back', { old: result.old || '', msg: result.message || '' }))
        renderDiagnoseOffer()
        return
      }
      // failed
      if (resetBtn) resetBtn()
      showToast(t('updates.toast.failed', { phase: result.phase || '?', msg: result.message || ('code ' + result.code) }))
      renderDiagnoseOffer()
      return
    }
  }
  if (resetBtn) resetBtn()
  showToast(t('updates.toast.status_timeout'))
}

document.getElementById('updatesApplyBtn').addEventListener('click', async () => {
  if (!confirm(t('updates.confirm.apply'))) return
  await runUpdate(false)
})

// Poll the badge on startup and every 5 min so the nav link reflects
// the cached status even on tabs other than the Updates page.
pollUpdatesBadge()
setInterval(pollUpdatesBadge, 5 * 60_000)
