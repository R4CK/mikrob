// Card 711a7e57: every store/*.selftest.sh actually RUNS.
//
// EXTENDED TO `.selftest.py` (card 2003e04b). The discovery this file introduced closed the hole for
// shell selftests and left the identical one open next to it: the glob matched `.selftest.sh` only,
// so BOTH of the repo's `store/*.selftest.py` files -- gate-closure-check and
// pentest-tool-egress-proxy -- were referenced by nothing and had never executed in the suite. That
// is the same "written, committed, green-looking, never run" class the card above was opened for,
// one file extension over, and it was found while changing gate-closure-check.py: its only control
// was a selftest nothing invoked. Discovery now keys on the interpreter each script needs.
//
// THE DEFECT. Measured on this repo 2026-09-04: of 13 `store/*.selftest.sh`, EIGHT were referenced
// by nothing at all — local-llm-bench-lock, -hwdetect, -model-routing, -parallel-bench, -platform,
// -tune-decide, -tune-sweep, and offload-dispatch. They are written, committed, and green-looking
// controls that had never executed once, because wiring a selftest meant remembering to hand-write
// a vitest file for it and nobody remembers on the busy day. Same class as the unwired hook and the
// never-called guard this fleet has now found several times in one day.
//
// WHY DISCOVERY AND NOT EIGHT WRAPPERS. The card asked for a thin wrapper per script, and eight
// wrappers would have fixed these eight — while leaving the NINTH orphaned the moment somebody adds
// it. The card's own text names the real cause: "nincs auto-felfedezes, minden selftest kulon
// vitest-fajlt igenyel". So this file discovers the glob instead. A new `store/<x>.selftest.sh` is
// wired the moment it lands, with nothing to remember.
//
// The five that already had their own test file keep it: those assert script-specific invariants
// this file cannot (skills-symlink-realdir pins `rm` before `mv`, for instance). Re-running them
// here costs ~29s and buys not having to maintain a "who else already wires this" list — the exact
// bookkeeping that goes stale and then silently un-covers something.
//
// COST, measured rather than estimated: 77s for all 13 sequentially. vitest runs test FILES in
// parallel, so inside a suite whose wall-clock is already ~80-100s this file largely hides.
//
// EXTENDED AGAIN to MODE-CARRIED selftests (card 453af053, parent ee2d6220). The `.selftest.`
// filename-suffix discovery above is structurally blind to a script whose selftest is an ARGUMENT
// instead (`<script> selftest` / `<script> --selftest`) -- the exact same "never run" class, one
// naming convention over. See MODE_SELFTESTS below for the registry (necessarily hand-kept, since
// there is no filename signal to discover from) and its own comment for the measurement behind it.
import { describe, it, expect } from 'vitest'
import { execFileSync } from 'node:child_process'
import {
  readdirSync,
  readFileSync,
  readlinkSync,
  writeFileSync,
  mkdtempSync,
  mkdirSync,
  chmodSync,
  rmSync,
} from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

const REPO_ROOT = join(import.meta.dirname, '..', '..')
const STORE = join(REPO_ROOT, 'store')

// Card 99a4a2d4 (WhiteHat F1 on ff7e1b0a, comment 6640): the EXISTING static detector
// (selftests-do-not-mutate-the-shared-tree.test.ts) matches destructive commands by NAME/SHAPE --
// a hand-picked `^\s*(mv|rm|ln|truncate|chmod)` pattern plus a hand-kept list of own-directory
// anchor variable names (HERE/ROOT/SCRIPT/SCRIPT_DIR/G). Measured live: 5 shapes all delete or
// overwrite a tracked file in the shared tree while that detector stays 56/56 green -- a
// non-line-start command (`true && rm ...`), `sed -i`, a `: >` redirect-truncate, `cp /dev/null`,
// and `rm "$(dirname "$0")/..."` (no anchor variable at all). A name/shape detector can only ever
// narrow this class, never close it (the next unnamed anchor or the next sed/cp/redirect variant is
// just as invisible). This is the DYNAMIC, name-independent layer WhiteHat asked for: compare the
// tracked-file git status of the tree BEFORE and AFTER each selftest runs, and fail loudly, naming
// the selftest, if the AFTER state contains an entry the BEFORE state did not -- regardless of which
// command or which variable name produced it. `--untracked-files=no` deliberately excludes new,
// never-committed scratch files a selftest creates under the tree (those are not "the shared fan"
// WhiteHat's finding is about); only a TRACKED file becoming modified/deleted counts.
function trackedDirtySet(repoRoot: string): ReadonlySet<string> {
  const out = execFileSync('git', ['-C', repoRoot, 'status', '--porcelain', '--untracked-files=no'], {
    encoding: 'utf-8',
  })
  return new Set(out.split('\n').filter((line) => line.length > 0))
}

