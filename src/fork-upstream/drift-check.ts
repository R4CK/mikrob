// The upstream-drift check, as a RUNNABLE thing rather than a test case (card 99c2eb09, parent
// 1f276349, MikroB decision 24642 direction "C").
//
// WHY IT MOVED. This check fetches `upstream/develop` at runtime and merges it into a throwaway
// worktree. Living inside the vitest suite meant living inside the LANDING GATE, so an upstream
// commit arriving in the wrong minute blocked a landing that had nothing to do with it. Measured
// from the guard file's own re-measure notes: 41 "landing-block" mentions, 32 re-measure rounds in
// five days, five agents, eight cards, one card hit thirteen times -- and one of the blocked
// commits was five store/*.py files plus DECISIONS.md, with no src/ file at all.
//
// The deeper reason is not the flakiness: a landing to `develop` does NOT merge upstream, so this
// check cannot catch anything the landing could break. It reports that the WORLD moved. That is a
// monitoring signal, and monitoring belongs on a schedule.
//
// The decision data stays in ./acknowledged-conflicts.ts, which the offline suite also reads, so
// there is exactly one copy of the acknowledgements.
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  classifyConflicts,
  extractConflictHunks,
  readyToPasteEntry,
  type StaleAcknowledgement,
} from './acknowledged-conflicts.js'

export const UPSTREAM_REMOTE = 'upstream'
export const UPSTREAM_BRANCH = 'develop'
const FETCH_TIMEOUT_MS = 20_000

/** Every git call goes through this one shape so a test can drive the whole check with a fake
 *  repository instead of a real remote. Without the seam the only machines that could exercise the
 *  logic would be the ones that can already do a real merge -- the same trap classifyConflicts's
 *  `blobOf` parameter exists to avoid. */
export type GitRunner = (args: readonly string[], cwd: string) => string

export const realGit: GitRunner = (args, cwd) =>
  execFileSync('git', [...args], { cwd, encoding: 'utf-8', timeout: FETCH_TIMEOUT_MS })

export interface DriftResult {
  /** false = the upstream remote is not configured or not reachable. NOT a failure: the check has
   *  nothing to say, exactly as the old test skipped rather than false-failing on an environment
   *  fact. A watcher must not open a card for this. */
  readonly reachable: boolean
  /** Fork-owned files that must never conflict, and did. */
  readonly guarded: readonly string[]
  /** Conflicting files nobody has recorded a resolution for. */
  readonly unwatched: readonly string[]
  /** Acknowledged conflicts whose UPSTREAM side has changed since the rule was written. */
  readonly stale: readonly StaleAcknowledgement[]
  /** Conflict markers captured while the merge was still in the worktree, per file. */
  readonly hunks: Readonly<Record<string, string>>
  /** Upstream's blob for each conflicting file, or absent when upstream genuinely does not have it
   *  (a delete/modify conflict). Card 9c665470: the report used to pass a hardcoded `null` here, so
   *  EVERY ready-to-paste entry claimed '(absent upstream ...)' -- and a pin pasted from that can
   *  never equal a real blob, which makes the new acknowledgement permanently stale on arrival. The
   *  value has to travel with the result, because the throwaway worktree it is read from is gone by
   *  the time the report is formatted. */
  readonly upstreamBlobs: Readonly<Record<string, string>>
}

export function isClean(r: DriftResult): boolean {
  return r.guarded.length === 0 && r.unwatched.length === 0 && r.stale.length === 0
}

function upstreamIsReachable(repoRoot: string, git: GitRunner): boolean {
  try {
    git(['remote', 'get-url', UPSTREAM_REMOTE], repoRoot)
    git(['ls-remote', '--exit-code', UPSTREAM_REMOTE, 'HEAD'], repoRoot)
    return true
  } catch {
    return false
  }
}

/**
 * Fetch upstream, dry-run the merge in a throwaway worktree, classify the conflicts.
 *
 * Never touches the real checkout's index or working files: the merge happens in a detached
 * worktree under a fresh temp dir, aborted and removed in finally.
 */
