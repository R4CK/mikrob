// app-repo-freshness.js -- per-repo freshness classification shared by two pages
// (card 92a4c2e7, Peti 2026-09-04: "the user cannot see per repo whether it is fresh").
//
// GET /api/integrated-repos already returns `behind` (commits upstream is ahead),
// `upstreamSha` (the locally-fetched upstream tip, null when never fetched or pipx),
// `installed` and `lastCheckedAt` per repo. Both the Beépített repók grid
// (app-connectors.js) and the Frissítések summary (fork-updates.js) render those
// fields through the two functions below, so the two pages can never disagree on
// what "up to date" means.
//
// Rule 12 (no invented state): behind === 0 is only "up to date" when there IS an
// upstream ref to have compared against. A pipx install or a never-fetched clone
// reports behind 0 because nothing was measured -- that is 'unknown', not fresh.
//
// Pure: no DOM access at load, so a test can import it under a bare window shim.

function repoFreshnessState(r) {
  if (!r) return 'unknown'
  if ((Number(r.behind) || 0) > 0) return 'behind'
  if (r.upstreamSha && r.installed !== false) return 'up_to_date'
  return 'unknown'
}

// Aggregate for the Frissítések page strip and the grid's stat tiles.
// lastCheckedAt values are YYYY-MM-DD strings (registry last_checked_at), so the
// newest one is the lexical maximum; neverChecked counts repos with no date at all.
function summarizeRepoFreshness(repos) {
  const s = {
    total: 0,
    upToDate: 0,
    behind: 0,
    unknown: 0,
    reviewRequired: 0,
    neverChecked: 0,
    lastCheckedAt: null,
  }
  for (const r of repos || []) {
    s.total++
    const state = repoFreshnessState(r)
    if (state === 'behind') s.behind++
    else if (state === 'up_to_date') s.upToDate++
    else s.unknown++
    if (r.reviewRequired) s.reviewRequired++
    const checked = r.lastCheckedAt ? String(r.lastCheckedAt) : ''
    if (!checked) s.neverChecked++
    else if (!s.lastCheckedAt || checked > s.lastCheckedAt) s.lastCheckedAt = checked
  }
  return s
}

window.repoFreshnessState = repoFreshnessState
window.summarizeRepoFreshness = summarizeRepoFreshness
