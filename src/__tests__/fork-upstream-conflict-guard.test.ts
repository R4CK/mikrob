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
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { REPO_ROOT } from './helpers/repo-location.js'

const UPSTREAM_REMOTE = 'upstream'
const UPSTREAM_BRANCH = 'develop'
const FETCH_TIMEOUT_MS = 20_000
import {
  MIGRATED_FROM_GUARDED,
  ACKNOWLEDGED_CONFLICTS,
  ACKNOWLEDGED_UPSTREAM_BLOBS,
  ACKNOWLEDGED_FORK_ANCHORS,
  classifyConflicts,
  classifyForkAnchors,
  containsAsToken,
  extractConflictHunks,
  readyToPasteEntry,
  type ForkAnchor,
} from '../fork-upstream/acknowledged-conflicts.js'


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
        const conflictHunks: Record<string, string> = {}
        try {
          git(
            ['merge', '--no-commit', '--no-ff', `${UPSTREAM_REMOTE}/${UPSTREAM_BRANCH}`],
            worktree
          )
          // Clean merge, nothing conflicted anywhere.
        } catch {
          conflicted = git(['diff', '--name-only', '--diff-filter=U'], worktree)
            .split('\n')
            .map((l) => l.trim())
            .filter(Boolean)
          // Grab both sides' conflict markers WHILE the working tree still has them -- `merge
          // --abort` below wipes this, so it is now or never (card 1e8111a3, ready-to-paste
          // failure message).
          for (const f of conflicted) {
            try {
              conflictHunks[f] = extractConflictHunks(readFileSync(join(worktree, f), 'utf-8'))
            } catch {
              // Binary file, or otherwise unreadable as text -- the ready-to-paste entry below
              // still works without a hunk snippet.
            }
          }
        } finally {
          try {
            git(['merge', '--abort'], worktree)
          } catch {
            // Nothing to abort (merge did not start / already clean) -- fine.
          }
        }

        const blobOf = (f: string): string | null => {
          try {
            return git(['rev-parse', `${UPSTREAM_REMOTE}/${UPSTREAM_BRANCH}:${f}`], worktree).trim()
          } catch {
            return null // deleted upstream -- a delete/modify conflict, not a match
          }
        }

        // One classification for all three verdicts, from the same pure function the offline
        // tests below exercise -- so what runs here is not a second, hand-inlined copy of the
        // rules that could drift from the one that is actually unit-tested.
        const verdict = classifyConflicts(conflicted, blobOf)

        const conflictedGuardedFiles = verdict.guarded
        expect(
          conflictedGuardedFiles,
          `upstream/develop now conflicts on fork-owned web file(s): ${conflictedGuardedFiles.join(', ')}. ` +
            'The "zero-conflict" claim in the README\'s "Upstream-owned vs fork-owned fájlok" section no ' +
            'longer holds -- re-run the card 641aca3f investigation (measure whether an overlay extraction ' +
            'is now justified) before the next upstream integration.'
        ).toEqual([])

        // The check the original guard could not make (card f085fd44). Watching four named files
        // means a conflict anywhere else is invisible: three files -- one of them behaviour-critical
        // -- had been conflicting with nothing watching, and were found only because a human ran
        // the dry-run by hand. So this asserts on the WHOLE conflict set: every conflicting file
        // must be one someone has already decided how to resolve.
        const unwatched = verdict.unwatched
        // Card 1e8111a3: the entry below, not just the instruction to write one. blobOf() is the
        // same closure classifyConflicts already consulted for acknowledged files -- calling it
        // again here for unwatched ones costs one more `git rev-parse` per file, paid only on the
        // failure path.
        const unwatchedGuidance = unwatched
          .map(
            (f) =>
              `\n--- ${f} ---\n` +
              readyToPasteEntry(f, blobOf(f)) +
              (conflictHunks[f] ? `\n\n  both sides' conflicting hunk(s):\n${conflictHunks[f]}` : '')
          )
          .join('\n')
        expect(
          unwatched,
          `upstream/develop conflicts on file(s) nobody has decided how to resolve: ${unwatched.join(', ')}. ` +
            'Decide the rule NOW, while there is time to look at both sides, and record it in ' +
            'ACKNOWLEDGED_CONFLICTS above -- not during the merge, when the cheap move is to take one ' +
            'side wholesale. If the file is fork-owned and should never conflict, it belongs in ' +
            `GUARDED_FILES instead. Ready-to-paste entries:${unwatchedGuidance}`
        ).toEqual([])

        // THE ACKNOWLEDGEMENT MUST STILL DESCRIBE WHAT IS THERE (card a1d613e3). The two checks
        // above only ask WHETHER a file was decided about; this one asks whether the decision was
        // read against TODAY's upstream content. Without it the exemption is permanent: card
        // 0ea89716 put installer-start-and-fallback.test.ts on the list precisely because upstream
        // keeps editing it, so a LATER, different conflict there -- in a test whose whole job is to
        // measure that an installer abort really happened -- would have crossed this gate in
        // silence, on the strength of a decision about some other hunk.
        expect(
          verdict.stale,
          'the upstream side of these acknowledged conflicts has CHANGED since the rule was ' +
            'written, so the recorded resolution no longer describes the conflict it is exempting: ' +
            verdict.stale
              .map(
                (s) =>
                  `${s.file} (recorded ${s.recorded.slice(0, 12)}, now ${s.actual.slice(0, 12)}) ` +
                  `-- the rule written last time was: "${s.rule}"`
              )
              .join('; ') +
            '. Read both sides again, update the rule in ACKNOWLEDGED_CONFLICTS if the resolution ' +
            'changed, then record the new sha in ACKNOWLEDGED_UPSTREAM_BLOBS. `git rev-parse ' +
            `${UPSTREAM_REMOTE}/${UPSTREAM_BRANCH}:<file>\` prints it.`
        ).toEqual([])
      } finally {
        try {
          git(['worktree', 'remove', '--force', worktree], REPO_ROOT)
        } catch {
          rmSync(worktree, { recursive: true, force: true })
        }
      }
    }
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

