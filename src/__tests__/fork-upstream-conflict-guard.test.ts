// Card 641aca3f: guard that a future `git merge upstream/develop` gives ZERO conflicts on the
// fork-owned web files (web/app.js, web/lang/{hu,en}.js, web/style.css). See the "Upstream-owned vs
// fork-owned fájlok" README section for the full investigation.
//
// Card f085fd44 widened it. The original guard could only see the four files it was told about, and
// that is exactly what went wrong: three OTHER files were conflicting -- one of them behaviour-
// critical (src/model-fallback.ts, where a wholesale merge in either direction either reintroduces
// a fleet-wide false positive or drops a real detection) -- and nothing was watching them. So the
// question this file answers is no longer "do these four still merge cleanly" but "is every
// conflicting file one we have already decided how to resolve".
//
// The premise this test enforces was MEASURED, not assumed: a real `git merge --no-commit --no-ff
// upstream/develop` dry-run (throwaway worktree, never touching the real checkout) currently gives
// zero conflicts on those files -- upstream and the fork's ~496 web/app.js references live in
// different regions of the same 18.5k-line bundler-less global script. A prior investigation (this
// same card) found no clean way to physically extract the fork's interleaved code into a separate
// overlay file without a hook framework the plain-script app does not have, and the measured
// conflict count did not justify inventing one. So instead of moving code, this test keeps the
// zero-conflict CLAIM itself honest over time: if a future upstream commit starts touching the same
// region as the fork code, this goes red BEFORE a real merge attempt surprises anyone.
//
// Network-dependent (needs the `upstream` remote reachable) and mutates nothing in the real
// checkout -- all git operations run inside a throwaway worktree under a fresh temp dir, removed in
// finally. Skips (not fails) when upstream is unreachable, same "always-armed meta-test states the
// reason out loud" discipline as REPO_UNDER_TMP-gated suites (see helpers/repo-location.ts).
import { describe, it, expect } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { REPO_ROOT } from './helpers/repo-location.js'

const UPSTREAM_REMOTE = 'upstream'
const UPSTREAM_BRANCH = 'develop'
const FETCH_TIMEOUT_MS = 20_000

// The fork-owned web files the card named as the conflict risk. Kept as an explicit list (not
// derived) because "which files are fork-owned" is a human/architectural judgement, not something
// git state can compute -- the guard's job is to check THESE specific files stay conflict-free, not
// to discover the list.
const GUARDED_FILES = ['web/app.js', 'web/lang/hu.js', 'web/lang/en.js', 'web/style.css'] as const

// Files that DO conflict today, deliberately, and whose resolution rule is written down (card
// f085fd44). This list is not a second copy of the one above: those files must never conflict,
// these are KNOWN to, and the point of naming them is that the resolution is a decision someone
// already made rather than one improvised mid-merge.
//
// They are listed here for one reason -- so the check below can be about the WHOLE conflict set
// rather than four hand-picked files. Before this, a manual list of four could only ever see what
// it already knew about: three files conflicted for weeks with nothing watching them, and the only
// reason anyone noticed was a human running the dry-run by hand.
const ACKNOWLEDGED_CONFLICTS: Readonly<Record<string, string>> = {
  // BEHAVIOUR-CRITICAL. The fork removed "upgrade to increase your usage limit" from the
  // usage-limit regex (2026-06-30: it matched Claude Code's /upgrade STARTUP HINT, so fresh agents
  // read as limited and got needlessly downgraded). Upstream still has that token AND added a real
  // "session limit" variant (2026-08-08). Resolution: ADOPT the session-limit alternative, KEEP the
  // /upgrade removal. Neither side's file may be taken wholesale -- see the pinned pair in
  // model-fallback.test.ts ("keeps BOTH halves of the fork/upstream resolution at once").
  'src/model-fallback.ts':
    'take upstream session-limit alternative, keep the fork /upgrade removal (never a wholesale side)',
  // The test file diverges with the module it tests: fork-only weekly-tier tests plus the pinned
  // resolution pair above. Resolution: keep both sides' cases, drop neither.
  'src/__tests__/model-fallback.test.ts': 'union of both sides cases -- fork weekly-tier + upstream additions',
  // The fork restructured this file into a MULTI-REPO aggregate (marveen + mikrob blocks, per-repo
  // results in `repos`); upstream kept the single-result shape and is still adding features to it,
  // e.g. the running `version` in the Updates header (upstream aefa693). So it is not "fork parts
  // are additive" in either direction -- measured 2026-08-14, the fork side currently LACKS that
  // version field. Resolution: keep the fork's aggregate structure, and port upstream's new
  // single-result features onto it one by one.
  'src/web/update-checker.ts': 'keep the fork aggregate shape, port upstream single-result features onto it',
  // A one-line import conflict, not a behavioural one (measured 2026-08-16, card 78c14372): the fork
  // added `agentDir` to the existing import from './agent-config.js' (workingDirFor() now goes
  // through the sanitized helper instead of building its own path), and upstream independently added
  // `readAgentClaudeConfigDir` to the SAME import line for an unrelated feature. Nothing else in the
  // file diverges. Resolution: merge both imports onto one line, keep both bindings.
  'src/web/context-restart-gate-runner.ts':
    'merge both added imports onto one line (agentDir from the fork, readAgentClaudeConfigDir from upstream) -- no other conflict in the file',
  // A single additive hunk (measured 2026-08-16, card 88505fb5), not a behavioural disagreement:
  // both sides add an INDEPENDENT schema migration/trigger at the same insertion point inside
  // ensureSchema(). Fork: the timestamp-integrity triggers (epoch validation + repair on
  // kanban_cards/kanban_comments) plus the kanban_card_events.forced column migration. Upstream:
  // the kanban_cards_status_bumps_updated_at self-healing trigger (keeps updated_at honest when a
  // raw SQL UPDATE only touches status). Neither reads or overwrites anything the other writes.
  // Resolution: keep BOTH blocks, either order -- union, not a pick.
  'src/db.ts':
    'keep both additive migrations -- the fork timestamp-integrity triggers + forced column, and the upstream kanban_cards_status_bumps_updated_at trigger -- neither side taken wholesale',
}

