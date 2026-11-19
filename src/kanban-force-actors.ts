/**
 * WHO may send `force: true` past a kanban status guard (card a8aa9ae5, Cybersec F-1).
 *
 * Every guard on the board's state machine -- the landed-commit guard, the gate-completeness
 * guard, the newDevStop route check and now the dependency guard -- has to answer the same
 * question, and it was answered three separate times in three files with three private copies of
 * the same one-element Set. That is exactly the shape where a later widening lands in one copy and
 * the other two keep their own idea of who is allowed; the module exists so there is one answer.
 *
 * WHAT THIS IS NOT: authentication. `actor` is self-declared -- the dashboard API is bearer-token
 * protected as a whole, but nothing binds a request to the name it puts in the body. So this is a
 * speed bump that makes an override deliberate and attributable in the audit row, not a proof of
 * who did it. That limit is identical for the three older guards; it is not new here, and it must
 * not be described as stronger than it is.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { STORE_DIR } from './config.js'

const FORCE_ACTORS = new Set(['mikrob'])

/**
 * Card 2ba008f2 (elemzo plan-grilling on d5638d28, comment 32144, C1): the self-declared `actor`
 * check below has the same shared-dashboard-token holder as every caller -- a buggy, stale or
 * doubled degraded/night loop holds that exact token and can send `actor: 'mikrob', force: true`
 * just as easily as the real main agent can. During a session outage the bypass is refused
 * outright, for every caller, regardless of what `actor` says -- the outage marker is the SAME
 * auto-clearing signal quota-bridge.py already writes/clears for the gemini-fallback engagement
 * decision, not a new flag (elemzo C2: "degraded-active comes from the outage marker, not a
 * manual flag"). This deliberately re-reads the marker directly rather than importing
 * gemini-fallback-runner.ts's own `readSessionOutageActive` -- that module imports db.js, which
 * itself imports THIS module (for isForceActor), so importing it here would be a circular import.
 * Same staleness/future-skew hardening as that function (see its own doc comment for why both
 * checks exist): a missing/corrupt/stale/future-dated marker reads as "not outaged", the same
 * fail-safe-toward-normal direction. A legitimate human-at-dashboard override during an outage
 * still has the normal gate flow available; this only removes the one-field self-declared
 * shortcut for that window.
 *
 * Cybered NO-GO (comment 32445, Finding 2): unlike readSessionOutageActive's routing use (where
 * misreading "no outage" is harmless), this reads a self-declared owner flag -- so a marker that
 * EXISTS but cannot be trusted (corrupt JSON, wrong field types, unreadable, or an implausible
 * heartbeat value such as milliseconds instead of seconds) must fail CLOSED (treat as outage,
 * deny the bypass), not fail open toward normal. Two states still mean normal operation, both
 * pinned by kanban-force-actors.test.ts before this fix and unchanged by it: a genuinely MISSING
 * marker (nothing to distrust), and a validly-shaped marker whose heartbeat is simply outside the
 * fresh window in EITHER direction (stale past SESSION_OUTAGE_STALE_MS, or a modest future skew
 * within SESSION_OUTAGE_FUTURE_TOLERANCE_MS's own small-clock-drift allowance) -- that symmetric
 * fail-safe-toward-normal behavior is the accepted design, not a bug. Every other malformed/
 * unreadable state resolves to true (outage).
 */
const SESSION_OUTAGE_PATH = join(STORE_DIR, 'mikrob-session-outage.json')
const SESSION_OUTAGE_STALE_MS = 15 * 60 * 1000
const SESSION_OUTAGE_FUTURE_TOLERANCE_MS = 60 * 1000
// A sane bound on the raw heartbeat VALUE itself (seconds since epoch), independent of the
// freshness window above -- catches a unit-confused heartbeat (e.g. milliseconds, ~1000x too
// large) as malformed rather than letting the freshness math quietly read it as "very stale" or
// "very future" and fall through to the unchanged fail-open branches those are meant for.
const MIN_PLAUSIBLE_HEARTBEAT_SEC = 1_600_000_000 // 2020-09-13, long before this marker existed
const MAX_PLAUSIBLE_HEARTBEAT_SEC = 4_000_000_000 // 2096-10-02, generous future bound

function isSessionOutageActive(): boolean {
  let raw: string
  try {
    raw = readFileSync(SESSION_OUTAGE_PATH, 'utf-8')
  } catch (err) {
    // ENOENT (no marker at all) is normal operation. Anything else -- permission denied, a
    // directory in place of the file, ... -- means the marker exists but cannot be read: fail
    // closed.
    return (err as NodeJS.ErrnoException)?.code !== 'ENOENT'
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return true // corrupt or empty content -- exists, cannot be trusted: fail closed
  }

  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return true
  const obj = parsed as Record<string, unknown>
  if (typeof obj.active !== 'boolean') return true // malformed `active` field: fail closed
  if (obj.active === false) return false // explicitly marked inactive: normal operation

  const heartbeat = obj.heartbeat
  if (typeof heartbeat !== 'number' || !Number.isFinite(heartbeat)) return true // malformed: fail closed
  if (heartbeat < MIN_PLAUSIBLE_HEARTBEAT_SEC || heartbeat > MAX_PLAUSIBLE_HEARTBEAT_SEC) return true // implausible value: fail closed

  const ageMs = Date.now() - heartbeat * 1000
  if (ageMs > SESSION_OUTAGE_STALE_MS) return false // genuinely stale: normal operation resumes (unchanged)
  if (ageMs < -SESSION_OUTAGE_FUTURE_TOLERANCE_MS) return false // modest clock skew beyond tolerance (unchanged)
  return true // fresh and active: fence holds
}

/** True when this (force, actor) pair may bypass a status guard. */
export function isForceActor(force: boolean, actor?: string): boolean {
  if (isSessionOutageActive()) return false
  return force && actor !== undefined && FORCE_ACTORS.has(actor)
}

/** The allowlist itself, for tests and for a caller that needs to name it in a message. */
export function forceActors(): readonly string[] {
  return [...FORCE_ACTORS]
}
