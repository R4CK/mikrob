import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { PROJECT_ROOT } from '../config.js'
import { TOOL_TIMEOUTS } from '../tool-timeouts.js'

export interface UpdateCommit {
  sha: string
  short: string
  message: string
  author: string
  date: string
}

export interface UpdateRelease {
  /** Release tag, e.g. "v1.20.0"; empty string for the not-yet-released group. */
  version: string
  /** Human-language summary for the version (release-commit subject after "--",
   * or the release-commit body when present). Empty when none is available. */
  summary: string
  commits: UpdateCommit[]
}

export interface UpdateStatus {
  current: string
  /** Semver of the running instance (package.json "version"), e.g. "1.32.1".
   * Resolved live per request. Empty/absent when package.json is missing,
   * unreadable, or malformed -- the UI then shows the SHA alone and NEVER a
   * fabricated version. */
  version?: string
  latest: string
  behind: number
  commits: UpdateCommit[]
  /** Commits grouped by release tag (newest first; the first group is the
   * not-yet-released "upcoming" commits with version=""). Derived from the
   * chore(release) commits in the list. Absent/empty when there is nothing to
   * group; the flat `commits` list is always populated for backward compat. */
  releases?: UpdateRelease[]
  remote: string
  lastChecked: number
  /** Branch this checkout follows (what update.sh pulls). The frontend warns
   * when it is not `main`: customer installs that landed on develop via a
   * branchless clone keep receiving unreleased code until switched back. */
  branch?: string
  error?: string
  /** True when the local HEAD is not on the GitHub remote (a customised fork);
   * `behind`/`commits` are then computed from the upstream merge-base. */
  fork?: boolean
}

/** One repo's check result. Extends UpdateStatus with identity fields so the
 * dashboard can label/route each block. `branch` is the remote branch checked. */
export interface RepoStatus extends UpdateStatus {
  /** Stable key the frontend maps to an i18n label ('marveen' | 'mikrob'). */
  key: string
  /** Human label fallback (used if the frontend has no i18n entry). */
  label: string
  /** The remote branch this result was computed against. */
  branch: string
}

/** The aggregate returned by getUpdateStatus/refreshUpdateStatus. Keeps the
 * flat single-result shape (mirrors the `mikrob`/origin repo for backward
 * compatibility -- the badge count and the apply action follow OUR fork) AND
 * carries the per-repo results in `repos` for the two-block UI. */
export type AggregateUpdateStatus = UpdateStatus & { repos: RepoStatus[] }

/** Definition of a single repo to check. `trackingRef` is the LOCAL ref used
 * for the fork merge-base fallback (its merge-base with HEAD is an actual
 * remote commit that CAN be compared on GitHub even when our HEAD cannot). */
interface RepoCheckConfig {
  key: string
  label: string
  remote: string
  branch: string
  trackingRef: string
}

let updateStatusCache: AggregateUpdateStatus = {
  current: '',
  latest: '',
  behind: 0,
  commits: [],
  remote: 'Szotasz/marveen',
  lastChecked: 0,
  repos: [],
}

export function getUpdateStatus(): AggregateUpdateStatus {
  // branch and version are resolved live (cheap local rev-parse / file read):
  // the cache may predate the first refresh cycle, and a checkout switch or
  // in-place version bump should be visible immediately.
  // (Fork: return the AggregateUpdateStatus so the per-repo `repos` block is kept.)
  return { ...updateStatusCache, branch: trackedBranch(), version: currentVersion() }
}

// Semver of the running instance, read from package.json at PROJECT_ROOT. Returns
// '' on ANY failure (missing / unreadable / malformed / no string "version"):
// the caller must never display a fabricated version, so the field is simply
// empty and the UI falls back to the commit SHA alone.
export function currentVersion(root: string = PROJECT_ROOT): string {
  try {
    const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf-8'))
    return typeof pkg?.version === 'string' ? pkg.version : ''
  } catch {
    return ''
  }
}

export function currentGitHead(): string {
  try {
    return execFileSync('/usr/bin/git', ['rev-parse', 'HEAD'], { cwd: PROJECT_ROOT, timeout: 3000, encoding: 'utf-8' }).trim()
  } catch {
    return ''
  }
}

