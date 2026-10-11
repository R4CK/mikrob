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
import { getKanbanCard, getKanbanComments, updateKanbanCard, addKanbanComment } from '../db.js'
import { logger } from '../logger.js'

const GUARD_AUTHOR = 'spec-template-guard'

const SEC_TAG_RX = /\[SEC\]/i
const PHASE_OR_TASK_TAG_RX = /\[(F[ÁA]ZIS|FELADAT)\]/i
const BLOCKED_PETI_DECISION_TAG = '[BLOKKOLT-Peti-dontes]'

/** Exported for tests -- this is the one place that decides what counts as "nem triviális", and the
 *  plan-grilling verdict is explicit that it must stay narrow (not every HIGH-ish card). */
export function isNonTrivialCard(title: string, priority: string | null | undefined): boolean {
  if (priority === 'high' || priority === 'urgent') return true
  if (PHASE_OR_TASK_TAG_RX.test(title)) return true
  if (SEC_TAG_RX.test(title)) return true
  return false
}

// The five mandatory sections, accent-tolerant (this fleet's Hungarian is often ASCII-degraded --
// same tolerance kanban-plan-grilling-guard.ts already applies to "kötelező"/"kotelezo").
const SECTION_PATTERNS: ReadonlyArray<{ readonly label: string; readonly rx: RegExp }> = [
  { label: 'Kontextus', rx: /kontextus/i },
  { label: 'Követelmények', rx: /k[öo]vetelm[ée]ny/i },
  { label: 'Ellenőrizhető elfogadási kritériumok', rx: /elfogad[áa]si krit[ée]rium/i },
  { label: 'Nincs benne', rx: /nincs benne/i },
  { label: 'Feltételezések', rx: /feltételez[ée]s|feltetelez[ée]s/i },
]

/** Exported for tests. Returns the labels of sections that are missing from the given text. */
export function missingSpecSections(text: string): string[] {
  return SECTION_PATTERNS.filter((s) => !s.rx.test(text)).map((s) => s.label)
}

// The explicit field the plan-grilling verdict asked for, instead of a content-guessing regex. Any
// assumption line ending in this field, with "igen", names a product decision.
const PRODUCT_DECISION_RX = /Term[ée]kd[öo]nt[ée]s\s*:\s*igen/i

interface Comment {
  readonly author: string
  readonly content: string
}

function cardText(description: string | null, comments: readonly Comment[]): string {
  return [description ?? '', ...comments.map((c) => c.content ?? '')].join('\n')
}

/**
 * Side effect only -- this guard never blocks a transition (plan-grilling verdict: warn-only for a
 * week). Call it alongside the blocking guards on planned -> in_progress; it swallows its own
 * errors, same fail-open rule as every other kanban guard (a checker that throws must not freeze
 * the board).
 */
export function specTemplateGuardCheck(cardId: string, nextStatus: unknown, actor?: string): void {
  try {
    if (process.env.SPEC_TEMPLATE_GUARD === 'off') return
    if (nextStatus !== 'in_progress') return

    const card = getKanbanCard(cardId)
    if (!card) return
    if (card.status !== 'planned') return // only a fresh dispatch is in scope, same as the sibling guards
    if (!isNonTrivialCard(card.title ?? '', card.priority)) return

    const comments = getKanbanComments(cardId)
    const text = cardText(card.description ?? null, comments)

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

    if (PRODUCT_DECISION_RX.test(text) && !(card.title ?? '').includes(BLOCKED_PETI_DECISION_TAG)) {
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
          `megnevezett termékdöntésről, mielőtt a munka folytatódik.`,
        true,
      )
    }
  } catch (err) {
    logger.warn({ err, cardId }, 'spec-template-guard could not evaluate the card; no side effect applied')
  }
}
