// Warn (non-blocking) -- or, for a "nem triviális" card (isNonTrivialCard: FÁZIS/FELADAT tag,
// HIGH/URGENT priority, or [SEC] tag), BLOCK -- a hand-off into `waiting` whose REVIEW's own
// declared Gate-SHA diff carries no DECISIONS.md line referencing this card's id (card 9b1ccbca).
//
// MEASURED (2026-09-25): five cards failed QA in a single day purely over a missing DECISIONS.md
// entry (197947ae, dac2e52b, c2aeefa5, 2564e877, f4cd1783, 9163495b). The code itself was fine
// every time; the round only burned gate time. The prose-only Döntésnapló rule (root CLAUDE.md)
// does not hold by itself -- code-quality rule 6: a written rule alone rests on discipline, which
// is forgettable.
//
// SHAPE: this file follows two existing precedents rather than inventing a third one.
//  * decisionsGuardCheck() mirrors kanban-spec-template-guard.ts's warn-only side effect: called
//    AFTER a successful transition into `waiting`, posts one informational comment, never blocks.
//  * decisionsGuardVerdict() mirrors kanban-landed-guard.ts's real 409 block: called BEFORE the
//    transition, but ONLY for a card isNonTrivialCard() already calls "nem triviális" -- the exact
//    boundary MikroB's plan-grilling verdict set for the sibling spec-template guard, reused here
//    rather than inventing a new "architektúra" tag just for this file. A FÁZIS/FELADAT card IS the
//    architecture-level unit on this board, and [SEC] is named explicitly either way.
//
// WHAT COUNTS AS "NO ENTRY": the Gate-SHA's own diff against its first parent (works for a plain
// commit and for a merge commit alike -- `^1` always resolves the branch's pre-existing tip) is
// searched for an ADDED line in DECISIONS.md naming this card's id. A card whose latest REVIEW
// names no Gate-SHA at all (config-only work, root CLAUDE.md rule 4e's `n/a (config-only)`) makes
// no landing claim this guard can check -- same "no claim, nothing to verify" silence
// kanban-landed-guard.ts's allowUnverified() already establishes for itself: never warned, never
// blocked.
import { getKanbanCard, getKanbanComments, addKanbanComment } from '../db.js'
import { isForceActor } from '../kanban-force-actors.js'
import { existsSync } from 'node:fs'
import { logger } from '../logger.js'
import { git, PROJECT_REPOS, NO_REPO_PROJECTS, type LandedVerdict } from './kanban-landed-guard.js'
import { latestReviewGateSha } from './kanban-gate-completeness-guard.js'
import { isNonTrivialCard } from './kanban-spec-template-guard.js'

const GUARD_AUTHOR = 'decisions-guard'

function cardIdInAddedLineRx(cardId: string): RegExp {
  const escaped = cardId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  // '+' line-prefix = added by this diff; the second '+' exclusion keeps the `+++ b/DECISIONS.md`
  // file header (which also starts with '+') from ever matching as "content".
  return new RegExp(`^\\+(?!\\+).*\\b${escaped}\\b`, 'i')
}

interface Comment {
  readonly author: string
  readonly content: string
  readonly created_at: number
}

/**
 * 'present' | 'missing' | 'unresolvable'. 'unresolvable' means the guard could not compute the
 * diff at all (bad sha, git error) -- distinct from 'missing' so a caller can stay silent on the
 * former and act on the latter, the same split kanban-landed-guard.ts's allowUnverified() makes.
 */
async function decisionsEntryState(
  repo: string,
  sha: string,
  cardId: string,
): Promise<'present' | 'missing' | 'unresolvable'> {
  const res = await git(repo, ['diff', '--no-color', `${sha}^1`, sha, '--', 'DECISIONS.md'])
  if (!res.ok) return 'unresolvable'
  const rx = cardIdInAddedLineRx(cardId)
  return res.out.split('\n').some((l) => rx.test(l)) ? 'present' : 'missing'
}

/**
 * Resolves the card's declared Gate-SHA and its repo, or null when there is nothing this guard
 * can check (no declared sha, unmapped/repo-less project, repo missing on disk). Shared by both
 * exported entry points so they can never disagree about which cards are in scope.
 */
function resolveCheck(cardId: string, comments: readonly Comment[]): { sha: string; repo: string } | null {
  const sha = latestReviewGateSha(comments)
  if (sha === null) return null

  const card = getKanbanCard(cardId)
  const project = (card?.project ?? '').toLowerCase()
  if (NO_REPO_PROJECTS.has(project)) return null
  const target = PROJECT_REPOS[project]
  if (target === undefined) return null
  if (!existsSync(`${target.root}/.git`)) return null
  return { sha, repo: target.root }
}

