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
import { describe, it, expect } from 'vitest'
import { execFileSync } from 'node:child_process'
import { readdirSync } from 'node:fs'
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

function discover(): Array<{ name: string; file: string; runner: string }> {
  const files = readdirSync(STORE)
  return RUNNERS.flatMap(([suffix, runner]) =>
    files
      .filter((f) => f.endsWith(suffix))
      .map((f) => ({ name: f.slice(0, -suffix.length), file: f, runner })),
  ).sort((a, b) => a.file.localeCompare(b.file))
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
  /selftest: ([1-9]\d*) passed, 0 failed/, //   offload-dispatch style
  /selftest: ([1-9]\d*) case\(s\), PASS/, //    skills-symlink-to-realdir style
]

describe('every store/*.selftest.{sh,py} actually runs (cards 711a7e57, 2003e04b)', () => {
  it('discovery found the selftests -- it is not asserting over an empty list', () => {
    // The negative control. A renamed directory or a broken glob would otherwise report a perfectly
    // healthy set of selftests that this file never looked at -- which is the very failure the card
    // is about, reintroduced one level up.
    expect(ALL.length, `no *.selftest.* found under ${STORE}`).toBeGreaterThanOrEqual(12)
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

  it('every excluded entry still exists, so a stale exclusion cannot sit here unnoticed', () => {
    // An exclusion for a deleted script is dead weight that reads like a live decision. Worse, it
    // hides that the reason no longer applies to anything.
    const names = ALL.map((s) => s.name)
    for (const name of Object.keys(EXCLUDED)) {
      expect(names, `${name} is excluded but no longer exists -- drop the entry`).toContain(name)
      expect(EXCLUDED[name]!.length, `${name}'s exclusion needs a real reason`).toBeGreaterThan(20)
    }
  })

  it.each(RUNNABLE.map((s) => [s.file, s] as const))('%s passes', (_label, script) => {
    const out = execFileSync(script.runner, [join(STORE, script.file)], {
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
