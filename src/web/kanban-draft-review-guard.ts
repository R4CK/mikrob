// Refuse the handoff (-> waiting) of a card carrying a LOCAL-LLM DRAFT that nobody has explicitly
// adjudicated (card 1338e68b, codebase-auditor finding (b) on the load-balancer phase 4df3e8e8).
//
// THE GAP THIS CLOSES. Rule 16 and the `local-llm-offload` skill both say the same thing in prose:
// the local 7B produces a DRAFT, and an online role-agent reviews it before anything ships
// ("DRAFT-ONLY: MikroB + a gate ujra-ellenorzi"). `store/offload-dispatch.sh` posts that draft as a
// comment under DRAFT_AUTHOR="local-llm". Nothing then checked that the review actually happened --
// the handoff lived entirely on the builder remembering to do it.
//
// MEASURED, NOT ASSUMED (this fleet's own board, 2026-09-10): 11 cards carrying a `local-llm` draft
// reached `done`. On NINE of them, no later comment from any other author so much as contains the
// word "draft". Two more sit in `waiting` today in the same state. So the failure mode is not
// hypothetical and it is not rare -- it is the normal case, which is exactly what CLAUDE.md's
// code-quality rule 6 means by "a written rule alone rests on discipline, which is forgettable".
//
// WHY -> waiting AND NOT -> done. `waiting` IS the handoff the card names ("atadas"): the builder
// declaring the work finished and asking for a gate. Catching it there costs one comment; catching
// it at `done` would mean the gates had already spent their pass on work whose draft provenance was
// never adjudicated, and `done` is reached by MikroB, who is a force-actor there anyway.
//
// WHY ANY VERDICT SATISFIES IT, INCLUDING A REJECTION. The defect being closed is a draft passing
// through UNEXAMINED -- silently ignored (wasted GPU) or silently shipped (unreviewed content). An
// agent who reads the draft, judges it wrong and writes the code itself has completed the handoff
// correctly. Demanding "accepted" would push agents to rubber-stamp bad drafts, inverting the point.
//
// THE PRECEDENT THIS FOLLOWS: kanban-plan-grilling-guard.ts, kanban-gate-completeness-guard.ts and
// kanban-landed-guard.ts are the same shape -- read the card for a requirement, look in the comments
// for satisfying evidence, refuse the transition when it is missing. Same force-actor escape hatch,
// same fail-open-on-internal-error rule (a guard that throws must not become a guard that freezes
// the board).
import { getKanbanCard, getKanbanComments } from '../db.js'
import { isForceActor } from '../kanban-force-actors.js'
import { logger } from '../logger.js'
import { GENERATED_COMMENT_AUTHORS, type LandedVerdict } from './kanban-landed-guard.js'

/**
 * The review marker, at the START of a line.
 *
 * LINE-ANCHORED DELIBERATELY, the same way rule 4b anchors `Gate-SHA:`: a comment that MENTIONS the
 * marker mid-sentence ("don't forget the Draft-Review: line") must be able to say so without
 * thereby satisfying the guard it is talking about. Quoting a rule is not obeying it.
 *
 * The vocabulary is small and closed because this marker is NEW -- there is no legacy corpus of
 * spellings to accommodate, so it can be defined tightly and documented, rather than widened after
 * the fact the way the gate-verdict scanner had to be (card 171422d2, 62 measured synonyms). Both
 * languages are accepted because this fleet writes both, and both accent spellings because its
 * Hungarian is routinely ASCII-degraded.
 */
export const DRAFT_REVIEW_RX =
  /^[ \t]*Draft-Review[ \t]*:[ \t]*(ELFOGADVA|ELUTAS[IÍ]TVA|R[EÉ]SZBEN|ACCEPTED|REJECTED|PARTIAL)\b/im

/** A draft comment is one posted by the offload writer itself (`store/offload-dispatch.sh`,
 *  DRAFT_AUTHOR="local-llm"). */
const DRAFT_AUTHOR = 'local-llm'

interface Comment {
  readonly author: string
  readonly content: string
  readonly created_at: number
}

