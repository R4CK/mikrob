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
const FORCE_ACTORS = new Set(['mikrob'])

/** True when this (force, actor) pair may bypass a status guard. */
export function isForceActor(force: boolean, actor?: string): boolean {
  return force && actor !== undefined && FORCE_ACTORS.has(actor)
}

/** The allowlist itself, for tests and for a caller that needs to name it in a message. */
export function forceActors(): readonly string[] {
  return [...FORCE_ACTORS]
}
