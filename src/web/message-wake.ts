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
// Card 7d47ca16 (the next step) adds the allowlist that says WHICH message
// classes may ask for wake:false; it belongs here too.
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