export function runDriftCheck(repoRoot: string, git: GitRunner = realGit): DriftResult {
  const empty = { guarded: [], unwatched: [], stale: [], hunks: {}, upstreamBlobs: {} }
  if (!upstreamIsReachable(repoRoot, git)) return { reachable: false, ...empty }

  const worktree = mkdtempSync(join(tmpdir(), 'fork-upstream-drift-'))
  try {
    git(['fetch', '--quiet', UPSTREAM_REMOTE, UPSTREAM_BRANCH], repoRoot)
    git(['worktree', 'add', '--quiet', '--detach', worktree, 'HEAD'], repoRoot)

    let conflicted: string[] = []
    const hunks: Record<string, string> = {}
    try {
      git(['merge', '--no-commit', '--no-ff', `${UPSTREAM_REMOTE}/${UPSTREAM_BRANCH}`], worktree)
      // Clean merge, nothing conflicted anywhere.
    } catch {
      conflicted = git(['diff', '--name-only', '--diff-filter=U'], worktree)
        .split('\n')
        .map((l) => l.trim())
        .filter(Boolean)
      // Capture both sides' markers WHILE the working tree still has them -- `merge --abort` below
      // wipes them, so it is now or never (card 1e8111a3).
      for (const f of conflicted) {
        try {
          hunks[f] = extractConflictHunks(readFileSync(join(worktree, f), 'utf-8'))
        } catch {
          // Binary or otherwise unreadable as text; the ready-to-paste entry works without a hunk.
        }
      }
    } finally {
      try {
        git(['merge', '--abort'], worktree)
      } catch {
        // Nothing to abort.
      }
    }

    const blobOf = (f: string): string | null => {
      try {
        return git(['rev-parse', `${UPSTREAM_REMOTE}/${UPSTREAM_BRANCH}:${f}`], worktree).trim()
      } catch {
        return null // deleted upstream -- a delete/modify conflict, not a match
      }
    }

    const verdict = classifyConflicts(conflicted, blobOf)
    // Read BEFORE the finally-block removes the worktree these are resolved from.
    const upstreamBlobs: Record<string, string> = {}
    for (const f of conflicted) {
      const b = blobOf(f)
      if (b !== null) upstreamBlobs[f] = b
    }
    return { reachable: true, guarded: verdict.guarded, unwatched: verdict.unwatched, stale: verdict.stale, hunks, upstreamBlobs }
  } finally {
    try {
      git(['worktree', 'remove', '--force', worktree], repoRoot)
    } catch {
      // Already gone, or never created.
    }
    rmSync(worktree, { recursive: true, force: true })
  }
}

/**
 * The human report. Deliberately carries the SAME guidance the test's assertion messages carried:
 * a reader who is being asked to re-decide needs the previous rule and a ready-to-paste entry in
 * front of them, or the re-decision degrades into bumping a number.
 */
export function formatDriftReport(r: DriftResult): string {
  if (!r.reachable) {
    return (
      `SKIPPED -- the '${UPSTREAM_REMOTE}' remote is not configured or not reachable from here. ` +
      'This check needs a live upstream fetch, so it reports nothing rather than claiming a clean tree.'
    )
  }
  if (isClean(r)) return 'CLEAN -- every upstream conflict is one someone has already decided how to resolve.'

  const parts: string[] = ['DRIFT -- the upstream side no longer matches what we decided about it.']
  if (r.guarded.length) {
    parts.push(
      `\nFORK-OWNED FILES NOW CONFLICT: ${r.guarded.join(', ')}. The "zero-conflict" claim in the ` +
        'README\'s "Upstream-owned vs fork-owned fájlok" section no longer holds -- re-run the card ' +
        '641aca3f investigation (measure whether an overlay extraction is now justified) before the ' +
        'next upstream integration.'
    )
  }
  if (r.unwatched.length) {
    const guidance = r.unwatched
      .map((f) => `\n--- ${f} ---\n${readyToPasteEntry(f, r.upstreamBlobs[f] ?? null)}${r.hunks[f] ? `\n\n  both sides' conflicting hunk(s):\n${r.hunks[f]}` : ''}`)
      .join('\n')
    parts.push(
      `\nNOBODY HAS DECIDED HOW TO RESOLVE: ${r.unwatched.join(', ')}. Decide the rule NOW, while ` +
        'there is time to look at both sides, and record it in ACKNOWLEDGED_CONFLICTS -- not during ' +
        'the merge, when the cheap move is to take one side wholesale. If the file is fork-owned and ' +
        `should never conflict, it belongs in GUARDED_FILES instead. Ready-to-paste entries:${guidance}`
    )
  }
  if (r.stale.length) {
    parts.push(
      '\nTHE ACKNOWLEDGEMENT NO LONGER DESCRIBES WHAT IS THERE: ' +
        r.stale
          .map(
            (s) =>
              `${s.file} (recorded ${s.recorded.slice(0, 12)}, now ${s.actual.slice(0, 12)}) -- the ` +
              `rule written last time was: "${s.rule}"`
          )
          .join('; ')
    )
  }
  return parts.join('\n')
}

// ---------------------------------------------------------------------------------------------
// The ARMED/SKIPPED announcement, moved here with the check it describes (card 5da60b85).
//
// It exists because a skip used to be invisible: the old META test asserted only
// `typeof canRun === 'boolean'`, which is true either way, so a suite with a DEAD upstream remote
// read exactly as green as one with a live remote (Cybered, card d359535c). Baking the state into
// the reported NAME is what makes it un-collapsible. The scheduled watcher reports the same two
// states for the same reason: "nothing to say" and "nothing wrong" must not look alike.
const SKIP_REASON =
  `the '${UPSTREAM_REMOTE}' remote is not configured or not reachable from this environment ` +
  '(no network, or CI has no upstream fetch access). This check needs a live upstream fetch, so it ' +
  'reports nothing rather than claiming a clean tree.'

export function metaAnnouncement(armed: boolean): { name: string; message: string } {
  return armed
    ? {
        name: 'META: ARMED -- upstream reachable, the merge-conflict check actually ran',
        message: '[fork-upstream-drift] ARMED -- upstream reachable, running the real merge dry-run.',
      }
    : {
        name: 'META: SKIPPED -- the merge-conflict check did NOT run this pass (no upstream reachability)',
        message: `[fork-upstream-drift] SKIPPED -- ${SKIP_REASON}`,
      }
}
