// ROUND 6 (Cybered NO-GO, live on this same card): the first fix folded PATH_PREFIX into the filler
// by routing every backslash through `\\.` (backslash + whatever follows, paired). All five shell
// names end in the two literal characters `s`,`h`, so a backslash placed directly before that `s`
// (`ba\sh`, `\sh`, `z\sh`, `da\sh`, `k\sh`) got force-paired with the `s`, consuming the character
// the shell-name alternation needed next -- a silent ALLOW where the old code correctly DENYed.
// Cybered proved bash itself resolves `ba\sh` to `bash` during word expansion (own repro:
// `bash -c 'echo ba\sh'` prints `bash`), so this is a real, trivially-usable bypass, not a regex
// artifact. The `MUST_DENY_BACKSLASH_BEFORE_SH` block below is that boundary, one case per shell
// name plus the piped variant Cybered also demonstrated.
//
// Card ccc2c742: STDIN_SHELL_RX's xargs branch --
// `\bxargs\b[^|]*?${PATH_PREFIX}(?:bash|sh|zsh|dash|ksh)\b` -- runs in O(n^2) on a long run of
// characters PATH_PREFIX can never close (no `/`), because the unbounded lazy filler `[^|]*?`
// sits directly in front of PATH_PREFIX's own optional, backtracking group: at each of the ~n
// positions the filler tries, PATH_PREFIX does an O(n) failed scan looking for a `/` that never
// comes. Measured (backend, 2026-08-24): n=100000 bytes -> 9051ms, clean quadratic growth (~4x
// time per 2x n). Extrapolated to the real MAX_COMMAND_BYTES=1MB ceiling: ~995s for one
// gateDecision() call -- within the size gate, so not excluded by it.
//
// PLAN-GRILLING VERDICT (posted on ccc2c742 before this file was written): a length-capped filler
// was REJECTED -- it would let an attacker pad past the cap with legitimate-looking xargs flags
// and silently defeat detection (fail-open, worse than the current slow-but-correct match). A
// naive fully-greedy/atomic filler was also REJECTED -- it would consume past a shell name that
// isn't at the very end of the filler run, which is a correctness (false-negative) regression, not
// just a performance one. This file is the CORRECTNESS half of that verdict's required accumulator
// (built before any regex change), covering shapes the fix must keep denying: shell name away from
// the end of the filler, a path-prefixed shell name, multiple candidate shell names, and a long but
// legitimate-looking filler that a length cap would have silently let through. The PERFORMANCE half
// lives in the last describe block.
import { describe, it, expect } from 'vitest'
// @ts-expect-error -- plain .mjs hook script, no types
import { gateDecision } from '../../scripts/self-pace-gate.mjs'

const CT = 'cron' + 'tab'
const bash = (command: string): boolean => Boolean(gateDecision('Bash', { command }).deny)
const backslashRun = (n: number): string => '\\'.repeat(n)

describe('STDIN_SHELL_RX xargs branch: must keep denying (card ccc2c742 fix accumulator)', () => {
  const MUST_DENY: Array<[string, string]> = [
    // Already covered by self-pace-english-word-binaries.test.ts / self-pace-wrapper-and-keyword-
    // positions.test.ts, repeated here so this file stands alone as the fix's own regression gate.
    ['bare shell after xargs (reported shape)', `echo "${CT} -" | xargs bash`],
    ['xargs -0 into bash -c (reported)', `echo "${CT} -" | xargs -0 bash -c`],
    ['xargs -I{} into bash -c', `echo "${CT} -" | xargs -I{} bash -c "id"`],
    // Shell name is NOT at the end of the filler run -- guards against a fully-greedy/atomic
    // filler that would consume past it and leave nothing for PATH_PREFIX+shell-name to match.
    ['shell name mid-command, trailing flags after it', `echo "${CT} -" | xargs -0 bash -c "id" --verbose`],
    [
      'shell name mid-command, trailing plain args after it',
      `echo "${CT} -" | xargs bash -c "id" extra tokens here`,
    ],
    // Path-prefixed shell name -- exercises PATH_PREFIX actually closing on a real `/`, not just
    // failing to find one.
    ['path-prefixed shell name', `echo "${CT} -" | xargs /usr/bin/bash -c "id"`],
    ['path-prefixed shell name with escaped space', `echo "${CT} -" | xargs /usr/local\\ bin/bash -c "id"`],
    // Multiple candidate shell-name occurrences -- the fix must not stop scanning after the first
    // non-matching one.
    ['shell name appears twice, first is a decoy substring', `echo "${CT} -" | xargs echo bashful bash -c "id"`],
    // A long but ordinary-looking filler (repeated valid-shaped flag/value pairs) that must still
    // reach the shell name -- this is the case a length-capped filler (rejected direction) would
    // have silently let through once the cap was exceeded.
    [
      'long legitimate-looking filler before the shell name',
      `echo "${CT} -" | xargs ${'-a file.txt '.repeat(40)}bash -c "id"`,
    ],
  ]

  it.each(MUST_DENY)('%s', (_name, cmd) => {
    expect(bash(cmd)).toBe(true)
  })

  // Round 6 boundary (Cybered): a backslash placed directly before the closing `s` of the shell
  // name's trailing `sh` -- the exact character bash itself drops during word expansion. One case
  // per named shell (all five end in `sh`), plus the piped variant.
  const MUST_DENY_BACKSLASH_BEFORE_SH: Array<[string, string]> = [
    ['backslash before sh: bare "sh"', `echo "${CT} -" | xargs \\sh -c "id"`],
    ['backslash before sh: "bash"', `echo "${CT} -" | xargs ba\\sh -c "id"`],
    ['backslash before sh: "zsh"', `echo "${CT} -" | xargs z\\sh -c "id"`],
    ['backslash before sh: "dash"', `echo "${CT} -" | xargs da\\sh -c "id"`],
    ['backslash before sh: "ksh"', `echo "${CT} -" | xargs k\\sh -c "id"`],
    ['backslash before sh, piped variant (Cybered repro)', `echo "${CT} -" | xargs ba\\sh -c "id"`],
  ]

  it.each(MUST_DENY_BACKSLASH_BEFORE_SH)('%s', (_name, cmd) => {
    expect(bash(cmd)).toBe(true)
  })

  // The escaped-pipe crossing PATH_PREFIX used to provide must still work -- this is the one real
  // capability the fold has to preserve, and the only case the 2-char `\\|` atom exists for.
  it('escaped pipe before the shell name is still crossed (not treated as a real delimiter)', () => {
    expect(bash(`echo "${CT} -" | xargs echo a\\|b bash -c "id"`)).toBe(true)
  })
})