/** The newest local-LLM draft's timestamp, or null when the card carries no draft at all. */
export function newestDraftAt(comments: readonly Comment[]): number | null {
  let newest: number | null = null
  for (const c of comments) {
    if ((c.author ?? '').toLowerCase() !== DRAFT_AUTHOR) continue
    const at = c.created_at ?? 0
    if (newest === null || at > newest) newest = at
  }
  return newest
}

/**
 * True when some comment adjudicates every draft on the card.
 *
 * TWO CHECKS, AND BOTH ARE LOAD-BEARING:
 *
 * (1) AUTHOR. The reviewer must not be one of the MACHINE-GENERATED writers -- reusing
 * kanban-landed-guard.ts's own `GENERATED_COMMENT_AUTHORS` rather than re-listing them here, so the
 * two cannot drift apart. Without this the local model could satisfy its own review by emitting the
 * marker inside its draft, which is precisely the class of hole Cybersec found in the plan-grilling
 * guard's first version (a builder self-satisfying the step meant to check it).
 *
 * (2) FRESHNESS, against the NEWEST draft rather than the oldest. A review is evidence only about
 * drafts that already existed when it was written. Anchoring on the newest means a card that got a
 * review and THEN two more drafts is blocked again -- which is correct, those two were never seen.
 * Anchoring on the oldest would let one early review cover every later draft forever, and needs no
 * per-draft id plumbing to get right.
 */
export function hasDraftReview(comments: readonly Comment[], newestDraft: number): boolean {
  return comments.some(
    (c) =>
      !GENERATED_COMMENT_AUTHORS.has((c.author ?? '').toLowerCase()) &&
      (c.created_at ?? 0) >= newestDraft &&
      DRAFT_REVIEW_RX.test(c.content ?? ''),
  )
}

/**
 * Blocks a transition INTO `waiting` when the card carries a local-LLM draft that no later
 * non-generated comment has explicitly adjudicated.
 */
export function draftReviewGuardVerdict(
  cardId: string,
  nextStatus: unknown,
  force: boolean,
  actor?: string,
): LandedVerdict {
  if (nextStatus !== 'waiting') return { blocked: false }
  if (isForceActor(force, actor)) return { blocked: false }

  let card: ReturnType<typeof getKanbanCard>
  try {
    card = getKanbanCard(cardId)
  } catch (err) {
    logger.warn({ err, cardId }, 'draft-review-guard could not read the card; allowing the move')
    return { blocked: false }
  }
  if (!card) return { blocked: false } // 404 is the writer's job, not this guard's

  // Only a real transition INTO waiting. Re-asserting the status a card already holds is not a
  // handoff and has nothing new to check.
  if (card.status === 'waiting') return { blocked: false }

  let comments: Comment[]
  try {
    comments = getKanbanComments(cardId)
  } catch (err) {
    logger.warn({ err, cardId }, 'draft-review-guard could not read comments; allowing the move')
    return { blocked: false }
  }

  const newestDraft = newestDraftAt(comments)
  if (newestDraft === null) return { blocked: false } // no draft -> nothing to adjudicate
  if (hasDraftReview(comments, newestDraft)) return { blocked: false }

  return {
    blocked: true,
    message:
      `Ez a kártya nem adható át gate-re: helyi LLM draft (\`local-llm\` komment) van rajta, amit még ` +
      `senki nem bírált el kimondottan. Írj egy kommentet, aminek egy SORA így kezdődik: ` +
      `"Draft-Review: ELFOGADVA" (beépítetted), "Draft-Review: RESZBEN" (egy részét használtad) vagy ` +
      `"Draft-Review: ELUTASITVA" (elolvastad, nem volt jó, magad írtad meg). Mindhárom elfogadható -- ` +
      `a lényeg, hogy a draft ne menjen át elbírálatlanul. A jelzésnek a legfrissebb draftnál ÚJABBNAK ` +
      `kell lennie, és nem írhatja a \`local-llm\` maga. Ha tudatosan lépsz át rajta, MikroB force: true ` +
      `értékkel megteheti.`,
  }
}
