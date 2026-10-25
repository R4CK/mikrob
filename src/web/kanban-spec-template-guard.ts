// Warn (never block) when a non-trivial card starts work without the mandatory spec template, and
// auto-flag product-decision assumptions for Peti approval (card 81452ce2, F3 of the b8ac0ef1 phase).
//
// SOURCE AND SCOPE: the idea of a mandatory pre-build spec is adapted from the general shape of
// zazencodes/zazencodes-season-3's software-factory-claude-code process (read-only reference,
// license:null on GitHub -> "csak saját", clean-room: no code or template text copied). The template
// wording below and the whole wiring is this fork's own.
//
// MikroB's plan-grilling verdict (card 81452ce2, comment 16170) set three load-bearing constraints:
// 1. "nem triviális" stays NARROW (FÁZIS/FELADAT tag, HIGH/URGENT priority, or [SEC] tag) so small
//    cards are never slowed down by this.
// 2. The guard is WARN-ONLY for one week (measurement first, gate later) -- it never blocks the
//    planned -> in_progress transition, it only posts a comment. Flipping it to a real gate is a
//    separate, future decision, not this card's job.
// 3. Product-decision assumptions are found by an EXPLICIT field in the spec ("Termékdöntés:
//    igen/nem"), never by a regex guessing at the assumption's content.
//
// DELTA-GATE (WhiteHat2 NO-GO, komment 16326, 2026-10-11): two MEDIUM findings fixed here.
// F1: the caller now invokes this ONLY after the planned -> in_progress transition has actually
// SUCCEEDED (past every 409 guard) -- a rejected request writes nothing. The "product decision"
// field is also only trusted from the card's own description or a comment from the card's
// assignee / mikrob, never from an arbitrary third party's comment.
// F2: both text scans exclude this guard's OWN comments (otherwise the warn comment's listing of
// all five section names satisfies its own "is the template present" check on the next call, and
// a quoted "Termékdöntés: igen" in the guard's own approval-request comment re-triggers itself).
// The product-decision regex no longer matches the unfilled template placeholder
// ("Termékdöntés: igen/nem"), and an explicit, durable "Termékdöntés-jóváhagyva" comment from
// mikrob permanently stops the auto-tag from being re-applied, even if the decision line is still
// physically present in the description.
import { getKanbanCard, getKanbanComments, updateKanbanCard, addKanbanComment } from '../db.js'
import { logger } from '../logger.js'

const GUARD_AUTHOR = 'spec-template-guard'

const SEC_TAG_RX = /\[SEC\]/i
const PHASE_OR_TASK_TAG_RX = /\[(F[ÁA]ZIS|FELADAT)\]/i
const BLOCKED_PETI_DECISION_TAG = '[BLOKKOLT-Peti-dontes]'
const APPROVAL_RX = /Term[ée]kd[öo]nt[ée]s-j[óo]v[áa]hagyva/i

/** Exported for tests -- this is the one place that decides what counts as "nem triviális", and the
 *  plan-grilling verdict is explicit that it must stay narrow (not every HIGH-ish card). */
export function isNonTrivialCard(title: string, priority: string | null | undefined): boolean {
  if (priority === 'high' || priority === 'urgent') return true
  if (PHASE_OR_TASK_TAG_RX.test(title)) return true
  if (SEC_TAG_RX.test(title)) return true
  return false
}

// The five mandatory sections, accent-tolerant (this fleet's Hungarian is often ASCII-degraded --
// same tolerance kanban-plan-grilling-guard.ts already applies to "kötelező"/"kotelezo") and
// bilingual: the English heading (Context, Requirements, Acceptance criteria, Out of scope,
// Assumptions) counts too, since the fleet's agent-to-agent/kanban-comment language moved to
// English (card 867fa8f2, Peti 12303/12306) and a card written in English must not warn.
const SECTION_PATTERNS: ReadonlyArray<{ readonly label: string; readonly rx: RegExp }> = [
  { label: 'Kontextus', rx: /kontextus|\bcontext\b/i },
  { label: 'Követelmények', rx: /k[öo]vetelm[ée]ny|\brequirements?\b/i },
  { label: 'Ellenőrizhető elfogadási kritériumok', rx: /elfogad[áa]si krit[ée]rium|\bacceptance criteri/i },
  { label: 'Nincs benne', rx: /nincs benne|\bout of scope\b/i },
  { label: 'Feltételezések', rx: /feltételez[ée]s|feltetelez[ée]s|\bassumptions?\b/i },
]

/** Exported for tests. Returns the labels of sections that are missing from the given text. */
export function missingSpecSections(text: string): string[] {
  return SECTION_PATTERNS.filter((s) => !s.rx.test(text)).map((s) => s.label)
}

