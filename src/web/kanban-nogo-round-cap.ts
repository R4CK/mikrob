// F5 (card a577d0a4, phase b8ac0ef1): NO-GO round cap on the structured gate-verdict record (F2 --
// see kanban-verdicts.ts). A card stuck in an unbounded delta-gate NO-GO/FAIL loop burns gate-agent
// and builder tokens forever without this -- once the cap is reached, escalate ONCE to Peti via the
// Approvals page (card waiting + the "[BLOKKOLT-Peti-dontes]" title tag, the same convention
// kanban-spec-template-guard.ts, F3 of this same phase, already uses) instead of looping.
//
// Independent of store/redispatch-guard.sh's own MAX_REDISPATCH=3 cap (card requirement 3): that
// guard throttles STUCK-CARD NUDGES (an agent not making progress). This one counts GATE VERDICT
// ROUNDS (an agent that keeps shipping fixes the gate keeps rejecting). Neither reads nor writes
// the other's state.
//
// Flag (requirement 4, code-quality rule 9): AGENT_VERDICT_ROUND_CAP env var, default OFF --
// depends on F2's own AGENT_VERDICT_RECORD flag already being on, since there is nothing to count
// without it. Checked independently (not inferred from F2's flag): an operator could turn this on
// while F2 stays off, and the cap must then just see zero verdicts forever, never crash.
import { createHash } from 'node:crypto'
import {
  getKanbanCard, getKanbanVerdicts, moveKanbanCard, updateKanbanCard, addKanbanComment,
  findPendingApproval, type KanbanVerdict,
} from '../db.js'
import { fileServerApproval } from './routes/approvals.js'
import { logger } from '../logger.js'

export function isNoGoRoundCapEnabled(): boolean {
  const v = (process.env.AGENT_VERDICT_ROUND_CAP ?? '').trim().toLowerCase()
  return v === '1' || v === 'true'
}

// Requirement (1)/(2): 3 total consecutive failed rounds = the original gate (round 1) plus 2
// failed delta re-gates (rounds 2 and 3). The card's own title names "2 sikertelen delta-gate
// kör", the requirement text "a 3. NO-GO/FAIL" -- the same event, counted from two different
// starting points (delta rounds only, vs. every round including the first full gate).
export const NOGO_ROUND_CAP = 3

const FAILED_WORDS = new Set<KanbanVerdict['verdict']>(['FAIL', 'NO-GO'])
const PASSED_WORDS = new Set<KanbanVerdict['verdict']>(['PASS', 'GO'])

const BLOCKED_PETI_DECISION_TAG = '[BLOKKOLT-Peti-dontes]'
const GUARD_AUTHOR = 'nogo-round-cap-guard'
const APPROVAL_CATEGORY = 'kanban-nogo-round-cap'

/** Trailing consecutive FAILED rounds, counted from the latest round backward. A round counts as
 *  failed only when EVERY verdict recorded for it is FAIL/NO-GO; a round with even one PASS/GO
 *  (any designated gate agreeing) stops the streak -- the same AGREE-wins-over-one-dissent shape
 *  gate-closure-check already applies to a single round's agreement. Rounds with no verdict at all
 *  are simply absent from the map and do not break or extend the streak. Exported for the self-test. */
export function trailingFailedRounds(verdicts: readonly KanbanVerdict[]): number {
  const byRound = new Map<number, KanbanVerdict[]>()
  for (const v of verdicts) {
    const arr = byRound.get(v.round) ?? []
    arr.push(v)
    byRound.set(v.round, arr)
  }
  const rounds = [...byRound.keys()].sort((a, b) => b - a)
  let count = 0
  for (const r of rounds) {
    const rows = byRound.get(r)!
    const anyPassed = rows.some((v) => PASSED_WORDS.has(v.verdict))
    const anyFailed = rows.some((v) => FAILED_WORDS.has(v.verdict))
    if (anyPassed || !anyFailed) break
    count += 1
  }
  return count
}

