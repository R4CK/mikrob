import {
  readFileSync, writeFileSync, appendFileSync, mkdirSync, openSync, closeSync, statSync, unlinkSync,
} from 'node:fs'
import { join } from 'node:path'
import type http from 'node:http'
import { spawn, execFileSync } from 'node:child_process'
import { PROJECT_ROOT, STORE_DIR } from '../../config.js'
import { logger } from '../../logger.js'
import {
  getUpdateStatus, refreshUpdateStatus,
} from '../update-checker.js'
import {
  checkUpdatePreflight, checkNoConcurrentUpdate, classifyLockWriteError,
  type GitRunner, type PidfileRunner,
} from '../../update-preflight.js'
import { json, readBody } from '../http-helpers.js'
import { claudeAgentRunnable } from '../../update-agent-capability.js'
import { runScheduledTaskNow } from '../schedule-runner.js'
import type { RouteContext } from './types.js'

// Pidfile path owned by update.sh for the lifetime of an update run.
// The dashboard never writes it -- update.sh does on entry, removes on exit
// via a trap -- so the gate survives the stop.sh / start.sh dashboard
// restart that happens inside a successful update.
const UPDATE_PIDFILE = join(PROJECT_ROOT, 'store', 'update.pid')

// The seeded on-demand (enabled:false) task the post-rollback diagnosis fires.
const DIAGNOSE_TASK = 'post-rollback-diagnose'
// One-diagnosis-per-rollback marker (keyed by the last-result timestamp).
const DIAGNOSE_MARKER = join(PROJECT_ROOT, 'store', 'update-diagnose.last')

// store/.update-history rollback log, in update.sh's EXACT tab-separated shape (Cybered NO-GO fix,
// card a3700b69): TIMESTAMP\tKIND\tBRANCH\tFROM_SHA\tTO_SHA\tNOTE\n -- recovery-prev-version.sh's
// `awk -F'\t' '$2=="update"{v=$4}'` picks the rollback target off field 2 ("update") + field 4
// (FROM_SHA) BLINDLY, so a differently-shaped line here would silently vanish from --list / never be
// selected as the recovery target. Before this fix, the upstream-merge branch below never wrote here
// at all -- update.sh (the fork-pull path) was the ONLY writer, so an upstream merge left NO rollback
// point: a bad upstream commit -> clean merge -> a later restart -> recovery-prev-version.sh has no
// record of this point to roll back to.
const UPDATE_HISTORY_PATH = join(PROJECT_ROOT, 'store', '.update-history')

/** Local-time `%Y-%m-%dT%H:%M:%S%z` (bash `date`'s format: zone offset with NO colon, e.g. +0200) --
 *  matches every existing line in store/.update-history exactly (both are written on the same host,
 *  same local TZ). */
export function updateHistoryTimestamp(d: Date): string {
  const pad = (n: number): string => String(n).padStart(2, '0')
  const offMin = -d.getTimezoneOffset() // Date.getTimezoneOffset(): minutes BEHIND UTC, sign inverted
  const sign = offMin >= 0 ? '+' : '-'
  const abs = Math.abs(offMin)
  return (
    `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}` +
    `T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}` +
    `${sign}${pad(Math.floor(abs / 60))}${pad(abs % 60)}`
  )
}

/** Append a rollback point iff the SHA actually changed (mirrors update.sh's own
 *  `[ "$OLD_VERSION_FULL" != "$NEW_VERSION_FULL" ]` guard) -- append-only, best-effort (store/ is
 *  gitignored; a write failure here must never fail the merge that already succeeded). Exported for
 *  direct unit testing of the exact TSV shape (recovery-prev-version.sh's awk parses this blindly). */
export function recordUpdateHistory(
  branch: string,
  fromSha: string,
  toSha: string,
  note: string,
  historyPath: string = UPDATE_HISTORY_PATH,
): void {
  if (fromSha === toSha) return
  const line = `${updateHistoryTimestamp(new Date())}\tupdate\t${branch}\t${fromSha}\t${toSha}\t${note}\n`
  try {
    appendFileSync(historyPath, line, { mode: 0o600 })
  } catch (err) {
    logger.warn({ err }, 'store/.update-history append failed (best-effort, non-fatal)')
  }
}

