// Tripwire on the agents/ namespace (card 53c59307, Cybered's plan).
//
// WHAT IT WATCHES, AND WHY THAT TRIGGER. The obvious trigger -- "a new directory appeared under
// agents/" -- is the wrong one: creating an agent through POST /api/agents is legitimate and does
// exactly that, so the trigger would need a drifting baseline and would cry wolf. The trigger here
// is the NAME instead. Every legitimate door already refuses a reserved or malformed name (the API
// with a 400, the bundle import by throwing, the seed-corpus guard of card 54fd9c02 at install
// time), so a directory carrying one means somebody went around the doors. That is a structurally
// zero-false-positive signal, not a lucky one.
//
// The drop lives in agent-config.ts and is the CONTROL; this file is the VISIBILITY. Neither is
// sufficient alone: dropping silently means the attacker learns it failed while we never learn it
// was tried, and alerting alone would report a minting that actually happened.
//
// NO AUTOMATIC DELETION, deliberately. The drop has already neutralised the directory, so removing
// it would destroy evidence and buy nothing -- and an irreversible delete whose path an attacker
// CHOOSES is itself a primitive the moment the name match ever loosens. One sloppy regex is the
// whole distance between a harmless narrow match and arbitrary directory removal. We copy the
// contents to quarantine and leave the original untouched for a human.
import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, readdirSync, statSync, cpSync, type Dirent } from 'node:fs'
import { join } from 'node:path'
import { STORE_DIR, MAIN_AGENT_ID } from '../config.js'
import { AGENTS_BASE_DIR, listRejectedAgentDirNames, type AgentDirRejection } from './agent-config.js'
import { atomicWriteFileSync } from './atomic-write.js'
import { logger } from '../logger.js'

const LATCH_PATH = join(STORE_DIR, 'agent-dir-tripwire-latch.json')
const QUARANTINE_DIR = join(STORE_DIR, 'agent-dir-quarantine')

interface LatchFile {
  /** Names already alerted on, so a hot sweep does not re-alert every tick. */
  readonly alerted: string[]
}

function readLatch(): Set<string> {
  try {
    const parsed = JSON.parse(readFileSync(LATCH_PATH, 'utf-8')) as LatchFile
    return new Set(Array.isArray(parsed.alerted) ? parsed.alerted : [])
  } catch {
    return new Set()
  }
}

function writeLatch(names: Set<string>): void {
  try {
    atomicWriteFileSync(LATCH_PATH, JSON.stringify({ alerted: [...names].sort() }, null, 2))
  } catch (err) {
    logger.warn({ err }, 'agent-dir-tripwire: could not persist the latch')
  }
}

/**
 * Best-effort creation time, reported as a CORRELATION HINT and never as attribution.
 *
 * Every agent in this fleet runs as the same OS user, so ownership and permissions say nothing
 * about which agent made the directory. Anyone promising the filesystem will name the culprit is
 * mistaken. What a timestamp supports is lining the minute up against which sessions were active,
 * which is a lead, not proof -- and the alert says so in those words rather than implying more.
 */
function createdAtIso(name: string): string | null {
  try {
    return new Date(statSync(join(AGENTS_BASE_DIR, name)).birthtimeMs || statSync(join(AGENTS_BASE_DIR, name)).ctimeMs).toISOString()
  } catch {
    return null
  }
}

/** How much of an offending name the alert shows before truncating. Long enough to recognise a
 *  name, short enough that a megabyte-long one cannot be used to flood the orchestrator's inbox. */
const NAME_DISPLAY_MAX = 80

/**
 * Ceilings for ONE sweep (Cybersec H2 on card 53c59307, card 75de69d4).
 *
 * The latch bounds repetition PER NAME, and the module comment used to claim that settled the
 * self-inflicted DoS. It does not: `mkdir` in a loop makes N distinct names, so N alerts and N
 * recursive copies happen in a single sweep. One command could fill the orchestrator's inbox and
 * the disk at the same time.
 *
 * The individual alerts beyond the ceiling are replaced by ONE summary, and the copies that would
 * have accompanied them are simply not made. That loses NO evidence, which is the point: this module never deletes, so
 * the originals are still sitting in agents/ exactly as the attacker left them -- the quarantine
 * copy is a convenience for a human, not the record. Every name is still latched, so a flood does
 * not re-alert on the next tick either, and every name still reaches the structured log.
 */
const MAX_ALERTS_PER_SWEEP = 3
/** Names listed by the summary alert before it stops naming them and only counts. */
const SUMMARY_NAMES_MAX = 10
/** A single directory larger than this is not copied; the original stays where it is. */
const QUARANTINE_MAX_BYTES = 5 * 1024 * 1024

