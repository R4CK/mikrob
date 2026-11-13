// The two landers' --selftest modes, actually run (card dfff9b37).
//
// WHY THIS FILE EXISTS. Both store/cleancore-land.sh and store/marveen-land.sh have carried a
// --selftest mode for a long time, and NOTHING ran it: no vitest suite invoked either one, so the
// cases only executed when a human typed the command. A selftest nobody runs is documentation, not
// a regression guard -- the same shape as an automation whose scheduler entry is unversioned. Card
// dfff9b37 added 24 cases to that mode (via the shared store/landing-downward-check.sh), which
// would have inherited exactly the same fate.
//
// The case COUNT is asserted, not just the PASS line. A suite that only fails when the script exits
// non-zero still passes after somebody deletes half the cases -- and deletion is the failure mode
// that matters here, because these cases exist to stop a landing, and a landing that stops nothing
// looks identical to a landing with nothing to stop.
import { describe, it, expect } from 'vitest'
import { execFileSync } from 'node:child_process'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..')

function selftest(script: string): { status: number; out: string } {
  try {
    // stderr is folded in deliberately: a sourcing failure (a missing shared lib) prints there and
    // would otherwise be invisible, leaving an empty-but-passing assertion.
    const out = execFileSync('bash', [join(REPO, 'store', script), '--selftest'], {
      encoding: 'utf-8',
      stdio: 'pipe',
      cwd: REPO,
    })
    return { status: 0, out }
  } catch (e) {
    const err = e as { status?: number; stdout?: string; stderr?: string }
    return { status: err.status ?? -1, out: String(err.stdout ?? '') + String(err.stderr ?? '') }
  }
}

const caseCount = (out: string) => Number(/selftest: (\d+) case\(s\)/.exec(out)?.[1] ?? -1)

describe.each([
  // The floors are the counts measured when this file landed, minus nothing: they are a ratchet, so
  // adding cases is free and removing one fails here. cleancore carries 23 of its own + 26 shared;
  // marveen carries 3 of its own + 26 shared.
  ['cleancore-land.sh', 42],
  ['marveen-land.sh', 29],
])('%s --selftest', (script, floor) => {
  it('passes', { timeout: 30_000 }, () => {
    const r = selftest(script)
    expect(r.out).toContain('PASS')
    expect(r.out).not.toContain('FAIL')
    expect(r.status).toBe(0)
  })

  it(`still runs at least ${floor} cases -- deleting cases is a failure, not a cleanup`, { timeout: 30_000 }, () => {
    expect(caseCount(selftest(script).out)).toBeGreaterThanOrEqual(floor)
  })
})

// Card 46194693 F1 (Cybered NO-GO 29382): --selftest-land-lock-release existed but nothing ran it
// in vitest, so WhiteHat's three named mutants (dead-branch false&&, name-in-comment) stayed green
// in every automated run. This case makes the hook part of the suite and verifies the count so
// that removing one of its cases fails here, not silently.
describe('marveen-land.sh --selftest-land-lock-release', () => {
  it('passes all 3 cases and reports the count', { timeout: 60_000 }, () => {
    let status = 0
    let out = ''
    try {
      out = execFileSync('bash', [join(REPO, 'store', 'marveen-land.sh'), '--selftest-land-lock-release'], {
        encoding: 'utf-8',
        stdio: 'pipe',
        cwd: REPO,
        timeout: 50_000,
        env: { ...process.env, MARVEEN_LAND_DEVELOP_LOCK_WAIT_MAX_S: '5' },
      })
    } catch (e) {
      const err = e as { status?: number; stdout?: string; stderr?: string }
      status = err.status ?? -1
      out = String(err.stdout ?? '') + String(err.stderr ?? '')
    }
    expect(status).toBe(0)
    expect(out).toContain('PASS')
    expect(out).not.toContain('FAIL')
    // Floor on the case count: a mutant that removes a case leaves rc=0 but drops the number.
    const m = /selftest-land-lock-release: (\d+) case\(s\)/.exec(out)
    expect(m).not.toBeNull()
    expect(Number(m?.[1] ?? 0)).toBeGreaterThanOrEqual(3)
  })
})