// Scoped to THIS selftest's own window (WhiteHat's own caution, comment 6640): a concurrent landing
// on the same shared test tree can leave the tree dirty for reasons that have nothing to do with the
// selftest under test. Blaming the selftest for a dirty entry that was ALREADY present before it ran
// would misattribute that noise; only an entry that is new in `after` is this selftest's own doing.
function newlyDirty(before: ReadonlySet<string>, after: ReadonlySet<string>): string[] {
  return [...after].filter((line) => !before.has(line))
}

// RedHat NO-GO K1 (card 99a4a2d4 delta, comment 23762): the first version of this guard had
// trackedDirtySet/newlyDirty exercised ONLY by the real it.each loop below and by a SEPARATE set of
// fixture tests that called those two helpers directly -- proving the helpers work, not that the
// real runner still calls them. Deleting the guard's assertion from the it.each body (W1), or moving
// the "before" snapshot to after the selftest ran (W2), left every test in the file green, because
// nothing but the loop itself exercised that wiring. This function is the ONE place both the real
// loop and the fixture tests now call, so a future edit that breaks the wiring breaks both at once.
// Throws (rather than returning a boolean) so `expect(() => ...).toThrow()` reads the same in a
// fixture test as an uncaught throw failing a real `it.each` case.
// Card 445e9515 (RedHat N1 on the 99a4a2d4 delta, comment 23840): runGuardedSelftest's own body was
// pinned (above), but its CALL SITE in the real it.each loop below was not -- if that loop reverted
// to calling execFileSync directly (W3), the separate fixture tests further down still call
// runGuardedSelftest themselves and would stay green, hiding the regression. This counter is read by
// a dedicated test placed right after the it.each loop, before any fixture test runs, so it only
// counts calls the real loop made.
let guardedCallCount = 0

function runGuardedSelftest(repoRoot: string, runner: string, file: string, args: readonly string[] = []): string {
  guardedCallCount++
  const store = join(repoRoot, 'store')
  const before = trackedDirtySet(repoRoot)
  const out = execFileSync(runner, [join(store, file), ...args], {
    encoding: 'utf-8',
    timeout: 180_000,
    // Inherit nothing that could make a selftest take a different path than it does by hand.
    env: process.env,
  })
  const dirtied = newlyDirty(before, trackedDirtySet(repoRoot))
  if (dirtied.length > 0) {
    throw new Error(
      `${file} left the shared tracked tree dirty (card 99a4a2d4): ${dirtied.join(', ')}. ` +
        `A selftest may read the shared tree freely, but must not modify or delete a tracked ` +
        `file in it -- write to a disposable copy/mktemp sandbox instead.`,
    )
  }
  return out
}

/**
 * Selftests this file deliberately does NOT run, each with the reason.
 *
 * Kept deliberately tiny and asserted below: an exclusion list is a place where a control quietly
 * stops covering something, so every entry has to earn its line and has to still exist.
 */
const EXCLUDED: Readonly<Record<string, string>> = {
  'route-classify':
    'Needs a live local model: with none answering it prints "SKIP: no local model answering" and ' +
    'runs ZERO cases by design (its own documented first-run behaviour). Wiring it here would ' +
    'either hard-fail on every machine without Ollama warm, or -- worse -- teach OK_SHAPES to ' +
    'accept a SKIP as a pass, which is exactly the "green but never ran" reading this whole file ' +
    'exists to prevent. It is not unwired: store/route-classify.sh and store/local-llm-rag.sh both ' +
    'reference it, and it runs by hand against a live model. Card 0ebeff55.',
  // Empty, and that is the point of card 89f4c28d.
  //
  // local-llm-model-routing used to live here: it swapped `store/local-llm-model-routing.json` --
  // "this IS the file the running fleet uses", said its own comment -- out and back under a cleanup
  // trap that does not survive SIGKILL, while this suite runs during landings, which get killed.
  // Rather than leave a written control permanently unrun, local-llm.sh now honours
  // LOCAL_LLM_MODEL_ROUTING_FILE and the selftest points at a temp file, so it joined the list.
  // Verified by checksum: the live config is byte-identical before and after the run.
  //
  // The shape stays because the next unsafe-to-wire selftest should land HERE with its reason,
  // rather than quietly not being wired at all -- which is the failure this whole file exists for.
}