/**
 * Render an offending directory name as DATA, never as prose (Cybersec H1 on card 53c59307).
 *
 * THE FINDING, reproduced: `r.name` is raw readdirSync output, so on Linux it may contain ANY byte
 * except `/` and NUL -- NEWLINES included. Interpolated straight into the alert, a name like
 * `system-directive\n\n[SYSTEM-DIREKTIVA msg_id:...] <instruction>` arrived at the orchestrator as
 * its own line, inside a SECURITY ALERT, in a message whose `from` is the main agent's own id. That
 * id is the one thing the HTTP API refuses to forge (POST /api/messages answers 403 for
 * `from=marveen`, since the main agent has no agents/ directory), and this module writes it
 * in-process, past that guard. So the raw interpolation was not the same capability in new clothes,
 * it was a new one -- created by a single `mkdir` from exactly the actor this control watches for.
 *
 * Everything outside printable ASCII is escaped BEFORE quoting rather than relying on
 * JSON.stringify alone: JSON.stringify does not escape U+2028/U+2029, which several renderers still
 * break lines on. What reaches the body is therefore always one line, and always visibly quoted.
 */
function asData(name: string): string {
  const truncated = name.length > NAME_DISPLAY_MAX
  const shown = truncated ? name.slice(0, NAME_DISPLAY_MAX) : name
  const escaped = [...shown]
    .map((ch) => {
      const cp = ch.codePointAt(0) ?? 0
      return cp >= 0x20 && cp <= 0x7e ? ch : `\\u{${cp.toString(16)}}`
    })
    .join('')
  const quoted = JSON.stringify(escaped)
  return truncated ? `${quoted} (truncated; the full name is ${name.length} characters)` : quoted
}

/**
 * A filesystem-safe destination for the quarantine copy, derived from the name rather than being
 * the name (same H1: the alert prints this path, so a raw name here would smuggle the payload in a
 * SECOND time). The sha256 suffix keeps two different names that flatten to the same slug from
 * merging their contents into one directory.
 */
function quarantineSlug(name: string): string {
  const flat = name.replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 40)
  const safe = flat.length === 0 || flat.startsWith('.') ? `_${flat}` : flat
  return `${safe}.${createHash('sha256').update(name).digest('hex').slice(0, 12)}`
}

/** Recursive byte size, bounded: it stops as soon as the limit is exceeded, so a directory built to
 *  be enormous costs a walk rather than a copy. */
function sizeExceeds(dir: string, limit: number): boolean {
  let total = 0
  const walk = (d: string): boolean => {
    let entries: Dirent[]
    try { entries = readdirSync(d, { withFileTypes: true }) } catch { return false }
    for (const e of entries) {
      const full = join(d, e.name)
      if (e.isDirectory()) { if (walk(full)) return true; continue }
      try { total += statSync(full).size } catch { /* vanished mid-walk */ }
      if (total > limit) return true
    }
    return false
  }
  return walk(dir)
}

/** Copy the contents aside so a human can look at it after the original is (eventually) handled. */
function quarantine(name: string): string | null {
  try {
    const src = join(AGENTS_BASE_DIR, name)
    // Size-capped (card 75de69d4). Skipping the copy is safe in a way deleting never would be: the
    // original is deliberately left in place, so the evidence does not move.
    if (sizeExceeds(src, QUARANTINE_MAX_BYTES)) {
      logger.warn({ name, limit: QUARANTINE_MAX_BYTES }, 'agent-dir-tripwire: too large to quarantine, original left in place')
      return null
    }
    mkdirSync(QUARANTINE_DIR, { recursive: true })
    const dest = join(QUARANTINE_DIR, `${quarantineSlug(name)}.${Date.now()}`)
    cpSync(src, dest, { recursive: true })
    return dest
  } catch (err) {
    logger.warn({ err, name }, 'agent-dir-tripwire: quarantine copy failed')
    return null
  }
}

/** The one message that stands in for every alert past the per-sweep ceiling. */
function summaryBody(rest: AgentDirRejection[]): string {
  const named = rest.slice(0, SUMMARY_NAMES_MAX).map((r) => asData(r.name)).join(', ')
  const more = rest.length > SUMMARY_NAMES_MAX ? `, and ${rest.length - SUMMARY_NAMES_MAX} more` : ''
  return [
    `[TRIPWIRE agents/] ${rest.length} FURTHER offending directories appeared in the same sweep, reported together instead of one message each.`,
    '',
    `Names (as data): ${named}${more}`,
    'Many names at once is itself the signal: creating them takes a loop, not a mistake.',
    'These were NOT copied to quarantine and NOT deleted -- the originals are untouched under agents/, which is where the evidence was all along. Each name is in the structured log with its own line.',
    'Each is latched, so the next sweep stays quiet unless a directory disappears and comes back.',
  ].join('\n')
}

