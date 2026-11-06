// Card a8a83d48 (Fazis ed332869), MikroB rescope comment 27940 point 6: POST /api/card-landings
// must independently VERIFY a claimed landing before writing the row, not trust the caller's say-so.
// db.ts's recordCardLanding() does no verification by design (its own doc comment says so) -- this
// module is the caller that must do it first, kept OUT of db.ts for the same reason
// kanban-relations-git.ts stays out of it: db.ts must never shell out to git.
//
// Deliberately async (execFile, not execFileSync): this runs on every landing's write call, and a
// synchronous git fetch would stall the whole single-process server (Telegram polling, every other
// request) for however long the network fetch takes.
//
// Cybersec2 NO-GO (card a8a83d48, Gate-SHA 6cc529f3d, F1 HIGH): the original version of this file
// only proved "merge_sha is SOME ancestor of origin/<branch>" -- nothing bound the row to the card
// or to work_sha. Measured live: an unrelated already-landed sha recorded ANY card as landed, a
// non-sha string ("origin/develop", a 7-char prefix) was accepted and stored verbatim, and work_sha
// was never checked at all. verifyCardLanding() below closes all three: full-hex format, each sha
// resolved to a real commit object (rev-parse --verify --end-of-options <sha>^{commit}, which
// rejects anything option-shaped and anything that isn't a commit), work_sha required to be an
// ancestor of merge_sha, and the card id required to appear in a commit subject in the
// work_sha^..merge_sha range (the convention this fleet's own commits already follow:
// "type(cardId): ..." or prose "card <id>").

import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

// F2 (MEDIUM, Cybersec2): a hung remote (the card text's own example: a GitHub SSH flap) left
// `git fetch` pending indefinitely -- one hung child process and one open HTTP request per POST,
// unbounded. Every git call below is capped. Read live per call (like repoConfig reads
// MARVEEN_MAIN), not cached at module load: a test overriding the env var after this module was
// already imported must still see the override take effect.
function gitTimeoutMs(): number {
  return Number(process.env.CARD_LANDING_GIT_TIMEOUT_MS) || 20_000
}

const FULL_SHA_RE = /^[0-9a-f]{40}$/i

/** Repo name -> {path, fallback default branch if origin/HEAD can't be read}.
 *
 *  Deliberately its OWN table, not a reuse of kanban-relations-git.ts's defaultRepos(): that
 *  module keys the mopsion repo as "cleancore" (CLAUDE.md: the internal id was never renamed on
 *  purpose, only the display name was). card_landings is read by cards and humans (F2.2's
 *  done-guard, the dashboard), so its `repo` column uses the CURRENT canonical name
 *  ("mopsion" -- project-names-canonical memory), and this table is the one place that maps it
 *  to a path -- same env vars the land scripts already use (MARVEEN_MAIN, CLEANCORE_MAIN). */
function repoConfig(repo: string): { path: string; fallbackBranch: string } | null {
  if (repo === 'marveen') {
    return { path: process.env.MARVEEN_MAIN || '/home/neon/marveen', fallbackBranch: 'develop' }
  }
  if (repo === 'mopsion') {
    return {
      path: process.env.CLEANCORE_MAIN || '/mnt/h/LM_Studio_Workdir/mopsion',
      fallbackBranch: 'main',
    }
  }
  return null
}

/** The caller's name for each repo this server knows how to verify against. */
export function knownRepos(): string[] {
  return ['marveen', 'mopsion']
}

async function git(repoPath: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync('git', ['-C', repoPath, ...args], { timeout: gitTimeoutMs() })
  return stdout.trim()
}