/** Suffix -> the interpreter that runs it. Adding a language here wires every existing script in
 *  it at once, which is the whole point of discovering rather than hand-writing wrappers. */
const RUNNERS: ReadonlyArray<readonly [string, string]> = [
  ['.selftest.sh', 'bash'],
  ['.selftest.py', 'python3'],
]

/**
 * store/ scripts that carry their selftest as a MODE (an argument), not a `.selftest.` filename
 * suffix -- so `discover()` below is structurally blind to them, the exact gap card 453af053
 * (parent ee2d6220) was opened for: 10 such scripts were found by stripping comments and matching
 * literal invocations (`<script> selftest` / `<script> --selftest`) rather than filenames, so a
 * renamed variable or a mid-file mention could not inflate the count the way a naive grep did once
 * (redispatch-guard.sh showed as "referenced" when it was only mentioned in a comment).
 *
 * MEASURED IN A DISPOSABLE CHECKOUT (2026-09-07, per this card's own explicit caution -- a selftest
 * in this repo has swapped a live config file out from under the running fleet before,
 * local-llm-model-routing, see EXCLUDED above), never the main clone: all 9 candidates from the
 * 09a3d52a discovery, minus redispatch-guard.sh (already wired by that card) and minus
 * cleancore-branch-drift-monitor.sh (a FALSE POSITIVE in the original discovery -- its only
 * "selftest" occurrence is a comment describing a LESSON LEARNED from a different script's incident;
 * it has no selftest mode at all, confirmed by reading its full argument-parsing case statement).
 * The remaining 8 all PASS, non-vacuously (real case counts, not an empty loop) -- so there is no
 * "red" list for this measurement; nothing needs a follow-up card.
 */
const MODE_SELFTESTS: ReadonlyArray<{ file: string; args: readonly string[] }> = [
  { file: 'agent-skill-drift-sync.sh', args: ['selftest'] },
  // Added by card 5acd21ea, and the reason is the same class this file exists for: BOTH of these
  // carried a working `--selftest` that NOTHING invoked. cleancore-pregate.sh had 5 cases and
  // cleancore-tsc-lib.sh its own, written, committed, green-looking, never executed in a suite --
  // found while fixing a pre-gate bug that made the tool report PRE-GATE CLEAN on a red branch.
  // An unrun control is exactly how that bug survived: the gate tool's own regression cases could
  // not have caught it, because they never ran.
  { file: 'mopsion-pregate.sh', args: ['--selftest'] },
  { file: 'mopsion-tsc-lib.sh', args: ['--selftest'] },
  { file: 'context-compact-monitor.sh', args: ['--selftest'] },
  { file: 'gate-dispatch-check.sh', args: ['selftest'] },
  { file: 'git-object-integrity-monitor.sh', args: ['--selftest'] },
  { file: 'live-tree-freshness.sh', args: ['--selftest'] },
  { file: 'migration-number-check.sh', args: ['selftest'] },
  { file: 'store-watch-exclusions.sh', args: ['selftest'] },
  { file: 'sync-agent-templates.sh', args: ['selftest'] },
  // Added by card 576b072e while fixing the ARCHIVED/ORPHAN misclassification bug: this script's
  // own --selftest is exactly the kind of check the bug fix needed (both directions of "card missing
  // from the bulk list" told apart), so it would be the same class of unrun control this file exists
  // to close if left out of this list.
  { file: 'unlanded-branch-sweep.sh', args: ['--selftest'] },
  // Found unwired while touching this file for card 85521c7e F2 (skill_roots() scope expansion):
  // its OWN OK_SHAPES entry ("vendored-skill-integrity style") already existed above, anticipating
  // exactly this registration, but nothing ever added the file -- the identical "written, committed,
  // green-looking, never run" class this whole discovery mechanism exists to close, one script over.
  { file: 'vendored-skill-integrity.py', args: ['--selftest'] },
  // Added by card 165350f1, new this card: carries its selftest as an argument (like its sibling
  // bump-fork-version.sh), so the filename-suffix discovery above is structurally blind to it --
  // wiring it here at birth is exactly what this file exists to make unnecessary to remember.
  { file: 'bump-upstream-version.sh', args: ['--selftest'] },
  // bump-fork-version.sh's OWN --selftest was never wired here either -- found while adding its
  // new sibling above, the identical "written, committed, green-looking, never run" class this
  // file exists for, one script over.
  { file: 'bump-fork-version.sh', args: ['--selftest'] },
  // Card 49b9e7d0 (RedHat N1): the fail-closed arg-parsing selftest was only ever run by hand --
  // nothing in the suite invoked it, so a regression in the parser or in the subprocess-isolation
  // helper (the same F-RH-Q1 class this card's delta fixed) could land unnoticed. The selftest is
  // self-contained (every case writes to a mktemp dir, never to the live store) and safe to run
  // under execFileSync's inherited env.
  { file: 'quota-shutdown-guard.sh', args: ['--selftest'] },
]

