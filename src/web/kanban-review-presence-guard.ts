// Warn (never block) when a card transitions to `waiting` without a recent REVIEW comment from its
// own assignee (card 18fbb3a8, F3.1 follow-up: "SERVER-side check: a transition to waiting with no
// REVIEW comment by the assignee in the last 30 min gets an automatic warning comment").
//
// WHY THIS EXISTS. store/post-review.sh already enforces post-then-verify-then-move for callers
// that go through it, but nothing stops a DIRECT PUT/POST .../move to `waiting` that skips the
// script entirely (manual curl, a different script, a bug) -- exactly the empty-REVIEW shape
// 88b67fb4 was built to close, just via a door that script can't watch. This is the server-side
// backstop: it looks at what actually landed on the card, not at who claims to have followed the
// convention.
//
// WARN-ONLY, SAME AS kanban-spec-template-guard.ts. The grilling note on this card is explicit:
// "Add a SERVER-side check ... gets an automatic warning comment (warn-only)" -- it never blocks
// the transition. A false positive (e.g. a REVIEW posted slightly more than 30 minutes before
// the move, or by someone covering for an absent assignee) costs one comment, not a frozen card.
//
// Call this ONLY after the transition to `waiting` has actually succeeded (same discipline as
// specTemplateGuardCheck: prevStatus captured before the write, this runs after).
import { getKanbanCard, getKanbanComments, addKanbanComment } from '../db.js'
import { logger } from '../logger.js'

const GUARD_AUTHOR = 'review-presence-guard'
const REVIEW_WINDOW_SECONDS = 30 * 60

// Line-anchored, same convention as kanban-draft-review-guard.ts's own marker check: a comment
// that merely MENTIONS "review" mid-sentence must not count, only one that actually starts with it.
const REVIEW_MARKER_RX = /^\s*review\s*:/im

interface Comment {
  readonly author: string
  readonly content: string
  readonly created_at: number
}

/** Exported for tests. True if any comment, by the given author, starts with a REVIEW marker and
 *  was posted within `windowSeconds` of `now` (looking backward only -- a REVIEW can't postdate
 *  the transition it is meant to justify). */
export function hasRecentReviewFrom(
  comments: readonly Comment[],
  author: string,
  now: number,
  windowSeconds: number = REVIEW_WINDOW_SECONDS,
): boolean {
  return comments.some(
    (c) =>
      c.author === author &&
      REVIEW_MARKER_RX.test(c.content ?? '') &&
      c.created_at <= now &&
      now - c.created_at <= windowSeconds,
  )
}

export function reviewPresenceGuardCheck(
  cardId: string,
  prevStatus: string | null | undefined,
  nextStatus: unknown,
  actor?: string,
): void {
  try {
    if (process.env.REVIEW_PRESENCE_GUARD === 'off') return
    if (nextStatus !== 'waiting') return
    if (prevStatus === 'waiting') return // only an actual transition INTO waiting is in scope

    const card = getKanbanCard(cardId)
    if (!card) return
    if (!card.assignee) return // nobody to check a REVIEW against

    const comments = getKanbanComments(cardId)
    const now = Math.floor(Date.now() / 1000)
    if (hasRecentReviewFrom(comments, card.assignee, now)) return

    addKanbanComment(
      cardId,
      GUARD_AUTHOR,
      `WARNING (warn-only, card 18fbb3a8): this card moved to waiting, but no REVIEW comment from ` +
        `its own assignee (${card.assignee}) was found in the last ${REVIEW_WINDOW_SECONDS / 60} minutes. ` +
        `This does not block anything -- it only flags the gap for whoever picks up the gate, in case ` +
        `the REVIEW step (rule 4/11a) was skipped. actor=${actor ?? 'unknown'}.`,
      true,
    )
  } catch (err) {
    logger.warn({ err, cardId }, 'review-presence-guard could not evaluate the card; no side effect applied')
  }
}