/** The git operations the upstream-merge branch needs, injected so {@link performUpstreamMerge} is
 *  unit-testable without a real repo -- same DI shape as {@link GitRunner}/{@link PidfileRunner} in
 *  this same file. */
export interface UpstreamMergeRunner {
  revParseHead(): string
  fetchUpstream(): void
  /** Throws on conflict or any other merge failure (the real adapter runs `git merge --no-edit`,
   *  which exits non-zero on both). */
  mergeUpstream(): void
  /** Best-effort; the real adapter's own failure (no merge in progress) is swallowed by the caller. */
  mergeAbort(): void
  currentBranch(): string
}

export type UpstreamMergeResult =
  | { readonly ok: true; readonly beforeSha: string; readonly afterSha: string }
  | { readonly ok: false; readonly reason: 'merge-conflict' | 'upstream-merge-failed'; readonly message: string }

/**
 * `git merge` writes its "CONFLICT (content): ..." / "Automatic merge failed" report to STDOUT, not
 * stderr -- but `execFileSync`'s thrown Error.message does NOT include stdout (Node only folds
 * stderr into the message), so {@link performUpstreamMerge}'s `msg.includes('CONFLICT')`
 * classification below would never match a real conflict without this. Found live 2026-08-04: a
 * real package-lock.json conflict against upstream/main came back as a bare 500
 * ('upstream-merge-failed') instead of the 409 'merge-conflict' with the "resolve manually"
 * guidance. Re-throws with stdout appended to the message; a no-op if the error carries no stdout.
 */
export function foldStdoutIntoMergeError(err: unknown): never {
  if (err instanceof Error) {
    const stdout = (err as NodeJS.ErrnoException & { stdout?: string }).stdout
    if (stdout) err.message = `${err.message}\n${stdout}`
  }
  throw err
}

/**
 * Fetch + merge upstream/main, recording a rollback point (store/.update-history) on success and
 * NEVER on failure -- an aborted/conflicted merge leaves HEAD unchanged, so there is nothing to
 * record. Pure control flow over the injected {@link UpstreamMergeRunner}; the HTTP route below is a
 * thin wrapper (lock + response shaping). `recordHistory` is injected too so a test can assert it was
 * (or was not) called without touching the real store/.update-history file.
 */
export function performUpstreamMerge(
  runner: UpstreamMergeRunner,
  recordHistory: typeof recordUpdateHistory = recordUpdateHistory,
): UpstreamMergeResult {
  // Captured BEFORE the merge so a rollback point can be recorded on success -- HEAD does not move
  // again after this in the success path (no checkout after the merge commit).
  const beforeSha = runner.revParseHead().trim()
  try {
    runner.fetchUpstream()
    runner.mergeUpstream()
  } catch (err) {
    // Abort any in-progress merge so the tree is clean again. Best-effort: `merge --abort` itself
    // fails if no merge is in progress (e.g. the fetch failed before any merge started) -- ignored.
    try {
      runner.mergeAbort()
    } catch {
      /* no merge in progress; nothing to abort */
    }
    const msg = err instanceof Error ? err.message : String(err)
    // Merge conflict returns exit code 1 with CONFLICT/"Automatic merge failed" in the output. Other
    // errors (network, missing remote) surface the raw message as a general failure.
    const isConflict = msg.includes('CONFLICT') || msg.includes('Automatic merge failed')
    return isConflict
      ? {
          ok: false,
          reason: 'merge-conflict',
          message:
            'Upstream merge conflict. Resolve manually: git merge upstream/main, fix conflicts, then git commit.',
        }
      : { ok: false, reason: 'upstream-merge-failed', message: msg }
  }
  const afterSha = runner.revParseHead().trim()
  recordHistory(runner.currentBranch().trim(), beforeSha, afterSha, 'upstream-merge')
  return { ok: true, beforeSha, afterSha }
}

