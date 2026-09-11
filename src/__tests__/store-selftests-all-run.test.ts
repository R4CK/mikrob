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
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

const REPO_ROOT = join(import.meta.dirname, '..', '..')
const STORE = join(REPO_ROOT, 'store')

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
  { file: 'context-compact-monitor.sh', args: ['--selftest'] },
  { file: 'gate-dispatch-check.sh', args: ['selftest'] },
  { file: 'git-object-integrity-monitor.sh', args: ['--selftest'] },
  { file: 'live-tree-freshness.sh', args: ['--selftest'] },
  { file: 'migration-number-check.sh', args: ['selftest'] },
  { file: 'store-watch-exclusions.sh', args: ['selftest'] },
  { file: 'sync-agent-templates.sh', args: ['selftest'] },
]

function discover(): Array<{ name: string; file: string; runner: string; args: readonly string[] }> {
  const files = readdirSync(STORE)
  const bySuffix = RUNNERS.flatMap(([suffix, runner]) =>
    files
      .filter((f) => f.endsWith(suffix))
      .map((f) => ({ name: f.slice(0, -suffix.length), file: f, runner, args: [] as readonly string[] })),
  )
  const byMode = MODE_SELFTESTS.map((s) => ({
    name: s.file.replace(/\.sh$/, '') + ' ' + s.args.join(' '),
    file: s.file,
    runner: 'bash',
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

  it.each(RUNNABLE.map((s) => [s.name, s] as const))('%s passes', (_label, script) => {
    const out = execFileSync(script.runner, [join(STORE, script.file), ...script.args], {
      encoding: 'utf-8',
      timeout: 180_000,
      // Inherit nothing that could make a selftest take a different path than it does by hand.
      env: process.env,
    })
    const matched = OK_SHAPES.some((re) => re.test(out))
    expect(
      matched,
      `${script.file} exited 0 but printed no recognised non-zero PASS summary. ` +
        `Either it ran no cases, or it reports in a shape this file does not know yet ` +
        `(add it to OK_SHAPES rather than loosening one). Tail:\n${out.slice(-400)}`,
    ).toBe(true)
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
