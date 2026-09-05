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
import { mkdirSync, readFileSync, statSync, cpSync } from 'node:fs'
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

/** Copy the contents aside so a human can look at it after the original is (eventually) handled. */
function quarantine(name: string): string | null {
  try {
    mkdirSync(QUARANTINE_DIR, { recursive: true })
    const dest = join(QUARANTINE_DIR, `${quarantineSlug(name)}.${Date.now()}`)
    cpSync(join(AGENTS_BASE_DIR, name), dest, { recursive: true })
    return dest
  } catch (err) {
    logger.warn({ err, name }, 'agent-dir-tripwire: quarantine copy failed')
    return null
  }
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

  const fired: AgentDirRejection[] = []
  for (const r of rejected) {
    if (latched.has(r.name)) continue
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

  if (changed) writeLatch(latched)
  return fired
}

/** Test seam: where the latch lives, so a test can point at a temp store instead of guessing. */
export const AGENT_DIR_TRIPWIRE_LATCH_PATH = LATCH_PATH
export const AGENT_DIR_QUARANTINE_DIR = QUARANTINE_DIR