/** True iff `file` is a same-directory SYMLINK ALIAS of another file already in `files` -- e.g. the
 *  card 647ea02a rebrand's compat symlinks (cleancore-land.sh -> mopsion-land.sh). Such a file is not
 *  an independently-authored script: running it is byte-for-byte the same test as its target, so
 *  counting it as a SEPARATE discovered entry double-runs one script under two names (measured, card
 *  647ea02a: two names binding the identical hardcoded port collided as if two different selftests
 *  shared it). Only a direct, single-hop, same-directory link is recognized -- anything else (an
 *  absolute target, a target outside STORE) is treated as a real, independent file so this cannot
 *  silently swallow a script this narrow check was not designed for. */
function isAliasOfSibling(file: string, files: readonly string[]): boolean {
  let target: string
  try {
    target = readlinkSync(join(STORE, file))
  } catch {
    return false // not a symlink
  }
  return !target.includes('/') && target !== file && files.includes(target)
}

function discover(): Array<{ name: string; file: string; runner: string; args: readonly string[] }> {
  const files = readdirSync(STORE)
  const bySuffix = RUNNERS.flatMap(([suffix, runner]) =>
    files
      .filter((f) => f.endsWith(suffix) && !isAliasOfSibling(f, files))
      .map((f) => ({ name: f.slice(0, -suffix.length), file: f, runner, args: [] as readonly string[] })),
  )
  const byMode = MODE_SELFTESTS.map((s) => ({
    // Every prior entry was a .sh, so this always resolved to 'bash' -- silently wrong for the
    // first .py entry (vendored-skill-integrity.py, card 85521c7e F2), which would otherwise run
    // as `bash vendored-skill-integrity.py --selftest` and fail on the first Python import line.
    name: s.file.replace(/\.(sh|py)$/, '') + ' ' + s.args.join(' '),
    file: s.file,
    runner: s.file.endsWith('.py') ? 'python3' : 'bash',
    args: s.args,
  }))
  return [...bySuffix, ...byMode].sort((a, b) => a.file.localeCompare(b.file))
}

const ALL = discover()
const RUNNABLE = ALL.filter((s) => !(s.name in EXCLUDED))

/** The two report shapes in use, both requiring a NON-ZERO count.
 *
 *  Non-zero matters more than "PASS" does: a selftest whose cases all got skipped, or whose loop
 *  never entered, prints a perfectly happy summary over nothing. Same reason the sibling wrapper
 *  for skills-symlink-to-realdir matches `[1-9]\d* case\(s\)` rather than just `PASS`. */