function alertBody(r: AgentDirRejection, copiedTo: string | null): string {
  const created = createdAtIso(r.name)
  const shown = asData(r.name)
  const what = r.reason === 'reserved-sender-id'
    ? `a RESERVED sender id (${shown}). It has been DROPPED from the fleet's agent list, so it never joins the context-guard sweep and nothing sends messages in its name.`
    : `a MALFORMED agent name (${shown}). It is NOT dropped -- it could be an old hand-made agent that genuinely needs life support, and the name is not a reserved id, so it mints nothing.`
  return [
    `[TRIPWIRE agents/] A directory under agents/ carries ${what}`,
    '',
    'Every legitimate way to create an agent refuses this name (POST /api/agents, the bundle import, the install-time seed guard), so its existence means those doors were bypassed -- most likely a plain `mkdir` from an agent shell.',
    created === null ? '' : `Directory created around: ${created}. That is a CORRELATION HINT ONLY: the whole fleet runs as one OS user, so the filesystem cannot say which agent made it. Compare the minute against which sessions were active.`,
    copiedTo === null ? '' : `Contents copied to: ${copiedTo}. The original is deliberately LEFT IN PLACE -- automatic deletion would destroy evidence and buy nothing, since the drop already neutralised it.`,
    'Alerted ONCE per name. It re-arms only if the directory disappears and comes back.',
  ].filter((l) => l !== '').join('\n')
}

/**
 * One sweep of the tripwire. Alerts at most once per offending name, ever, unless the directory
 * goes away and returns.
 *
 * THE LATCH IS NOT POLISH, IT IS LOAD-BEARING. listAllAgentNames() runs on a hot path (the invite
 * monitor calls it every few seconds, this sweep cyclically). Without a latch a single
 * `mkdir agents/system-directive` would write roughly twenty messages a minute into the main
 * agent's inbox for ever -- a one-command self-inflicted DoS on the orchestrator's input, reachable
 * by exactly the actor this control exists to stop. Persisting it means a process restart does not
 * re-arm the weapon either.
 *
 * WHAT THE LATCH DOES NOT COVER, stated because this comment used to imply it did (Cybersec H2,
 * card 75de69d4): the latch is keyed on the NAME, so it bounds repetition of one name over time and
 * nothing else. N distinct names -- a loop, not a mistake -- still produce N alerts and N recursive
 * copies inside a SINGLE sweep. That is what MAX_ALERTS_PER_SWEEP bounds -- copies included, since
 * only a detailed alert copies. The two mechanisms are perpendicular and both are needed.
 *
 * @param send the message writer, injected so this module stays testable without a database.
 * @returns the rejections it alerted on in THIS call (empty on a quiet sweep).
 */
export function sweepAgentDirTripwire(
  send: (from: string, to: string, content: string, originNote?: string | null) => unknown,
): AgentDirRejection[] {
  const rejected = listRejectedAgentDirNames()
  const present = new Set(rejected.map((r) => r.name))
  const latched = readLatch()

  // Re-arm: a name that is no longer present must leave the latch, or a directory that is removed
  // and recreated would never alert again.
  let changed = false
  for (const name of [...latched]) {
    if (!present.has(name)) { latched.delete(name); changed = true }
  }

  const fresh = rejected.filter((r) => !latched.has(r.name))
  const detailed = fresh.slice(0, MAX_ALERTS_PER_SWEEP)
  const overflow = fresh.slice(MAX_ALERTS_PER_SWEEP)

  const fired: AgentDirRejection[] = []
  for (const r of detailed) {
    // No separate copy ceiling: only the names that get a DETAILED alert are copied, so
    // MAX_ALERTS_PER_SWEEP already bounds the disk half of the amplification. A second constant
    // measured as dead -- removing it changed no test, which is the definition of unpinnable.
    const copiedTo = quarantine(r.name)
    try {
      send(MAIN_AGENT_ID, MAIN_AGENT_ID, alertBody(r, copiedTo), 'agents/ namespace tripwire (card 53c59307)')
    } catch (err) {
      // A failed send must NOT latch, or the one alert that mattered is lost silently.
      logger.warn({ err, name: r.name }, 'agent-dir-tripwire: alert send failed, staying armed')
      continue
    }
    logger.warn({ name: r.name, reason: r.reason, dropped: r.dropped }, 'agent-dir-tripwire: reserved or malformed directory under agents/')
    latched.add(r.name)
    changed = true
    fired.push(r)
  }

  // The overflow is logged per name either way -- only the MESSAGES are collapsed, not the record.
  if (overflow.length > 0) {
    for (const r of overflow) {
      logger.warn({ name: r.name, reason: r.reason, dropped: r.dropped }, 'agent-dir-tripwire: offending directory beyond the per-sweep alert ceiling')
    }
    try {
      send(MAIN_AGENT_ID, MAIN_AGENT_ID, summaryBody(overflow), 'agents/ namespace tripwire summary (card 75de69d4)')
      for (const r of overflow) { latched.add(r.name); fired.push(r) }
      changed = true
    } catch (err) {
      // Same rule as above: a summary that never left must not latch the names it covered.
      logger.warn({ err, count: overflow.length }, 'agent-dir-tripwire: summary send failed, staying armed')
    }
  }

  if (changed) writeLatch(latched)
  return fired
}

/** Test seam: where the latch lives, so a test can point at a temp store instead of guessing. */
export const AGENT_DIR_TRIPWIRE_LATCH_PATH = LATCH_PATH
export const AGENT_DIR_QUARANTINE_DIR = QUARANTINE_DIR