async function defaultBranch(repoPath: string, fallback: string): Promise<string> {
  try {
    const ref = await git(repoPath, ['symbolic-ref', '--short', 'refs/remotes/origin/HEAD'])
    return ref.replace(/^origin\//, '') || fallback
  } catch {
    return fallback
  }
}

/**
 * Resolves `sha` to itself only if it is a real commit object -- never a tag, tree, blob, ref
 * name ("origin/develop") or a hex PREFIX. `--end-of-options` stops git from reading a
 * dash-leading value as a flag; `^{commit}` forces dereferencing to a commit, so a tag or
 * annotated-tag-wrapped object is rejected rather than silently accepted. Returns null on any
 * failure (never throws) -- the caller treats null the same as "not verified".
 */
async function resolveCommit(repoPath: string, sha: string): Promise<string | null> {
  if (!FULL_SHA_RE.test(sha)) return null
  try {
    const resolved = await git(repoPath, ['rev-parse', '--verify', '--end-of-options', `${sha}^{commit}`])
    return resolved.toLowerCase() === sha.toLowerCase() ? resolved : null
  } catch {
    return null
  }
}

async function isAncestor(repoPath: string, ancestor: string, descendant: string): Promise<boolean> {
  try {
    await git(repoPath, ['merge-base', '--is-ancestor', ancestor, descendant])
    return true
  } catch {
    return false
  }
}

/**
 * True only if `cardId` is named in the subject of at least one commit in `fromSha^..toSha`
 * (inclusive of fromSha, exclusive of its parent) -- the range this landing's own work_sha and
 * merge_sha describe. Matches both this fleet's conventional-commit scope form
 * ("fix(a8a83d48): ...") and the prose form ("card a8a83d48", "Card a8a83d48:"): a hex-delimited
 * substring match, not an anchored regex, so either shape is caught by the same check. False on
 * any git failure (an unreadable range proves nothing).
 */
async function cardBoundToRange(repoPath: string, cardId: string, fromSha: string, toSha: string): Promise<boolean> {
  try {
    const log = await git(repoPath, ['log', '--format=%s', `${fromSha}^..${toSha}`])
    const needle = new RegExp(`(?:^|[^0-9a-f])${cardId}(?:[^0-9a-f]|$)`, 'i')
    return log.split('\n').some((subject) => needle.test(subject))
  } catch {
    return false
  }
}

export type CardLandingVerdict =
  | { ok: true; workSha: string; mergeSha: string }
  | { ok: false; reason: string }

/**
 * The full check a card_landings write must pass before the row is trusted by any future reader
 * (F2.2's done-guard, F2.3's gate-closure-check): both shas are real commit objects in `repo`,
 * mergeSha is a verified-fresh ancestor of origin's default branch, workSha is an ancestor of
 * mergeSha (the gated work is actually IN the landed merge, not just coincidentally alongside
 * it), and cardId is named in a commit subject somewhere in that range (the row is actually
 * about this card, not an unrelated one). Every failure returns `{ok:false, reason}`; nothing
 * here writes anything.
 */
export async function verifyCardLanding(
  repo: string,
  cardId: string,
  workSha: string,
  mergeSha: string,
): Promise<CardLandingVerdict> {
  const cfg = repoConfig(repo)
  if (!cfg) return { ok: false, reason: `unknown repo "${repo}"` }

  // Fetch BEFORE resolving either sha: a landing pushed moments ago by the land script's own
  // worktree is a real object only reachable from origin's branch, not yet in this checkout's
  // object database -- resolving first would reject a perfectly real, just-landed commit.
  const branch = await defaultBranch(cfg.path, cfg.fallbackBranch)
  try {
    await git(cfg.path, ['fetch', '-q', 'origin', branch])
  } catch {
    return { ok: false, reason: `could not fetch origin/${branch}` }
  }

  const resolvedMerge = await resolveCommit(cfg.path, mergeSha)
  if (!resolvedMerge) return { ok: false, reason: 'merge_sha is not a real full-sha commit object' }
  const resolvedWork = await resolveCommit(cfg.path, workSha)
  if (!resolvedWork) return { ok: false, reason: 'work_sha is not a real full-sha commit object' }

  if (!(await isAncestor(cfg.path, resolvedMerge, `origin/${branch}`))) {
    return { ok: false, reason: `merge_sha is not a verified ancestor of origin/${branch}` }
  }
  if (!(await isAncestor(cfg.path, resolvedWork, resolvedMerge))) {
    return { ok: false, reason: 'work_sha is not an ancestor of merge_sha' }
  }
  if (!(await cardBoundToRange(cfg.path, cardId, resolvedWork, resolvedMerge))) {
    return { ok: false, reason: `card_id "${cardId}" is not named in any commit subject between work_sha and merge_sha` }
  }

  return { ok: true, workSha: resolvedWork, mergeSha: resolvedMerge }
}
