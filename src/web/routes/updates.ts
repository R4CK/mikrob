import {
  readFileSync, writeFileSync, mkdirSync, openSync, closeSync, statSync, unlinkSync,
} from 'node:fs'
import { join } from 'node:path'
import type http from 'node:http'
import { spawn, execFileSync, execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { PROJECT_ROOT, STORE_DIR } from '../../config.js'
import { logger } from '../../logger.js'
import { getKanbanCard } from '../../db.js'
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
import { buildCliUpdateStatus, cliUpdateDepsForRoute, startCliUpdate, VERSION_RE } from '../cli-update.js'
import type { RouteContext } from './types.js'

const execFileAsync = promisify(execFile)

// git for the update pre-check, off the event loop (ls-remote is a network call
// with a 15 s timeout). stdin is closed at once, as the synchronous calls did.
async function gitOut(args: string[], timeout: number): Promise<string> {
  const pending = execFileAsync('/usr/bin/git', args, { cwd: PROJECT_ROOT, timeout, encoding: 'utf-8' })
  pending.child.stdin?.end()
  const { stdout } = await pending
  return stdout
}

// trackedBranch() (update-checker.ts) runs git synchronously; the pre-check
// needs the same answer without blocking the event loop.
async function trackedBranchAsync(): Promise<string> {
  try {
    const b = (await gitOut(['rev-parse', '--abbrev-ref', 'HEAD'], 3000)).trim()
    return b && b !== 'HEAD' ? b : 'main'
  } catch {
    return 'main'
  }
}

// Pidfile path owned by update.sh for the lifetime of an update run.
// The dashboard never writes it -- update.sh does on entry, removes on exit
// via a trap -- so the gate survives the stop.sh / start.sh dashboard
// restart that happens inside a successful update.
const UPDATE_PIDFILE = join(PROJECT_ROOT, 'store', 'update.pid')

// The seeded on-demand (enabled:false) task the post-rollback diagnosis fires.
const DIAGNOSE_TASK = 'post-rollback-diagnose'
// One-diagnosis-per-rollback marker (keyed by the last-result timestamp).
const DIAGNOSE_MARKER = join(PROJECT_ROOT, 'store', 'update-diagnose.last')

// NOT ADOPTED: a repo==='upstream' special path used to fetch+merge upstream/main directly onto
// HEAD here, then hand off to update.sh in POST_MERGE_MODE -- entirely bypassing the gated, batched
// upstream-sync process (e5c46e87) that reviews every upstream commit through QA+Cybersec+Cybered
// before it reaches origin/develop. Cybered (card ef6a8031, comment 11275) found this is live-host
// code execution (T1543/T1195.001) behind one dashboard click: a never-reviewed upstream unit
// change could install/stop a systemd timer within the same minute. Peti's decision (card 55885cb1,
// comment 11279): the button stays, but may only ever pull content that has ALREADY passed the
// gated sync -- i.e. whatever is on this fork's own `origin` remote, the exact same thing the
// (unchanged, pre-existing) fork-pull path below already does. So `repo==='upstream'` no longer
// gets a special branch at all; see the apply handler below. The merge/analysis machinery that used
// to live here (performUpstreamMerge, analyzeUpstreamChanges, formatUpstreamAnalysis, their DI
// runner types, and the real git-shelling adapters) is deleted as dead code -- grep-verified nothing
// else in the tree referenced them (only this file and their own now-deleted test,
// updates-upstream-merge.test.ts, did). recordUpdateHistory/updateHistoryTimestamp/
// UPDATE_HISTORY_PATH went with them: they existed ONLY to give the raw upstream-merge path a
// rollback point: the fork-pull path's rollback point is recorded by update.sh itself, not by this
// file, both before this feature existed and after its removal.

// Card 651ee11f (WhiteHat2 CYBERSEC GO on 758e06dd, L3): a known-safe ALLOWLIST, not the full
// inherited process.env with specific bad keys deleted one at a time. update.sh reads several
// control switches straight from its OWN environment, with no CLI-flag equivalent --
// FORCE_REBUILD, UPDATE_AUTO_REBASE, RESEED_FLEET, REGEN_CLAUDEMD, POST_MERGE_OLD_SHA -- and a
// denylist only ever catches the ones someone thought to name; any other inherited value (set
// once for a debug run, left in a systemd unit, inherited from an operator shell) silently rode
// along into every ordinary fork-pull update after it. None of these are a login/shell basic, so
// none of them belong in this list.
// XDG_RUNTIME_DIR/DBUS_SESSION_BUS_ADDRESS (RedHat NO-GO F1, comment on 1cc5be855): neither is a
// control switch or a code-loading variable, they are what `systemctl --user` needs to reach the
// user session bus. Without them update.sh's `systemctl --user daemon-reload` calls (after it
// patches/creates unit files) and its `_unit_drift` check are written `2>/dev/null || true` /
// treat-failure-as-ok, so the loss was SILENT: measured on this host, `systemctl --user status`
// exits 1 with "$DBUS_SESSION_BUS_ADDRESS and $XDG_RUNTIME_DIR not defined" when only the other
// base keys are set, and exits 0 once XDG_RUNTIME_DIR alone is restored.
const BASE_ENV_KEYS = [
  'PATH', 'HOME', 'USER', 'LOGNAME', 'LANG', 'LC_ALL', 'TMPDIR', 'SHELL',
  'XDG_RUNTIME_DIR', 'DBUS_SESSION_BUS_ADDRESS',
] as const

/** Returns the env {@link spawnUpdateScript} hands to update.sh: the {@link BASE_ENV_KEYS} login
 *  basics (if set on this process), with `extraEnv` layered on top -- nothing else from the
 *  inherited environment crosses over. Builds a LOCAL object and never touches the real
 *  process.env (Cybersec NO-GO on an earlier version of the NODE_ENV fix below, which mutated it
 *  directly): a child process's env is an OS-level copy taken at its OWN spawn() (execve envp),
 *  not a live view of the parent's object, so a local object passed to spawn() already protects
 *  update.sh AND everything IT spawns, without the unbounded on-this-long-running-process lifetime
 *  a direct process.env mutation would have if update.sh exits before ever restarting it.
 *
 *  NODE_ENV is deliberately NOT in BASE_ENV_KEYS (AUTOUPDNODEENV905 half 2/2, card c116696f --
 *  half 1/2 landed as update.sh's own `--include=dev` on both npm ci sites, card 50af1a27): under
 *  NODE_ENV=production a plain `npm ci` prunes dev dependencies including the compiler, so an
 *  inherited value broke update.sh's own build five times in ten days before that card. The
 *  allowlist shape already keeps it out, but it is deleted here too, explicitly, as a named guard
 *  against a future BASE_ENV_KEYS edit silently reopening that incident.
 *
 *  POST_MERGE_MODE/POST_MERGE_OLD_SHA (card 758e06dd) no longer need special-case code: they are
 *  not base keys, so an inherited value can never reach `env` at all, and a caller that genuinely
 *  needs to set POST_MERGE_MODE still can, through `extraEnv`, the same as any other switch --
 *  this also closes the prototype-pollution gap the old `'POST_MERGE_MODE' in extraEnv` check had
 *  (`in` walks the prototype chain; `Object.assign` below only ever copies extraEnv's OWN
 *  properties). The one caller that used to set it directly (a raw upstream fetch+merge handed
 *  off to update.sh in POST_MERGE_MODE) was removed as dead code under card 55885cb1 -- see the
 *  NOT ADOPTED comment near the top of this file -- so nothing sets it today either way.
 *
 *  Built with Object.create(null), not a plain {} (RedHat NO-GO F2): node's spawn() copies the
 *  child env with a `for...in` loop, which walks the prototype chain -- a plain object inherits
 *  Object.prototype, so a polluted Object.prototype.FOO is an ENUMERABLE inherited property and
 *  reaches the spawned child even though `Object.hasOwn(env, 'FOO')` is false (measured on node
 *  22.23.2). A null-prototype object has no inherited enumerable properties at all, so `for...in`
 *  only ever sees what was actually assigned here. This also defuses `Object.assign(env,
 *  extraEnv)` for an extraEnv with an own `__proto__` key (e.g. from JSON.parse): against a plain
 *  object that assignment invokes Object.prototype's `__proto__` setter and changes env's own
 *  prototype (measured: a later-set key then leaks via the same for...in path); against a
 *  null-prototype object there is no inherited `__proto__` accessor, so it becomes an ordinary own
 *  property literally named "__proto__", never a prototype change. */
export function buildUpdateScriptEnv(extraEnv: Record<string, string>): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = Object.create(null)
  for (const key of BASE_ENV_KEYS) {
    const value = process.env[key]
    if (value !== undefined) env[key] = value
  }
  Object.assign(env, extraEnv)
  delete env.NODE_ENV
  return env
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
      env: buildUpdateScriptEnv(extraEnv),
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

// Cybersec MEDIUM (card 55885cb1 @ 68949451, fixed on card 82f05633): both repo blocks run the
// SAME fork-pull against this fork's own `origin` (see the big removed-code comment above), but
// marveen-land.sh pushes a batch BEFORE its gate closes -- the gate runs against the branch sha,
// AGREE only comes after. A landed-but-not-yet-gated UPSTREAM-SYNC batch (like ef6a8031's
// ed4633c2 before its own fix) can therefore sit on `origin` for a while, and a button press in
// that window would pull it straight onto the live host, exactly the thing Peti's "only a gated
// batch" decision on 55885cb1 was trying to prevent -- it just moved from "raw upstream merge"
// to "landed-but-ungated batch". MikroB's two-layer fix (card 82f05633, recorded on e5c46e87):
// (1) process -- UPSTREAM-SYNC batch cards now land only AFTER their gate closes; (2) this code
// -- refuse the pull outright if anything in the range about to be pulled names an UPSTREAM-SYNC
// card that is not yet `done`, as a second, independent layer that holds even if (1) is ever
// missed by a human or a script.
//
// Mirrors store/landing-downward-check.sh's `cards_in_subject` exactly (same regex, same
// card 6500e1d3 fix for the comma-vs-slash separator class) rather than inventing a second,
// possibly-divergent extractor for the same "which card(s) does this commit subject name"
// question -- see that script's own measurement notes for why the separator class and the
// `card`/`cards` keyword anchor are each worth keeping as they are.
const CARD_REF_BLOCK_RE = /\bcards?[ \t]+[0-9a-f]{8}\b(?:[ \t]*[/,][ \t]*[0-9a-f]{8}\b)*/gi
const HEX8_RE = /\b[0-9a-f]{8}\b/gi

/** Every card id a commit SUBJECT line names, lowercased, in the order they appear (may repeat). */
export function cardsInSubject(subject: string): string[] {
  const out: string[] = []
  for (const block of subject.match(CARD_REF_BLOCK_RE) ?? []) {
    for (const id of block.match(HEX8_RE) ?? []) out.push(id.toLowerCase())
  }
  return out
}

/** Looks up one card id; returns only the two fields the check below needs, so a test can fake
 *  this without constructing a full {@link KanbanCard}. */
export type KanbanCardLookup = (id: string) => { title: string; status: string } | undefined

/**
 * Pure: given the subjects of the commits about to be pulled and a card lookup, returns the
 * (deduplicated, sorted) ids of every UPSTREAM-SYNC card named in that range whose status is NOT
 * `done`. An empty result means the pull is safe to proceed. Deliberately does not care WHICH
 * commit named which card, or how many times -- the apply handler only needs a yes/no plus the
 * names for its error message.
 */
export function findOpenUpstreamSyncCards(
  commitSubjects: readonly string[],
  lookupCard: KanbanCardLookup,
): string[] {
  const open = new Set<string>()
  for (const subject of commitSubjects) {
    for (const id of cardsInSubject(subject)) {
      if (open.has(id)) continue
      const card = lookupCard(id)
      if (card && /UPSTREAM-SYNC/i.test(card.title) && card.status !== 'done') open.add(id)
    }
  }
  return [...open].sort()
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

  // Claude Code CLI update OFFER (CLIFRISSAJANLAS923). GET measures; nothing
  // is installed until the operator POSTs the exact target the GET offered.
  if (path === '/api/updates/cli' && method === 'GET') {
    json(res, await buildCliUpdateStatus(cliUpdateDepsForRoute({ fresh: ctx.url.searchParams.get('fresh') === '1' })))
    return true
  }
  if (path === '/api/updates/cli/apply' && method === 'POST') {
    const body = String(await readBody(ctx.req).catch(() => '') ?? '')
    let requested = ''
    try { requested = String((JSON.parse(body || '{}') as { target?: unknown }).target ?? '') } catch { requested = '' }
    if (!VERSION_RE.test(requested)) { json(res, { error: 'target must be a dotted version', reason: 'bad-target' }, 400); return true }
    // Re-decide fresh: the only installable version is the one the offer
    // computes NOW (an AVX-less host can never be handed "latest" this way).
    const status = await buildCliUpdateStatus(cliUpdateDepsForRoute({ fresh: true }))
    if (!status.offer || status.target !== requested) {
      json(res, { error: `not offered: ${status.reason}`, reason: 'not-offered', target: status.target, offer: status.offer }, 409)
      return true
    }
    if (status.installMethod === 'unknown') {
      json(res, { error: 'the installed claude was not installed by npm or the official installer; run the manual command instead', reason: 'unknown-method', manualCommand: status.manualCommand }, 400)
      return true
    }
    const started = startCliUpdate(status.target, status.installMethod)
    if (!started.ok) { json(res, { error: started.error, reason: 'not-started' }, 409); return true }
    json(res, { ok: true, started: true, target: status.target, method: status.installMethod })
    return true
  }

  if (path === '/api/updates/check' && method === 'POST') {
    const status = await refreshUpdateStatus()
    json(res, status)
    return true
  }

  if (path === '/api/updates/apply' && method === 'POST') {
    // Optional body { autoStash: true, repo?: string }. `repo` is accepted but no longer changes
    // behavior (card 55885cb1): every accepted value below runs the SAME fork-pull path -- a plain
    // `git pull`/update.sh run against this fork's own `origin` remote, never the raw `upstream`
    // remote. That remote is only ever touched by the gated, batched upstream-sync process
    // (e5c46e87); by the time anything from it is reachable here, it is already on `origin`.
    // `repo` is still validated (not silently ignored) so a genuinely unknown value is a clear
    // 400, not a quiet no-op -- Peti's acceptance criterion (2) on card 55885cb1. The accepted set
    // covers both the route's own historical values ('fork'/'upstream') and the actual values the
    // dashboard's status endpoint uses today (update-checker.ts: 'mikrob'/'marveen') -- the two
    // never lined up (a pre-existing bug, found while fixing this card: every real button click
    // was already getting a 400 'Invalid repo' before this change, for EITHER repo block).
    let autoStash = false
    try {
      const buf = await readBody(ctx.req)
      if (buf.length > 0) {
        const parsed = JSON.parse(buf.toString()) as { autoStash?: unknown; repo?: unknown }
        autoStash = parsed.autoStash === true
        const ACCEPTED_REPO_KEYS = new Set(['fork', 'upstream', 'mikrob', 'marveen'])
        if (parsed.repo !== undefined && !ACCEPTED_REPO_KEYS.has(parsed.repo as string)) {
          json(res, { error: 'Invalid repo.', reason: 'invalid-repo' }, 400)
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
    const countRevs = async (range: string): Promise<number> => {
      try {
        const out = (await gitOut(['rev-list', '--count', range], 3000)).trim()
        const n = parseInt(out, 10)
        return Number.isFinite(n) ? n : 0
      } catch { return 0 }
    }
    const git: GitRunner = {
      currentBranch: () => gitOut(['rev-parse', '--abbrev-ref', 'HEAD'], 3000),
      porcelainStatus: () => gitOut(['status', '--porcelain', '--untracked-files=no'], 3000),
      // UPSTREAMSRC927: origin/<branch>, the ref update.sh pulls -- not `@{u}`,
      // which is whatever the branch happens to track. No fetch here (this is
      // the request path); the ref can be stale, which is why update.sh fetches
      // and measures again before its own divergence check.
      aheadCount: async () => countRevs(`origin/${await trackedBranchAsync()}..HEAD`),
      behindCount: async () => countRevs(`HEAD..origin/${await trackedBranchAsync()}`),
      // Mirrors update.sh guard 2. `git ls-remote --exit-code --heads` exits
      // 2 for "no such branch" and 128 for a transport/auth failure -- the
      // difference matters: only 2 is evidence, 128 is an unknown we must not
      // block on. A spawn failure or a timeout leaves no numeric exit code,
      // which is likewise unknown.
      originHasBranch: async (branch: string) => {
        try {
          await gitOut(['ls-remote', '--exit-code', '--heads', 'origin', branch], 15000)
          return 'yes' as const
        } catch (err) {
          // execFile reports git's exit status as err.code (a number); a spawn
          // failure or a timeout leaves no numeric code -- unknown, as before.
          const code = (err as { code?: unknown }).code
          return code === 2 ? ('no' as const) : ('unknown' as const)
        }
      },
    }
    let preflight
    try {
      preflight = await checkUpdatePreflight(git)
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
    // NOT ADOPTED (card 55885cb1): this used to branch on `repo === 'upstream'` into a direct
    // fetch+merge of the raw `upstream` remote onto HEAD, then an immediate POST_MERGE_MODE
    // update.sh run -- see the removed-code comment near the top of this file. Every accepted
    // `repo` value now runs this exact same path: a plain pull against this fork's own `origin`,
    // through update.sh's own preflight/stash/rebuild/restart/rollback machinery, same as it
    // always has for the non-upstream case. If there is nothing new to pull, update.sh's own
    // "already on the latest commit" exit covers Peti's acceptance criterion (2) -- a clear
    // message, not a silent no-op.
    //
    // Card 82f05633, second layer (see findOpenUpstreamSyncCards' own comment for the first):
    // refuse outright if the range about to be pulled names an UPSTREAM-SYNC card that has not
    // yet reached `done` -- a batch that landed before its own gate closed.
    //
    // TOCTOU fix (Cybered NO-GO, comment 11486): the check used to read `HEAD..@{u}` -- the
    // LOCAL tracking ref, as of the dashboard's last fetch -- while the actual pull below
    // (update.sh's own `git pull --ff-only origin <branch>`) fetches FRESH. A batch that landed
    // on origin since the dashboard's last fetch was invisible to `@{u}` and therefore to this
    // check, while update.sh's pull would still bring it onto the live host: exactly the window
    // the card's own acceptance criterion says must not exist ("holds even if the process layer
    // is missed"). Fixed by fetching immediately before computing the range, against the SAME
    // ref the pull is about to use, fail-closed on the fetch itself too.
    let openUpstreamSyncCards: string[]
    try {
      const branch = (await git.currentBranch()).trim()
      execFileSync('/usr/bin/git', ['fetch', 'origin', branch], { cwd: PROJECT_ROOT, timeout: 15_000 })
      const subjectsOut = execFileSync(
        '/usr/bin/git',
        ['log', '--format=%s', `HEAD..origin/${branch}`],
        { cwd: PROJECT_ROOT, timeout: 10_000, encoding: 'utf-8' },
      )
      openUpstreamSyncCards = findOpenUpstreamSyncCards(subjectsOut.split('\n').filter(Boolean), getKanbanCard)
    } catch (err) {
      // FAIL-CLOSED, not fail-open: this is a security gate (card 82f05633 exists because a
      // gap here lets ungated upstream code reach the live host), so "could not determine the
      // answer" refuses the same as "the answer is yes" -- it does not silently become "no".
      // A failure here (fetch or log) is a transient or network error, not evidence of safety;
      // the operator can simply retry.
      releaseLock()
      logger.warn({ err }, 'open-UPSTREAM-SYNC-card check failed -- refusing the pull (fail-closed)')
      json(res, {
        error: 'Nem sikerült ellenőrizni, van-e nyitott UPSTREAM-SYNC köteg a lehúzandó tartományban. Próbáld újra.',
        reason: 'open-upstream-sync-check-failed',
      }, 500)
      return true
    }
    if (openUpstreamSyncCards.length > 0) {
      releaseLock()
      json(res, {
        error:
          'A lehúzandó tartományban nyitott UPSTREAM-SYNC köteg van, ami még nem ment át a ' +
          `gate-en: ${openUpstreamSyncCards.join(', ')}. Várj, amíg a kártya gate-je lezárja ` +
          '(PASS/GO + done), majd próbáld újra.',
        reason: 'open-upstream-sync-card',
        openCardIds: openUpstreamSyncCards,
      }, 409)
      return true
    }
    spawnUpdateScript(res, { AUTO_STASH: autoStash ? '1' : '0' }, pidfileContent, releaseLock)
    return true
  }

  return false
}
