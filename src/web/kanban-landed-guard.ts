// Refuse to close a card whose REVIEW names a commit that never reached origin/main (card 9cc72f2c).
//
// On 2026-08-07 MikroB closed three cards on QA/Cybersec/Cybered PASS+GO alone; all three lived only
// on a feature branch. A sweep of that day's 120 closed CleanCore cards then found 39 more. The trap
// is documented (committed-is-not-landed) and store/fix-landed-check.sh exists for it -- but it runs
// AFTER the fact, and only for this repo. Detecting it afterwards means someone must remember to
// look; the same trap had already been documented before it caught 39 cards.
//
// So this checks at the moment of closing, which is the only moment where the answer changes the
// outcome. It is deliberately narrow -- it makes exactly one claim:
//
//   "a commit id written in this card's comments is not reachable from origin/main"
//
// and stays silent about everything else. A card with no commit named in its comments (an E2E/user-
// story card, a decision card -- 17 of the 120 that day) is not making a claim this can check, so it
// closes normally. That is not a fail-open: there is no landing claim to falsify.
//
// KNOWN LIMIT, stated rather than hidden: this checks ANCESTRY only. A cherry-pick with a conflict
// resolved on the way lands the content under a different sha with a different patch, and ancestry
// says no -- the sweep tool (store/cleancore-landed-check.py) adds patch-id and content probes for
// that, but they are too slow for a request path. So `force` exists, and the message says which
// check failed so the operator can run the fuller one.
import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { getKanbanCard, getKanbanComments } from '../db.js'
import { logger } from '../logger.js'

/**
 * project -> git checkout. Parametric on purpose: the kanban DB holds cards for several repos, and
 * the guard must not assume the one it happens to run inside. An unmapped project simply is not
 * checked -- better than guessing a repo and reporting a commit "missing" from the wrong history.
 */
const PROJECT_REPOS: Readonly<Record<string, string>> = {
  cleancore: process.env['CLEANCORE_MAIN'] ?? '/mnt/h/LM_Studio_Workdir/CleanCore',
}

/** Only agents allowed to close a card despite an unlanded commit. */
const FORCE_ACTORS = new Set(['mikrob'])

const SHA_RX = /\b[0-9a-f]{7,40}\b/g

export interface LandedVerdict {
  readonly blocked: boolean
  readonly message?: string
}

function git(repo: string, args: string[]): { ok: boolean; out: string } {
  try {
    const out = execFileSync('git', ['-C', repo, ...args], {
      encoding: 'utf-8',
      timeout: 8000,
      stdio: ['ignore', 'pipe', 'ignore'],
    })
    return { ok: true, out: out.trim() }
  } catch {
    return { ok: false, out: '' }
  }
}

/**
 * Commit ids named in the card's comments that are real commits in `repo`.
 *
 * A 7-hex word is a loose pattern, so every candidate is confirmed against the object database
 * before it counts. Without that, any hex-looking token in prose ("card 1bf4f8a4") would be treated
 * as a missing commit and block the close -- a guard inventing its own findings, which is the
 * failure mode that makes people disable guards.
 */
function claimedCommits(cardId: string, repo: string): string[] {
  const out: string[] = []
  for (const c of getKanbanComments(cardId)) {
    for (const m of (c.content ?? '').match(SHA_RX) ?? []) {
      if (out.length >= 12) break
      const t = git(repo, ['cat-file', '-t', m])
      if (!t.ok || t.out !== 'commit') continue
      const full = git(repo, ['rev-parse', m])
      if (full.ok && !out.includes(full.out)) out.push(full.out)
    }
  }
  return out
}

/** Blocks a move to `done` when every commit the card names is absent from origin/main. */
export function landedGuardVerdict(
  cardId: string,
  nextStatus: unknown,
  force: boolean,
  actor?: string,
): LandedVerdict {
  if (nextStatus !== 'done') return { blocked: false }
  if (force && actor !== undefined && FORCE_ACTORS.has(actor)) return { blocked: false }

  const card = getKanbanCard(cardId)
  const repo = PROJECT_REPOS[(card?.project ?? '').toLowerCase()]
  if (repo === undefined || !existsSync(`${repo}/.git`)) return { blocked: false }

  let commits: string[]
  try {
    commits = claimedCommits(cardId, repo)
  } catch (err) {
    // A guard that throws must not become a guard that closes the board. Log and stand aside: this
    // is the ONE place failing open is right, because the failure is in the checker, not the claim.
    logger.warn({ err, cardId }, 'landed-guard could not read the card; allowing the close')
    return { blocked: false }
  }
  if (commits.length === 0) return { blocked: false }

  git(repo, ['fetch', 'origin', 'main', '--quiet'])
  const landed = commits.filter(
    (c) => git(repo, ['merge-base', '--is-ancestor', c, 'origin/main']).ok,
  )
  if (landed.length > 0) return { blocked: false }

  const short = commits.map((c) => c.slice(0, 8)).join(', ')
  return {
    blocked: true,
    message:
      `Ez a kártya nem zárható: a REVIEW-ban megnevezett commit(ok) NINCSENEK az origin/main-en (${short}). ` +
      `A gate-verdikt a TARTALOMRÓL szól, nem arról, hogy a munka landolt-e -- 2026-08-07-én 42 kártya ` +
      `állt nem-landolt commiton emiatt. Mergeld az ágat, VAGY ha cherry-pick/konfliktus-feloldás miatt ` +
      `más SHA-val landolt, futtasd a store/cleancore-landed-check.py-t (az patch-id és tartalom alapján ` +
      `is ellenőriz), és MikroB force: true-val zárhatja.`,
  }
}
