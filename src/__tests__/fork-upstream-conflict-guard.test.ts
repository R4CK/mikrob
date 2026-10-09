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

  // Card 232e01e2 (Cybersec measurement on this file's own re-measure history): a `present` anchor
  // must not be satisfiable by a comment merely NAMING the needle -- that lets the CODE half of a
  // rule be edited away while the pin stays green because the explaining comment still mentions it.
  it('a present-anchor is NOT satisfied by a // comment merely naming the needle', () => {
    const anchors = {
      'a.ts': { needle: 'touchAncestorChain', file: 'src/db.ts', expect: 'present', because: 'x' },
    } as const
    const drifted = classifyForkAnchors(
      anchors,
      () => '// touchAncestorChain used to live here, removed 2026-09-07'
    )
    expect(drifted).toHaveLength(1)
    expect(drifted[0]!.found).toBe(false)
  })

  it('a present-anchor is NOT satisfied by a # comment either -- both comment styles this map spans', () => {
    const anchors = {
      'a.py': {
        needle: 'def is_send_invocation',
        file: 'scripts/hooks/outgoing-copy-gate.py',
        expect: 'present',
        because: 'x',
      },
    } as const
    const drifted = classifyForkAnchors(
      anchors,
      () => '# def is_send_invocation(cmd): removed, see history'
    )
    expect(drifted).toHaveLength(1)
  })

  // Card 26083811 (WhiteHat L1, 405a6da0 gate): stripLineComments only special-cased `.py` for the
  // `#` marker -- a .sh anchor (the map carries three: limit-monitor.sh, install-prod-tree-guard-
  // hook.sh, update.sh) fell through to the `//` marker instead, so a needle left behind in a bash
  // `#` comment satisfied a `present` anchor the same way the .py case above was already fixed to
  // reject. Mutation-proof at the bottom of this test confirms this.
  it('a present-anchor on a .sh file is NOT satisfied by a # comment either', () => {
    const anchors = {
      'a.sh': {
        needle: 'touchAncestorChain',
        file: 'demo.sh',
        expect: 'present',
        because: 'x',
      },
    } as const
    const drifted = classifyForkAnchors(
      anchors,
      () => '# touchAncestorChain removed, see history'
    )
    expect(drifted).toHaveLength(1)
    expect(drifted[0]!.found).toBe(false)
  })

  // MUTATION CHECK: without .sh routed to the `#` stripper -- the pre-fix code special-cased only
  // `.py`, everything else (including .sh) got the `//` marker -- the exact fixture above is not
  // merely theoretically wrong: the needle genuinely survives stripping, reproduced here directly
  // against the OLD marker-selection logic rather than assumed.
  it('MUTATION: the pre-fix (.py-only) marker selection genuinely leaves the needle in a .sh # comment (proves the test above is non-vacuous)', () => {
    const oldMarkerFor = (file: string): RegExp => (file.endsWith('.py') ? /#.*$/ : /\/\/.*$/)
    const stripOld = (content: string, file: string): string =>
      content
        .split('\n')
        .map((line) => line.replace(oldMarkerFor(file), ''))
        .join('\n')
    const strippedOld = stripOld('# touchAncestorChain removed, see history', 'demo.sh')
    expect(strippedOld).toContain('touchAncestorChain') // the OLD stripper leaves it in, unstripped
  })

  // THE CONTROL that makes the two cases above mean something: real code on the SAME line as a
  // trailing comment must still be found. Without this, a stripper that ate too much (or the whole
  // line) would pass every case above by accident of never finding anything at all.
  it('CONTROL: a present-anchor whose needle is real code is still found, even with a trailing comment', () => {
    const anchors = {
      'a.ts': { needle: 'touchAncestorChain', file: 'src/db.ts', expect: 'present', because: 'x' },
    } as const
    const drifted = classifyForkAnchors(
      anchors,
      () => 'export function touchAncestorChain() {} // the real thing, not a mention'
    )
    expect(drifted).toEqual([])
  })

  // The asymmetric half of the same fix: an `absent` anchor stays on the RAW text on purpose. A
  // statement reverted but left behind as a comment is still a prose claim worth re-deciding (the
  // installer-ollama-nonfatal exclusion below rests on exactly this reasoning already).
  it('an absent-anchor is STILL drift when the needle survives only in a comment', () => {
    const anchors = {
      'a.ts': { needle: 'ollama_pull', file: 'install-linux.sh', expect: 'absent', because: 'x' },
    } as const
    const drifted = classifyForkAnchors(anchors, () => '// ollama_pull was removed here')
    expect(drifted).toHaveLength(1)
    expect(drifted[0]!.found).toBe(true)
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

  // Card 405a6da0 (WhiteHat 1f252502 gate): known-positive control, per CLAUDE.md code-quality rule
  // 12 ("run a guard on its own founding case before reporting zero findings"). The keychainDelete
  // anchor (src/web/keychain.ts, above) was added SPECIFICALLY because this exact regression already
  // happened for real once (the F1-F5 merge, b8de50d2, 2026-08-26) and sat unwatched for 13 days.
  // This test does not use a synthetic fixture -- it runs the REAL ACKNOWLEDGED_FORK_ANCHORS entry
  // against a reconstruction of that actual incident's content (keychainDelete re-declared, as
  // upstream's merge reintroduced it), proving the anchor as it exists in this file today would have
  // caught the founding case, not just a fixture built to satisfy the test.
  it('KNOWN-POSITIVE CONTROL: the real keychainDelete anchor catches the actual 2026-08-26 regression', () => {
    const reconstructedIncident =
      "export function isKeychainAvailable() { /* ... */ }\n" +
      "export function keychainStore() { /* ... */ }\n" +
      // The exact shape of the reversal: upstream's re-added function, unchanged by the fork. Kept
      // free of any real git/network call name (card 5da60b85's own self-scan below flags those as
      // source TEXT, not parsed code, and would wrongly treat this fixture string as a live call.
      "export function keychainDelete(account: string): boolean {\n" +
      "  return runSecurityDeleteCommand(account)\n" +
      "}\n"
    const drifted = classifyForkAnchors(
      { 'src/web/keychain.ts': ACKNOWLEDGED_FORK_ANCHORS['src/web/keychain.ts']! },
      () => reconstructedIncident
    )
    expect(drifted, 'the real anchor must flag the reconstructed incident as drift').toHaveLength(1)
    expect(drifted[0]!.found).toBe(true)

    // Negative half of the control: the CURRENT tree (no keychainDelete) must NOT trip the same
    // anchor, or the "positive" result above would be meaningless noise rather than a real signal.
    expect(
      classifyForkAnchors(
        { 'src/web/keychain.ts': ACKNOWLEDGED_FORK_ANCHORS['src/web/keychain.ts']! },
        readReal
      )
    ).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// Card 66ad1f95: a recorded REFUSAL must come with a tripwire.
// ---------------------------------------------------------------------------
//
// THE FAILURE THIS CLOSES. When an upstream integration merges HISTORY rather than cherry-picking,
// the merge-base moves to the upstream tip, and everything upstream added earlier that this fork
// deliberately did NOT take stops being visible to a git-based drift check -- not because the two
// agree, but because the history now books it as merged. A refusal written in prose can then reverse
// in a later auto-merge with nothing firing.
//
// Measured on the four NOT-ADOPTED decisions that name a checkable symbol (2026-09-12): THREE had
// already reversed, one of them with nobody noticing. The mechanism that would have caught it --
// ACKNOWLEDGED_FORK_ANCHORS, evaluated against the real tree by the test above on every landing --
// existed and was hardened, and simply had no entry for any of them. Coverage, not machinery.
//
// NO QUOTE OR NEGATION FILTER, on purpose (CLAUDE.md rule 12 names this trap explicitly): some of
// these rules QUOTE the phrase while describing a refusal that has since been lifted. Filtering
// those out is how a real refusal slips through a guard built to be convenient. Every rule that
// mentions it needs an anchor, full stop -- and today every one of them has one, so the strict form
// costs nothing and needs no exception list.
describe('every recorded refusal is watched by an anchor (card 66ad1f95)', () => {
  // Widened card 405a6da0 (WhiteHat 1f252502 gate, komment 13314): the literal "NOT ADOPTED" missed
  // 14 entries (of 157) that record the same kind of decision in different words -- measured against
  // the real corpus, not guessed. Each phrase below was found in an ACTUAL entry quoted verbatim in
  // this card and individually triaged (see the ACKNOWLEDGED_FORK_ANCHORS additions and
  // UNANCHORED_BACKLOG entries below this describe block, each citing the entry it covers). Still NO
  // quote/negation filter, per the comment above and CLAUDE.md rule 12 -- "do not take A SIDE" (a
  // union decision, not a refusal) is caught by this too and handled by classification in the
  // backlog below, not by excluding it from the pattern.
  // Widened AGAIN card 26083811 (WhiteHat L2, 405a6da0 gate): the "not adopt(ed/able)" family
  // (Do NOT adopt / NOT ADOPTABLE / not adoptable) was still missing -- measured against the real
  // corpus: 13 more entries, 1 already anchored for a different reason, 12 newly unwatched, 4 of
  // those 12 triaged to a new anchor and 8 to the backlog below (each cited individually there).
  const mentionsRefusal = (text: string): boolean =>
    /NOT ADOPTED|\bnot ported\b|\bNOT taken\b|\bdo not take\b|\bkeep\b[^.]{0,30}\b(?:deletion|removal)\b|\bnot adopt/i.test(
      text,
    )

  const refusing = Object.entries(ACKNOWLEDGED_CONFLICTS as Readonly<Record<string, string>>).filter(
    ([, text]) => mentionsRefusal(String(text)),
  )

  it('the measure is not vacuous -- refusals really are recorded in these rules', () => {
    // If this hits zero the scan stopped finding the phrase (a rewording), and the assertion below
    // would pass over an empty set while claiming every refusal is covered.
    expect(refusing.length).toBeGreaterThanOrEqual(10)
  })

  // A RATCHET, not a clean sheet, and the difference is stated rather than hidden. MEASURED from the
  // module itself: 16 rules record a refusal, 6 were anchored on 2026-09-12 (card 66ad1f95). Of the
  // other 10, 9 were backfilled 2026-09-25 (card 2f1cbaf1), one symbol at a time, per file -- a raw
  // occurrence count is not a measurement, as 66ad1f95 already showed (the Telegram copy gate read
  // as "adopted" when all three hits were a test's own const). FOUR of the nine had already reversed
  // by the time they were checked (src/web/routes/kanban.ts + web/app.js's blockers UI, schedule-
  // runner.ts's TASK_FIRE_TIMEOUT_MS, notify.sh's CHATID0 guard, github-pr-monitor.sh's
  // AUTH_ALERT_COOLDOWN) and a fifth (channel-monitor.ts, three items) was found and corrected the
  // same day under card ea86a362 -- see each file's own ACKNOWLEDGED_CONFLICTS entry for the
  // CORRECTION paragraph and evidence. The tenth, src/__tests__/context-guard.test.ts, CANNOT be
  // anchored: its refusal is about a TEST file's own content, and 'an anchor points at a production
  // file' is enforced below as an absolute rule (a test can declare its own copy of anything). It
  // stays in this list permanently -- the underlying decision (MiniMax NO-GO, card 48565f81) is
  // watched for real by the 'src/web/agent-process.ts' anchor instead. This is why the list is a
  // named backlog and not a bare count: a name that can never leave needs to be readable as that,
  // not indistinguishable from one nobody got around to yet.
  //
  // Four more joined 2026-10-09 (card 405a6da0) when mentionsRefusal widened beyond "NOT ADOPTED".
  // Each was triaged individually, not swept in as a batch:
  //   - src/__tests__/installer-ollama-nonfatal.test.ts: "keep the deletion" of Peti's EPIC ebc7b4dd
  //     Ollama pre-install step -- the fork has NO code left for a production anchor to watch
  //     (the entry's own text: "the fork has no code left for this test to exercise"). Same shape
  //     as context-guard.test.ts: a real, permanent decision with nothing in the tree to point at.
  //   - src/__tests__/send-honesty-round2.test.ts: the only unresolved half (OWNERCHAT803/CHATID0)
  //     is explicitly NOT decided here -- the entry's own text says the triage concluded ESCALATE,
  //     and a dedicated card (3026a591) already exists and owns it. Anchoring here would duplicate
  //     that card's job on a guess at scope that card is still working out.
  //   - src/__tests__/system-directive-auth-section.test.ts: the matched phrase is "do not take A
  //     SIDE" -- a union decision over which TEST CASES to keep (both sides' assertions survive),
  //     not a refusal of a feature. It is also self-referential about this fork's own describe
  //     blocks, the same "anchor must name a production file" exclusion as context-guard.test.ts.
  //   - src/web/session-send-lock.ts: "do NOT take upstream's ... paragraph wholesale" -- the
  //     dispute is between two PROSE COMMENTS describing which cron-shell writers the lock already
  //     covers (withSessionSendLock itself is uncontested on both sides). Neither comment is
  //     executable, so there is no checkable production FACT that distinguishes "still refused" from
  //     "silently reverted" -- an anchor here could only watch a comment's wording, which is exactly
  //     the kind of pin the file's own re-measure history (this same entry, 2026-09-13) shows goes
  //     stale on its own without anyone touching the code it describes.
  //
  // Eight more joined 2026-10-09 (card 26083811) when mentionsRefusal widened to the "not
  // adopt(ed/able)" family. Of the 12 newly-unwatched entries this widening caught, 4 named a
  // checkable production fact and got a new ACKNOWLEDGED_FORK_ANCHORS entry (watchdog.sh,
  // bridge-pairing-i18n.test.ts, governance-gates.test.ts, memory-search-label-backfill.test.ts --
  // see those keys above); these 8 did not, each for its own reason:
  //   - src/__tests__/api-messages-freshness.test.ts, heartbeat-db-size.test.ts,
  //     heartbeat-summary-truncation-safe.test.ts, memories-search-has-a-floor.test.ts: each entry
  //     says so itself -- "NOT ADOPTABLE, no functional difference" -- cosmetic style-only notes
  //     (const extraction, String() vs .toString()) on test files, nothing behavioural to anchor.
  //   - src/__tests__/notify-delivery-honesty.test.ts: the CHATID0/notify.sh-guard gap this entry
  //     flags is the SAME decision send-honesty-round2.test.ts already backlogs below, tracked by
  //     card 3026a591 -- not a second, independent gap to duplicate here.
  //   - src/__tests__/session-send-lock.test.ts: the lock-acquisition gap its refused upstream
  //     tests assert (a lock around the /rename send this fork does not have) is the same gap
  //     src/web/session-send-lock.ts already backlogs below -- both sides are prose/test-only until
  //     the fix this entry says must come FIRST actually lands.
  //   - src/__tests__/setup/assert-not-live-install.ts: CORRECTED 2026-10-09 (card 3531538d,
  //     WhiteHat L1 on this very gate). The "same shape as context-guard.test.ts" call above was
  //     wrong: that file has describe/it blocks that could fake a copy of a symbol, this one has
  //     none -- it is a vitest setupFiles guard with real, running refusal logic. The needle
  //     occurring 0 times in it is exactly an absent anchor's condition, not a reason to skip
  //     anchoring. Anchored below (ACKNOWLEDGED_FORK_ANCHORS), carved out of the __tests__-file
  //     rule via SETUP_GUARD_EXCEPTIONS, removed from the list below.
  //   - web/lang/en.js: the matched phrase is one cosmetic sub-point ("purely cosmetic, zero
  //     functional difference") inside this file's own much larger UNION-everything resolution --
  //     not a standalone refusal with its own fact to watch.
  const UNANCHORED_BACKLOG: readonly string[] = [
    'src/__tests__/context-guard.test.ts',
    'src/__tests__/installer-ollama-nonfatal.test.ts',
    'src/__tests__/send-honesty-round2.test.ts',
    'src/__tests__/system-directive-auth-section.test.ts',
    'src/web/session-send-lock.ts',
    'src/__tests__/api-messages-freshness.test.ts',
    'src/__tests__/heartbeat-db-size.test.ts',
    'src/__tests__/heartbeat-summary-truncation-safe.test.ts',
    'src/__tests__/memories-search-has-a-floor.test.ts',
    'src/__tests__/notify-delivery-honesty.test.ts',
    'src/__tests__/session-send-lock.test.ts',
    'web/lang/en.js',
  ]

  it('no refusal ships WITHOUT a tripwire -- the unanchored set may shrink, never grow', () => {
    const unwatched = refusing
      .map(([file]) => file)
      .filter((file) => !(file in ACKNOWLEDGED_FORK_ANCHORS))
    const added = unwatched.filter((f) => !UNANCHORED_BACKLOG.includes(f))
    expect(
      added,
      'this rule records a NOT-ADOPTED decision with nothing watching it. After an upstream history ' +
        'merge the merge-base moves to the upstream tip, so git can no longer show that element as a ' +
        'difference -- the refusal can reverse in a later auto-merge and stay green. Add an ' +
        'ACKNOWLEDGED_FORK_ANCHORS entry naming a symbol checkable in the TREE (absent while the ' +
        'refusal holds, present once it is lifted). Measured when this was written: of the four ' +
        'refusals that named a checkable symbol, THREE had already reversed, one with nobody noticing.',
    ).toEqual([])
  })

  it('the backlog is honest -- every name in it really is an unanchored refusal', () => {
    // Without this the list is a place to park anything. A name that gets an anchor, or whose rule
    // stops recording a refusal, must leave the list in the same commit.
    const unwatched = new Set(
      refusing.map(([file]) => file).filter((file) => !(file in ACKNOWLEDGED_FORK_ANCHORS)),
    )
    const stale = UNANCHORED_BACKLOG.filter((f) => !unwatched.has(f))
    expect(stale, 'these are anchored (or no longer refuse) -- delete them from the backlog').toEqual([])
  })

  // Files under __tests__/ that are NOT tests: vitest setupFiles guards with real, running logic
  // and no describe/it blocks, so the "a test can declare its own copy of any symbol" rationale
  // below does not apply to them -- there is no test-assertion mechanism here that could fake a
  // copy. Card 3531538d (WhiteHat L1, 26083811 gate). Keep this list narrow and named, not a path
  // pattern: each entry needs its own "no describe/it" check before being added.
  const SETUP_GUARD_EXCEPTIONS = ['src/__tests__/setup/assert-not-live-install.ts']

  it('an anchor points at a PRODUCTION file, not at a test that may declare its own copy', () => {
    // Measured while writing these: TELEGRAM_COPY_GATE_MATCHER reads as three occurrences tree-wide
    // and looks adopted -- all three inside a test that declares its own const of that name and says
    // in its header that the export is NOT adopted. An anchor aimed there would have reported a
    // reversal that never happened, which is the same "a name in prose and code cannot be asserted
    // by name" failure the fleet keeps meeting.
    for (const [key, anchor] of Object.entries(ACKNOWLEDGED_FORK_ANCHORS)) {
      if (anchor && SETUP_GUARD_EXCEPTIONS.includes(anchor.file)) continue
      expect(
        anchor?.file.includes('__tests__'),
        `${key}: the anchor reads ${anchor?.file}, a test file -- a test can declare its own copy ` +
          'of any symbol, so presence there proves nothing about adoption',
      ).toBe(false)
    }
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