/** Real {@link UpstreamMergeRunner}: the actual git shell-outs, unchanged from the pre-refactor
 *  inline calls (same binary, args, cwd, timeouts). */
const realUpstreamMergeRunner: UpstreamMergeRunner = {
  revParseHead: () =>
    execFileSync('/usr/bin/git', ['rev-parse', 'HEAD'], {
      cwd: PROJECT_ROOT,
      timeout: 3000,
      encoding: 'utf-8',
    }),
  fetchUpstream: () => {
    execFileSync('/usr/bin/git', ['fetch', 'upstream'], { cwd: PROJECT_ROOT, timeout: 15_000 })
  },
  mergeUpstream: () => {
    try {
      execFileSync('/usr/bin/git', ['merge', 'upstream/main', '--no-edit'], {
        cwd: PROJECT_ROOT,
        timeout: 20_000,
        encoding: 'utf-8',
      })
    } catch (err) {
      foldStdoutIntoMergeError(err)
    }
  },
  mergeAbort: () => {
    execFileSync('/usr/bin/git', ['merge', '--abort'], { cwd: PROJECT_ROOT, timeout: 5_000 })
  },
  currentBranch: () =>
    execFileSync('/usr/bin/git', ['rev-parse', '--abbrev-ref', 'HEAD'], {
      cwd: PROJECT_ROOT,
      timeout: 3000,
      encoding: 'utf-8',
    }),
}

/** The read-only git queries {@link analyzeUpstreamChanges} needs, injected the same way as
 *  {@link UpstreamMergeRunner} so the analysis is unit-testable without a real repo. Runs BEFORE the
 *  merge (against the pre-merge HEAD), so `mergeBase`/`oursChangedFiles` reflect our fork's own
 *  divergence from the point the two histories split. */
export interface UpstreamAnalysisRunner {
  fetchUpstream(): void
  /** `git log --oneline <mergeBase>..upstream/main`: the incoming commits, one per line. */
  commitsBehind(): string
  /** `git diff --stat <mergeBase> upstream/main`: human-readable file/line change summary. */
  diffStat(): string
  /** Files WE changed since the merge-base (our own fork divergence). */
  oursChangedFiles(): string
  /** Files the upstream side changed since the merge-base. */
  theirsChangedFiles(): string
}

export interface UpstreamAnalysis {
  commitCount: number
  commits: string[]
  diffStat: string
  /** Files touched on BOTH sides since the merge-base -- the actual conflict-risk zone (a real
   *  conflict is still decided by git itself during the merge; this is a pre-merge heads-up). */
  riskyFiles: string[]
  hasRisk: boolean
}

/** Pure analysis of what an upstream merge WOULD change, run before touching HEAD. Read-only:
 *  computes the incoming commit/diff summary plus the file-level overlap between "what we changed"
 *  and "what upstream changed" since the merge-base -- the files most likely to conflict. */
export function analyzeUpstreamChanges(runner: UpstreamAnalysisRunner): UpstreamAnalysis {
  runner.fetchUpstream()
  const commits = runner.commitsBehind().trim().split('\n').filter(Boolean)
  const diffStat = runner.diffStat().trim()
  const ours = new Set(runner.oursChangedFiles().trim().split('\n').filter(Boolean))
  const theirs = runner.theirsChangedFiles().trim().split('\n').filter(Boolean)
  const riskyFiles = theirs.filter((f) => ours.has(f))
  return {
    commitCount: commits.length,
    commits,
    diffStat,
    riskyFiles,
    hasRisk: riskyFiles.length > 0,
  }
}

/** Real {@link UpstreamAnalysisRunner}: same binary/cwd/timeout conventions as
 *  {@link realUpstreamMergeRunner}. `fetchUpstream` is separate from the merge's own fetch (idempotent,
 *  cheap) so this analysis can run standalone before {@link performUpstreamMerge}. */
