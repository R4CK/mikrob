// EGRESSSELFEDIT824: a hash baseline for store/egress-allowlist.json, and a report of every
// change to it, whoever made it and by whatever route.
//
// WHY: the allowlist is the gate egress-gate.mjs applies to every agent, and it is a plain
// file in the agents' own tree. On 2026-08-24 a nested sub-agent added a domain to it and
// removed it again. Afterwards nobody could prove the file was back to its old bytes: store/
// is gitignored, and no copy or hash existed. self-pace-gate.mjs now refuses the casual write
// routes for sub-agents, but a hook reads a command STRING -- a script that builds the path at
// runtime, or a glob that never spells the name, is invisible to it. This module is the layer
// that does not depend on the route: it compares the file's bytes with the last recorded ones.
//
// What it does on every check (dashboard boot + every change the file watcher sees):
//   - sha256 of the current bytes (or "missing");
//   - if that differs from the last history entry: a full copy into
//     store/egress-allowlist.history/<UTC-stamp>-<sha12>.json, a line in history.log, and a
//     report (the domain-level diff) to the main agent;
//   - the very first check only writes the baseline, it has nothing to compare against.
// The boot check is what catches a write made while the dashboard was down.
//
// HONEST LIMIT: every agent runs as the same OS user, so the history directory is as writable
// as the file itself. This makes a change VISIBLE and the previous bytes RECOVERABLE; it does
// not make the file unwritable. That needs an OS-level owner or flag, an owner decision.
//
// Card 86c1372a (RedHat GO on 1f4c046b, F-RH1): "previous" used to be re-derived on every check
// by reading the LAST file in the history directory -- and that directory was,
// until this same card's companion fix in self-pace-gate.mjs, writable by a sub-agent through the
// native Write tool (the Bash-side check already refused it by name, the file-tool check did
// not). A decoy entry dropped there with a later timestamp could make the next check believe the
// decoy's bytes were already the approved baseline, silencing any future report of the real
// change (the "history decoy" bypass). The dashboard process now keeps the approved sha/bytes in
// its OWN memory, keyed by store dir, and compares against THAT -- not a re-read of the (still,
// defense-in-depth, same-OS-user-writable) history directory. The history directory keeps
// recording every observed version for recovery, as before; it is simply no longer the source of
// truth for "did this change".
//
// This also moves detection off the 5s mtime-poll (watchFile) onto fs.watch on the store
// directory, which gets an event per write syscall rather than per timer tick -- a value written
// and reverted within a second (the measured "1s pickup-putback" bypass) now produces two
// separate, immediately-detected events instead of one silent round trip between poll ticks.
// watchFile stays wired too, as a slower backstop (its own comment on why mtime-polling survives
// a replaced file still applies -- fs.watch on some platforms can lose a watch across an
// unlink+recreate).
//
// WHAT THIS STILL DOES NOT DO: write the approved bytes back over an unapproved change. Doing
// that unconditionally would also revert the one LEGITIMATE route to this file -- the operator (or
// main agent) editing store/egress-allowlist.json directly to grant a domain, which is the
// workflow egress-gate.mjs's own top comment documents ("add it to store/egress-allowlist.json,
// then re-run the WebFetch"). This module cannot tell that edit apart from an attacker's at the
// byte level, and there is no approval step wired to anything yet -- adding a silent auto-revert
// here would break a working, documented feature without Peti's sign-off. See the REVIEW on this
// card for the explicit follow-up question.
import { createHash } from 'node:crypto'
import {
  existsSync, mkdirSync, readFileSync, writeFileSync, appendFileSync,
  watchFile, unwatchFile, watch as fsWatch,
} from 'node:fs'
import { join, basename as pathBasename } from 'node:path'
import { MAIN_AGENT_ID } from '../config.js'
import { createAgentMessage } from '../db.js'
import { logger } from '../logger.js'

export const HISTORY_DIRNAME = 'egress-allowlist.history'
const MISSING = 'missing'
const ALLOWLIST_FILENAME = 'egress-allowlist.json'

// The approved baseline, in process memory only -- keyed by store dir so tests using distinct
// temp dirs never see each other's state, and never read back from the history directory.
const approved = new Map<string, { sha: string; bytes: Buffer | null; historyName: string }>()

export interface BaselineResult {
  /** sha256 of the current bytes, or 'missing' */
  sha: string
  /** the previous recorded sha, null on the very first check */
  previous: string | null
  /** true when a new history entry was written */
  recorded: boolean
  /** the report sent (null when nothing changed or on the first baseline) */
  report: string | null
}

function sha256(buf: Buffer): string {
  return createHash('sha256').update(buf).digest('hex')
}

type Lists = Record<string, string[] | string>
function parseLists(text: string | null): Lists | null {
  if (text === null) return {}
  try {
    const j = JSON.parse(text) as Record<string, unknown>
    const out: Lists = {}
    for (const [k, v] of Object.entries(j)) {
      if (Array.isArray(v)) out[k] = v.map((x) => String(x))
      else if (typeof v === 'string') out[k] = v
    }
    return out
  } catch {
    return null
  }
}

