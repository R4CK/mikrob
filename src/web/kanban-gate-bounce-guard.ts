// Gate-bounce budget: a hard ceiling on consecutive NO-GO/FAIL gate verdicts on the same card,
// enforced in code rather than left to the self-advance/gate loop to notice on its own (card
// 6eb298b5). Idea from promptops' goal_loop.rs: a budget and stop condition must live in code,
// never delegated to the model being evaluated -- https://github.com/shellonback/promptops
// (Apache-2.0, NOTICE file present). Idea and the general shape only; no code copied.
//
// Before this, a card could bounce NO-GO/FAIL -> fix -> re-gate indefinitely with no counter
// anywhere (grep of src/web found no regate limit). This reuses the SAME anchored-verdict parser
// kanban-gate-completeness-guard.ts already uses, so "what counts as a NO-GO/FAIL" is defined once.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { STORE_DIR } from '../config.js'
import { getKanbanCard, getKanbanComments, updateKanbanCard, addKanbanComment, createAgentMessage } from '../db.js'
import { anchoredGateVerdict } from './kanban-gate-completeness-guard.js'
import { logger } from '../logger.js'

const GUARD_AUTHOR = 'gate-bounce-guard'
export const BOUNCE_TAG = '[BLOKKOLT-bounce]'
const DEFAULT_THRESHOLD = 3

export function gateBounceBudgetConfigPath(): string {
  return join(STORE_DIR, 'gate-bounce-budget.json')
}

/** Code-quality rule 14: the threshold is read from config, never a hardcoded constant. A missing
 *  or unreadable config file, or a non-positive-integer value, falls back to the documented
 *  default (3) -- the same fail-open posture every other kanban guard in this codebase takes on a
 *  broken config, rather than switching to "never trips" or throwing. */
export function readGateBounceThreshold(path: string = gateBounceBudgetConfigPath()): number {
  try {
    const cfg = JSON.parse(readFileSync(path, 'utf-8')) as { consecutiveThreshold?: unknown }
    const n = Number(cfg.consecutiveThreshold)
    return Number.isInteger(n) && n > 0 ? n : DEFAULT_THRESHOLD
  } catch {
    return DEFAULT_THRESHOLD
  }
}

interface Comment {
  readonly author: string
  readonly content: string
  readonly created_at: number
}

/** Exported for tests. Walks the card's comments in chronological order and returns the length of
 *  the TRAILING streak of consecutive negative (FAIL/NO-GO) anchored verdicts, i.e. the streak as
 *  of the LAST verdict comment. A verdict comment that opens positive (PASS/GO/SKIP) resets the
 *  streak to 0; a non-verdict comment (anchoredGateVerdict returns null -- audit note, dispatch
 *  ack, anything that does not OPEN with a role+verdict) is skipped: it neither extends nor breaks
 *  the streak, since it made no claim either way. */
export function consecutiveNegativeVerdictStreak(comments: readonly Comment[]): number {
  const sorted = [...comments].sort((a, b) => a.created_at - b.created_at)
  let streak = 0
  for (const c of sorted) {
    const v = anchoredGateVerdict(c.content ?? '')
    if (!v) continue
    if (v.outcome === 'FAIL' || v.outcome === 'NO-GO') streak += 1
    else streak = 0 // PASS, GO or SKIP all count as "the model made progress" -- reset
  }
  return streak
}

/** Side effect only, fail-open (same posture as kanban-spec-template-guard.ts): call this right
 *  after a NEW comment has already been persisted (`addKanbanComment`), passing that same comment.
 *  Only a comment that itself opens as a fresh NO-GO/FAIL can trip the guard -- a comment that
 *  doesn't even claim a negative verdict cannot be "the 3rd bounce", so there is nothing to
 *  recompute. Idempotent: once the card already carries BOUNCE_TAG, this returns immediately,
 *  which is what keeps a 4th/5th consecutive NO-GO from sending a 2nd/3rd escalation for the SAME
 *  bounce run -- the tag itself is the one-shot latch, not a separate "already escalated" flag. */
export function gateBounceGuardCheck(cardId: string, newComment: { readonly author: string; readonly content: string }): void {
  try {
    const card = getKanbanCard(cardId)
    if (!card) return
    if ((card.title ?? '').includes(BOUNCE_TAG)) return

    const outcome = anchoredGateVerdict(newComment.content ?? '')
    if (!outcome || (outcome.outcome !== 'FAIL' && outcome.outcome !== 'NO-GO')) return

    const threshold = readGateBounceThreshold()
    const streak = consecutiveNegativeVerdictStreak(getKanbanComments(cardId))
    if (streak < threshold) return

    updateKanbanCard(cardId, { title: `${BOUNCE_TAG} ${card.title}` }, { actor: GUARD_AUTHOR, force: true })
    addKanbanComment(
      cardId,
      GUARD_AUTHOR,
      `GATE-BOUNCE BUDGET: ${streak} consecutive NO-GO/FAIL verdicts on this card (threshold ${threshold}). ` +
        `Auto-tagged ${BOUNCE_TAG} and escalated to mikrob instead of another auto re-dispatch -- a repeated ` +
        `bounce needs a decision (change approach, reassign, override), not another fix-and-re-gate cycle.`,
      true,
    )
    createAgentMessage(
      GUARD_AUTHOR,
      'mikrob',
      `[GATE-BOUNCE] Card ${cardId} hit ${streak} consecutive NO-GO/FAIL verdicts and was auto-tagged ${BOUNCE_TAG}. ` +
        `Needs your decision before another re-dispatch.`,
    )
  } catch (err) {
    logger.warn({ err, cardId }, 'gate-bounce-guard could not evaluate the card; no side effect applied')
  }
}