const realUpstreamAnalysisRunner: UpstreamAnalysisRunner = {
  fetchUpstream: () => {
    execFileSync('/usr/bin/git', ['fetch', 'upstream'], { cwd: PROJECT_ROOT, timeout: 15_000 })
  },
  commitsBehind: () => {
    const base = execFileSync('/usr/bin/git', ['merge-base', 'HEAD', 'upstream/main'], {
      cwd: PROJECT_ROOT, timeout: 5000, encoding: 'utf-8',
    }).trim()
    return execFileSync('/usr/bin/git', ['log', '--oneline', `${base}..upstream/main`], {
      cwd: PROJECT_ROOT, timeout: 10_000, encoding: 'utf-8',
    })
  },
  diffStat: () => {
    const base = execFileSync('/usr/bin/git', ['merge-base', 'HEAD', 'upstream/main'], {
      cwd: PROJECT_ROOT, timeout: 5000, encoding: 'utf-8',
    }).trim()
    return execFileSync('/usr/bin/git', ['diff', '--stat', base, 'upstream/main'], {
      cwd: PROJECT_ROOT, timeout: 10_000, encoding: 'utf-8',
    })
  },
  oursChangedFiles: () => {
    const base = execFileSync('/usr/bin/git', ['merge-base', 'HEAD', 'upstream/main'], {
      cwd: PROJECT_ROOT, timeout: 5000, encoding: 'utf-8',
    }).trim()
    return execFileSync('/usr/bin/git', ['diff', '--name-only', base, 'HEAD'], {
      cwd: PROJECT_ROOT, timeout: 10_000, encoding: 'utf-8',
    })
  },
  theirsChangedFiles: () => {
    const base = execFileSync('/usr/bin/git', ['merge-base', 'HEAD', 'upstream/main'], {
      cwd: PROJECT_ROOT, timeout: 5000, encoding: 'utf-8',
    }).trim()
    return execFileSync('/usr/bin/git', ['diff', '--name-only', base, 'upstream/main'], {
      cwd: PROJECT_ROOT, timeout: 10_000, encoding: 'utf-8',
    })
  },
}

/** Renders {@link UpstreamAnalysis} as a short plain-text summary for a Telegram notice / log line.
 *  Plain text only (no HTML) -- scripts/notify.sh sends with parse_mode=HTML, so unescaped commit
 *  subjects containing `<`/`&` could break the message; callers must not feed this straight into HTML
 *  without escaping if that ever changes. */
export function formatUpstreamAnalysis(a: UpstreamAnalysis): string {
  const lines = [
    `Upstream elemzes: ${a.commitCount} uj commit.`,
    a.hasRisk
      ? `Kockazat: ${a.riskyFiles.length} fajlt MI IS modositottunk, amit az upstream is erint (utkozes-eselyes): ${a.riskyFiles.slice(0, 10).join(', ')}${a.riskyFiles.length > 10 ? ', ...' : ''}`
      : 'Kockazat: nincs atfedes a sajat modositasainkkal, alacsony konfliktus-eselyes.',
  ]
  return lines.join('\n')
}

/** Spawns update.sh detached (same shape for both the fork-pull path and the post-upstream-merge
 *  rebuild+restart path below), with `extraEnv` layered over the inherited environment. The pidfile
 *  lock is handed off to update.sh's own pidfile-overwrite (update.sh:133-158); `releaseLock` is only
 *  invoked here on a failure BEFORE that handoff (log-open failure, spawn error racing a still-ours
 *  pidfile). Writes the JSON response itself so callers just return after invoking it. */