const OK_SHAPES: readonly RegExp[] = [
  /All ([1-9]\d*) checks pass\./, //            local-llm-* style
  /selftest: ([1-9]\d*) passed, 0 failed/, //   offload-dispatch style, also live-tree-freshness
  /selftest: ([1-9]\d*) case\(s\), PASS/, //    skills-symlink-to-realdir style
  /selftest OK \(([1-9]\d*) cases?\)/, //       context-compact-monitor / git-object-integrity-monitor style
  // agent-skill-drift-sync / gate-dispatch-check / migration-number-check / store-watch-exclusions /
  // sync-agent-templates style: N `ok   <case description>` lines, then a bare `selftest: PASS` with
  // no count of its own -- the count lives in the "ok" lines above it, so this requires AT LEAST ONE
  // before accepting the final PASS (same non-vacuous-loop guarantee the other shapes get from their
  // captured number).
  /^\s*ok\s+\S[\s\S]*\nselftest: PASS$/m,
  // card-build-route style: a per-case table then `passed: N   failed: 0`. Surfaced by card
  // 0ebeff55 -- this script had never run here, so its shape had never been seen. The captured
  // number keeps the non-vacuous guarantee: `passed: 0` does not match.
  /passed: ([1-9]\d*)\s+failed: 0/,
  // cleancore-main-suite-guard style: `ok  <case>` lines then a bare `controls: PASS`. Same
  // shape as the selftest: PASS entry above, different final word, and the same requirement of at
  // least one `ok` line before it.
  /^\s*ok\s+\S[\s\S]*\ncontrols: PASS$/m,
  // vendored-skill-integrity style: `selftest: N checks, 0 failed`. Same family as the
  // `N passed, 0 failed` entry above, different noun. The captured number keeps the
  // non-vacuous guarantee: `0 checks` does not match.
  /selftest: ([1-9]\d*) checks, 0 failed/,
  // local-llm-rag.selftest.sh style (card 613a8142): `<script>.sh selftest: all N checks passed`.
  // Captured number keeps the non-vacuous guarantee: `all 0 checks passed` does not match.
  /selftest: all ([1-9]\d*) checks passed/,
  // seged-hivo-agy-jail-binds style (card 0f01b9cf F2, RedHat komment 20293): a WSLg-less host's
  // degraded run used to print "PASS, K SKIPPED", which the `case\(s\), PASS` entry above matched
  // by accident (unanchored) -- a skip read as an ordinary pass to this machine consumer. The
  // script now uses wholly different wording (no "PASS" substring) for that shape, with its own
  // deliberate entry here, so the skip still exits 0 without silently satisfying the real-pass
  // pattern.
  /selftest: ([1-9]\d*) case\(s\), DEGRADED-SKIP \([1-9]\d* skipped, not counted as coverage\)/,
  // kg-check-landing.selftest.sh style: `pass=N fail=0`. Captured non-zero N keeps the
  // non-vacuous guarantee: `pass=0 fail=0` does not match.
  /pass=([1-9]\d*) fail=0/,
  // freellm-catalog-sync.selftest.sh style (card 405869d9): `PASS=N FAIL=0` on its own line,
  // after per-case `OK   <description>` lines. Captured non-zero N keeps the non-vacuous
  // guarantee: `PASS=0 FAIL=0` does not match.
  /^PASS=([1-9]\d*) FAIL=0$/m,
]

