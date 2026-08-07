// Refuse to close a card whose REVIEW names a commit that never reached origin/main (card 9cc72f2c).
//
// On 2026-08-07 MikroB closed three cards on QA/Cybersec/Cybered PASS+GO alone; all three lived only
// on a feature branch. A sweep of that day's 120 closed CleanCore cards then found 39 more. The trap
// is documented (committed-is-not-landed) and store/fix-landed-check.sh exists for it -- but it runs
// AFTER the fact. Detecting it later means someone must remember to look.
//
// The guard makes exactly one claim -- "a commit id written in this card's comments is not reachable
// from origin/main" -- and stays silent about everything else. A card naming no commit (an E2E/user-
// story card, a decision card -- 17 of the 120 that day) makes no landing claim, so it closes.
//
// COST, and why this file looks the way it does (Cybersec NO-GO on the first version): the dashboard
// is ONE single-threaded node server. The first cut used execFileSync and spawned `git cat-file` per
// candidate token -- 110 spawns at ~42ms plus a fixed 2.5s `git fetch` -- which froze the WHOLE fleet
// API for 3-7 seconds on every close, including /api/messages, so inter-agent delivery stopped too.
// A guard that stalls the fleet gets removed, and rightly. So:
//
//   * one `git cat-file --batch-check` fed from stdin resolves every candidate in a single spawn
//   * NO fetch on the happy path -- ancestry is asked of the origin/main ref we already have, and a
//     fetch happens only when we are otherwise about to BLOCK. A stale ref can therefore cause a
//     false block (loud, recoverable, and the fetch then clears it) but never a false pass, which is
//     the direction a security-adjacent check must fail in
//   * everything is async, so the event loop keeps serving while git runs
//
// KNOWN LIMIT, stated rather than hidden: this checks ANCESTRY only. A cherry-pick whose conflict was
// resolved on the way lands the content under a different sha with a different patch, and ancestry
// says no -- measured on card bf2ba50e. The patch-id and content probes live in
// store/cleancore-landed-check.py; they are far too slow for a request path, so the block message
// names that tool instead of pretending completeness.
import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { getKanbanCard, getKanbanComments } from '../db.js'
import { PROJECT_ROOT } from '../config.js'
import { logger } from '../logger.js'

/**
 * project -> git checkout. Parametric because the kanban DB serves several repos and the guard must
 * not assume the one it runs inside. An unmapped project is simply not checked: guessing a repo
 * would report a commit "missing" from the wrong history.
 *
 * marveen's own project labels are here too (card 84091afd, QA2): its cards face the same
 * close-on-unlanded-commit class. The risk is lower -- marveen is not shared across parallel
 * worktrees the way CleanCore is -- but "lower" is not "absent", and the guard costs nothing extra.
 */
interface RepoTarget {
  readonly root: string
  /** The ref that means "landed" for THIS repo. Not every repo integrates on main. */
  readonly mainRef: string
}

const CLEANCORE: RepoTarget = {
  root: process.env['CLEANCORE_MAIN'] ?? '/mnt/h/LM_Studio_Workdir/CleanCore',
  mainRef: 'origin/main',
}
// marveen integrates on DEVELOP and has no origin/main at all (Cybersec, card 84091afd). The first
// version of this map hardcoded origin/main for every project, so `merge-base --is-ancestor <sha>
// origin/main` would have failed on a bad ref for every marveen card, the fetch would have failed
// too, and the guard would have blocked EVERY correctly-landed marveen card -- a fleet-wide close
// blocker. Carried per-entry rather than resolved at runtime: resolving the default branch costs
// another git call on a path that was just brought from 7307ms down to 502ms.
const MARVEEN: RepoTarget = { root: PROJECT_ROOT, mainRef: 'origin/develop' }

const PROJECT_REPOS: Readonly<Record<string, RepoTarget>> = {
  cleancore: CLEANCORE,
  marveen: MARVEEN,
  'mikrob-infra': MARVEEN,
  'fleet-infra': MARVEEN,
  mikrob: MARVEEN,
}

/** Only agents allowed to close a card despite an unlanded commit. */
const FORCE_ACTORS = new Set(['mikrob'])

const SHA_RX = /\b[0-9a-f]{7,40}\b/g
const MAX_CANDIDATES = 40
const GIT_TIMEOUT_MS = 8000

export interface LandedVerdict {
  readonly blocked: boolean
  readonly message?: string
}

