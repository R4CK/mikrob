// F2.2 (card 339ad171, child of Fazis ed332869 / Feladat 471d0fdc): refuse (or warn, warn-only
// first) a close to `done` when a card's gated commit has NO verified landing row in
// `card_landings` (F2.1, a8a83d48/ec34c025 -- written only by marveen-land.sh/mopsion-land.sh
// AFTER an independently confirmed push, never typed by an agent).
//
// WHY THIS IS A SEPARATE GUARD FROM kanban-landed-guard.ts, not an extension of it. That guard
// answers "is some commit the card's comments NAME actually on the branch" -- a text scan over
// prose. This one answers a narrower, stronger question: "did the AUTHORITATIVE land script
// itself record landing THE SPECIFIC COMMIT THIS CARD WAS GATED ON". The two guards run
// independently and both must pass; neither supersedes the other.
//
// MIKROB'S BINDING RULE (card 339ad171, comment 28280, same lesson store/gate-closure-check.py's
// F2.3 round learned the hard way through three adversarial NO-GO rounds on 634a188c): NEVER
// accept a card_landings row on card_id alone -- a row can exist for this card_id while recording
// a DIFFERENT commit than the one the gates actually approved (an abandoned attempt, a stale
// re-run, a card amended after gating). So this guard requires a row whose work_sha OR merge_sha
// matches the card's own GATED sha (the Gate-SHA line on its latest declaring REVIEW), not merely
// "a row exists for this card_id".
//
// "Landing: n/a" EXEMPTION SCOPE. When the card has a gated sha, the exemption line is honoured
// only from the card's own description or from that SAME latest declaring comment -- never from
// an unrelated later comment by any author, which is the exact bypass class store/
// gate-closure-check.py's own _landing_exempt()/_latest_declaring_review() were hardened against
// (cybersec2/WhiteHat2 NO-GO rounds on 634a188c, comments 31861/31869). When the card has NO
// gated sha at all (never gated, or a true config-only card), nothing is being exempted away, so
// the line is honoured from the description or any comment.
//
// WARN-ONLY FIRST (`LANDING_GUARD` env flag, the card's own Kesz-ha spelling). `off` disables the
// guard entirely, `enforce` blocks with 409, anything else (including unset) warns: a close is
// never blocked, but a comment records the gap so it is visible before the flag is flipped.
//
// FORCE BYPASS IS ALREADY AUDITED, structurally, not by anything this file adds (card's own Kesz-ha
// "force:true by mikrob still possible with reason, audited"): isForceActor's own doc comment
// says the override is "attributable in the audit row" -- the status-change write this guard sits
// in front of records force/reason into kanban_card_events regardless of which guard let it
// through, so a force bypass is audited by the existing write path the moment it is allowed.
import { getKanbanCard, getKanbanComments, listCardLandings, addKanbanComment } from '../db.js'
import { isForceActor } from '../kanban-force-actors.js'
import { PROJECT_REPOS, NO_REPO_PROJECTS } from './kanban-landed-guard.js'
import { logger } from '../logger.js'

interface Comment {
  readonly author: string
  readonly content: string
}

const SHA_RX = /\b[0-9a-f]{7,40}\b/i
const GATE_SHA_LINE_RX = /^\s*Gate-SHA:\s*(.+)$/im
const REVIEW_START_RX = /^\s*review\b/i
const LANDING_NA_RX = /landing\s*:\s*n\s*\/?\s*a\b/i

/** The gated sha a card's latest REVIEW-shaped, Gate-SHA-bearing comment declares, or null when no
 *  comment both opens with "REVIEW" and carries a Gate-SHA line. Scans newest-first so an earlier
 *  declaration can never outrank a later one. Only the FIRST sha on the line is used (a multi-sha
 *  `Gate-SHA: <a>, <b>` line is rare on this guard's own population and the match below already
 *  tries every row, so taking the first token is enough to bind "did a real landing happen", not
 *  to replay rule 4b's full multi-sha agreement logic). */
function latestGatedSha(comments: readonly Comment[]): { sha: string; comment: Comment } | null {
  for (let i = comments.length - 1; i >= 0; i--) {
    const c = comments[i]!
    if (!REVIEW_START_RX.test(c.content ?? '')) continue
    const line = GATE_SHA_LINE_RX.exec(c.content ?? '')
    if (!line) continue
    const sha = SHA_RX.exec(line[1] ?? '')
    if (sha) return { sha: sha[0].toLowerCase(), comment: c }
  }
  return null
}

