// fork-updates.js -- the fork's two-repo Updates page, as a real overlay seam.
//
// WHY THIS FILE EXISTS. Peti's rule is that upstream must always merge into this
// fork without conflicts. web/app.js broke that rule (card eba65f46): the fork had
// REPLACED loadUpdates() in place -- a 78-line single-repo renderer became a
// 27-line dispatcher over two repos (upstream Marveen + our fork MikroB) -- while
// upstream kept growing the same function (#963 added renderUpdatesVersion). That
// is three-way divergence on ONE shared function, which no amount of helper
// extraction resolves: the conflict is inside the function itself.
//
// So the seam is a runtime override, not a source-level edit. loadUpdates() in
// app.js is now byte-for-byte upstream's version and stays that way; this file
// loads after app.js and replaces the global with the fork's renderer. app.js's
// three call sites are unqualified `loadUpdates()` references, so they resolve to
// the global at call time and get this one.
//
// CONSEQUENCE WORTH KNOWING: the upstream loadUpdates left in app.js is dead code
// here and would throw if it ever ran -- the fork's index.html replaced upstream's
// #updatesCommitList container with #updatesRepos. If this file ever fails to
// load, the Updates page breaks rather than degrades. It is a plain static file
// served from the same directory as app.js, loaded by the same kind of script tag,
// so that failure mode is the same one app.js itself has.
//
// SCOPE. This is a move, not a rewrite: the three functions below are the fork's
// existing code, unchanged except for the rename that makes the override explicit.
// handleRepoInstallClick() deliberately stays in app.js -- it is fork-only, it does
// not conflict, and moving it would be diff for its own sake. renderUpdatesVersion()
// (#963, card ae0f2178) is now called here too -- it is upstream's own function,
// defined in app.js and left untouched, so no code is duplicated. window._updatesStatus
// is deliberately still not set from here: pollUpdatesBadge() in app.js already sets it
// every 5 minutes independent of this override, so the one consumer that reads it
// (wireBranchDriftBanner's dismiss handler) already has a fresh-enough value without
// this function needing to set it too.

// Render the changes list (release-grouped, else flat commits) for one repo.
function updatesChangesHtml(repo) {
  const commitCard = (c) => `
        <div class="updates-commit">
          <div class="updates-commit-head">
            <span>${escapeHtmlUpdates(c.short)} · ${escapeHtmlUpdates(c.author)}</span>
            <span>${escapeHtmlUpdates((c.date || '').slice(0, 10))}</span>
          </div>
          <div class="updates-commit-msg">${escapeHtmlUpdates(c.message)}</div>
        </div>`
  if (repo.releases && repo.releases.length) {
    // Version-centric: the human-language summary per version is the primary
    // content; the raw commit list (SHAs, conventional-commit prefixes, author
    // names) is tucked behind a collapsed "details".
    return repo.releases.map((rel) => {
      const isUpcoming = !rel.version
      const label = isUpcoming ? t('updates.group.upcoming') : escapeHtmlUpdates(rel.version)
      const human = rel.summary
        ? escapeHtmlUpdates(rel.summary)
        : (isUpcoming ? t('updates.upcoming_note') : '')
      return `
        <div class="updates-version">
          <div class="updates-version-tag">${label}</div>
          ${human ? `<div class="updates-version-summary">${human}</div>` : ''}
          <details class="updates-version-details">
            <summary>${t('updates.details', { n: rel.commits.length })}</summary>
            <div class="updates-commit-list">${rel.commits.map(commitCard).join('')}</div>
          </details>
        </div>`
    }).join('')
  }
  if (repo.commits && repo.commits.length) {
    return repo.commits.map(commitCard).join('')
  }
  return `<p style="color:var(--text-muted);font-size:13px">${t('updates.no_changes')}</p>`
}

// Render one labelled repo block (upstream Marveen or our fork MikroB): a header
// with the repo label + remote, its own status summary, and its changes list.
function updatesRepoBlockHtml(repo) {
  const cur = (repo.current || '').slice(0, 7) || '–'
  const labelKey = 'updates.repo.' + repo.key
  const labelTxt = t(labelKey)
  const label = labelTxt === labelKey ? escapeHtmlUpdates(repo.label || repo.key) : escapeHtmlUpdates(labelTxt)
  const remote = escapeHtmlUpdates(repo.remote || '')
  let summaryClass = 'updates-summary'
  let summaryHtml = ''
  if (repo.error) {
    summaryClass += ' error'
    summaryHtml = `<strong>${t('updates.check_failed')}:</strong> ${escapeHtmlUpdates(repo.error)}<br>${t('updates.current_label')} <code>${cur}</code>`
  } else if (!repo.behind) {
    summaryClass += ' up-to-date'
    summaryHtml = `<strong>${t('updates.up_to_date_html')}</strong> (<code>${cur}</code>). ${t('updates.no_changes')}`
  } else {
    summaryClass += ' behind'
    const versions = (repo.releases || []).filter((r) => r.version)
    if (versions.length > 0) {
      summaryHtml = `<strong>${t('updates.versions_available', { n: versions.length })}</strong> <code>${escapeHtmlUpdates(versions[0].version)}</code>`
    } else {
      summaryHtml = `<strong>${t('updates.behind', { n: repo.behind })}</strong> ${t('updates.available_on', { remote: `<code>${remote}</code>` })}`
    }
  }
  const installBtnHtml = (repo.behind && !repo.error)
    ? `<div class="updates-install-wrap">
        <button class="btn-primary btn-compact updates-install-btn" id="updates-install-btn-${repo.key}" data-repo="${escapeHtmlUpdates(repo.key)}">
          <span class="btn-text">${escapeHtmlUpdates(t('updates.btn.install_repo'))}</span>
          <span class="btn-loading" hidden>${escapeHtmlUpdates(t('updates.checking'))}</span>
        </button>
      </div>`
    : ''
  return `
      <section class="updates-repo-block">
        <h3 class="updates-repo-label">${label} <span class="updates-repo-remote">(${remote})</span></h3>
        <div class="${summaryClass}">${summaryHtml}</div>
        ${installBtnHtml}
        <div class="updates-commit-list">${updatesChangesHtml(repo)}</div>
      </section>`
}