/**
 * Side effect only -- warns, never blocks. Call ONLY after a transition into `waiting` has
 * actually succeeded (never on a request a 409 guard rejected), same calling convention as
 * kanban-spec-template-guard.ts's specTemplateGuardCheck.
 */
export async function decisionsGuardCheck(
  cardId: string,
  prevStatus: string | null | undefined,
  nextStatus: unknown,
  actor?: string,
): Promise<void> {
  try {
    if (process.env['DECISIONS_GUARD'] === 'off') return
    if (nextStatus !== 'waiting') return
    if (prevStatus === 'waiting') return // re-asserting, not a fresh hand-off

    const card = getKanbanCard(cardId)
    if (!card) return
    // decisionsGuardVerdict already blocks a non-trivial card before this transition could even
    // succeed -- this warn-only path covers everything else, so a card never gets both a 409 AND
    // a warn comment for the same hand-off.
    if (isNonTrivialCard(card.title ?? '', card.priority)) return

    const comments = getKanbanComments(cardId)
    const resolved = resolveCheck(cardId, comments)
    if (resolved === null) return

    if ((await decisionsEntryState(resolved.repo, resolved.sha, cardId)) !== 'missing') return

    const alreadyWarned = comments.some((c) => c.author === GUARD_AUTHOR && c.content.includes(resolved.sha))
    if (alreadyWarned) return

    addKanbanComment(
      cardId,
      GUARD_AUTHOR,
      `DECISIONS-ŐRSÉG WARN (nem blokkol, kártya 9b1ccbca): a Gate-SHA (${resolved.sha}) diffjében ` +
        `nincs a kártya ID-jére (${cardId}) hivatkozó DECISIONS.md sor. Ha ez érdemi döntés volt ` +
        `(architektúra-választás, Peti jóváhagyás/elutasítás), pótold a bejegyzést a DECISIONS.md ` +
        `VÉGÉRE (farokba-írás szabály, project-decisions-log skill); ha nem volt érdemi döntés, ez a ` +
        `figyelmeztetés biztonságosan ignorálható. actor=${actor ?? 'ismeretlen'}.`,
      true,
    )
  } catch (err) {
    logger.warn({ err, cardId }, 'decisions-guard could not evaluate the card; no side effect applied')
  }
}

/**
 * Blocks a transition INTO `waiting` for a "nem triviális" card (isNonTrivialCard: FÁZIS/FELADAT
 * tag, HIGH/URGENT priority, or [SEC] tag) whose REVIEW's declared Gate-SHA diff carries no
 * DECISIONS.md line referencing this card's id.
 */
export async function decisionsGuardVerdict(
  cardId: string,
  nextStatus: unknown,
  force: boolean,
  actor?: string,
): Promise<LandedVerdict> {
  if (nextStatus !== 'waiting') return { blocked: false }
  if (isForceActor(force, actor)) return { blocked: false }

  let card: ReturnType<typeof getKanbanCard>
  try {
    card = getKanbanCard(cardId)
  } catch (err) {
    logger.warn({ err, cardId }, 'decisions-guard could not read the card; allowing the move')
    return { blocked: false }
  }
  if (!card) return { blocked: false }
  if (card.status === 'waiting') return { blocked: false }
  if (!isNonTrivialCard(card.title ?? '', card.priority)) return { blocked: false }

  let comments: Comment[]
  try {
    comments = getKanbanComments(cardId)
  } catch (err) {
    logger.warn({ err, cardId }, 'decisions-guard could not read comments; allowing the move')
    return { blocked: false }
  }

  let resolved: { sha: string; repo: string } | null
  try {
    resolved = resolveCheck(cardId, comments)
  } catch (err) {
    logger.warn({ err, cardId }, 'decisions-guard could not resolve the gate-sha/repo; allowing the move')
    return { blocked: false }
  }
  if (resolved === null) return { blocked: false }

  let state: 'present' | 'missing' | 'unresolvable'
  try {
    state = await decisionsEntryState(resolved.repo, resolved.sha, cardId)
  } catch (err) {
    logger.warn({ err, cardId }, 'decisions-guard could not diff the gate-sha; allowing the move')
    return { blocked: false }
  }
  if (state !== 'missing') return { blocked: false }

  return {
    blocked: true,
    message:
      `Ez a kártya ([FÁZIS]/[FELADAT]/HIGH/URGENT/[SEC] -- nem triviális) nem adható át gate-re: a ` +
      `Gate-SHA (${resolved.sha}) diffjében nincs a kártya ID-jére (${cardId}) hivatkozó DECISIONS.md ` +
      `sor. Írj egy döntésnapló-sort a DECISIONS.md VÉGÉRE (farokba-írás szabály), hivatkozva a ` +
      `kártya ID-jére, majd próbáld újra. Ha tudatosan át akarsz lépni rajta, MikroB force: true ` +
      `értékkel megteheti.`,
  }
}