describe('every store/*.selftest.{sh,py} actually runs (cards 711a7e57, 2003e04b)', () => {
  it('discovery found the selftests -- it is not asserting over an empty list', () => {
    // The negative control. A renamed directory or a broken glob would otherwise report a perfectly
    // healthy set of selftests that this file never looked at -- which is the very failure the card
    // is about, reintroduced one level up.
    expect(ALL.length, `no *.selftest.* or mode-selftest found under ${STORE}`).toBeGreaterThanOrEqual(12)
    expect(RUNNABLE.length).toBeGreaterThanOrEqual(ALL.length - Object.keys(EXCLUDED).length)
  })

  it('every wired language actually matched something', () => {
    // Per-language negative control. Without it, a typo in one suffix silently un-covers that whole
    // language while the total count above stays comfortably above its floor -- which is exactly how
    // the .py files went unrun in the first place.
    for (const [suffix] of RUNNERS) {
      expect(
        ALL.filter((s) => s.file.endsWith(suffix)).length,
        `no *${suffix} discovered -- either the suffix is wrong or they were all deleted`,
      ).toBeGreaterThan(0)
    }
  })

  it('every registered mode-selftest still exists (card 453af053)', () => {
    // Same shape as the exclusion-still-exists control below: MODE_SELFTESTS cannot be discovered
    // from disk (that is the whole reason it is a hand-kept list), so a deleted or renamed script
    // would otherwise sit here as a dead, silently-failing entry rather than a loud one.
    for (const s of MODE_SELFTESTS) {
      expect(
        ALL.some((a) => a.file === s.file && a.args.join(' ') === s.args.join(' ')),
        `${s.file} ${s.args.join(' ')} is registered but discover() did not produce it`,
      ).toBe(true)
    }
  })

  it('every excluded entry still exists, so a stale exclusion cannot sit here unnoticed', () => {
    // An exclusion for a deleted script is dead weight that reads like a live decision. Worse, it
    // hides that the reason no longer applies to anything.
    const names = ALL.map((s) => s.name)
    for (const name of Object.keys(EXCLUDED)) {
      expect(names, `${name} is excluded but no longer exists -- drop the entry`).toContain(name)
      expect(EXCLUDED[name]!.length, `${name}'s exclusion needs a real reason`).toBeGreaterThan(20)
    }
  })

  // PORT OWNERSHIP ACROSS SELFTESTS (card 0ebeff55's own consequence, found 2026-09-11).
  //
  // Wiring the never-run selftests into this file made two of them RUN TOGETHER for the first
  // time -- and they both bind 127.0.0.1:38820. fleet-nudger owns 38811-38829 and uses 38820 as
  // one of its cases; cleancore-branch-drift-monitor had it hardcoded. The symptom is not a
  // clean failure but a flaky one: `OSError: [Errno 98] Address already in use`, whichever runs
  // while the other's server is still letting go of the socket.
  //
  // The discovery in this file is what makes a port a SHARED resource, so the rule belongs here:
  // a selftest may reuse a port within itself, but two different ones may not name the same port.
  it('no two selftests bind the same TCP port', () => {
    const portsBy = new Map<string, Set<string>>()
    for (const s of ALL) {
      const src = readFileSync(join(STORE, s.file), 'utf-8')
      // Strip comments so a port mentioned in prose does not manufacture a collision.
      const code = src
        .split('\n')
        .map((l) => l.replace(/#.*$/, ''))
        .join('\n')
      for (const m of code.matchAll(/\b(3[0-9]{4}|[45][0-9]{4})\b/g)) {
        if (!portsBy.has(m[1]!)) portsBy.set(m[1]!, new Set())
        portsBy.get(m[1]!)!.add(s.name)
      }
    }
    const shared = [...portsBy.entries()]
      .filter(([, owners]) => owners.size > 1)
      .map(([port, owners]) => `${port}: ${[...owners].sort().join(' + ')}`)
    expect(
      shared,
      'These selftests bind the same port. Running them in one suite makes whichever goes second ' +
        'fail intermittently with EADDRINUSE. Give each selftest its own range.',
    ).toEqual([])
  })

  // Without this, the check above passes trivially on a corpus where nothing binds anything.
  it('the port scan sees real ports -- otherwise the check above is vacuous', () => {
    const withPorts = ALL.filter((s) =>
      /\b(3[0-9]{4}|[45][0-9]{4})\b/.test(readFileSync(join(STORE, s.file), 'utf-8')),
    )
    expect(withPorts.length).toBeGreaterThanOrEqual(2)
  })

  // card 2f05b3e3: vitest 5's 5000ms default test timeout is far shorter than several of these
  // selftests legitimately take (e.g. channels-reap-poller-pids/graphify-build-singleflight/
  // local-llm-tune-sweep/mopsion-suite-run ~30s each). The 180_000ms cap above is the SUBPROCESS
  // timeout (execFileSync); vitest's own per-case timeout is separate and must also be raised, or
  // vitest kills the case long before the subprocess cap would ever fire.
  it.each(RUNNABLE.map((s) => [s.name, s] as const))(
    '%s passes',
    (_label, script) => {
      // Card 99a4a2d4: runGuardedSelftest (above) wraps the dynamic, name-independent tree guard
      // around the SAME execFileSync this test needs to make anyway -- no separate invocation, so a
      // selftest that leaves tracked files dirty cannot slip through in the gap. It throws on its
      // own if the tree came out dirty; this is the ONLY place that decides pass/fail for that part.
      const out = runGuardedSelftest(REPO_ROOT, script.runner, script.file, script.args)
      const matched = OK_SHAPES.some((re) => re.test(out))
      expect(
        matched,
        `${script.file} exited 0 but printed no recognised non-zero PASS summary. ` +
          `Either it ran no cases, or it reports in a shape this file does not know yet ` +
          `(add it to OK_SHAPES rather than loosening one). Tail:\n${out.slice(-400)}`,
      ).toBe(true)
    },
    200_000,
  )

  // Card 445e9515: pins the it.each loop's CALL SITE above, not just runGuardedSelftest's own body.
  // Placed directly after the it.each block and before the fixture describe further down (vitest
  // runs cases in declaration order within a file), so guardedCallCount reflects only what the real
  // loop did. If the loop above is changed to call execFileSync directly instead of
  // runGuardedSelftest (W3), this count stays 0 and the assertion goes red even though every fixture
  // test below -- which calls runGuardedSelftest itself, not the loop -- would still pass.
  it('the real loop above calls runGuardedSelftest exactly once per selftest (card 445e9515, W3)', () => {
    expect(guardedCallCount).toBe(RUNNABLE.length)
  })
})

// Card 99a4a2d4 (WhiteHat F1 on ff7e1b0a, comment 6640): proves the guard wired into the real
// it.each loop above actually catches the 5 shapes Cybersec measured as invisible to the static
// detector, PLUS that it does not false-positive on a clean read-only selftest or on tree-dirt that
// predates the selftest under test (a concurrent landing on the shared test tree). Uses its own
// disposable git fixture repo -- never the real tree -- so a deliberately-corrupting probe script
// cannot touch anything this suite depends on.
describe('the shared-tracked-tree guard is name-independent (card 99a4a2d4)', () => {
  // The tracked file AND the probe both live under `<repo>/store/`, mirroring the real shape
  // (REPO_ROOT/store), so every case below can call the real `runGuardedSelftest(repoRoot, ...)` --
  // the EXACT function the real it.each loop calls -- rather than re-testing trackedDirtySet/
  // newlyDirty in isolation (RedHat NO-GO K1, card 99a4a2d4 delta, comment 23762): calling the
  // helpers directly proved the HELPERS work, not that the real runner still calls them. Deleting
  // the guard's check from the loop (W1), or moving the "before" snapshot to after the selftest runs
  // (W2), left every test in the FIRST version of this file green -- going through the same shared
  // function this suite's real cases use closes that gap, because a break there now fails these too.
  function makeFixtureRepo(): string {
    const dir = mkdtempSync(join(tmpdir(), 'selftest-tree-guard-fixture-'))
    const store = join(dir, 'store')
    mkdirSync(store, { recursive: true })
    execFileSync('git', ['init', '-q', dir])
    execFileSync('git', ['-C', dir, 'config', 'user.email', 'fixture@fixture.invalid'])
    execFileSync('git', ['-C', dir, 'config', 'user.name', 'fixture'])
    writeFileSync(join(store, 'tracked.sh'), '#!/bin/sh\necho hi\n')
    execFileSync('git', ['-C', dir, 'add', '.'])
    execFileSync('git', ['-C', dir, 'commit', '-q', '-m', 'init'])
    return dir
  }

  // Exactly Cybersec's 5 measured shapes (comment 6640), each run against `$1` (the fixture repo
  // root, passed through runGuardedSelftest's `args`, so the probe itself needs no HERE/ROOT/
  // SCRIPT/G anchor variable -- the whole point is that the guard must not care what the probe
  // calls its own path).
  const EVASIONS: ReadonlyArray<readonly [string, string]> = [
    ['mutation not at the start of the line', 'true && rm "$1/store/tracked.sh"\n'],
    ['sed -i', 'sed -i "s/hi/bye/" "$1/store/tracked.sh"\n'],
    ['redirect truncate', ': > "$1/store/tracked.sh"\n'],
    ['cp /dev/null', 'cp /dev/null "$1/store/tracked.sh"\n'],
    ['no anchor variable at all (dirname "$0")', 'rm "$(dirname "$0")/tracked.sh"\n'],
  ]

  it.each(EVASIONS)('catches: %s', (_label, body) => {
    const repo = makeFixtureRepo()
    try {
      const probe = join(repo, 'store', 'probe.sh')
      writeFileSync(probe, `#!/bin/sh\n${body}`)
      chmodSync(probe, 0o755)
      expect(
        () => runGuardedSelftest(repo, 'sh', 'probe.sh', [repo]),
        `expected the ${body.trim()} shape to be caught`,
      ).toThrow()
    } finally {
      rmSync(repo, { recursive: true, force: true })
    }
  })

  it('a read-only selftest produces no false positive', () => {
    const repo = makeFixtureRepo()
    try {
      const probe = join(repo, 'store', 'probe.sh')
      writeFileSync(probe, `#!/bin/sh\ncat "$1/store/tracked.sh" > /dev/null\necho "selftest: 1 passed, 0 failed"\n`)
      chmodSync(probe, 0o755)
      expect(() => runGuardedSelftest(repo, 'sh', 'probe.sh', [repo])).not.toThrow()
    } finally {
      rmSync(repo, { recursive: true, force: true })
    }
  })

  it('tree-dirt that already existed BEFORE this selftest ran is not blamed on it', () => {
    // The scoping WhiteHat's own comment called for: a concurrent landing on the same shared test
    // tree can leave it dirty for reasons that have nothing to do with the selftest under test.
    const repo = makeFixtureRepo()
    try {
      writeFileSync(join(repo, 'store', 'tracked.sh'), 'dirtied by something else before this selftest ran\n')
      const probe = join(repo, 'store', 'probe.sh')
      // This selftest itself does nothing -- the pre-existing dirt must not surface as "new".
      writeFileSync(probe, `#!/bin/sh\necho "selftest: 1 passed, 0 failed"\n`)
      chmodSync(probe, 0o755)
      expect(() => runGuardedSelftest(repo, 'sh', 'probe.sh', [repo])).not.toThrow()
    } finally {
      rmSync(repo, { recursive: true, force: true })
    }
  })
})

// Card 0ebeff55. The discovery above keys on the `.selftest.` SUFFIX, and that is exactly how far
// it reaches: a script named `<x>-selftest.sh` with a HYPHEN matches the glob nowhere and is run by
// nothing, forever. Measured on this repo 2026-09-10: 28 dot-form scripts were discovered while
// SEVEN hyphen-form ones sat beside them, FOUR of them referenced by nothing at all --
// card-build-route, cleancore-branch-drift-monitor, external-repos-sync and fleet-nudger. Written,
// committed, green-looking controls that had never executed once.
//
// That is the same "written, never run" class this file was built for (711a7e57), one naming
// convention over -- and the irony is sharp: card-build-route-selftest.sh is the selftest of the
// very router whose skipped invocations card 0c473a5e had just finished measuring.
//
// All seven were renamed to the dot form, so the fix is a rename plus THIS: a rename alone would
// be a one-time cleanup that the next hyphen-named file silently undoes. The guard is what makes
// the naming a rule instead of a habit -- the same reason the exclusion list above must justify
// itself rather than being trusted.
describe('store selftests use ONE naming convention (card 0ebeff55)', () => {
  const hyphenForm = readdirSync(STORE).filter((f) => f.endsWith('-selftest.sh') || f.endsWith('-selftest.py'))

  it('no store/*-selftest.{sh,py} exists -- the discovery glob would never see it', () => {
    expect(
      hyphenForm,
      'these are invisible to the discovery above and would never run. Rename them to ' +
        '<name>.selftest.<ext> (a DOT), and update any references.',
    ).toEqual([])
  })

  it('the discovery actually found the renamed scripts (the rename was not a no-op)', () => {
    // Negative control for the case above: an empty store/ directory would also satisfy "no
    // hyphen-form files", so assert the dot-form population is real and includes the ones that
    // were orphaned.
    const names = ALL.map((s) => s.name)
    expect(names.length).toBeGreaterThan(20)
    for (const orphan of ['card-build-route', 'external-repos-sync', 'fleet-nudger']) {
      expect(names, `${orphan} was orphaned before this card and must now be discovered`).toContain(orphan)
    }
  })
})