function shaMatches(a: string, b: string | null | undefined): boolean {
  if (!b) return false
  const lo = b.toLowerCase()
  const short = Math.min(a.length, lo.length)
  return short >= 7 && a.slice(0, short) === lo.slice(0, short)
}

/** The card_landings `repo` column value for a project, or null when the project has no mapped git
 *  repo at all -- reuses kanban-landed-guard.ts's own, already-vetted PROJECT_REPOS/
 *  NO_REPO_PROJECTS maps rather than keeping a second, driftable copy (marveen integrates on
 *  DEVELOP, everything else this map knows integrates on MAIN, same distinction that file's own
 *  comments document). */
function landingsRepoFor(project: string): boolean {
  const key = project.toLowerCase()
  if (NO_REPO_PROJECTS.has(key)) return false
  return PROJECT_REPOS[key] !== undefined
}

export interface CardLandingsVerdict {
  readonly blocked: boolean
  readonly message?: string
}

function mode(): 'off' | 'enforce' | 'warn' {
  const v = process.env.LANDING_GUARD
  return v === 'off' || v === 'enforce' ? v : 'warn'
}

const GUARD_AUTHOR = 'card-landings-guard'

/**
 * Checked at the same two close doors as landedGuardVerdict (PUT with a status, POST /move) --
 * guarding one guards neither. Returns {blocked:false} for every transition that is not a close to
 * `done`, when the flag is `off`, for a force actor, for a project with no mapped repo, or for a
 * card carrying the "Landing: n/a" exemption (scoped per the header comment above).
 *
 * Fail-open on any internal error, same rule every other guard on this file follows: a checker
 * that throws must not freeze the board.
 */
export function cardLandingsGuardVerdict(
  cardId: string,
  nextStatus: unknown,
  force: boolean,
  actor?: string,
): CardLandingsVerdict {
  try {
    if (nextStatus !== 'done') return { blocked: false }
    const m = mode()
    if (m === 'off') return { blocked: false }
    if (isForceActor(force, actor)) return { blocked: false }

    const card = getKanbanCard(cardId)
    if (!card) return { blocked: false }
    if (!landingsRepoFor(card.project ?? '')) return { blocked: false }

    const comments = getKanbanComments(cardId)
    const gated = latestGatedSha(comments)

    if (LANDING_NA_RX.test(card.description ?? '')) return { blocked: false }
    if (gated) {
      if (LANDING_NA_RX.test(gated.comment.content ?? '')) return { blocked: false }
    } else if (comments.some((c) => LANDING_NA_RX.test(c.content ?? ''))) {
      return { blocked: false }
    }

    const rows = listCardLandings(cardId)
    let message: string | null = null
    if (rows.length === 0) {
      message =
        `Nincs VERIFIKÁLT landolási bejegyzés (card_landings) ehhez a kártyához -- a land script ` +
        `(marveen-land.sh/mopsion-land.sh) sosem rögzített egy ellenőrzött push-t erre a kártya-id-re.`
    } else if (gated && !rows.some((r) => shaMatches(gated.sha, r.work_sha) || shaMatches(gated.sha, r.merge_sha))) {
      // Mikrob's binding rule (comment 28280): a row existing for this card_id is not enough -- it
      // must name the sha the gates actually judged, or a card amended/re-landed after gating
      // would read as landed on the strength of an unrelated, earlier (or abandoned) landing.
      message =
        `Van landolási bejegyzés erre a kártyára, de none a gate-elt sha-t (${gated.sha.slice(0, 12)}) nevezi ` +
        `meg -- egy card_id-n önmagán alapuló landolás nem elég (MikroB szabálya, kártya 339ad171 komment 28280).`
    }

    if (message === null) return { blocked: false }
    const fullMessage =
      `${message} Ha a munka valóban landolt, futtasd a land scriptet a kártyára (--card ${cardId}), ` +
      `vagy ha ez a kártya nem szállít kódot, tegyél egy "Landing: n/a" sort a leírásba/kommentbe ` +
      `(card 471d0fdc).`

    if (m === 'enforce') return { blocked: true, message: fullMessage }

    const alreadyWarned = comments.some((c) => c.author === GUARD_AUTHOR)
    if (!alreadyWarned) {
      addKanbanComment(
        cardId,
        GUARD_AUTHOR,
        `LANDING-GUARD WARN (warn-only, card 339ad171): ${fullMessage} Ez a figyelmeztetés NEM ` +
          `blokkol (mérési időszak); actor=${actor ?? 'ismeretlen'}.`,
        true,
      )
    }
    return { blocked: false }
  } catch (err) {
    logger.warn({ err, cardId }, 'card-landings-guard could not evaluate the card; allowing the close')
    return { blocked: false }
  }
}