function spawnUpdateScript(
  res: http.ServerResponse,
  extraEnv: Record<string, string>,
  pidfileContent: string,
  releaseLock: () => void,
): void {
  try {
    let outFd: number | 'ignore' = 'ignore'
    try {
      mkdirSync(STORE_DIR, { recursive: true })
      outFd = openSync(join(STORE_DIR, 'update.log'), 'a', 0o600)
    } catch (err) {
      releaseLock()
      logger.error({ err }, 'store/update.log not writable; refusing to start a blind update')
      json(res, { error: 'store/ is not writable; cannot run the updater safely.', reason: 'store-unwritable' }, 500)
      return
    }
    const child = spawn('/bin/bash', [join(PROJECT_ROOT, 'update.sh')], {
      cwd: PROJECT_ROOT,
      detached: true,
      stdio: ['ignore', outFd, outFd],
      env: { ...process.env, ...extraEnv },
    })
    child.on('error', (err) => {
      logger.error({ err }, 'update.sh spawn reported an async error')
      let stillOurs = false
      try {
        stillOurs = readFileSync(UPDATE_PIDFILE, 'utf-8') === pidfileContent
      } catch { /* file already gone -- nothing to release */ }
      if (stillOurs) releaseLock()
    })
    child.unref()
    if (typeof outFd === 'number') {
      try { closeSync(outFd) } catch { /* already closed */ }
    }
    json(res, { ok: true })
  } catch (err) {
    releaseLock()
    json(res, { error: err instanceof Error ? err.message : String(err) }, 500)
  }
}

type LastResult = { status?: string; ts?: number; phase?: string; message?: string }
function readLastResult(): LastResult | null {
  try { return JSON.parse(readFileSync(join(STORE_DIR, 'update.last-result'), 'utf-8')) as LastResult }
  catch { return null }
}
// A post-rollback diagnosis is meaningful only after a terminal FAILED /
// ROLLED-BACK outcome (a success or an in-progress run is not diagnosable).
function isDiagnosable(r: LastResult | null): boolean {
  return r?.status === 'rolled-back' || r?.status === 'failed'
}

