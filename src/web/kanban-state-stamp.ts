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

/** Bare 8-hex tokens on a word boundary. Deliberately NOT anchored to `#`: a dispatch message names
 *  the card as `45331a93`, and by the time this runs the `#`-prefixed form has already been rewritten
 *  to `#<seq>` by normalizeKanbanRefs. */
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
  if (content.includes(CARD_STATE_MARKER)) return content

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