// Adopted repos' freshness strip on the Updates page (card 92a4c2e7). Its own fetch and
// its own try/catch: a failure here must never blank the two version blocks above it.
// The classification (repoFreshnessState / summarizeRepoFreshness) is the same one the
// Beépített repók grid uses, so the two pages cannot disagree about a repo.
function integratedReposSummaryHtml(repos) {
  const s = summarizeRepoFreshness(repos)
  const esc = escapeHtmlUpdates
  const dateLocale = window._lang === 'en' ? 'en-US' : 'hu-HU'
  const cls = s.behind > 0 ? 'behind' : (s.upToDate > 0 ? 'up-to-date' : '')
  const counts = esc(t('updates.integrated.counts', {
    total: String(s.total), fresh: String(s.upToDate), behind: String(s.behind),
    review: String(s.reviewRequired), unknown: String(s.unknown),
  }))
  const checked = s.lastCheckedAt
    ? esc(t('updates.integrated.last_checked', { date: new Date(s.lastCheckedAt).toLocaleDateString(dateLocale) }))
    : esc(t('updates.integrated.never_checked'))
  const never = s.neverChecked > 0 && s.lastCheckedAt
    ? ' · ' + esc(t('updates.integrated.never_count', { n: String(s.neverChecked) }))
    : ''
  const behindRepos = repos.filter((r) => repoFreshnessState(r) === 'behind')
    .sort((a, b) => (Number(b.behind) || 0) - (Number(a.behind) || 0))
  const list = behindRepos.length
    ? `<ul class="updates-integrated-list">${behindRepos.map((r) =>
        `<li><code>${esc(r.name)}</code> ${esc(t('updates.integrated.behind_item', { n: String(r.behind) }))}${r.reviewRequired ? ` <span class="updates-integrated-review">${esc(t('repos.update_review_required'))}</span>` : ''}</li>`,
      ).join('')}</ul>`
    : `<div class="updates-integrated-none">${esc(t('updates.integrated.none_behind'))}</div>`
  return `
      <section class="updates-repo-block updates-integrated">
        <h3 class="updates-repo-label">${esc(t('updates.integrated.title'))}</h3>
        <div class="updates-summary ${cls}">
          <strong>${counts}</strong><br>${checked}${never}
          ${list}
          <button type="button" class="btn-secondary btn-compact updates-integrated-link" id="updatesIntegratedReposLink">${esc(t('updates.integrated.link'))}</button>
        </div>
      </section>`
}

async function renderIntegratedReposSummary() {
  const container = document.getElementById('updatesIntegratedRepos')
  if (!container) return
  try {
    const res = await fetch('/api/integrated-repos')
    if (!res.ok) throw new Error('HTTP ' + res.status)
    const data = await res.json()
    container.innerHTML = integratedReposSummaryHtml(Array.isArray(data.repos) ? data.repos : [])
    const link = document.getElementById('updatesIntegratedReposLink')
    if (link) link.addEventListener('click', () => switchPage('repos'))
  } catch (err) {
    // Rule 12: a speaking, localized error with the way forward, not a blank strip.
    container.innerHTML = `<section class="updates-repo-block updates-integrated"><h3 class="updates-repo-label">${escapeHtmlUpdates(t('updates.integrated.title'))}</h3><div class="updates-summary error">${escapeHtmlUpdates(t('updates.integrated.error'))} <code>${escapeHtmlUpdates(String(err && err.message || err))}</code></div></section>`
  }
}

async function forkLoadUpdates() {
  const container = document.getElementById('updatesRepos')
  const applyBtn = document.getElementById('updatesApplyBtn')
  container.innerHTML = `<div class="updates-summary">${t('updates.checking')}</div>`
  try {
    const res = await fetch('/api/updates')
    if (!res.ok) throw new Error('HTTP ' + res.status)
    const data = await res.json()
    renderUpdatesBadge(data)
    renderUpdatesVersion(data)
    renderBranchNotice(data)
    // Two independent checks live in data.repos. Fall back to the flat single
    // shape (older backend/cache) synthesised as one 'mikrob' block.
    const repos = (Array.isArray(data.repos) && data.repos.length)
      ? data.repos
      : [{ ...data, key: 'mikrob', label: 'MikroB' }]
    container.innerHTML = repos.map(updatesRepoBlockHtml).join('')
    // Per-repo install buttons replace the single global apply button.
    applyBtn.hidden = true
    document.querySelectorAll('.updates-install-btn').forEach((btn) => {
      btn.addEventListener('click', () => handleRepoInstallClick(btn))
    })
  } catch (err) {
    container.innerHTML = `<div class="updates-summary error">${escapeHtmlUpdates('Hiba: ' + (err.message || err))}</div>`
    applyBtn.hidden = true
  }
  renderDiagnoseOffer()
  // Independent of the version checks above: its own endpoint, its own failure state.
  renderIntegratedReposSummary()
}

// The override itself. app.js declared its own loadUpdates(); this replaces that
// global binding, and every unqualified call in app.js follows it here.
window.loadUpdates = forkLoadUpdates
