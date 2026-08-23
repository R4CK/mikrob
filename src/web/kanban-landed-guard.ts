// Refuse to close a card whose REVIEW names a commit that never reached origin/main (card 9cc72f2c).
//
// On 2026-08-07 MikroB closed three cards on QA/Cybersec/Cybered PASS+GO alone; all three lived only
// on a feature branch. A sweep of that day's 120 closed CleanCore cards then found 39 more. The trap
// is documented (committed-is-not-landed) and store/fix-landed-check.sh exists for it -- but it runs
// AFTER the fact. Detecting it later means someone must remember to look.
//
// The guard makes exactly one claim -- "a commit id written in this card's comments is not reachable
// from origin/main" -- and stays silent about everything else. A card naming no commit (an E2E/user-
// story card, a decision card -- 17 of the 120 that day) makes no landing claim, so it closes. It
// closes NOISILY though (card b428f3da): "nothing to check" and "checked, it landed" both allow, and
// until they were logged apart, a card the guard never actually verified looked exactly like a
// verified one. See allowUnverified().
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
import { isForceActor } from '../kanban-force-actors.js'
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


const SHA_RX = /\b[0-9a-f]{7,40}\b/g
const MAX_CANDIDATES = 40
const GIT_TIMEOUT_MS = 8000

/**
 * Comment authors whose text is MACHINE-GENERATED and therefore never a landing claim about THIS
 * card. Their comments are skipped when collecting candidate commit ids.
 *
 * This is not a precaution -- it is two reproduced false passes. Card a7b7fe43 was let through to
 * done while both of its sides (d7a8520c, c90c5dd8) sat on a branch: its `local-llm` draft comment
 * quoted fcc535b3 and 11a366eb inside an invented example, both real commits on CleanCore main, and
 * the guard read them as the card's own. A sweep of all 304 open done cards found card f91fcd7e
 * freed by the SAME two hashes, from the same kind of comment. The guard is an "any named commit
 * landed -> allow" rule, so every extra token can only ever free a card, never block one.
 *
 * Both names come from the two writers that post generated text, not from a guess:
 * `store/offload-dispatch.sh` (DRAFT_AUTHOR="local-llm") and `store/gate-pretriage-card.sh`
 * ("gate-pretriage"). `store/cybersec-gate-scan.py` and `store/cybered-gate-scan.py` already skip
 * `local-llm` for the same reason -- this is that existing rule reaching the close path.
 *
 * gate-pretriage does usually name the RIGHT commit, so skipping it loses a true reference. That is
 * the safe direction: its sha is copied from the REVIEW comment the guard still reads, and its own
 * resolution has a weak bare-hex fallback that has already named the wrong commit once. Measured
 * over all 304 done cards, excluding both authors blocks exactly one more card (f91fcd7e, a true
 * catch) and costs zero false blocks.
 */
const GENERATED_COMMENT_AUTHORS: ReadonlySet<string> = new Set(['local-llm', 'gate-pretriage'])

export interface LandedVerdict {
  readonly blocked: boolean
  readonly message?: string
}