// Offline half of card a1d613e3. The live guard above only runs where the upstream remote is
// reachable, so without these the content-binding would be exercised nowhere else -- and the whole
// finding was about a check that looked present and decided nothing.
describe('classifyConflicts: an acknowledgement is bound to CONTENT, not to a file name (card a1d613e3)', () => {
  // Cybersec's own example: a watchdog test that upstream keeps editing, exempted by name.
  const WATCHDOG = 'src/__tests__/installer-start-and-fallback.test.ts'
  const RECORDED = '9017ce4fcfe808b73fdcd1389ebf1c9eaf374f7e'

  it('the fixture is a REAL entry, not a name that happens to look like one', () => {
    // Without this, every case below could be measuring the "unwatched" path by accident: a typo in
    // WATCHDOG would send it there and the stale cases would trivially "pass" for the wrong reason.
    expect(Object.keys(ACKNOWLEDGED_UPSTREAM_BLOBS)).toContain(WATCHDOG)
    expect(ACKNOWLEDGED_UPSTREAM_BLOBS[WATCHDOG]).toBe(RECORDED)
  })

  it('SAME file, SAME upstream blob -> still acknowledged, the landing is not stopped twice', () => {
    const v = classifyConflicts([WATCHDOG], () => RECORDED)
    expect(v.unwatched).toEqual([])
    expect(v.stale).toEqual([])
  })

  it('THE DEFECT: same file, DIFFERENT upstream content -> blocks again instead of passing', () => {
    // This is the case that used to be silent forever. The name was on the list, so the guard said
    // nothing -- about a hunk nobody had ever looked at, in a test that measures whether an
    // installer abort really happened.
    const moved = 'ffffffffffffffffffffffffffffffffffffffff'
    const v = classifyConflicts([WATCHDOG], () => moved)
    expect(v.stale).toEqual([
      { file: WATCHDOG, recorded: RECORDED, actual: moved, rule: ACKNOWLEDGED_CONFLICTS[WATCHDOG] },
    ])
    // The PREVIOUS rule travels with the finding. Blocking someone and making them go look up what
    // they decided last time is how a re-decision turns into a rubber-stamp.
    expect(v.stale[0]!.rule).toContain('TRAP:5')
    // Still not "unwatched" -- somebody DID decide about this file. The two verdicts are different
    // questions and the messages a reader gets must not be interchangeable.
    expect(v.unwatched).toEqual([])
  })

  it('a delete/modify conflict (gone upstream) is stale, not a pass', () => {
    const v = classifyConflicts([WATCHDOG], () => null)
    expect(v.stale).toEqual([
      {
        file: WATCHDOG,
        recorded: RECORDED,
        actual: '(absent upstream)',
        rule: ACKNOWLEDGED_CONFLICTS[WATCHDOG],
      },
    ])
  })

  it('every file ever in GUARDED_FILES is still ACKNOWLEDGED -- migrating one out is not deleting it', () => {
    // GUARDED_FILES is empty now. Without this, the guarded assertion in the live check passes by
    // having nothing to check, and a file could be dropped from BOTH lists by deleting one line --
    // silently un-watching a conflict that someone once cared enough about to name.
    for (const file of MIGRATED_FROM_GUARDED) {
      expect(
        Object.prototype.hasOwnProperty.call(ACKNOWLEDGED_CONFLICTS, file),
        `${file} left GUARDED_FILES but has no written resolution rule`,
      ).toBe(true)
      expect(
        Object.prototype.hasOwnProperty.call(ACKNOWLEDGED_UPSTREAM_BLOBS, file),
        `${file} has a rule but no pinned upstream blob, so the rule cannot go stale`,
      ).toBe(true)
    }
  })

  it('an undecided file is still UNWATCHED, and is never reported as stale', () => {
    const v = classifyConflicts(['src/some/brand-new-file.ts'], () => 'whatever')
    expect(v.unwatched).toEqual(['src/some/brand-new-file.ts'])
    expect(v.stale).toEqual([])
  })

  it('a fork-owned GUARDED file is classified as guarded, not as undecided', () => {
    // Uses an injected list: the live GUARDED_FILES is empty today (every member migrated to
    // ACKNOWLEDGED_CONFLICTS), and a test that indexed it would either not compile or silently
    // stop exercising this branch.
    const FAKE = 'web/some-fork-owned.js'
    const v = classifyConflicts([FAKE], () => 'whatever', [FAKE])
    expect(v.guarded).toEqual([FAKE])
    expect(v.unwatched).toEqual([])
    expect(v.stale).toEqual([])
  })

  it('blobOf is consulted ONLY for acknowledged files -- no needless git call per conflict', () => {
    const asked: string[] = []
    const FAKE = 'web/some-fork-owned.js'
    classifyConflicts([WATCHDOG, 'src/some/brand-new-file.ts', FAKE], (f) => {
      asked.push(f)
      return RECORDED
    }, [FAKE])
    expect(asked).toEqual([WATCHDOG])
  })
})