/**
 * CPU milliseconds spent inside `fn`, not wall-clock (card 3b6c94af).
 *
 * WHY THE INSTRUMENT CHANGED. This pair is a QUADRATIC-BLOWUP regression test: the thing it must
 * catch is a regex that starts doing vastly more WORK. Wall-clock measures work plus whatever else
 * the machine was doing, and the suite runs 12 vitest workers in parallel, so the second case went
 * red at 573ms against a 500ms budget during a full run while passing 18/18 in isolation. That is a
 * false alarm on a green codebase, and under marveen-land's zero-tolerance it stopped every landing.
 *
 * Measured on this host, same call, idle vs all cores saturated:
 *
 *            n=100000              n=500000
 *   idle     wall  83  cpu  88     wall 237  cpu 234
 *   loaded   wall  90  cpu  64     wall 315  cpu 181
 *
 * Wall inflates with contention (237 -> 315 here, 573 in the real full run); CPU stays in the same
 * band. The work is CPU-bound regex backtracking, so a genuine blowup shows up in CPU just as
 * plainly -- the pre-fix cost was 9051ms at n=100000, roughly 100x the current figure. Switching
 * instrument therefore does NOT weaken the assertion (rule 7): it measures the same quantity with
 * the noise removed, and the budgets below still sit an order of magnitude under any real
 * regression.
 */
function cpuMsOf(fn: () => void): number {
  const before = process.cpuUsage()
  fn()
  const d = process.cpuUsage(before)
  return (d.user + d.system) / 1000
}

describe('STDIN_SHELL_RX xargs branch: quadratic-blowup repro must stay fast (card ccc2c742)', () => {
  // The exact adversarial shape from the finding: `xargs` + a long backslash run (no `/`, so
  // PATH_PREFIX's optional group can never close) + a shell name. Whatever the outcome (denied or
  // not), it must not take anywhere near the measured pre-fix cost (9051ms at n=100000).
  it('stays cheap at n=100000 backslashes (pre-fix measured: 9051ms; now ~64-88ms CPU)', () => {
    const text = `xargs -0 ${backslashRun(100000)}bash`
    const ms = cpuMsOf(() => { gateDecision('Bash', { command: text }) })
    // ~11x the worst measured figure, and ~9x BELOW the pre-fix cost: a blowup cannot hide in here.
    expect(ms).toBeLessThan(1000)
    // Non-vacuity: a gate that stopped examining the input at all would read as 0 and pass silently.
    expect(ms).toBeGreaterThan(0)
  })

  it('stays cheap at n=500000 backslashes, below the 1MB size gate (now ~181-234ms CPU)', () => {
    const text = `xargs -0 ${backslashRun(500000)}bash`
    const ms = cpuMsOf(() => { gateDecision('Bash', { command: text }) })
    // A quadratic regression here would be ~25x the n=100000 pre-fix cost, i.e. minutes, not 1.5s.
    expect(ms).toBeLessThan(1500)
    expect(ms).toBeGreaterThan(0)
  })
})