function git(repo: string, args: string[], stdin?: string): Promise<{ ok: boolean; out: string }> {
  return new Promise((resolve) => {
    const child = execFile(
      'git',
      ['-C', repo, ...args],
      { timeout: GIT_TIMEOUT_MS, maxBuffer: 1 << 20 },
      (err, stdout) => resolve({ ok: err === null, out: (stdout ?? '').trim() }),
    )
    if (stdin !== undefined) {
      child.stdin?.end(stdin)
    }
  })
}

/**
 * Commit ids named in the card's comments that are real commits in `repo`.
 *
 * ONE spawn: `cat-file --batch-check` takes the candidates on stdin and answers per line, so a card
 * with a hundred hex-looking tokens costs the same as a card with one. The confirmation itself is not
 * optional -- a 7-hex word is a loose pattern, and without it any hex-looking token in prose
 * ("card 1bf4f8a4") would count as a missing commit and block a perfectly good close. A guard that
 * invents its own findings is one people learn to force past.
 */
async function claimedCommits(cardId: string, repo: string): Promise<string[]> {
  const candidates: string[] = []
  for (const c of getKanbanComments(cardId)) {
    for (const m of (c.content ?? '').match(SHA_RX) ?? []) {
      if (!candidates.includes(m)) candidates.push(m)
      if (candidates.length >= MAX_CANDIDATES) break
    }
    if (candidates.length >= MAX_CANDIDATES) break
  }
  if (candidates.length === 0) return []

  const res = await git(repo, ['cat-file', '--batch-check'], candidates.join('\n') + '\n')
  if (!res.ok && res.out === '') return []
  const out: string[] = []
  for (const line of res.out.split('\n')) {
    // "<sha> commit <size>" for a hit; "<token> missing" otherwise.
    const parts = line.trim().split(/\s+/)
    if (parts.length >= 2 && parts[1] === 'commit' && !out.includes(parts[0]!)) out.push(parts[0]!)
  }
  return out
}

async function anyAncestorOfMainRef(t: RepoTarget, commits: string[]): Promise<boolean> {
  for (const c of commits) {
    if ((await git(t.root, ['merge-base', '--is-ancestor', c, t.mainRef])).ok) return true
  }
  return false
}

/** Blocks a move to `done` when every commit the card names is absent from origin/main. */
export async function landedGuardVerdict(
  cardId: string,
  nextStatus: unknown,
  force: boolean,
  actor?: string,
): Promise<LandedVerdict> {
  if (nextStatus !== 'done') return { blocked: false }
  if (force && actor !== undefined && FORCE_ACTORS.has(actor)) return { blocked: false }

  const card = getKanbanCard(cardId)
  const target = PROJECT_REPOS[(card?.project ?? '').toLowerCase()]
  if (target === undefined || !existsSync(`${target.root}/.git`)) return { blocked: false }
  const repo = target.root

  let commits: string[]
  try {
    commits = await claimedCommits(cardId, repo)
  } catch (err) {
    // A guard that throws must not become a guard that closes the board. Log and stand aside: this
    // is the ONE place failing open is right, because the failure is in the checker, not the claim.
    logger.warn({ err, cardId }, 'landed-guard could not read the card; allowing the close')
    return { blocked: false }
  }
  if (commits.length === 0) return { blocked: false }

  // Happy path: no network, no fetch. Most closes land here and cost one cat-file plus one
  // merge-base.
  if (await anyAncestorOfMainRef(target, commits)) return { blocked: false }

  // Only now is a stale ref worth 2.5 seconds -- we are about to block, and being wrong here costs
  // someone a re-run. Note the asymmetry: a stale ref can only make us block something that is
  // actually fine, never wave through something that is not.
  const [remote, branch] = target.mainRef.split('/')
  await git(repo, ['fetch', remote ?? 'origin', branch ?? 'main', '--quiet'])
  if (await anyAncestorOfMainRef(target, commits)) return { blocked: false }

  const short = commits.map((c) => c.slice(0, 8)).join(', ')
  return {
    blocked: true,
    message:
      `Ez a kártya nem zárható: a REVIEW-ban megnevezett commit(ok) NINCSENEK a(z) ${target.mainRef}-en (${short}). ` +
      `A gate-verdikt a TARTALOMRÓL szól, nem arról, hogy a munka landolt-e -- 2026-08-07-én 42 kártya ` +
      `állt nem-landolt commiton emiatt. Mergeld az ágat, VAGY ha cherry-pick/konfliktus-feloldás miatt ` +
      `más SHA-val landolt, futtasd a store/cleancore-landed-check.py-t (az patch-id és tartalom alapján ` +
      `is ellenőriz), és MikroB force: true-val zárhatja.`,
  }
}