// Offline unit tests for the two card-1e8111a3 helpers -- no network, no worktree, so the format of
// the ready-to-paste entry is pinned even on a machine where `upstream` is unreachable.
describe('readyToPasteEntry + extractConflictHunks (card 1e8111a3: hand a paste-ready entry, not just an instruction)', () => {
  it('readyToPasteEntry embeds the file path and the resolved upstream blob', () => {
    const entry = readyToPasteEntry('src/some/brand-new-file.ts', 'deadbeef00000000000000000000000000000000')
    expect(entry).toContain("'src/some/brand-new-file.ts'")
    expect(entry).toContain('deadbeef00000000000000000000000000000000')
    expect(entry).toContain('ACKNOWLEDGED_UPSTREAM_BLOBS')
    // The resolution itself is never guessed -- it is human judgement.
    expect(entry).toContain('TODO')
  })

  it('readyToPasteEntry states a delete/modify conflict plainly when there is no blob', () => {
    const entry = readyToPasteEntry('src/some/deleted-upstream.ts', null)
    expect(entry).toContain('absent upstream')
    expect(entry).not.toContain('null')
  })

  it('extractConflictHunks pulls out exactly the marked region, not the whole file', () => {
    const content = [
      'line before',
      '<<<<<<< HEAD',
      'fork version',
      '=======',
      'upstream version',
      '>>>>>>> upstream/develop',
      'line after',
    ].join('\n')
    const hunk = extractConflictHunks(content)
    expect(hunk).toContain('fork version')
    expect(hunk).toContain('upstream version')
    expect(hunk).not.toContain('line before')
    expect(hunk).not.toContain('line after')
  })

  it('extractConflictHunks joins multiple hunks in the same file', () => {
    const content = [
      '<<<<<<< HEAD',
      'a-fork',
      '=======',
      'a-upstream',
      '>>>>>>> upstream/develop',
      'unrelated middle',
      '<<<<<<< HEAD',
      'b-fork',
      '=======',
      'b-upstream',
      '>>>>>>> upstream/develop',
    ].join('\n')
    const hunk = extractConflictHunks(content)
    expect(hunk).toContain('a-fork')
    expect(hunk).toContain('b-upstream')
    expect(hunk).not.toContain('unrelated middle')
  })

  it('extractConflictHunks returns empty for content with no markers (e.g. a binary conflict)', () => {
    expect(extractConflictHunks('just some ordinary file content\n')).toBe('')
  })

  it('extractConflictHunks truncates a hunk larger than the given cap', () => {
    const bigLine = 'x'.repeat(5000)
    const content = ['<<<<<<< HEAD', bigLine, '=======', 'short', '>>>>>>> upstream/develop'].join(
      '\n'
    )
    const hunk = extractConflictHunks(content, 200)
    expect(hunk.length).toBeLessThan(250)
    expect(hunk).toContain('truncated')
  })
})

