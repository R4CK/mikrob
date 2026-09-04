// Const-only module on purpose. Both the SENDER (system-directive.ts, which
// pulls in agent-process/tmux) and the RECEIVING-side guard (routes/
// messages.ts, on the request path) need this one string, and they must never
// drift apart -- the guard is what makes the sender's anchor trustworthy. A
// shared const module gives them one source of truth without dragging the
// heavyweight sender module into the HTTP route's import graph.
//
// It has no imports of its own and must keep it that way: routes/messages.ts,
// system-directive.ts AND agent-scaffold.ts all pull it in, so anything added
// here lands on the request path, the tmux path and the scaffold path at once.

/**
 * The reserved sender id of authenticated system-directive rows.
 * Written only by in-process callers; POST /api/messages rejects it with 403.
 *
 * NOT the bare `system` (card 5c5d7bc4, Cybersec MEDIUM on ab4c85f2's gate).
 * `system` is not this channel's namespace: five other in-process writers use
 * it for ordinary notifications, and one of them -- routes/agents.ts's "new
 * teammate arrived" notice -- interpolates a caller-supplied `description`
 * into the body. A token holder POSTing /api/agents could therefore put chosen
 * text into a genuine `from_agent="system"` row, and a recipient following the
 * CLAUDE.md recipe would find the row exactly where the recipe said to look.
 * The directive channel owning its OWN id makes that row a non-directive by
 * construction, without having to audit every present and future `system`
 * writer for injectable interpolation.
 */
export const SYSTEM_DIRECTIVE_SENDER = 'system-directive'

/**
 * The shared in-process notification sender. Legitimate INSIDE the process
 * (message-router, approvals, agents) and never legitimate over HTTP: the
 * `from` of a POST is a claim by whoever holds the shared Bearer token.
 */
export const LEGACY_SYSTEM_SENDER = 'system'

const RESERVED_SENDER_IDS: ReadonlySet<string> = new Set([
  SYSTEM_DIRECTIVE_SENDER,
  LEGACY_SYSTEM_SENDER,
])

/**
 * Whether an already-sanitized `from` claims one of the in-process-only sender
 * ids. Takes the SANITIZED form (sanitizeAgentIdent) rather than calling it
 * here, so this module stays import-free; the caller normalizes once and uses
 * the same value for every other guard in the chain.
 *
 * Case-insensitive, unlike the byte-exact comparison this replaces (card
 * 5c5d7bc4 item 2). sanitizeAgentIdent only strips characters, it does not
 * lower-case, so `from: "System"` sanitized to `System` slipped past a `===
 * 'system'` test. It could then be waved through by SYSTEM_SENDERS whenever
 * .env happened to carry the matching casing (`SYSTEM_SENDER_IDS=System`) --
 * the guard missing and the exemption matching are the same casing bug read
 * from two ends. Lower-casing here is a strict tightening: it only ever adds
 * rejections, and never widens what SYSTEM_SENDERS accepts (that set is left
 * byte-exact on purpose -- see the note at its construction).
 */
export function isReservedSenderId(sanitized: string): boolean {
  return RESERVED_SENDER_IDS.has(sanitized.toLowerCase())
}
