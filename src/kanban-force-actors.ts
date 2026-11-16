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
 */
const SESSION_OUTAGE_PATH = join(STORE_DIR, 'mikrob-session-outage.json')
const SESSION_OUTAGE_STALE_MS = 15 * 60 * 1000
const SESSION_OUTAGE_FUTURE_TOLERANCE_MS = 60 * 1000

function isSessionOutageActive(): boolean {
  try {
    const raw = JSON.parse(readFileSync(SESSION_OUTAGE_PATH, 'utf-8')) as Record<string, unknown>
    if (raw.active !== true) return false
    const heartbeat = raw.heartbeat
    if (typeof heartbeat !== 'number' || !Number.isFinite(heartbeat)) return false
    const ageMs = Date.now() - heartbeat * 1000
    return ageMs >= -SESSION_OUTAGE_FUTURE_TOLERANCE_MS && ageMs <= SESSION_OUTAGE_STALE_MS
  } catch {
    return false
  }
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
