// Card a8a83d48 (Fazis ed332869), MikroB rescope comment 27940 point 6: POST /api/card-landings
// must independently VERIFY a claimed landing before writing the row, not trust the caller's say-so.
// db.ts's recordCardLanding() does no verification by design (its own doc comment says so) -- this
// module is the caller that must do it first, kept OUT of db.ts for the same reason
// kanban-relations-git.ts stays out of it: db.ts must never shell out to git.
//
// Deliberately async (execFile, not execFileSync): this runs on every landing's write call, and a
// synchronous git fetch would stall the whole single-process server (Telegram polling, every other
// request) for however long the network fetch takes.

import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

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
  const { stdout } = await execFileAsync('git', ['-C', repoPath, ...args])
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
 * True only if `sha` is a real commit in `repo`'s local checkout AND an ancestor of
 * `origin/<default branch>` there, after fetching that branch fresh from origin -- so the answer
 * reflects what is actually on the remote right now, not whatever this checkout happened to have
 * cached. False (never throws) for an unknown repo, an unreachable remote, or a sha that is not an
 * ancestor: every failure mode is "not verified", the caller's job is to refuse the write on any of
 * them, not to tell them apart.
 */
export async function verifyLandedOnDefaultBranch(repo: string, sha: string): Promise<boolean> {
  const cfg = repoConfig(repo)
  if (!cfg) return false
  try {
    const branch = await defaultBranch(cfg.path, cfg.fallbackBranch)
    await git(cfg.path, ['fetch', '-q', 'origin', branch])
    await git(cfg.path, ['merge-base', '--is-ancestor', sha, `origin/${branch}`])
    return true
  } catch {
    return false
  }
}
