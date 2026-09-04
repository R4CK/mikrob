// Stamp the CARD STATE onto an inter-agent message at SEND time (card ffaa4ff1).
//
// THE FAILURE. A dispatch message is written against the board as it looked when MikroB read it,
// and the recipient may not read it for minutes or hours -- longer if they are mid-task. By then the
// card can be done, taken by someone else, or reopened with a different finding. Three agents
// (backend, backend2, fullstack) independently hit this in one day; backend2 counted at least two
// cases of its own where the answer was either rebuilding something already finished or spending a
// round re-verifying.
//
// WHY SERVER-SIDE AND NOT A RULE IN THE DISPATCH TEMPLATE. Fullstack's split of the problem is the
// right one: the STRUCTURAL half (the state is read, then the message is composed, and the gap
// between them is invisible) cannot be closed by asking people to remember. The rule half is real
// too and lands in the runbooks -- but a stamp that depends on the sender remembering is exactly the
// control that goes missing on the busy day. So this runs in the POST /api/messages path, next to
// the kanban-ref normalizer that already rewrites card references there for the same reason: code
// enforcement of a convention agents otherwise have to hold in their heads.
//
// TWO CALLERS, AND THEY ARE NOT THE SAME (card 382dcb15, Cybered F1/F2). The POST path carries text an
// AUTHOR wrote, so a stamp already in it is a re-send and must be left alone. The AUTO-dispatch path
// (fireKanbanDispatch) composes its content from the card's own title and description, so its
// "sender" is the system, not an author -- and a marker in that text is the CARD TALKING ABOUT
// stamping, not a stamp. Those two need different idempotency answers, which is why there are two
// entry points below; appendCardStateStampForDispatch carries the measured failure.
//
// WHAT IT IS NOT. The stamp is a STALENESS HINT, not an authorization or a lock. It says what the
// board said at send time; the recipient still has to re-read the card before acting, which is why
// the runbook rule ships with it rather than instead of it. It is also not a guarantee against a
// hand-written lookalike: a sender can type a fake stamp line into their own content, and a reader
// cannot tell the two apart. That is acceptable for a hint between trusted peers and would NOT be
// acceptable if anything ever gated on it -- if something does, it needs a real signature, not this.

/** What the board says about one card, right now. */
export interface CardStateSnapshot {
  readonly id: string
  readonly status: string
  readonly updatedAt: number
}

export type CardStateLookup = (idPrefix: string) => CardStateSnapshot | null

/** Bare 8-hex tokens on a word boundary, which covers BOTH callers -- deliberately not anchored to
 *  `#`. On the POST /api/messages path the `#`-prefixed form has already been rewritten to `#<seq>` by
 *  normalizeKanbanRefs before this runs, so what is left is bare. On the AUTO-dispatch path
 *  normalizeKanbanRefs does NOT run at all (card 382dcb15, Cybered F3), so the id deliberately stays
 *  in hex as `[Kanban feladat #a1b2c3d4]` -- the word boundary matches it straight through the `#`. */
const HEX8_RE = /\b([a-f0-9]{8})\b/gi

/** At most this many cards get a line. A message quoting a dozen ids is a report, not a dispatch,
 *  and a dozen stamp lines would be noise that trains people to skip the block. */
export const MAX_STAMPED_CARDS = 3

/** The marker the block opens with. Also the idempotency check -- a message that already carries a
 *  stamp (a re-send, or a caller that built one itself) is left alone rather than stamped twice. */
export const CARD_STATE_MARKER = '[card-state @send]'

/**
 * Append a card-state block to `content` for the cards it names.
 *
 * Returns the content unchanged when: it names no card, none of the tokens resolve to a real card,
 * or a stamp is already present. Never throws -- a lookup that fails is treated as "no card", because
 * a message must not be lost over a decoration.
 */
export function appendCardStateStamp(content: string, lookup: CardStateLookup): string {
  if (!content) return content
  // Author-written text: a marker already present means this is a re-send, so leave it alone.
  if (content.includes(CARD_STATE_MARKER)) return content
  return stampCards(content, lookup)
}

/**
 * The AUTO-dispatch entry point -- the same stamp, WITHOUT the re-send guard.
 *
 * THE MEASURED FAILURE (card 382dcb15, Cybered F1). fireKanbanDispatch builds its message out of the
 * card's own title and description. appendCardStateStamp's guard asks "does this content contain the
 * marker?", and on this path the content is mostly text a card AUTHOR wrote -- so a card whose
 * description merely MENTIONS `[card-state @send]` answered yes, and the dispatch went out silently
 * unstamped.
 *
 * Not hypothetical, and worst exactly where it hurts: cards 382dcb15 and 790c962d both carry the
 * marker in their descriptions, so the two cards most likely to be dispatched while someone works on
 * this feature were the two that would not be stamped. An unstamped dispatch also silences the
 * delivery-time note, which takes the send stamp as its input -- so the miss is invisible twice.
 *
 * The guard has nothing to do here: this path never re-sends. It composes fresh content from the
 * board on every call, so a marker in that text is the card TALKING ABOUT stamping, never a stamp
 * this code wrote.
 *
 * RESIDUAL, stated rather than quietly fixed: a description containing a full stamped LINE
 * (`  <hex8> status=... updated_at=...`), not just the marker, will also be parsed by
 * formatDeliveryStalenessNote, which scans the whole body. That can only add a spurious "changed"
 * hint, never suppress a real one, and a hand-written message can do the same today -- so it is
 * hint quality, not this card's defect.
 */
