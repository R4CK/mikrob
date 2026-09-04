// Card 711a7e57: every store/*.selftest.sh actually RUNS.
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
  // Its own comment says it plainly: it swaps `store/local-llm-model-routing.json` out and back,
  // and "this IS the file the running fleet uses". A `trap cleanup EXIT` restores it on a normal
  // exit or an ordinary signal -- but NOT on SIGKILL, and this suite runs during landings, which do
  // get killed (one of this agent's own runs was killed by a session teardown the same day). A
  // killed run would leave 18 agents' routing config replaced by a fake pointing at a nonexistent
  // model. It passes when run by hand (5/5); it is the WIRING that is unsafe, not the script.
  //
  // The fix is one line in local-llm.sh -- `cfg="${LOCAL_LLM_MODEL_ROUTING_FILE:-$HERE/...}"` --
  // after which the selftest can point at a temp file and join this list. That edits a live fleet
  // script, which is a separate decision from wiring, so it is not folded in here.
  'local-llm-model-routing':
    'swaps the LIVE fleet routing config; its cleanup trap does not survive SIGKILL, and landings get killed',
}

function discover(): string[] {
  return readdirSync(STORE)
    .filter((f) => f.endsWith('.selftest.sh'))
    .map((f) => f.replace(/\.selftest\.sh$/, ''))
    .sort()
}

const ALL = discover()
const RUNNABLE = ALL.filter((n) => !(n in EXCLUDED))

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

describe('every store/*.selftest.sh actually runs (card 711a7e57)', () => {
  it('discovery found the selftests -- it is not asserting over an empty list', () => {
    // The negative control. A renamed directory or a broken glob would otherwise report a perfectly
    // healthy set of selftests that this file never looked at -- which is the very failure the card
    // is about, reintroduced one level up.
    expect(ALL.length, `no *.selftest.sh found under ${STORE}`).toBeGreaterThanOrEqual(12)
    expect(RUNNABLE.length).toBeGreaterThanOrEqual(ALL.length - Object.keys(EXCLUDED).length)
  })

  it('every excluded entry still exists, so a stale exclusion cannot sit here unnoticed', () => {
    // An exclusion for a deleted script is dead weight that reads like a live decision. Worse, it
    // hides that the reason no longer applies to anything.
    for (const name of Object.keys(EXCLUDED)) {
      expect(ALL, `${name} is excluded but no longer exists -- drop the entry`).toContain(name)
      expect(EXCLUDED[name]!.length, `${name}'s exclusion needs a real reason`).toBeGreaterThan(20)
    }
  })

  it.each(RUNNABLE)('%s passes', (name) => {
    const out = execFileSync('bash', [join(STORE, `${name}.selftest.sh`)], {
      encoding: 'utf-8',
      timeout: 180_000,
      // Inherit nothing that could make a selftest take a different path than it does by hand.
      env: process.env,
    })
    const matched = OK_SHAPES.some((re) => re.test(out))
    expect(
      matched,
      `${name}.selftest.sh exited 0 but printed no recognised non-zero PASS summary. ` +
        `Either it ran no cases, or it reports in a shape this file does not know yet ` +
        `(add it to OK_SHAPES rather than loosening one). Tail:\n${out.slice(-400)}`,
    ).toBe(true)
  })
})