/** Human-readable, domain-level difference between two versions of the file. */
export function describeAllowlistChange(before: string | null, after: string | null): string {
  if (after === null) return 'the file was DELETED'
  const a = parseLists(before)
  const b = parseLists(after)
  if (b === null) return 'the new content is NOT valid JSON (egress-gate falls back to the built-in list)'
  if (a === null) return 'the previous content was not valid JSON; new keys: ' + Object.keys(b).join(', ')
  const lines: string[] = []
  for (const key of [...new Set([...Object.keys(a), ...Object.keys(b)])].sort()) {
    const x = a[key]; const y = b[key]
    if (Array.isArray(x) || Array.isArray(y)) {
      const xs = new Set(Array.isArray(x) ? x : []); const ys = new Set(Array.isArray(y) ? y : [])
      const added = [...ys].filter((d) => !xs.has(d)); const removed = [...xs].filter((d) => !ys.has(d))
      if (added.length) lines.push(`${key} +${added.join(', +')}`)
      if (removed.length) lines.push(`${key} -${removed.join(', -')}`)
    } else if (x !== y) {
      lines.push(`${key}: ${x ?? '(none)'} -> ${y ?? '(none)'}`)
    }
  }
  return lines.length ? lines.join('; ') : 'bytes changed, lists unchanged (formatting only)'
}

// 2026-10-03T07:41:02.123Z -> 20261003T074102123Z (sortable, no characters a path dislikes)
function stamp(now: Date): string {
  return now.toISOString().replace(/[-:.]/g, '')
}

/**
 * Compare the allowlist with its last APPROVED (in-memory) version; record and report a
 * difference. `notify` receives the report text (production: an agent message to the main
 * agent). The history directory is still written on every change, for recovery -- it is not
 * consulted for the comparison (card 86c1372a; see the module header).
 */
export function checkEgressAllowlistBaseline(
  storeDir: string,
  notify: (report: string) => void,
  now: Date = new Date(),
): BaselineResult {
  const file = join(storeDir, ALLOWLIST_FILENAME)
  const historyDir = join(storeDir, HISTORY_DIRNAME)
  const bytes = existsSync(file) ? readFileSync(file) : null
  const sha = bytes ? sha256(bytes) : MISSING
  const prev = approved.get(storeDir) ?? null
  if (prev && prev.sha === sha) return { sha, previous: prev.sha, recorded: false, report: null }

  mkdirSync(historyDir, { recursive: true })
  const name = `${stamp(now)}-${sha.slice(0, 12)}${bytes ? '.json' : '.missing'}`
  writeFileSync(join(historyDir, name), bytes ?? '')
  appendFileSync(join(historyDir, 'history.log'), `${now.toISOString()} ${sha} ${bytes ? bytes.length : 0} ${name}\n`)

  if (!prev) {
    approved.set(storeDir, { sha, bytes, historyName: name })
    return { sha, previous: null, recorded: true, report: null }
  }

  const before = prev.sha === MISSING ? null : (prev.bytes ? prev.bytes.toString('utf-8') : null)
  const report =
    `[EGRESS-ALLOWLIST] store/egress-allowlist.json CHANGED (${describeAllowlistChange(before, bytes ? bytes.toString('utf-8') : null)}). ` +
    `sha ${prev.sha.slice(0, 12)} -> ${sha.slice(0, 12)}. Previous version: store/${HISTORY_DIRNAME}/${prev.historyName}. ` +
    'If you did not make or approve this change, restore the previous version and find out who wrote it: ' +
    'sub-agents may not edit this file (EGRESSSELFEDIT824).'
  try { notify(report) } catch { /* the record above stands even if the report fails */ }
  approved.set(storeDir, { sha, bytes, historyName: name })
  return { sha, previous: prev.sha, recorded: true, report }
}

/**
 * Check once now (catches a change made while the dashboard was down), then on every change
 * either watcher sees. fs.watch on the store DIRECTORY (not the file) for immediate, per-write
 * detection -- card 86c1372a, closing the window a fixed-interval poll left open. watchFile
 * (mtime polling) stays wired too, as a slower backstop: its own original reason (surviving the
 * file being replaced, same as the reader re-render watcher) still holds, and fs.watch can lose
 * its handle across an unlink+recreate on some platforms. Returns a stop function.
 */
export function watchEgressAllowlistBaseline(
  storeDir: string,
  notify: (report: string) => void,
  intervalMs = 5000,
): () => void {
  const file = join(storeDir, ALLOWLIST_FILENAME)
  const run = () => {
    try { checkEgressAllowlistBaseline(storeDir, notify) } catch { /* a failed check must not crash the server */ }
  }
  run()
  watchFile(file, { interval: intervalMs }, run)
  mkdirSync(storeDir, { recursive: true })
  const dirWatcher = fsWatch(storeDir, (_event, filename) => {
    if (filename && pathBasename(String(filename)) === ALLOWLIST_FILENAME) run()
  })
  dirWatcher.on('error', () => { /* fs.watch is the fast path; watchFile still covers us */ })
  return () => {
    unwatchFile(file, run)
    dirWatcher.close()
  }
}

/**
 * The production report: a `system` message in the main agent's queue, written the moment the
 * change is seen. Its value is exactly that it is ALREADY QUEUED: a history directory rewritten
 * later (same OS user) does not take back a message that has been sent.
 */
export function queueAllowlistReport(report: string): void {
  logger.warn({ report }, 'egress-allowlist.json changed')
  createAgentMessage('system', MAIN_AGENT_ID, report)
}