export function appendCardStateStampForDispatch(content: string, lookup: CardStateLookup): string {
  if (!content) return content
  return stampCards(content, lookup)
}

/** The stamping itself, shared by both entry points -- they differ ONLY in the re-send guard. */
function stampCards(content: string, lookup: CardStateLookup): string {
  const seen = new Set<string>()
  const found: CardStateSnapshot[] = []
  for (const m of content.matchAll(HEX8_RE)) {
    const id = (m[1] ?? '').toLowerCase()
    if (seen.has(id)) continue
    seen.add(id)
    let snap: CardStateSnapshot | null = null
    try {
      snap = lookup(id)
    } catch {
      snap = null // a decoration must never cost a message
    }
    if (snap !== null) found.push(snap)
    if (found.length >= MAX_STAMPED_CARDS) break
  }
  if (found.length === 0) return content

  const lines = found.map((c) => `  ${c.id} status=${c.status} updated_at=${c.updatedAt}`)
  return (
    `${content}\n\n${CARD_STATE_MARKER} a tabla ezt mondta a kuldes pillanataban -- ` +
    `MIELOTT dolgozol rajta, olvasd ujra a kartyat:\n${lines.join('\n')}`
  )
}

// --- Delivery-time re-check (card 9566a197) ----------------------------------
//
// WHAT THE MEASUREMENT SAID, AND WHAT IT REFUTED. Card 9566a197 opened on the theory that dispatches
// about already-closed cards come from the SENDER reading a stale/cached board. The queue disagrees.
// Every stale dispatch in the 2026-08-22 incident carries a send-time stamp that was CORRECT when it
// was written -- msg 19064 stamped `956fdaf5 status=in_progress updated_at=1787398822`, and that is
// exactly what the board said at that moment. The card went `done` 35 minutes later. The message
// reached backend's pane 153 minutes after it was written. Backend's whole afternoon looks like that
// (msg 18976 onward: 25, 33, 66, 97, 108, 134, 153, 166, 183 minutes of queue wait), because
// delivery only happens when the receiving pane is ready and each delivery costs a full turn.
//
// So the sender was never the problem. The stamp is a PHOTOGRAPH, and the failure is that nothing
// re-reads the board between taking it and showing it -- a gap the send-time stamp's own header
// comment predicted ("the recipient may not read it for minutes or hours") and could not close from
// where it sits, because it runs in the POST path and the wait happens afterwards.
//
// WHY STATUS ONLY, NOT updated_at. A dispatch is made worthless by the card CHANGING COLUMN (done,
// or reopened by someone else), not by its updated_at ticking. Comparing timestamps would fire on
// every message MikroB sends right after moving a card -- the normal dispatch flow -- and a note that
// fires on healthy traffic is one that gets skipped when it matters.
//
// STILL A HINT, NOT A GATE. Same standing as the send-time stamp: a sender can hand-write a stamp
// block, so a "changed" line proves only that the CURRENT status differs from what the block claims.
// The current status itself is read from the board here, so the note cannot invent a state a card is
// not in. Nothing gates on it.

/** Opens the delivery-time block. Distinct from CARD_STATE_MARKER so the send-time stamp's own
 *  idempotency check never mistakes one for the other. */
export const CARD_STATE_DELIVERY_MARKER = '[card-state @delivery]'

/** One stamped line: leading whitespace, the id, status, updated_at -- the exact shape
 *  appendCardStateStamp writes. */
const STAMPED_LINE_RE = /^[ \t]+([a-f0-9]{8}) status=(\S+) updated_at=(\d+)[ \t]*$/gim

/**
 * Re-read the board for the cards a message was stamped with, and describe what MOVED while the
 * message sat in the queue.
 *
 * Returns '' -- append nothing -- when the message carries no send-time stamp, when no stamped card
 * resolves, or when every stamped card is still in the column it was stamped in. Never throws: a
 * lookup failure is treated as "unchanged", because a decoration must not cost a delivery.
 */