// Branch this checkout actually follows. update.sh pulls `origin/<this>`, so
// the update check must compare against the same ref -- hardcoding `main` made
// every non-release checkout (e.g. `develop`) report a phantom "new version"
// that the update button could never deliver, while staying silent about the
// commits that WERE coming. This fork tracks `develop`, upstream tracks `main`.
// Falls back to `main` on a detached HEAD, which is also the branch update.sh
// tells the operator to check out in that state.
export function trackedBranch(): string {
  try {
    const b = execFileSync('/usr/bin/git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: PROJECT_ROOT, timeout: 3000, encoding: 'utf-8' }).trim()
    return b && b !== 'HEAD' ? b : 'main'
  } catch {
    return 'main'
  }
}

export function parseGitHubRemote(): string {
  try {
    const url = execFileSync('/usr/bin/git', ['config', '--get', 'remote.origin.url'], { cwd: PROJECT_ROOT, timeout: 3000, encoding: 'utf-8' }).trim()
    // Normalize "git@github.com:Owner/Repo.git" or "https://github.com/Owner/Repo.git" to "Owner/Repo"
    const m = url.match(/github\.com[:/]([^/]+\/[^/]+?)(?:\.git)?$/i)
    if (m) return m[1]
  } catch { /* fall through */ }
  return 'Szotasz/marveen'
}

type GhCompare = {
  ahead_by?: number
  commits?: { sha: string; commit: { message: string; author: { name: string; date: string } } }[]
}

const GH_HEADERS = { 'Accept': 'application/vnd.github+json', 'User-Agent': 'marveen-update-check' }

// Fetch the GitHub compare of base...head. Returns the parsed body, the
// sentinel { notFound: true } on a 404 (base or head not on the remote), or
// null on any other failure.
async function fetchCompare(remote: string, base: string, head: string): Promise<GhCompare | { notFound: true } | null> {
  const res = await fetch(`https://api.github.com/repos/${remote}/compare/${base}...${head}`, { headers: GH_HEADERS, signal: AbortSignal.timeout(TOOL_TIMEOUTS['github']) })
  if (res.ok) return await res.json() as GhCompare
  if (res.status === 404) return { notFound: true }
  return null
}

// Matches a `chore(release): vX.Y.Z` subject and captures the version + the
// human summary that follows a "--" / "—" separator (if any).
const RELEASE_RE = /^chore\(release\):\s*(v\d+\.\d+\.\d+)\s*(?:--|—)?\s*(.*)$/

// Strip trailing git trailers (Co-Authored-By, Signed-off-by) and blank lines
// from a release-commit body so only the human summary remains.
function releaseBodySummary(fullMessage: string): string {
  const lines = fullMessage.split('\n').slice(1) // drop the subject line
  const kept: string[] = []
  for (const line of lines) {
    if (/^(Co-Authored-By|Signed-off-by|Co-authored-by):/i.test(line.trim())) continue
    kept.push(line)
  }
  return kept.join('\n').trim()
}

// Map a GitHub compare body onto the status: the flat newest-first commit list
// (backward compat) plus a release-grouped view derived from the chore(release)
// commits already present in the list.
function applyCompare(status: UpdateStatus, cmp: GhCompare): void {
  status.behind = cmp.ahead_by ?? 0
  // GitHub returns commits oldest-first; flip to newest-first for the UI.
  const raw = (cmp.commits ?? []).slice().reverse()
  const commits: UpdateCommit[] = raw.map(c => ({
    sha: c.sha,
    short: c.sha.slice(0, 7),
    message: (c.commit.message || '').split('\n')[0],
    author: c.commit.author?.name || '',
    date: c.commit.author?.date || '',
  }))
  status.commits = commits
  status.releases = groupByRelease(commits, raw.map(c => c.commit.message || ''))
}

// Group a newest-first commit list into release buckets. A `chore(release): vX`
// commit starts a version group; the non-release commits OLDER than it (until
// the next release marker) are the changes shipped in vX. Commits newer than
// the newest release marker form the leading "upcoming" group (version="").
export function groupByRelease(commits: UpdateCommit[], fullMessages: string[]): UpdateRelease[] {
  const groups: UpdateRelease[] = []
  let cur: UpdateRelease | null = null
  const upcoming: UpdateRelease = { version: '', summary: '', commits: [] }
  for (let i = 0; i < commits.length; i++) {
    const c = commits[i]
    const m = c.message.match(RELEASE_RE)
    if (m) {
      const subjectSummary = (m[2] || '').trim()
      const bodySummary = releaseBodySummary(fullMessages[i] || '')
      cur = { version: m[1], summary: bodySummary || subjectSummary, commits: [] }
      groups.push(cur)
    } else if (cur) {
      cur.commits.push(c)
    } else {
      upcoming.commits.push(c)
    }
  }
  const out: UpdateRelease[] = []
  if (upcoming.commits.length) out.push(upcoming)
  return out.concat(groups)
}

// Merge-base of local HEAD with a LOCAL tracking ref (e.g. origin/develop or
// upstream/main). For a customised fork this is the fork point -- an actual
// commit on that remote -- so it can be compared on GitHub even though the
// local HEAD itself never landed there. Empty string when the ref is absent.
function mergeBaseWith(trackingRef: string): string {
  try {
    return execFileSync('/usr/bin/git', ['merge-base', 'HEAD', trackingRef], { cwd: PROJECT_ROOT, timeout: 3000, encoding: 'utf-8' }).trim()
  } catch {
    return ''
  }
}

// Compute the update status for a single repo (remote + branch), reusing the
// fork-aware compare logic. `current` is the shared local HEAD; `cfg.trackingRef`
// is the local ref whose merge-base with HEAD provides the fork-fallback base.
async function computeStatus(current: string, cfg: RepoCheckConfig): Promise<RepoStatus> {
  const status: RepoStatus = {
    key: cfg.key,
    label: cfg.label,
    branch: cfg.branch,
    current,
    latest: '',
    behind: 0,
    commits: [],
    remote: cfg.remote,
    lastChecked: Date.now(),
  }
  if (!current) {
    status.error = 'Not a git checkout'
    return status
  }
  try {
    // 1) find HEAD of the target branch via the commits endpoint
    const latestRes = await fetch(`https://api.github.com/repos/${cfg.remote}/commits/${encodeURIComponent(cfg.branch)}`, {
      headers: GH_HEADERS,
      signal: AbortSignal.timeout(TOOL_TIMEOUTS['github']),
    })
    if (!latestRes.ok) throw new Error(`GitHub /commits/${cfg.branch} -> ${latestRes.status}`)
    const latestJson = await latestRes.json() as { sha?: string }
    if (!latestJson.sha) throw new Error(`No sha on commits/${cfg.branch} response`)
    status.latest = latestJson.sha

    if (status.latest === current) return status

    // 2) list commits between local HEAD and the remote latest via compare.
    const cmp = await fetchCompare(cfg.remote, current, status.latest)
    if (cmp && !('notFound' in cmp)) {
      applyCompare(status, cmp)
    } else if (cmp && 'notFound' in cmp) {
      // Local HEAD is not a commit on the GitHub remote -- the normal state of a
      // customised fork carrying local commits on top of upstream. Comparing the
      // raw HEAD 404s forever, surfacing as a permanent scary error. Fall back to
      // the tracking-ref merge-base (our fork point, which IS a remote commit) so
      // `behind`/`commits` reflect genuinely new remote commits rather than the
      // fork divergence. For the upstream (Marveen) repo this is exactly how the
      // (expectedly large) behind-count against Szotasz/marveen@main is measured.
      status.fork = true
      const base = mergeBaseWith(cfg.trackingRef)
      if (!base || base === status.latest) {
        // No local tracking ref, or the fork point already is the remote tip:
        // nothing new. A fork being ahead of the remote is expected, not an error.
        status.behind = 0
      } else {
        const baseCmp = await fetchCompare(cfg.remote, base, status.latest)
        if (baseCmp && !('notFound' in baseCmp)) {
          applyCompare(status, baseCmp)
        } else {
          status.error = 'Local HEAD not found on GitHub -- different fork or unpushed commits?'
        }
      }
    }
  } catch (err) {
    status.error = err instanceof Error ? err.message : String(err)
  }
  return status
}

// The two repos the dashboard checks: the original upstream (Marveen) and OUR
// fork (MikroB). The upstream entry is fixed to Szotasz/marveen@main; the fork
// entry is derived from the local checkout (origin remote + tracked branch) so
// it keeps working on any fork. The `mikrob` result also becomes the flat
// top-level status (backward compat: badge + apply follow our fork).
function repoConfigs(): { marveen: RepoCheckConfig; mikrob: RepoCheckConfig } {
  const branch = trackedBranch()
  return {
    marveen: {
      key: 'marveen',
      label: 'Eredeti Marveen',
      remote: 'Szotasz/marveen',
      branch: 'main',
      trackingRef: 'upstream/main',
    },
    mikrob: {
      key: 'mikrob',
      label: 'MikroB',
      remote: parseGitHubRemote(),
      branch,
      trackingRef: `origin/${branch}`,
    },
  }
}

export async function refreshUpdateStatus(): Promise<AggregateUpdateStatus> {
  const current = currentGitHead()
  const cfgs = repoConfigs()
  // Both checks are independent; run them concurrently.
  const [marveen, mikrob] = await Promise.all([
    computeStatus(current, cfgs.marveen),
    computeStatus(current, cfgs.mikrob),
  ])
  // Flat top-level = the fork (mikrob) result for backward compatibility; the
  // per-repo blocks live in `repos` (upstream first, then our fork).
  const aggregate: AggregateUpdateStatus = { ...mikrob, repos: [marveen, mikrob] }
  updateStatusCache = aggregate
  return aggregate
}

// Polls the GitHub branch this checkout follows for new commits and compares to the
// local HEAD. Lets the dashboard show a "new version available" badge
// without anyone having to SSH in and run update.sh.
export function startUpdateChecker(): NodeJS.Timeout {
  // First check shortly after startup; then every 15 minutes.
  setTimeout(() => { refreshUpdateStatus().catch(() => {}) }, 10_000)
  return setInterval(() => { refreshUpdateStatus().catch(() => {}) }, 15 * 60_000)
}