export async function tryHandleUpdates(ctx: RouteContext): Promise<boolean> {
  const { res, path, method } = ctx

  if (path === '/api/updates' && method === 'GET') {
    json(res, getUpdateStatus())
    return true
  }

  // Real outcome of the last (or in-flight) update.sh run. update.sh writes
  // store/update.last-result on EXIT with the true status, so the frontend can
  // show success/failed/rolled-back instead of a blind reload that hides a
  // silent failure. Absent file => no run yet (or one still in progress; the
  // presence of store/update.pid disambiguates).
  if (path === '/api/updates/status' && method === 'GET') {
    const result = readLastResult()
    let running = false
    try { running = statSync(UPDATE_PIDFILE).isFile() } catch { /* not running */ }
    // Post-rollback diagnosis offer (PR-D). Offer the opt-in fixer only when the
    // last update FAILED/ROLLED-BACK *and* this host can actually run a Claude
    // agent. On an AVX-less host (agent cannot start) we flag needsHuman so the
    // UI shows a "manual intervention" note instead of a dead-end button.
    const diagnosable = isDiagnosable(result)
    const claudeRunnable = claudeAgentRunnable()
    json(res, {
      running,
      result,
      canDiagnose: diagnosable && claudeRunnable && !running,
      needsHuman: diagnosable && !claudeRunnable,
    })
    return true
  }

  // Opt-in post-rollback diagnosis (PR-D). The operator explicitly requests it
  // from the dashboard (credit consent handled in the UI). Fires the seeded,
  // guardrailed post-rollback-diagnose task at the main agent. Guarded so it is
  // only reachable in a genuine rollback state and never on a host that cannot
  // run the agent.
  if (path === '/api/updates/diagnose' && method === 'POST') {
    const result = readLastResult()
    if (!isDiagnosable(result)) {
      json(res, { error: 'No failed or rolled-back update to diagnose.', reason: 'no-rollback' }, 409)
      return true
    }
    if (!claudeAgentRunnable()) {
      json(res, {
        error: 'This host cannot run a Claude agent (CPU lacks AVX), so auto-diagnosis is unavailable. Manual intervention needed.',
        reason: 'claude-unrunnable',
      }, 400)
      return true
    }
    // Idempotency: one diagnosis per rollback, keyed by the outcome timestamp,
    // so a double-click (or a re-poll) does not spawn a second agent.
    const key = String(result?.ts ?? '')
    try {
      if (key && readFileSync(DIAGNOSE_MARKER, 'utf-8').trim() === key) {
        json(res, { ok: true, already: true })
        return true
      }
    } catch { /* no marker yet */ }
    const fired = await runScheduledTaskNow(DIAGNOSE_TASK, { allowDisabled: true })
    if (!fired.ok) {
      logger.warn({ err: fired.error }, 'post-rollback diagnosis could not be fired')
      json(res, { error: fired.error || 'Could not start the diagnosis agent.', reason: 'fire-failed' }, 500)
      return true
    }
    try { writeFileSync(DIAGNOSE_MARKER, key, { mode: 0o600 }) } catch { /* best-effort */ }
    logger.info({ result: fired.result }, 'post-rollback diagnosis fired')
    json(res, { ok: true, result: fired.result })
    return true
  }

  if (path === '/api/updates/check' && method === 'POST') {
    const status = await refreshUpdateStatus()
    json(res, status)
    return true
  }

  if (path === '/api/updates/apply' && method === 'POST') {
    // Optional body { autoStash: true, repo: 'fork' | 'upstream' }.
    // repo defaults to 'fork' (existing behavior). 'upstream' runs a
    // synchronous git fetch+merge without restarting services.
    let autoStash = false
    let repo: 'fork' | 'upstream' = 'fork'
    try {
      const buf = await readBody(ctx.req)
      if (buf.length > 0) {
        const parsed = JSON.parse(buf.toString()) as { autoStash?: unknown; repo?: unknown }
        autoStash = parsed.autoStash === true
        if (parsed.repo === 'upstream') {
          repo = 'upstream'
        } else if (parsed.repo !== undefined && parsed.repo !== 'fork') {
          json(res, { error: 'Invalid repo. Must be "fork" or "upstream".', reason: 'invalid-repo' }, 400)
          return true
        }
      }
    } catch {
      // Empty/invalid body: treat as defaults.
    }
    const pf: PidfileRunner = {
      readPidfile: () => {
        try {
          const st = statSync(UPDATE_PIDFILE)
          if (!st.isFile() || st.size > 256) return null
          return readFileSync(UPDATE_PIDFILE, 'utf-8')
        } catch {
          return null
        }
      },
      isProcessAlive: (pid) => {
        try {
          process.kill(pid, 0)
          return true
        } catch (err) {
          return (err as NodeJS.ErrnoException)?.code === 'EPERM'
        }
      },
      now: () => Date.now(),
    }
    const pidfileContent = `${process.pid}\n${Date.now()}\n`
    let lockHeld = false
    try {
      writeFileSync(UPDATE_PIDFILE, pidfileContent, { flag: 'wx' })
      lockHeld = true
    } catch (err) {
      if ((err as NodeJS.ErrnoException)?.code !== 'EEXIST') {
        json(res, {
          error: 'Pidfile write failed: ' + (err instanceof Error ? err.message : String(err)),
          reason: 'lock-write-failed',
        }, 500)
        return true
      }
      const concurrency = checkNoConcurrentUpdate(pf)
      if (!concurrency.ok) {
        json(res, {
          error: concurrency.message,
          reason: concurrency.reason,
          pid: concurrency.pid,
        }, 409)
        return true
      }
      try { unlinkSync(UPDATE_PIDFILE) } catch { /* already gone */ }
      try {
        writeFileSync(UPDATE_PIDFILE, pidfileContent, { flag: 'wx' })
        lockHeld = true
      } catch (retryErr) {
        const code = (retryErr as NodeJS.ErrnoException)?.code
        if (classifyLockWriteError(code) === 'race') {
          json(res, {
            error: 'Another update is starting concurrently. Retry in a few seconds.',
            reason: 'already-running',
            pid: 0,
          }, 409)
          return true
        }
        json(res, {
          error: 'Pidfile retry-write failed: ' + (retryErr instanceof Error ? retryErr.message : String(retryErr)),
          reason: 'lock-write-failed',
        }, 500)
        return true
      }
    }
    const releaseLock = () => {
      if (!lockHeld) return
      try { unlinkSync(UPDATE_PIDFILE) } catch { /* already gone */ }
      lockHeld = false
    }
    const git: GitRunner = {
      currentBranch: () => execFileSync(
        '/usr/bin/git',
        ['rev-parse', '--abbrev-ref', 'HEAD'],
        { cwd: PROJECT_ROOT, timeout: 3000, encoding: 'utf-8' },
      ),
      porcelainStatus: () => execFileSync(
        '/usr/bin/git',
        ['status', '--porcelain', '--untracked-files=no'],
        { cwd: PROJECT_ROOT, timeout: 3000, encoding: 'utf-8' },
      ),
      aheadCount: () => {
        try {
          const out = execFileSync(
            '/usr/bin/git',
            ['rev-list', '--count', '@{u}..HEAD'],
            { cwd: PROJECT_ROOT, timeout: 3000, encoding: 'utf-8' },
          ).trim()
          const n = parseInt(out, 10)
          return Number.isFinite(n) ? n : 0
        } catch { return 0 }
      },
    }
    let preflight
    try {
      preflight = checkUpdatePreflight(git)
    } catch (err) {
      releaseLock()
      json(res, {
        error: 'Pre-check failed: ' + (err instanceof Error ? err.message : String(err)),
        reason: 'precheck-crashed',
      }, 500)
      return true
    }
    if (!preflight.ok) {
      // dirty-tree + autoStash=true: skip the dashboard-side block and let
      // update.sh handle the stash+pop. The other failure reason (detached
      // HEAD) still hard-blocks since stash cannot rescue it.
      // dirty-tree can be auto-stashed; local-commits and detached-head cannot.
      const skipForAutoStash = preflight.reason === 'dirty-tree' && autoStash
      if (!skipForAutoStash) {
        releaseLock()
        const body: Record<string, unknown> = {
          error: preflight.message,
          reason: preflight.reason,
        }
        json(res, body, 409)
        return true
      }
    }
    // Upstream merge: analyze what would change + the conflict-risk (own-divergence overlap) BEFORE
    // touching HEAD, notify Peti with that summary, merge, then -- on success -- hand off to update.sh
    // in POST_MERGE_MODE (rebuild + the SAME restart/health-check/auto-rollback the fork-pull path
    // uses, skipping the pull step since the merge already advanced HEAD). Peti directive 2026-08-04
    // (Telegram msg 3284): analyze -> assess risk -> implement -> safe restart+health-check+rollback,
    // all behind the one button.
    if (repo === 'upstream') {
      let analysis: UpstreamAnalysis | undefined
      try {
        analysis = analyzeUpstreamChanges(realUpstreamAnalysisRunner)
      } catch (err) {
        logger.warn({ err }, 'upstream pre-merge analysis failed (non-fatal, merge proceeds without it)')
      }
      if (analysis) {
        try {
          execFileSync('/bin/bash', [join(PROJECT_ROOT, 'scripts', 'notify.sh'), formatUpstreamAnalysis(analysis)], {
            cwd: PROJECT_ROOT, timeout: 10_000,
          })
        } catch (err) {
          logger.warn({ err }, 'pre-merge analysis notify failed (non-fatal)')
        }
      }
      const result = performUpstreamMerge(realUpstreamMergeRunner)
      if (!result.ok) {
        releaseLock()
        logger.warn({ reason: result.reason }, 'upstream merge failed')
        json(res, { error: result.message, reason: result.reason }, result.reason === 'merge-conflict' ? 409 : 500)
        return true
      }
      logger.info({ beforeSha: result.beforeSha, afterSha: result.afterSha }, 'upstream merge completed successfully; handing off to update.sh for rebuild+restart')
      // Lock handoff to update.sh's own pidfile-overwrite (same as the fork path below) --
      // releaseLock() is only called by spawnUpdateScript on a failure BEFORE that handoff.
      spawnUpdateScript(res, {
        AUTO_STASH: '0',
        POST_MERGE_MODE: '1',
        POST_MERGE_OLD_SHA: result.beforeSha,
        MARVEEN_UPDATE_NOTIFY: '1',
      }, pidfileContent, releaseLock)
      return true
    }

    spawnUpdateScript(res, { AUTO_STASH: autoStash ? '1' : '0' }, pidfileContent, releaseLock)
    return true
  }

  return false
}
