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
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { REPO_ROOT } from './helpers/repo-location.js'
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





// THE NETWORK CASE THAT USED TO LIVE HERE IS GONE, ON PURPOSE (card 5da60b85, parent 1f276349,
// MikroB decision 24642 direction "C"). It ran a live `git fetch upstream develop` and a real merge
// dry-run, from inside the vitest suite -- which IS the landing gate. So an upstream commit landing
// in the wrong minute blocked somebody else's unrelated landing.
//
// Measured from this file's own re-measure notes before the move: 41 "landing-block" mentions, 32
// re-measure rounds in five days (09-02: 3, 09-03: 9, 09-04: 1, 09-05: 5, 09-06: 14), five agents,
// eight cards, one card hit thirteen times. It then happened twice more DURING the landing of the
// fix itself, an hour apart, which is what settled the sequencing.
//
// The deeper reason is not the flakiness: a landing to `develop` does NOT merge upstream, so this
// check could never catch anything the landing might break. It reports that the WORLD moved, which
// is a monitoring signal, and monitoring belongs on a schedule (card a1ce8952).
//
// It now lives in src/fork-upstream/drift-check.ts, reading the same acknowledgement data this file
// reads, with its own hermetic tests. What stays here is everything that is about OUR tree and
// needs no network -- and that is most of it.


// Always runs, no network involved: pins BOTH states of metaAnnouncement() deterministically (card
// d359535c). The live META test above can only ever exercise whichever state this environment
// happens to be in right now -- these two cases are what actually prove the skip path produces a
// distinct, loud test name rather than silently reusing the armed one.

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

// The scan lives at the BOTTOM of this file, not the top, and that placement is the whole control.
// Cybersec and QA both measured the first version independently (card 5da60b85, comments 21593 and
// the QA FAIL beside it): the sentinel sat on line 65, immediately above the first `describe`, so
// the scanned region was the import header -- 65 lines, ZERO cases -- and all 24 real cases sat
// outside it. QA proved it live by appending a forbidden call below the sentinel and watching the
// whole suite stay green. A guard that cannot see its own subject is decoration.
describe('this file must never reach the network again (card 5da60b85)', () => {
  const SENTINEL = 'NETWORK-GUARD ' + 'SENTINEL'
  // Assembled from fragments so this list is not itself a hit. A predicate that matches its own
  // needles can only be "fixed" by weakening it -- that was the first version's failure.
  const FORBIDDEN = ['fet' + 'ch', 'ls-' + 'remote', 'mer' + 'ge(', 'execFile' + 'Sync']

  /** Which forbidden operations appear in `source`, ignoring what the prose merely NAMES. */
  function remoteGitCallsIn(source: string): string[] {
    // Comment-stripped: the prose above names every one of these operations, and a scan that
    // flagged its own explanation would be "fixed" by weakening the pattern (cards 06d36307,
    // 2f0c7d24).
    const code = source
      .split('\n')
      .map((l) => l.replace(/\/\/.*$/, ''))
      .join('\n')
    return FORBIDDEN.filter((needle) => code.includes(needle))
  }

  const whole = readFileSync(new URL(import.meta.url), 'utf-8')
  const scanned = whole.slice(0, whole.indexOf(SENTINEL))

  it('the sentinel exists exactly once, so the scan boundary cannot be quietly deleted', () => {
    // ONE occurrence, not two: the needle is assembled from fragments above, so neither that line
    // nor this one matches itself. Asserting the count is what proves the fragmentation held.
    expect(whole.split(SENTINEL).length - 1, 'the sentinel that bounds this scan must exist exactly once').toBe(1)
  })

  it('THE GUARD CAN SEE ITS SUBJECT: the scan covers EVERY case in this file', () => {
    // This is the assertion whose absence made the first version vacuous. It is deliberately an
    // EQUALITY against the whole-file count, not a floor: a floor does not discriminate. Measured
    // while writing this -- the first attempt asserted `> 20` cases in the scanned region, and
    // moving the sentinel back to its old spot (immediately above this describe) still left more
    // than twenty cases above it, because this block sits at the bottom. The mutation survived. A
    // uniform result across both positions means the bench is not measuring the thing.
    //
    // Equality pins it exactly: the sentinel may sit below the last case and nowhere else.
    const marker = 'i' + 't('
    const inScan = scanned.split(marker).length - 1
    const inFile = whole.split(marker).length - 1
    expect(inScan, 'this file must actually contain cases, or the equality below is vacuous').toBeGreaterThan(20)
    expect(inScan, 'the sentinel must sit BELOW the last case, or the scan misses what it guards').toBe(inFile)
  })

  it('no case in this file performs a remote git operation', () => {
    // Without this, the network case removed above could be reintroduced by one edit and nobody
    // would notice until landings started blocking on upstream again.
    expect(remoteGitCallsIn(scanned), 'the network half lives in the drift checker, not here').toEqual([])
  })

  it('REGRESSION: the scan FAILS on a case that does reach the network', () => {
    // The point Cybersec made: a guard that is green on a corpus containing the very thing it
    // forbids is not a guard. The forbidden token is assembled at RUNTIME, so this fixture does not
    // put a contiguous match into this file's own source and cannot make the case above red.
    const fixture = [
      "describe('a future edit that brings the network back', () => {",
      // The title deliberately avoids the word itself: the needles match as plain SUBSTRINGS, so
      // "fetches" is a hit too. That is the correct side to err on in a DENY matcher -- refusing to
      // match is permitting -- and it is not theoretical: the first run of this corrected guard went
      // red on THIS very line, which is the proof it now sees a region the old one never scanned.
      "  it('pulls from the remote', async () => {",
      '    await ' + 'fet' + 'ch' + "('https://example.invalid')",
      '  })',
      '})',
    ].join('\n')
    expect(remoteGitCallsIn(fixture)).toEqual(['fet' + 'ch'])
  })

  it('REGRESSION: a forbidden operation named only in a COMMENT is not a hit', () => {
    // The other direction, and the reason for the comment-stripping: this file's own prose says
    // "git fetch upstream develop" several times while describing what was removed. If those
    // counted, the only way to keep the guard green would be to soften the pattern.
    const fixture = '// this used to run a git ' + 'fet' + 'ch' + ' upstream develop\nconst x = 1'
    expect(remoteGitCallsIn(fixture)).toEqual([])
  })
})

// ---- NETWORK-GUARD SENTINEL: everything ABOVE this line is scanned by the guard -------------