describe('the shared downward-check cases run from BOTH landers, not just one', () => {
  // The point of putting them in store/landing-downward-check.sh was that the two landers cannot
  // end up testing different things about the same code. If one lander stops sourcing the lib, its
  // count drops back to its own cases and this notices -- the count floors above would not, on
  // their own, prove the SHARED block ran in each.
  it('both counts include the shared block', { timeout: 30_000 }, () => {
    // Card 3731c807, RedHat 16619 N2: runs BOTH landers' full --selftest in sequence, and under
    // concurrent-suite load that measured 5988ms once -- over vitest's 5000ms default -- while
    // logically still green (the --selftest runs themselves exited 0 well under 60s). A timing
    // flake on a correctness assertion is strictly worse than a slow test: it looks like a real
    // regression under exactly the CPU-contention conditions rule 17 already documents.
    const cc = caseCount(selftest('cleancore-land.sh').out)
    const mv = caseCount(selftest('marveen-land.sh').out)
    // 49 since card 22835648 round 4 (Cybered NO-GO 28967) added 4 more selftest cases (the
    // --cache-path/--worktree-path MIKROB_LAND_CACHE/CLEANCORE_LAND_CACHE and MOPSION_WORKTREES/
    // CLEANCORE_WORKTREES precedence pins) -- again mopsion-land.sh's own env-compat reads, not
    // part of the shared downward-check lib.
    // 45 since card 22835648 B2 added 4 new selftest cases (the --main-path MOPSION_MAIN/
    // CLEANCORE_MAIN precedence pin) -- mopsion-land.sh's own env-compat read, not part of the
    // shared downward-check lib, so it does not touch marveen-land.sh's own count.
    // 41 since card d8207630 added 4 new selftest cases (vacuum + mopsion-land.sh own-block);
    // 37 before that since card 79311937 added two migration_number_check cases (a real-git-fixture regression
    // test for the deleted-migration false-collision bug) to cleancore-land.sh's own block -- a
    // mopsion-only concept (migration numbering), not part of the shared downward-check lib, so it
    // does not touch marveen-land.sh's own count. It was 35 after card 5136cf80's nine bundle-guard
    // cases (F-1/F-2), 27 after 3bfb133e's four fmt_bad_files cases, 23 before that after
    // edf9c837's seven pick_branch cases. This constant tracks ONE lander's own block, so it moves
    // whenever that block does -- the assertion it feeds is about the SHARED block being identical
    // in both, and lowering it to make an edit fit would delete exactly that guarantee.
    //
    // marveen-land.sh's own-case constant moved 3 -> 7 with card cd3e577b (F1 per-card
    // worktree/branch: card_designated_gates_agree + --card/--all gate-requirement cases), then
    // 7 -> 10 with card 3731c807 (cd3e577b follow-up: the acquire_land_lock call-site pin, the
    // behavioral flock-release case, and the Designated: unknown-sentinel case), then
    // 10 -> 14 with card 5d9731cd (FIFO ticket queue for the develop lock: atomic parallel
    // ticket-sequencing, ordering-follows-ticket-order + mutation check, and the land_one
    // call-site pin on the new wait-loop condition), then 14 -> 20 with card 81c6fbb5
    // (5d9731cd follow-up: recycled-pid/pid-0 reaping red-then-green pairs, the seq-reset floor
    // red-then-green pair, and the two T1 ticket-cleanup pins + two T1 reap-call mutation
    // checks), then 20 -> 25 with the same card's re-gate round (CYBERSEC NO-GO 28862: the N1
    // stray-file floor-scan crash, the N2 zero-padded-pid and N3 legacy-ticket reaping pairs,
    // the Q3 fd-close call-site pin, and the N4 independent-field-parse pin), then 25 -> 27 with
    // card 1ce1059a (81c6fbb5 round 2 residual, Q1b: the land_lock_take_ticket write-before-
    // release ordering pin plus its reorder-mutant-caught case) -- all touch marveen-land.sh's
    // own --selftest block only, not the shared lib or cleancore-land.sh's own. Then 27 -> 33
    // with card 07f1fe6e (9d1ee327 follow-up: the six HUP/INT group-kill parity cases) --
    // marveen-only own-block cases again, cleancore-land.sh untouched.
    //
    // cc's floor moves 41 -> 45 with card 22835648 B2 (the --main-path MOPSION_MAIN/
    // CLEANCORE_MAIN precedence pin, 4 cases) -- mopsion-land.sh's own env-compat read, not part
    // of the shared downward-check lib, so it does not touch marveen-land.sh's own count. Then
    // 45 -> 49 with card 22835648 round 4 (Cybered NO-GO 28967 fix: Mopsi bridge precedence +
    // Python env reads, 4 more cases) -- same category, mopsion-land.sh's own block only.
    //
    // mv's own-case constant moved 33 -> 34 with card 78339a8a (the LANDING_DOWNWARD_CHECK leak
    // fix: one new case in marveen-land-run-fg-killable.selftest.sh, folded into marveen-land.sh's
    // own --selftest total the same way the HUP/INT cases above were) -- marveen-only own-block,
    // cleancore-land.sh untouched, same category as every other bump in this comment history.
    expect(cc).toBeGreaterThan(49) // 49 = cleancore-land.sh's own cases
    expect(mv).toBeGreaterThan(34) // 34 = marveen-land.sh's own cases
    expect(cc - 49).toBe(mv - 34) // the same shared block, in both
  })
})