/** What the card's comments claim, and how much of that claim the guard could resolve. */
interface Claimed {
  /** Candidate tokens that `cat-file` confirmed are real commits in the mapped repo. */
  readonly commits: string[]
  /** Hex tokens named in non-generated comments, before that confirmation. */
  readonly named: number
  /** Comments skipped as machine-generated -- explains a card that names nothing. */
  readonly skippedGenerated: number
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
async function claimedCommits(cardId: string, repo: string): Promise<Claimed> {
  const candidates: string[] = []
  let skippedGenerated = 0
  for (const c of getKanbanComments(cardId)) {
    if (GENERATED_COMMENT_AUTHORS.has(c.author ?? '')) {
      skippedGenerated += 1
      continue
    }
    for (const m of (c.content ?? '').match(SHA_RX) ?? []) {
      if (!candidates.includes(m)) candidates.push(m)
      if (candidates.length >= MAX_CANDIDATES) break
    }
    if (candidates.length >= MAX_CANDIDATES) break
  }
  if (candidates.length === 0) return { commits: [], named: 0, skippedGenerated }

  const res = await git(repo, ['cat-file', '--batch-check'], candidates.join('\n') + '\n')
  if (!res.ok && res.out === '') return { commits: [], named: candidates.length, skippedGenerated }
  const out: string[] = []
  for (const line of res.out.split('\n')) {
    // "<sha> commit <size>" for a hit; "<token> missing" otherwise.
    const parts = line.trim().split(/\s+/)
    if (parts.length >= 2 && parts[1] === 'commit' && !out.includes(parts[0]!)) out.push(parts[0]!)
  }
  return { commits: out, named: candidates.length, skippedGenerated }
}

/**
 * Of the commits a card names, the ones whose OWN message says they are this card's work.
 *
 * QA's finding on card 9cc72f2c, and it is the fleet's normal way of writing: a comment says "same
 * pattern as <sha>" or "see also <sha>", that unrelated commit is on main, and a rule of "ANY named
 * commit landed -> allow" closes the card on someone else's work. Measured on the 51 cards MikroB had
 * independently confirmed as NOT landed, three were freed exactly this way; among the 304 open done
 * cards, four are closed on it right now -- including 24038ea3, an URGENT security revoke whose own
 * commit never left the branch and which was freed by an unrelated prettier run.
 *
 * QA proposed narrowing to the last REVIEW comment. Replayed over those 304 cards that costs 11
 * correctly-landed cards (they become unchecked closes) and re-frees two the guard blocks today,
 * because the landing evidence is usually MikroB's "Landolva: <sha> mergelve main-re" line rather
 * than the REVIEW. The commit MESSAGE is the better witness: `fix(sec): ... (card 24038ea3)` is
 * written by the author of the work, in the repo, and a commit belonging to another card does not
 * carry this id. One `git log --grep`, one spawn, on a path that already spawns.
 *
 * FALLBACK IS THE POINT: when no candidate names the card, every candidate is kept. Not all commits
 * carry a card id, and the "same work, different sha after a rebase or cherry-pick" case QA asked us
 * to preserve depends on that breadth. This narrows only when it has a better answer, so it can turn
 * an allow into a block (loud, forceable) but never a block into an allow.
 */
async function attributedToCard(repo: string, cardId: string, commits: string[]): Promise<string[]> {
  // With a single candidate the answer cannot change: it is either attributed and kept, or not
  // attributed and kept by the fallback. Skip the spawn.
  if (commits.length < 2) return commits
  const res = await git(repo, [
    'log',
    '--no-walk',
    '--format=%H',
    '-i',
    '--fixed-strings',
    `--grep=${cardId}`,
    ...commits,
  ])
  // ONE fallback, not two: an empty answer, a git failure and an answer naming nothing we hold all
  // arrive here as an empty `owned`. An early return for each would read as care and would be a
  // branch no test can kill -- this way the fallback that matters is the one under test.
  const matched = new Set(res.out.split('\n'))
  const owned = commits.filter((c) => matched.has(c))
  return owned.length > 0 ? owned : commits
}

/**
 * A close that the guard did NOT verify, recorded so it is distinguishable from a verified one.
 *
 * Both outcomes return `blocked: false`, which is what card b428f3da is about: "no commit to check"
 * and "checked, it landed" were the same silent event. They are not the same thing. 52 of the 304
 * done cards close with nothing checked -- some rightly (decision and user-story cards make no
 * landing claim), and at least one wrongly: on card 94727c79 the project label said mikrob while the
 * work lived in CleanCore, so the guard looked in the wrong history, found nothing, and allowed. That
 * case is `reason: named-commits-absent-from-mapped-repo` here, and it reads differently from a card
 * that simply named no commit -- which is the whole point of separating them.
 *
 * Deliberately NOT a block: 17 of the 120 cards in the original sweep name no commit at all, and
 * blocking those would stop every legitimate non-code close.
 */
function allowUnverified(
  cardId: string,
  project: string,
  reason: string,
  extra: Record<string, unknown> = {},
): LandedVerdict {
  logger.info(
    { cardId, project, reason, ...extra },
    'landed-guard: allowing a close it could NOT verify (no commit checked)',
  )
  return { blocked: false }
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
  if (isForceActor(force, actor)) return { blocked: false }

  const card = getKanbanCard(cardId)
  const project = card?.project ?? ''
  const target = PROJECT_REPOS[project.toLowerCase()]
  if (target === undefined) return allowUnverified(cardId, project, 'no-repo-mapping')
  if (!existsSync(`${target.root}/.git`)) {
    return allowUnverified(cardId, project, 'mapped-repo-missing', { root: target.root })
  }
  const repo = target.root

  let claimed: Claimed
  try {
    claimed = await claimedCommits(cardId, repo)
  } catch (err) {
    // A guard that throws must not become a guard that closes the board. Log and stand aside: this
    // is the ONE place failing open is right, because the failure is in the checker, not the claim.
    logger.warn({ err, cardId }, 'landed-guard could not read the card; allowing the close')
    return { blocked: false }
  }
  const commits = await attributedToCard(repo, cardId, claimed.commits)
  if (commits.length === 0) {
    // Two different silences, now two different lines. `named > 0` means the card DOES name commit-
    // shaped tokens, none of which exists in the repo this project maps to -- the 94727c79 shape.
    const reason = claimed.named > 0 ? 'named-commits-absent-from-mapped-repo' : 'no-commit-named'
    return allowUnverified(cardId, project, reason, {
      repo,
      namedTokens: claimed.named,
      skippedGeneratedComments: claimed.skippedGenerated,
    })
  }

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