describe('fork-side anchors: a rule that rests on OUR tree goes stale when OUR tree moves (card a14812e8)', () => {
  const readReal = (file: string): string | null => {
    try {
      return readFileSync(join(REPO_ROOT, file), 'utf-8')
    } catch {
      return null
    }
  }

  // The one that matters: green on the tree as it is. A guard landing red would block every
  // marveen landing (card 368b77f7 measured exactly that), so this is not a formality.
  it('every declared anchor holds on the CURRENT tree', () => {
    const drifted = classifyForkAnchors(
      ACKNOWLEDGED_FORK_ANCHORS as Readonly<Record<string, ForkAnchor>>,
      readReal
    )
    expect(
      drifted.map(
        (d) =>
          `${d.file}: expected '${d.anchor.needle}' ${d.anchor.expect} in ${d.anchor.file}, ` +
          `found=${d.found}. WHY IT MATTERS: ${d.anchor.because} ` +
          `Re-decide the ACKNOWLEDGED_CONFLICTS rule -- do not just edit the anchor to match.`
      )
    ).toEqual([])
  })

  it('every anchor points at a file that actually exists -- a missing file is drift, not a pass', () => {
    for (const [, anchor] of Object.entries(ACKNOWLEDGED_FORK_ANCHORS)) {
      expect(readReal(anchor!.file), `anchor file missing: ${anchor!.file}`).not.toBeNull()
    }
  })

  it('a present-anchor whose needle is gone is drift', () => {
    const anchors = {
      'a.ts': { needle: 'touchAncestorChain', file: 'src/db.ts', expect: 'present', because: 'x' },
    } as const
    const drifted = classifyForkAnchors(anchors, () => 'nothing relevant here')
    expect(drifted).toHaveLength(1)
    expect(drifted[0]!.found).toBe(false)
  })

  it('a present-anchor whose needle is there is NOT drift', () => {
    const anchors = {
      'a.ts': { needle: 'touchAncestorChain', file: 'src/db.ts', expect: 'present', because: 'x' },
    } as const
    expect(classifyForkAnchors(anchors, () => 'export function touchAncestorChain() {}')).toEqual([])
  })

  // The inverse direction has to work too, or "expect: absent" would be a decorative field that
  // silently never fires -- the same class of defect this whole map exists to catch.
  it('an absent-anchor whose needle APPEARED is drift', () => {
    const anchors = {
      'a.ts': { needle: 'ollama_pull', file: 'install-linux.sh', expect: 'absent', because: 'x' },
    } as const
    const drifted = classifyForkAnchors(anchors, () => 'ollama_pull "nomic-embed-text"')
    expect(drifted).toHaveLength(1)
    expect(drifted[0]!.found).toBe(true)
  })

  // Measured, not assumed: this exact mutation went GREEN before containsAsToken existed.
  it('a RENAMED symbol is drift -- substring containment would have missed it', () => {
    const anchors = {
      'a.ts': { needle: 'touchAncestorChain', file: 'src/db.ts', expect: 'present', because: 'x' },
    } as const
    const drifted = classifyForkAnchors(anchors, () => 'export function touchAncestorChainRENAMED()')
    expect(drifted).toHaveLength(1)
  })

  it('containsAsToken matches on identifier boundaries, both sides', () => {
    expect(containsAsToken('call touchAncestorChain(id)', 'touchAncestorChain')).toBe(true)
    expect(containsAsToken('touchAncestorChainRENAMED()', 'touchAncestorChain')).toBe(false)
    expect(containsAsToken('xtouchAncestorChain()', 'touchAncestorChain')).toBe(false)
    // A later legitimate occurrence must still be found after an earlier glued one.
    expect(containsAsToken('preTouch touchAncestorChainX; touchAncestorChain()', 'touchAncestorChain')).toBe(true)
    // Needles that are not bare identifiers still work -- the boundary is about the edges only.
    expect(containsAsToken('def is_send_invocation(cmd):', 'def is_send_invocation')).toBe(true)
  })

  it('a missing FILE is drift for a present-anchor -- a rule resting on a deleted file is stale', () => {
    const anchors = {
      'a.ts': { needle: 'anything', file: 'gone.ts', expect: 'present', because: 'x' },
    } as const
    expect(classifyForkAnchors(anchors, () => null)).toHaveLength(1)
  })

  // Card a14812e8, measured: `ollama_pull` still appears once in install-linux.sh, inside a comment
  // saying the call was REMOVED. An anchor there would assert the comment and stay green forever for
  // the wrong reason. This pins the EXCLUSION so a future editor adding the obvious anchor trips
  // here and reads why, instead of shipping a check that cannot fail.
  it('installer-ollama-nonfatal deliberately has NO anchor, because its needle survives only in a comment', () => {
    expect(
      Object.prototype.hasOwnProperty.call(
        ACKNOWLEDGED_FORK_ANCHORS,
        'src/__tests__/installer-ollama-nonfatal.test.ts'
      )
    ).toBe(false)
    const installer = readReal('install-linux.sh') ?? ''
    // The measurement the exclusion rests on: the string is present, and only in prose.
    expect(installer).toContain('ollama_pull')
    const codeLines = installer
      .split('\n')
      .filter((l) => l.includes('ollama_pull') && !l.trimStart().startsWith('#'))
    expect(codeLines, 'ollama_pull reappeared in CODE -- the exclusion needs re-deciding').toEqual(
      []
    )
  })
})