function git(args: string[], cwd: string): string {
  return execFileSync('git', args, { cwd, encoding: 'utf-8', timeout: FETCH_TIMEOUT_MS })
}

function upstreamIsReachable(): boolean {
  try {
    execFileSync('git', ['remote', 'get-url', UPSTREAM_REMOTE], {
      cwd: REPO_ROOT,
      timeout: 5_000,
      stdio: 'pipe',
    })
    execFileSync('git', ['ls-remote', '--exit-code', UPSTREAM_REMOTE, 'HEAD'], {
      cwd: REPO_ROOT,
      timeout: FETCH_TIMEOUT_MS,
      stdio: 'pipe',
    })
    return true
  } catch {
    return false
  }
}

const canRun = upstreamIsReachable()
const SKIP_REASON =
  `the '${UPSTREAM_REMOTE}' remote is not configured or not reachable from this environment ` +
  '(no network, or CI has no upstream fetch access). This guard needs a live upstream fetch, so it ' +
  'skips rather than false-failing on an environment limitation.'

// Pure, so both states are unit-testable without touching real network reachability (card
// d359535c, Cybered's finding): the old META test asserted only `typeof canRun === 'boolean'`,
// which is true whichever way canRun goes -- it could never distinguish armed from skipped, so a
// suite with a dead upstream remote read exactly as green as one with a live one, and the only
// trace of the difference was a console.log line most CI views never surface.
//
// The fix does NOT make the guard fail when skipped -- that would reopen exactly the false-red-on-
// an-environment-limitation problem this file's header comment already rejected (same discipline as
// REPO_UNDER_TMP-gated suites: skip, do not false-fail, when the precondition is an environment
// fact rather than a code defect). Instead the skip state is baked into the TEST'S OWN NAME, which
// every reporter shows (console list, JUnit XML, GitHub Actions summary) -- unlike a console.log
// line, a test name cannot be collapsed or filtered out of a green run's summary.
export function metaAnnouncement(armed: boolean): { name: string; message: string } {
  return armed
    ? {
        name: 'META: ARMED -- upstream reachable, the merge-conflict guard below actually ran',
        message:
          '[fork-upstream-conflict-guard] ARMED -- upstream reachable, running the real merge dry-run.',
      }
    : {
        name: 'META: SKIPPED -- the merge-conflict guard below did NOT run this pass (no upstream reachability)',
        message: `[fork-upstream-conflict-guard] SKIPPED -- ${SKIP_REASON}`,
      }
}

const META = metaAnnouncement(canRun)