/** One line per failed round, oldest first, gate=verdict pairs -- the "leletek összefoglalása"
 *  (findings summary) the requirement names for the Approvals-page request. Exported for the
 *  self-test. */
export function summarizeFailedRounds(verdicts: readonly KanbanVerdict[], roundsBack: number): string {
  const byRound = new Map<number, KanbanVerdict[]>()
  for (const v of verdicts) {
    const arr = byRound.get(v.round) ?? []
    arr.push(v)
    byRound.set(v.round, arr)
  }
  const rounds = [...byRound.keys()].sort((a, b) => b - a).slice(0, roundsBack).sort((a, b) => a - b)
  return rounds
    .map((r) => {
      const words = byRound.get(r)!.map((v) => `${v.gate}=${v.verdict}${v.findings_ref ? ` (${v.findings_ref})` : ''}`)
      return `round ${r}: ${words.join(', ')}`
    })
    .join('; ')
}

/** Side effect only, fail-open (same contract as kanban-spec-template-guard.ts's check): call after
 *  a FAIL/NO-GO verdict has just been recorded (addKanbanVerdict). Does nothing when the flag is
 *  off, when the cap is not yet reached, or when an approval for this exact card is already
 *  pending -- so a card stuck past the cap does not re-file an approval on every subsequent failed
 *  round, only once per escalation until Peti resolves it. */
export function noGoRoundCapCheck(cardId: string): void {
  try {
    if (!isNoGoRoundCapEnabled()) return
    const card = getKanbanCard(cardId)
    if (!card) return

    const verdicts = getKanbanVerdicts(cardId)
    const trailing = trailingFailedRounds(verdicts)
    if (trailing < NOGO_ROUND_CAP) return

    const contentHash = createHash('sha256').update(`${APPROVAL_CATEGORY}:${cardId}`).digest('hex')
    if (findPendingApproval(APPROVAL_CATEGORY, contentHash)) return // already escalated, still unresolved

    if (!(card.title ?? '').includes(BLOCKED_PETI_DECISION_TAG)) {
      updateKanbanCard(cardId, { title: `${BLOCKED_PETI_DECISION_TAG} ${card.title}` }, { actor: GUARD_AUTHOR, force: true })
    }
    if (card.status !== 'waiting') {
      moveKanbanCard(
        cardId, 'waiting', Date.now(), GUARD_AUTHOR, true,
        `NO-GO round cap: ${trailing} consecutive failed verdict rounds (F5, card a577d0a4)`,
      )
    }
    const findingsSummary = summarizeFailedRounds(verdicts, NOGO_ROUND_CAP)
    addKanbanComment(
      cardId,
      GUARD_AUTHOR,
      `NO-GO ROUND CAP REACHED (F5, card a577d0a4): ${trailing} consecutive failed verdict rounds on the ` +
        `structured gate-verdict record. ${findingsSummary}. Escalated to Peti via the Approvals page ` +
        `(approval request filed) -- card held waiting + ${BLOCKED_PETI_DECISION_TAG} until a decision ` +
        `(rewrite / narrow scope / release as-is). Independent of store/redispatch-guard.sh's own ` +
        `stuck-nudge cap, which this never reads or writes.`,
      true,
    )
    fileServerApproval({
      agent_id: GUARD_AUTHOR,
      category: APPROVAL_CATEGORY,
      action_description:
        `Card ${cardId} (${card.title ?? ''}) hit the NO-GO round cap: ${trailing} consecutive failed ` +
        `gate-verdict rounds. ${findingsSummary}. Decide: rewrite the approach, narrow the scope, or ` +
        `release the finding as an accepted risk.`,
      content_hash: contentHash,
    })
  } catch (err) {
    logger.warn({ err, cardId }, 'nogo-round-cap-guard could not evaluate the card; no side effect applied')
  }
}