// The explicit field the plan-grilling verdict asked for, instead of a content-guessing regex. Any
// assumption line ending in this field, with "igen" NOT followed by "/nem" (the unfilled template
// placeholder "Termékdöntés: igen/nem" must never self-match, F2), names a product decision.
const PRODUCT_DECISION_RX = /Term[ée]kd[öo]nt[ée]s\s*:\s*igen\b(?!\s*\/)/i

interface Comment {
  readonly author: string
  readonly content: string
}

function cardText(description: string | null, comments: readonly Comment[]): string {
  return [description ?? '', ...comments.map((c) => c.content ?? '')].join('\n')
}

/**
 * Side effect only -- this guard never blocks a transition (plan-grilling verdict: warn-only for a
 * week). Call it ONLY after the planned -> in_progress transition has actually succeeded (F1 --
 * never on a request a later 409 guard rejects), passing the status the card had BEFORE that
 * transition (the caller must capture it before attempting the write; by the time this function
 * can look the card up again, its status is already the new one). It swallows its own errors, same
 * fail-open rule as every other kanban guard (a checker that throws must not freeze the board).
 */
export function specTemplateGuardCheck(
  cardId: string,
  prevStatus: string | null | undefined,
  nextStatus: unknown,
  actor?: string,
): void {
  try {
    if (process.env.SPEC_TEMPLATE_GUARD === 'off') return
    if (nextStatus !== 'in_progress') return
    if (prevStatus !== 'planned') return // only a fresh dispatch is in scope, same as the sibling guards

    const card = getKanbanCard(cardId)
    if (!card) return
    if (!isNonTrivialCard(card.title ?? '', card.priority)) return

    const comments = getKanbanComments(cardId)
    // F2: exclude the guard's OWN comments from both scans -- otherwise the warn comment (which
    // names all five sections) satisfies the next "is the template present" check on itself, and a
    // quoted "Termékdöntés: igen" inside the guard's own approval-request comment re-triggers it.
    const foreignComments = comments.filter((c) => c.author !== GUARD_AUTHOR)
    const text = cardText(card.description ?? null, foreignComments)

    const missing = missingSpecSections(text)
    if (missing.length > 0) {
      const alreadyWarned = comments.some((c) => c.author === GUARD_AUTHOR)
      if (!alreadyWarned) {
        addKanbanComment(
          cardId,
          GUARD_AUTHOR,
          `SPEC-TEMPLATE WARN (warn-only, 81452ce2): ez egy nem triviális kártya (FÁZIS/FELADAT ` +
            `vagy HIGH/URGENT vagy [SEC]), de a leírásából/kommentjeiből hiányzik: ${missing.join(', ')}. ` +
            `A kötelező spec-sablon: Kontextus, Követelmények, Ellenőrizhető elfogadási kritériumok, ` +
            `Nincs benne, Feltételezések (ld. project-workflow skill). Ez a figyelmeztetés NEM blokkol ` +
            `(mérési időszak); actor=${actor ?? 'ismeretlen'}.`,
          true,
        )
      }
    }

    // F1: the product-decision field is only trusted from the card's own description, or from a
    // comment authored by the card's assignee or by mikrob -- never from an arbitrary third party's
    // comment (anyone with API access could otherwise forge the field and freeze someone else's
    // card out of the self-advance/gate nudger via the title tag it adds below).
    const trustedAuthors = new Set<string>(['mikrob'])
    if (card.assignee) trustedAuthors.add(card.assignee)
    const trustedComments = foreignComments.filter((c) => trustedAuthors.has(c.author))
    const trustedText = cardText(card.description ?? null, trustedComments)

    // F2: an explicit, durable approval from mikrob permanently stops the auto-tag, even though the
    // decision line is still physically present in the description -- resolution must not depend on
    // deleting the comment or the description line (there was no such path before).
    const alreadyApproved = comments.some((c) => c.author === 'mikrob' && APPROVAL_RX.test(c.content ?? ''))

    if (!alreadyApproved && PRODUCT_DECISION_RX.test(trustedText) && !(card.title ?? '').includes(BLOCKED_PETI_DECISION_TAG)) {
      updateKanbanCard(
        cardId,
        { title: `${BLOCKED_PETI_DECISION_TAG} ${card.title}` },
        { actor: GUARD_AUTHOR, force: true },
      )
      addKanbanComment(
        cardId,
        GUARD_AUTHOR,
        `A kártya specje "Termékdöntés: igen" feltételezést jelöl -- automatikusan ${BLOCKED_PETI_DECISION_TAG} ` +
          `jelölést kapott. Jóváhagyás-kérés: MikroB (vagy Peti rajta keresztül) döntsön a kártyán ` +
          `megnevezett termékdöntésről, mielőtt a munka folytatódik. A feloldás tartós: mikrob egy ` +
          `"Termékdöntés-jóváhagyva" kommentje kell, a cím-tag utólagos kézi törlése nem elég.`,
        true,
      )
    }
  } catch (err) {
    logger.warn({ err, cardId }, 'spec-template-guard could not evaluate the card; no side effect applied')
  }
}
