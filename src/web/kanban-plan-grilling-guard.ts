// Refuse to start (planned -> in_progress) a card whose OWN description names plan-grilling as
// mandatory, when no plan-grilling verdict comment exists yet (card 8e42a4c3).
//
// THE INCIDENT: card fed3f037's own description said "plan-grilling KOTELEZO dispatch elott (1b.
// munkavegzesi szabaly)" -- it named its own risk (a previously-crashed critical infra component)
// and its own required step -- and the step was skipped anyway. It only surfaced because backend2
// re-read the card and flagged it by hand. Rule 6 of CLAUDE.md's code-quality section names exactly
// this failure mode: "a written rule alone rests on discipline, which is forgettable; make it
// STRUCTURAL wherever possible."
//
// THE PRECEDENT THIS FOLLOWS: kanban-gate-completeness-guard.ts and kanban-landed-guard.ts already
// do the same shape of thing for different claims -- read the card's OWN text for a requirement,
// check the comments for satisfying evidence, refuse the transition if it is missing. Same
// force-actor escape hatch (mikrob, for a deliberately trivial/already-scoped skip -- the
// plan-grilling skill's own Pitfalls section names that exception), same fail-open-on-internal-
// error rule (a guard that throws must not become a guard that freezes the board).
import { getKanbanCard, getKanbanComments } from '../db.js'
import { isForceActor } from '../kanban-force-actors.js'
import { logger } from '../logger.js'
import type { LandedVerdict } from './kanban-landed-guard.js'

// MEASURED, NOT ASSUMED (card 0b23ec28's own description, and root CLAUDE.md rule 1b): this is the
// one real occurrence of the phrase in this fleet's own kanban corpus. Proximity-bounded (no
// sentence break in between) rather than "anywhere in the description", so a long description that
// separately mentions plan-grilling once and "kötelező" once, about unrelated things, does not
// false-positive. Both accent spellings ("kötelező"/"kotelezo") are common in this fleet's ASCII-
// degraded Hungarian.
const PLAN_GRILLING_REQUIRED_RX = /(plan-grilling[^.\n]{0,60}k[öo]telez|k[öo]telez[^.\n]{0,60}plan-grilling)/i

// MikroB's own observed verdict shape (card 0b23ec28, real incident): "MIKROB VERDIKT JOVAHAGYVA:
// GO-WITH-CHANGES." The word "grilling" itself does not have to appear in the verdict comment --
// the grilling REPORT (a separate, earlier comment) already names the card; the verdict comment's
// job is to say GO/GO-WITH-CHANGES/RETHINK, which is what the skill's own Output section asks for.
// `(?<!NO[- ])\bGO\b` keeps the bare "GO" reading from also matching inside "NO-GO", the same guard
// kanban-gate-completeness-guard.ts's VERDICT_RX already applies for a different verdict family.
const PLAN_GRILLING_VERDICT_RX = /\bVERDIKT\b[\s\S]{0,80}?(GO-WITH-CHANGES|RETHINK|(?<!NO[- ])\bGO\b)/i

interface Comment {
  readonly author: string
  readonly content: string
}

/** True when `description` names plan-grilling as mandatory for this card. Exported for tests --
 *  the trigger phrase is the load-bearing, easy-to-drift part of this guard. */
export function requiresPlanGrilling(description: string | null): boolean {
  if (!description) return false
  return PLAN_GRILLING_REQUIRED_RX.test(description)
}

/** True when some comment on the card carries MikroB's plan-grilling verdict shape. */
function hasPlanGrillingVerdict(comments: readonly Comment[]): boolean {
  return comments.some((c) => PLAN_GRILLING_VERDICT_RX.test(c.content ?? ''))
}

/** Blocks planned -> in_progress when the card's own description requires plan-grilling and no
 *  verdict comment exists yet. Only fires on the START of work -- a card already past that point
 *  (waiting -> in_progress resume, a gate re-dispatch) is not a fresh dispatch and this guard has
 *  nothing new to check there; the landed/gate-completeness guards already own that transition's
 *  own rules. */
export function planGrillingGuardVerdict(cardId: string, nextStatus: unknown, force: boolean, actor?: string): LandedVerdict {
  if (nextStatus !== 'in_progress') return { blocked: false }
  if (isForceActor(force, actor)) return { blocked: false }

  let card: ReturnType<typeof getKanbanCard>
  try {
    card = getKanbanCard(cardId)
  } catch (err) {
    // Same rule as the landing/gate-completeness guards: a guard that throws must not become a
    // guard that freezes the board. The failure is in the checker, not the claim.
    logger.warn({ err, cardId }, 'plan-grilling-guard could not read the card; allowing the move')
    return { blocked: false }
  }
  if (!card) return { blocked: false } // 404 is the writer's job, not this guard's

  // Only a FRESH dispatch (planned -> in_progress) is in scope -- a card resuming from any other
  // status already passed this gate once (or never needed to).
  if (card.status !== 'planned') return { blocked: false }

  if (!requiresPlanGrilling(card.description ?? null)) return { blocked: false }

  let comments: Comment[]
  try {
    comments = getKanbanComments(cardId)
  } catch (err) {
    logger.warn({ err, cardId }, 'plan-grilling-guard could not read comments; allowing the move')
    return { blocked: false }
  }
  if (hasPlanGrillingVerdict(comments)) return { blocked: false }

  return {
    blocked: true,
    message:
      `Ez a kártya nem indítható: a kártya saját leírása plan-grillinget ír elő (1b. munkavégzési szabály), ` +
      `de nincs rajta MikroB plan-grilling verdikt komment ("VERDIKT ... GO/GO-WITH-CHANGES/RETHINK" alakban). ` +
      `Futtasd a \`plan-grilling\` skillt és várd meg MikroB verdiktjét, mielőtt dolgozni kezdesz rajta. ` +
      `Ha a kihagyás tudatos (triviális, jól körülhatárolt részfeladat -- a skill saját kivétel-szabálya szerint), ` +
      `MikroB force: true értékkel megnyithatja.`,
  }
}
