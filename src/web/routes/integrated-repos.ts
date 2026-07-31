import { readFileSync, existsSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { join } from 'node:path'
import { STORE_DIR } from '../../config.js'
import { logger } from '../../logger.js'
import { json } from '../http-helpers.js'
import type { RouteContext } from './types.js'

// ---------------------------------------------------------------------------
// Integrated (adopted) upstream repos -- registry + upstream-behind detection.
// Card a5c13533.
//
// RULE-10 (do not reinvent): the ADOPTION and UPDATE mechanics already exist and are
// NOT duplicated here --
//   * store/watched-repos.json is the existing registry file (name/repo/branch/local/
//     type/enabled/last_sha/note), written by the adoption flow;
//   * store/git-repo-watcher.sh already fetches, decides text-vs-code, fast-forwards
//     text adoptions and FLAGS code ones for review.
// This module is the missing READ surface over that same data: it reports what is
// adopted, at which vendored commit, and whether upstream has moved ahead.
//
// SECURITY / SAFETY:
//   * Behind the /api/* Bearer gate enforced in src/web.ts -- do NOT re-auth here and
//     do NOT add this path to any public allowlist.
//   * READ-ONLY, and deliberately NO blind upstream execution (the card's explicit
//     "detect+flag, nincs vak upstream-futtatas"): the only git commands run are
//     rev-parse / rev-list / log against ALREADY-FETCHED local objects. This endpoint
//     never fetches, never merges, never checks out. Upstream code that has landed in
//     the object store is never executed by looking at it.
//   * Every git call is execFileSync with an argv ARRAY (never a shell string), so a
//     hostile value in watched-repos.json cannot inject a command, and every call is
//     timeout- and buffer-capped.
//   * Only repo metadata is returned -- no tokens, no file contents, no remote creds.
//     The remote URL is passed through as configured; if an operator ever stores a
//     credential-bearing URL there, redactRemote() strips the userinfo.
//
// UPDATE-SAFETY (card requirement): the registry DATA lives in store/ (gitignored) and
// is only READ here; this route file is tracked code. Nothing is written, so an
// ff-only update can never conflict on it.
// ---------------------------------------------------------------------------

const WATCHED_REPOS = join(STORE_DIR, 'watched-repos.json')
const GIT_TIMEOUT_MS = 5_000
const GIT_MAX_BUFFER = 1 << 20 // 1 MiB -- a rev-list count/log line set is tiny
const MAX_COMMITS = 20 // cap the preview list; the count is exact regardless

/** One adopted repo as configured in store/watched-repos.json. */
export interface IntegratedRepoConfig {
  name: string
  /** Upstream source URL. */
  repo: string
  branch: string
  /** Local checkout path. */
  local: string
  /** 'text' adoptions auto-update; 'code' is detect+flag only (supply-chain safety). */
  type: string
  enabled: boolean
  /** The reviewed/vendored commit the fleet is pinned to, when recorded. */
  last_sha?: string
  /** How the repo was adopted: 'pipx' (PyPI-pinned), 'vendored', 'vendored-external', etc.
   *  Distinguishes a pipx/version install (no git checkout) from a git clone. */
  adoption?: string
  /** For pipx/version adoptions: the pinned package version actually installed. */
  pinned_version?: string
  /** Human-readable one-liner: what the repo is / what it helps solve. Surfaced in the UI tooltip. */
  description?: string
  /** Date the repo was adopted/installed into the fleet (YYYY-MM-DD). The real "install date"
   *  the UI shows -- distinct from vendoredDate, which is the upstream COMMIT date. */
  reviewed_at?: string
  note?: string
}

export interface IntegratedRepoCommit {
  sha: string
  short: string
  message: string
  date: string
}

/** Registry entry + live upstream-behind status. */
export interface IntegratedRepoStatus {
  name: string
  /** Source URL, with any embedded credentials stripped. */
  repo: string
  branch: string
  local: string
  type: string
  enabled: boolean
  /** Adoption kind, surfaced for the card's registry contract. Derived from `type`:
   *  a 'code' adoption is an executable third-party dependency, 'text' is docs/skills. */
  kind: 'skill' | 'mcp' | 'external'
  /** True when the local checkout exists (an adopted-but-not-yet-cloned entry is valid). */
  cloned: boolean
  /** How the repo was adopted; surfaced so the UI can tell a pipx install apart from a clone. */
  adoption: string
  /** For pipx/version adoptions: the pinned package version installed. */
  pinnedVersion: string | null
  /** Human one-liner (what it is / what it solves) for the UI hover tooltip. */
  description: string
  /** Adoption/install date (YYYY-MM-DD) -- the real install date the UI shows, not the
   *  upstream commit date. Null when the registry entry has no recorded reviewed_at. */
  adoptedAt: string | null
  /** True when the repo is actually INSTALLED: a git checkout exists, OR it is a
   *  version/pipx adoption with a recorded pinned version. A pipx adoption legitimately has
   *  cloned=false yet IS installed -- so `cloned` alone must not read as "not installed". */
  installed: boolean
  /** The vendored commit currently checked out locally (what the fleet actually runs). */
  vendoredSha: string | null
  vendoredShort: string | null
  /** ISO date of that vendored commit -- the card's "utolso frissites datuma". */
  vendoredDate: string | null
  /** Upstream tip for the tracked branch, from already-fetched objects. */
  upstreamSha: string | null
  /** How many commits upstream is AHEAD of the vendored sha. 0 = up to date. */
  behind: number
  /** Newest-first preview of those commits (capped). Empty when up to date. */
  commits: IntegratedRepoCommit[]
  /** True when behind > 0 AND this is executable code -- i.e. needs a supply-chain
   *  review before updating. Mirrors git-repo-watcher.sh's FLAGGED-review-before-update. */
  reviewRequired: boolean
  /** Set when this entry could not be evaluated; the rest of the fields stay best-effort. */
  error?: string
}

/** Strip `user:pass@` from a remote URL so a credential-bearing entry is never echoed. */
export function redactRemote(url: string): string {
  return url.replace(/\/\/[^/@\s]*@/, '//')
}

/** Map the watcher's text/code type onto the card's registry kind. A 'text' adoption is a
 *  skill/doc; executable code is either an MCP server or a plain external tool -- we can only
 *  tell those apart by an explicit `kind` in the config, so honour it when present. */
export function repoKind(cfg: { type?: string; kind?: string }): 'skill' | 'mcp' | 'external' {
  const explicit = (cfg.kind || '').toLowerCase()
  if (explicit === 'skill' || explicit === 'mcp' || explicit === 'external') return explicit
  return (cfg.type || '').toLowerCase() === 'text' ? 'skill' : 'external'
}

function git(local: string, args: string[]): string {
  return execFileSync('git', ['-C', local, ...args], {
    encoding: 'utf8',
    timeout: GIT_TIMEOUT_MS,
    maxBuffer: GIT_MAX_BUFFER,
    stdio: ['ignore', 'pipe', 'ignore'],
  }).trim()
}

export function readRegistry(path = WATCHED_REPOS): IntegratedRepoConfig[] {
  if (!existsSync(path)) return []
  try {
    const raw: unknown = JSON.parse(readFileSync(path, 'utf8'))
    if (!Array.isArray(raw)) return []
    return raw.filter((r): r is IntegratedRepoConfig => !!r && typeof r === 'object')
  } catch (err) {
    logger.warn(`[integrated-repos] unreadable registry ${path}: ${String(err)}`)
    return []
  }
}

/**
 * Evaluate ONE registry entry against its local checkout. Never fetches -- `behind` is
 * computed from objects the watcher already fetched, so a stale answer is possible and is
 * strictly better than this read endpoint reaching out to the network on every dashboard poll.
 */
export function statusForRepo(cfg: IntegratedRepoConfig): IntegratedRepoStatus {
  const branch = cfg.branch || 'main'
  const base: IntegratedRepoStatus = {
    name: String(cfg.name || ''),
    repo: redactRemote(String(cfg.repo || '')),
    branch,
    local: String(cfg.local || ''),
    type: String(cfg.type || ''),
    enabled: cfg.enabled === true || String(cfg.enabled).toLowerCase() === 'true',
    kind: repoKind(cfg),
    cloned: false,
    adoption: String(cfg.adoption || ''),
    pinnedVersion: cfg.pinned_version ? String(cfg.pinned_version) : null,
    description: String(cfg.description || cfg.note || ''),
    adoptedAt: cfg.reviewed_at ? String(cfg.reviewed_at) : null,
    installed: false,
    vendoredSha: null,
    vendoredShort: null,
    vendoredDate: null,
    upstreamSha: null,
    behind: 0,
    commits: [],
    reviewRequired: false,
  }

  // A pipx/version adoption (e.g. code-review-graph, graphify) has NO git checkout but IS
  // installed via its pinned package version -- so seed `installed` from that first.
  base.installed = !!base.pinnedVersion
  if (!base.local || !existsSync(join(base.local, '.git'))) return base
  base.cloned = true
  base.installed = true

  try {
    // What the fleet actually runs: the recorded vendored sha if present, else the checkout HEAD.
    const head = git(base.local, ['rev-parse', 'HEAD'])
    const vendored = cfg.last_sha && cfg.last_sha.trim() ? cfg.last_sha.trim() : head
    base.vendoredSha = vendored
    base.vendoredShort = vendored.slice(0, 8)
    try {
      base.vendoredDate = git(base.local, ['log', '-1', '--format=%cI', vendored])
    } catch {
      base.vendoredDate = null // the recorded sha may not be present locally; not fatal
    }

    // Upstream tip from ALREADY-FETCHED refs -- no network call here by design.
    let upstream: string | null = null
    try {
      upstream = git(base.local, ['rev-parse', `refs/remotes/origin/${branch}`])
    } catch {
      upstream = null // never fetched, or the branch does not exist locally
    }
    base.upstreamSha = upstream

    if (upstream && upstream !== vendored) {
      // Count ONLY commits reachable from upstream but not from the vendored sha.
      const count = git(base.local, ['rev-list', '--count', `${vendored}..${upstream}`])
      base.behind = Number.parseInt(count, 10) || 0
      if (base.behind > 0) {
        const log = git(base.local, [
          'log',
          `-${MAX_COMMITS}`,
          '--format=%H%x1f%s%x1f%cI',
          `${vendored}..${upstream}`,
        ])
        base.commits = log
          ? log.split('\n').map((line) => {
              const [sha = '', message = '', date = ''] = line.split('\x1f')
              return { sha, short: sha.slice(0, 8), message, date }
            })
          : []
        // Executable adoptions must be reviewed before update -- same stance as the watcher.
        base.reviewRequired = base.kind !== 'skill' && base.type.toLowerCase() !== 'text'
      }
    }
  } catch (err) {
    base.error = String(err instanceof Error ? err.message : err).slice(0, 200)
  }
  return base
}

export function buildIntegratedRepos(path = WATCHED_REPOS): {
  repos: IntegratedRepoStatus[]
  total: number
  behind: number
  reviewRequired: number
  checkedAt: number
} {
  const repos = readRegistry(path).map(statusForRepo)
  return {
    repos,
    total: repos.length,
    behind: repos.filter((r) => r.behind > 0).length,
    reviewRequired: repos.filter((r) => r.reviewRequired).length,
    checkedAt: Date.now(),
  }
}

export async function tryHandleIntegratedRepos(ctx: RouteContext): Promise<boolean> {
  const { res, path, method } = ctx

  // GET /api/integrated-repos -- registry + upstream-behind status.
  if (path === '/api/integrated-repos' && method === 'GET') {
    try {
      json(res, buildIntegratedRepos())
    } catch (err) {
      logger.warn(`[integrated-repos] ${String(err)}`)
      json(res, { error: 'integrated-repos failed' }, 500)
    }
    return true
  }
  return false
}
