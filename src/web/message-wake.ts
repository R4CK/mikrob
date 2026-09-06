// Card 3bd457ed (parent dc35fa1a): does an inter-agent message ask to interrupt
// its receiver NOW, or is it content for the receiver's next natural check?
//
// This lives in its own module rather than next to the row it reads (db.ts) for
// one concrete reason: both wake DECIDERS -- the message router's main-agent
// wakeup and the inbox-nudge watcher -- are heavily unit-tested with
// `vi.mock('../db.js')`, which replaces the whole module. A predicate imported
// from there would be an undefined binding in every one of those suites, and the
// failure would look like a crash in unrelated tests rather than a missing stub.
// A module nobody mocks keeps the predicate real in exactly the tests that
// exercise the decision.
//
// Card 7d47ca16 adds the allowlist that says WHICH message classes may ask for
// wake:false; it lives here too, right next to the predicate it constrains.
import type { AgentMessage } from '../db.js'

/**
 * The single predicate both wake-deciding call sites use, so the two cannot
 * drift into disagreeing about what a stored value means.
 *
 * Anything that is not an explicit 0 wakes. That direction is fail-OPEN on
 * purpose, and it is deliberately the opposite of the redispatch ledger's lock
 * (card 09a3d52a), because the two failures do not cost the same: a message that
 * wrongly wakes someone costs one interruption, while a message that wrongly
 * stays silent is invisible until the receiver happens to look -- and if it was
 * a failure or a security notice, that is the expensive one.
 */
export function messageWakesReceiver(msg: Pick<AgentMessage, 'wake'>): boolean {
  return Number(msg.wake ?? 1) !== 0
}

/**
 * The message classes that may ask for a quiet delivery. A STATIC list, in
 * source, on purpose (MikroB, comment 21447): the gate then decides on a STRING
 * it can read here, not on the behaviour of whatever object a caller passes.
 * Growing this list is a code change that goes through the gates -- there is no
 * configuration file, no environment variable and no runtime path that adds to
 * it, because a list that can grow at runtime is not an allowlist.
 *
 * WHAT BELONGS ON IT: an automated, REPEATING notice whose information is
 * already visible where the receiver will look anyway (the board, the pane), so
 * the second and third copy inform nobody. Today that is the session-stuck
 * repeat pair, measured at 13x / 10x / 9x / 7x over seven days.
 *
 * WHAT MAY NEVER: anything reporting a failure, a security finding, a quota
 * event, or asking for a decision. Those are exactly the messages whose cost of
 * arriving late is unbounded, which is why messageWakesReceiver() is fail-OPEN
 * in the same direction. The test that pins this can only recognise such a class
 * by its NAME, which is a real limit and is written down in DECISIONS.md rather
 * than papered over: it catches a class called `agent-failure-alert`, not one
 * called `class-17`.
 */
export const QUIET_MESSAGE_CLASSES = Object.freeze([
  'session-stuck-not-ready-repeat',
  'session-stuck-busy-repeat',
] as const)

export type QuietMessageClass = (typeof QUIET_MESSAGE_CLASSES)[number]

/**
 * True only for a class that is literally on the list above. Everything else --
 * an unknown string, a near-miss, a non-string, undefined -- is false, so the
 * caller wakes. The gate is fail-CLOSED towards silence and fail-OPEN towards
 * waking, which is the same asymmetry messageWakesReceiver() states: a needless
 * wake costs one interruption, a wrongly silenced failure costs however long it
 * takes someone to look.
 */
export function isQuietMessageClass(value: unknown): value is QuietMessageClass {
  return typeof value === 'string' && (QUIET_MESSAGE_CLASSES as readonly string[]).includes(value)
}