export function formatDeliveryStalenessNote(
  content: string,
  lookup: CardStateLookup,
  queuedSeconds: number,
): string {
  if (!content || !content.includes(CARD_STATE_MARKER)) return ''

  const changed: string[] = []
  const seen = new Set<string>()
  for (const m of content.matchAll(STAMPED_LINE_RE)) {
    const id = (m[1] ?? '').toLowerCase()
    if (seen.has(id)) continue
    seen.add(id)
    const stampedStatus = m[2] ?? ''
    let snap: CardStateSnapshot | null = null
    try {
      snap = lookup(id)
    } catch {
      snap = null // a decoration must never cost a message
    }
    if (snap === null || snap.status === stampedStatus) continue
    changed.push(`  ${id}: ${stampedStatus} -> ${snap.status}`)
  }
  if (changed.length === 0) return ''

  const waited = Math.max(0, Math.round(queuedSeconds / 60))
  return (
    `\n\n${CARD_STATE_DELIVERY_MARKER} ez az uzenet ${waited} percet allt a sorban, es azota ` +
    `VALTOZOTT a tabla -- lehet hogy a dispatch mar nem aktualis:\n${changed.join('\n')}\n` +
    `Olvasd ujra az erintett kartyakat, mielott barmit csinalsz.`
  )
}

/** Cards a "start this card" dispatch has nothing left to say about.
 *
 *  `done` is obvious. `waiting` is here because it means the work is BUILT and sitting in a gate --
 *  telling the builder to start it is the same noise, one step later. `planned` is deliberately NOT
 *  terminal: a card moved back to planned may genuinely need picking up again. `in_progress` is not
 *  terminal either, including the case where a gate FAIL reopened it -- that dispatch is live again. */
const DISPATCH_SUPERSEDED_STATUSES: ReadonlySet<string> = new Set(['done', 'waiting'])

/** The generated dispatch header, anchored to the START of the first line.
 *
 *  Anchored on purpose, and it is the whole safety of this feature: a message that merely MENTIONS a
 *  dispatch ("the [Kanban feladat #abc12345] you sent is stale") must never be suppressed. Same
 *  anchoring lesson isUrgentMessage records for verdict words, and c4f2de32 for gate verdicts.
 *
 *  The shape is produced by routes/kanban.ts (`[Kanban feladat #${id}]: ${title}...`), so it is
 *  formulaic rather than hand-written -- which is why dropping one loses no authored text. */
const DISPATCH_HEADER_RE = /^\[Kanban feladat #([a-f0-9]{8})\]/i

/**
 * Should this queued message be dropped instead of delivered, because it is a card dispatch whose
 * card has already finished?
 *
 * WHY THIS EXISTS, measured 2026-09-04 (card 790c962d). backend's queue held 10 dispatches; against
 * the board at that moment, SEVEN were already obsolete -- five `done`, two `waiting`, the oldest
 * queued six hours. The agent had done that work: it self-advances from the BOARD (fleet rule 11),
 * so the dispatch never informed it of anything. What the message still costs on arrival is a full
 * agent turn, plus a second one while the receiver works out it is stale and writes back. That
 * round trip -- not router latency -- is the "repeating stale-dispatch pattern" the card reports.
 * Delivery to an idle agent measures 0.1-0.2 minutes; there is no transport problem to fix.
 *
 * WHY NOT REUSE formatDeliveryStalenessNote's PATH. That function needs a send-time stamp block, and
 * dispatches do not carry one: they are created inside routes/kanban.ts via createAgentMessage,
 * bypassing the POST /api/messages path where appendCardStateStamp runs. Measured over 24 hours:
 * **1 of 62** dispatch messages carried a stamp. Keying this on the stamp would have made it inert
 * for 61 of the 62 messages it exists for -- a silent no-op that still looked implemented.
 *
 * FAIL-OPEN, deliberately, and the opposite of the sibling gates in this codebase. A lookup that
 * throws or finds nothing returns null and the message is DELIVERED. The asymmetry is the point:
 * delivering a stale dispatch costs one wasted turn, while wrongly dropping a live one loses work
 * nobody will notice is missing. When the two error directions have different weights, the guard
 * follows the lighter one.
 *
 * @returns the card id and its current status when the dispatch is superseded, else null.
 */
export function supersededDispatch(
  content: string,
  lookup: CardStateLookup,
): { readonly id: string; readonly status: string } | null {
  const firstLine = (content ?? '').split('\n').find((l) => l.trim().length > 0)
  if (!firstLine) return null
  const m = DISPATCH_HEADER_RE.exec(firstLine.trim())
  if (!m) return null
  const id = (m[1] ?? '').toLowerCase()
  let snap: CardStateSnapshot | null = null
  try {
    snap = lookup(id)
  } catch {
    return null // a lookup failure must never eat a message
  }
  if (snap === null || !DISPATCH_SUPERSEDED_STATUSES.has(snap.status)) return null
  return { id, status: snap.status }
}