describe('fork/upstream web-file merge-conflict guard (card 641aca3f)', () => {
  it(META.name, () => {
    console.log(META.message)
    // Content check, not a type check: pins the message to the SAME state the test name reports,
    // so the two cannot drift apart silently.
    expect(META.message).toContain(canRun ? 'ARMED' : 'SKIPPED')
  })

  it.skipIf(!canRun)(
    'a real merge of upstream/develop conflicts on ZERO fork-owned web files',
    () => {
      const worktree = mkdtempSync(join(tmpdir(), 'fork-conflict-guard-'))
      try {
        git(['fetch', '--quiet', UPSTREAM_REMOTE, UPSTREAM_BRANCH], REPO_ROOT)
        // Detached worktree of our own HEAD -- never touches the real checkout's index or files.
        git(['worktree', 'add', '--quiet', '--detach', worktree, 'HEAD'], REPO_ROOT)

        let conflicted: string[] = []
        try {
          git(
            ['merge', '--no-commit', '--no-ff', `${UPSTREAM_REMOTE}/${UPSTREAM_BRANCH}`],
            worktree,
          )
          // Clean merge, nothing conflicted anywhere.
        } catch {
          conflicted = git(['diff', '--name-only', '--diff-filter=U'], worktree)
            .split('\n')
            .map((l) => l.trim())
            .filter(Boolean)
        } finally {
          try {
            git(['merge', '--abort'], worktree)
          } catch {
            // Nothing to abort (merge did not start / already clean) -- fine.
          }
        }

        const conflictedGuardedFiles = conflicted.filter((f) =>
          (GUARDED_FILES as readonly string[]).includes(f),
        )
        expect(
          conflictedGuardedFiles,
          `upstream/develop now conflicts on fork-owned web file(s): ${conflictedGuardedFiles.join(', ')}. ` +
            'The "zero-conflict" claim in the README\'s "Upstream-owned vs fork-owned fájlok" section no ' +
            'longer holds -- re-run the card 641aca3f investigation (measure whether an overlay extraction ' +
            'is now justified) before the next upstream integration.',
        ).toEqual([])

        // The check the original guard could not make (card f085fd44). Watching four named files
        // means a conflict anywhere else is invisible: three files -- one of them behaviour-critical
        // -- had been conflicting with nothing watching, and were found only because a human ran
        // the dry-run by hand. So this asserts on the WHOLE conflict set: every conflicting file
        // must be one someone has already decided how to resolve.
        const unwatched = conflicted.filter(
          (f) =>
            !(GUARDED_FILES as readonly string[]).includes(f) &&
            !Object.prototype.hasOwnProperty.call(ACKNOWLEDGED_CONFLICTS, f),
        )
        expect(
          unwatched,
          `upstream/develop conflicts on file(s) nobody has decided how to resolve: ${unwatched.join(', ')}. ` +
            'Decide the rule NOW, while there is time to look at both sides, and record it in ' +
            'ACKNOWLEDGED_CONFLICTS above -- not during the merge, when the cheap move is to take one ' +
            'side wholesale. If the file is fork-owned and should never conflict, it belongs in ' +
            'GUARDED_FILES instead.',
        ).toEqual([])
      } finally {
        try {
          git(['worktree', 'remove', '--force', worktree], REPO_ROOT)
        } catch {
          rmSync(worktree, { recursive: true, force: true })
        }
      }
    },
  )
})

// Always runs, no network involved: pins BOTH states of metaAnnouncement() deterministically (card
// d359535c). The live META test above can only ever exercise whichever state this environment
// happens to be in right now -- these two cases are what actually prove the skip path produces a
// distinct, loud test name rather than silently reusing the armed one.
describe('metaAnnouncement (card d359535c: the skip state must be loud, not just typeof-boolean)', () => {
  it('armed: the name says ARMED and the message matches', () => {
    const a = metaAnnouncement(true)
    expect(a.name).toContain('ARMED')
    expect(a.name).not.toContain('SKIPPED')
    expect(a.message).toContain('ARMED')
  })

  it('skipped: the name says SKIPPED and the message matches -- this is what used to be invisible', () => {
    const a = metaAnnouncement(false)
    expect(a.name).toContain('SKIPPED')
    expect(a.name).not.toContain('ARMED')
    expect(a.message).toContain('SKIPPED')
  })

  it('the two states never produce the same test name (armed cannot masquerade as skipped or vice versa)', () => {
    expect(metaAnnouncement(true).name).not.toBe(metaAnnouncement(false).name)
  })
})
