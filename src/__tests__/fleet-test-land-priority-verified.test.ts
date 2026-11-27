// FLEET_TEST_PRIORITY=land (card b7d8ecc4) is a SELF-REPORTED bare env var -- any caller can
// export it and jump the land-priority lane ahead of every normal run. Card e99c3dc1 (MikroB
// decision 39179, corrected scope 39196, tightened GO 25163) hardens the claim: fleet-test.sh
// now verifies it against the ACTUAL holder of marveen-land.sh's own develop-push lock before
// honouring it, by walking the ancestor PID chain for a process that (a) has the develop-lock
// file open on some fd, (b) actually HOLDS the flock on that exact fd (per that fd's own
// /proc/<pid>/fdinfo "lock:" line -- MEASURED to be the one that reliably reports a live flock()
// hold on this platform, unlike the machine-wide /proc/locks listing, which did not show it even
// though a second process's flock -n correctly blocked and fuser -v correctly reported it; an
// open fd alone proves nothing, since any process can open a world-readable file), and (c) whose
// own cmdline names store/marveen-land.sh. Any incomplete check falls back to normal priority,
// never land (fail-closed).
//
// ROUND 2 (CYBERSEC NO-GO 39208 on the first round's Gate-SHA 6bab004a). F-1 (MUST, 3/3 probes):
// the first round read the develop-lock path from MARVEEN_LAND_DEVELOP_LOCK_FILE -- the SAME env
// var marveen-land.sh itself reads -- so any caller could point it at a lock file of their own,
// flock it themselves, and name marveen-land.sh in their own argv to pass every check against a
// lock nobody else contends on. Production now reads the canonical, hardcoded-$ROOT path only;
// the env var has NO EFFECT on the real check any more (pinned below as its own test). F-2 (MUST,
// pre-existing, same round): FLEET_TEST_AGING_S was also read from the caller's env, so
// AGING_S=0 let a normal ticket's OWN mtime check promote it to rank 0 on its first poll, no
// land-impersonation needed at all -- now a hardcoded constant (pinned structurally below, since
// exercising the real aging-promotion window behaviourally would need a multi-second wait). F-3
// (SHOULD): pins for the shared lock-path constant, inode binding, and a depth-bound test built
// from REAL forked processes (nested `bash -c`, never a lone subshell command bash's own
// tail-exec optimisation could collapse to one hop short of what production's run_fg_killable
// actually produces).
//
// Card 81c6fbb5 Q3 matters here: run_fg_killable's subshell deliberately closes ITS OWN copy of
// the land-lock fd before exec'ing fleet-test.sh, so the fd only ever lives on marveen-land.sh's
// own long-lived process, past the immediate parent. The harness below reproduces that shape with
// REAL forked `bash -c` processes at every hop, not a bare `(...)` subshell bash could tail-exec
// away, so the depth actually walked here is the depth production actually has to walk.
//
// HERMETIC BY CONSTRUCTION (MikroB msg 25163's constraint, after CYBERSEC's 15:12:35 incident on
// this same card's earlier round): every lock file this test creates lives under a fresh mktemp
// dir. No literal real-install or real-test-tree path appears anywhere in this file -- grepped
// below as its own test, not just asserted in prose -- and `--effective-priority` exits before
// any lock/tree/CPU-slot machinery runs, so asking never touches the real install at all. The one
// test that exercises the production constant (F-1's pin) never names the real path either: it
// simply confirms the env override has no effect, whatever the canonical path resolves to.
import { describe, it, expect, afterEach } from 'vitest'
import { execFileSync } from 'node:child_process'
import { readFileSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { tmpdir } from 'node:os'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const SCRIPT = join(ROOT, 'store', 'fleet-test.sh')
const SOURCE = readFileSync(SCRIPT, 'utf-8')

const tmpDirs: string[] = []
function freshDir(): string {
  const d = mkdtempSync(join(tmpdir(), 'e99c3dc1-land-lock-'))
  tmpDirs.push(d)
  return d
}
const tmpFiles: string[] = []
afterEach(() => {
  while (tmpDirs.length) {
    const d = tmpDirs.pop()!
    rmSync(d, { recursive: true, force: true })
  }
  while (tmpFiles.length) {
    const f = tmpFiles.pop()!
    rmSync(f, { force: true })
  }
})

/** Extracts a named function's source verbatim out of the real script, the same technique
 * marveen-land.sh's own selftest and fleet-test-priority-lane.selftest.sh already use (sed/awk
 * from the def line to its closing brace) -- a future edit to the real function is what this
 * exercises, never a hand-written copy that can silently drift from production. */
function extractFunction(name: string): string {
  const fn = SOURCE.split('\n')
    .reduce<{ lines: string[]; inFn: boolean; done: boolean }>(
      (acc, line) => {
        if (acc.done) return acc
        if (!acc.inFn && line.startsWith(`${name}() {`)) return { ...acc, inFn: true, lines: [line] }
        if (acc.inFn) {
          acc.lines.push(line)
          if (line === '}') return { ...acc, inFn: false, done: true }
        }
        return acc
      },
      { lines: [], inFn: false, done: false },
    ).lines.join('\n')
  expect(fn, `could not extract ${name} from ${SCRIPT} -- selftest and production have drifted`).toMatch(
    new RegExp(`^${name}\\(\\) \\{`),
  )
  return fn
}

const VERIFY_FUNCS = ['fleet_test_ppid', 'fleet_test_pid_cmdline_is_marveen_land', 'fleet_test_pid_holds_lock_inode', 'fleet_test_verify_land_priority']
function verifyFuncsSource(): string {
  return VERIFY_FUNCS.map(extractFunction).join('\n')
}

/** Builds a REAL process tree with `bash -c` at every hop -- never a bare `(...)` subshell, whose
 * last-command tail-exec optimisation could collapse a hop bash never actually forked for. P1
 * holds (or merely opens) the lock and carries the impersonation marker in its own argv; P2 is a
 * genuine forked process that closes ITS OWN copy of the fd (mirroring run_fg_killable, card
 * 81c6fbb5 Q3); P3 is the leaf that sources the extracted verify function and calls it directly
 * with a throwaway tmp lock path -- never through the full script, so the env-override pin (F-1)
 * can be exercised separately without this harness depending on it. */
function verifyUnderRealAncestorChain(opts: { lockFile: string; holdFlock: boolean; marker: string; depth?: number }): string {
  // Written to real FILES and invoked via `bash <file>`, never nested `bash -c '...'` strings --
  // the extracted function bodies contain their own single quotes (e.g. `stat -c '%i'`), and
  // escaping those correctly through two levels of shell-quoting proved fragile in practice.
  // Files sidestep the whole problem: no quoting of a script's own content is needed at all.
  const dir = freshDir()
  const driverPath = join(dir, 'driver.sh')
  const p2Path = join(dir, 'p2.sh')
  const p1Path = join(dir, 'p1.sh')
  writeFileSync(
    driverPath,
    `#!/usr/bin/env bash\nset -uo pipefail\n${verifyFuncsSource()}\nfleet_test_verify_land_priority "$LOCKFILE" && echo land || echo normal\n`,
  )
  writeFileSync(p2Path, `#!/usr/bin/env bash\nset -uo pipefail\n{ exec {FD}>&-; } 2>/dev/null\nbash "${driverPath}"\n`)
  writeFileSync(
    p1Path,
    `#!/usr/bin/env bash\nset -uo pipefail\nif [ "$HOLD_FLOCK" = "1" ]; then\n  exec {FD}>>"$LOCKFILE"\n  flock "$FD" || exit 9\nelse\n  exec {FD}>>"$LOCKFILE"\nfi\nbash "${p2Path}"\n`,
  )
  return execFileSync('bash', [p1Path, opts.marker], {
    encoding: 'utf-8',
    env: {
      ...process.env,
      LOCKFILE: opts.lockFile,
      HOLD_FLOCK: opts.holdFlock ? '1' : '0',
      FLEET_TEST_PRIORITY_ANCESTOR_DEPTH: String(opts.depth ?? 10),
    },
  }).trim()
}

/** Launches `bash <targetPath> <args...>` DOUBLE-FORKED + in a new session (`( setsid ... & )`,
 * the detaching subshell exits right after backgrounding it), so the kernel reparents it away
 * from THIS test process's own ancestry -- measured on this platform: the orphan's new parent is
 * the nearest subreaper (systemd --user here), never anything in the caller's own chain. Fix for
 * round 3's real failure: this test file runs as `bash store/fleet-test.sh` itself, invoked BY a
 * real `marveen-land.sh` (that is what landing a card means); without detaching, the ancestor
 * walk under test does not stop at this test's own fake p1/p2 -- it keeps walking and can reach
 * that REAL, genuinely land-holding outer process, which satisfies the production check's own
 * criteria for real and returns 'land' for a scenario that should say 'normal'. Detaching the
 * harness's own fake chain from whatever actually launched the test run is what makes the result
 * independent of whether this file happens to be running nested inside a real land. The wrapper
 * script, not this JS process, does the bounded poll-and-cat -- a single synchronous
 * `execFileSync` call either way, no sleep-loop or setTimeout needed on the JS side. */
function runDetached(targetPath: string, args: string[], env: Record<string, string>, pollTimeoutMs = 8000): string {
  const dir = freshDir()
  const outFile = join(dir, 'out')
  const doneFile = join(dir, 'done')
  const runnerPath = join(dir, 'runner.sh')
  const wrapperPath = join(dir, 'wrapper.sh')
  const deadlineS = Math.max(1, Math.ceil(pollTimeoutMs / 1000))
  // The runner does the actual work and writes the DONE marker itself, as the LAST thing it
  // does, after it (still detached) finishes -- polling for marker existence, not "$OUT" having
  // any content, matters because fleet-test.sh can write intermediate lines (env_compat_get
  // warnings etc.) to stdout well before its final land/normal answer; polling on non-empty size
  // alone races ahead and `cat`s a truncated capture (measured: it DID, cutting output short).
  writeFileSync(runnerPath, `#!/usr/bin/env bash\nset -uo pipefail\nbash "${targetPath}" "$@" >"${outFile}" 2>&1\n: > "${doneFile}"\n`)
  writeFileSync(
    wrapperPath,
    `#!/usr/bin/env bash\nset -uo pipefail\n( setsid bash "${runnerPath}" "$@" </dev/null & )\ndeadline=$((SECONDS + ${deadlineS}))\nwhile [ ! -e "${doneFile}" ] && [ $SECONDS -lt $deadline ]; do sleep 0.02; done\ncat "${outFile}" 2>/dev/null\n`,
  )
  return execFileSync('bash', [wrapperPath, ...args], { encoding: 'utf-8', env: { ...process.env, ...env } }).trim()
}

/** The production ROOT constant, read live from SOURCE -- never typed as a literal in this file
 * (see the "names no real install path" self-test below, which greps this file's own text for
 * exactly that). Needed to build the REAL canonical develop-lock path for the hermeticity proof:
 * the production call site hardcodes `${ROOT}/store/.marveen-land-develop.lock` (F-3/V4, pinned
 * elsewhere in this file as a string match), so a fake land-ancestor that is supposed to satisfy
 * that SAME production check for real has to hold its flock on that exact resolved path, not an
 * arbitrary throwaway one. */
function productionRootValue(): string {
  const m = SOURCE.match(/^ROOT="([^"]+)"/m)
  expect(m, 'could not find ROOT="..." in SOURCE -- script has changed shape').toBeTruthy()
  return m![1]
}

/** Materializes a copy of fleet-test.sh with the F-1 vulnerability reintroduced (the
 * env-override-reads-the-caller's-claim bug CYBERSEC NO-GO 39208 closed), same bash idiom as the
 * existing F-2 CONTROL mutant (`"${VAR:-default}"`). Used to prove the hermeticity fix below is
 * not vacuous: the fixed script must say 'normal' in both scenarios, and THIS mutant must still
 * say 'land' in both -- never a coincidence of the fixed script simply never being asked.
 * Written BESIDE the real script (dirname(SCRIPT), same dir as env-compat-lib.sh), not under a
 * throwaway tmp dir: fleet-test.sh sources `env-compat-lib.sh` by a path relative to its own
 * BASH_SOURCE before it ever reaches the --effective-priority arg check, so a copy anywhere else
 * fails before the mutation under test is even exercised. Removed again in afterEach. */
function materializeMutantScript(): string {
  const mutantSource = SOURCE.replace(
    'FLEET_TEST_LAND_LOCK_FILE="${ROOT}/store/.marveen-land-develop.lock"',
    'FLEET_TEST_LAND_LOCK_FILE="${MARVEEN_LAND_DEVELOP_LOCK_FILE:-${ROOT}/store/.marveen-land-develop.lock}"',
  )
  expect(mutantSource, 'the F-1 production line has changed shape -- update this mutant').not.toBe(SOURCE)
  const mutantPath = join(dirname(SCRIPT), `fleet-test-mutant-e99c3dc1-test-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}.sh`)
  tmpFiles.push(mutantPath)
  writeFileSync(mutantPath, mutantSource)
  return mutantPath
}

/** Builds the attacker's own chain (p1 self-flocks+self-impersonates, p2 closes its fd copy and
 * runs `<scriptPath> --effective-priority` with the forged env override) against whichever
 * script copy (real or mutant) is given, so the original F-1 test and the hermeticity proof
 * below share one construction. Returns p1's path -- run it DETACHED (runDetached /
 * runNestedUnderFakeLand), never directly, so an outer real-or-fake land ancestor elsewhere in
 * the actual process tree cannot leak into the result. */
function writeAttackerChain(scriptPath: string): string {
  const dir = freshDir()
  const p2Path = join(dir, 'p2.sh')
  const p1Path = join(dir, 'p1.sh')
  writeFileSync(
    p2Path,
    `#!/usr/bin/env bash\nset -uo pipefail\n{ exec {FD}>&-; } 2>/dev/null\nFLEET_TEST_PRIORITY=land MARVEEN_LAND_DEVELOP_LOCK_FILE="$LOCKFILE" bash "${scriptPath}" --effective-priority\n`,
  )
  writeFileSync(p1Path, `#!/usr/bin/env bash\nset -uo pipefail\nexec {FD}>>"$LOCKFILE"\nflock "$FD" || exit 9\nbash "${p2Path}"\n`)
  return p1Path
}

describe('fleet-test.sh verifies a FLEET_TEST_PRIORITY=land claim before honouring it (card e99c3dc1)', () => {
  it('no ancestor at all (lock file does not even exist): falls back to normal (fail-closed default)', () => {
    const fnSrc = verifyFuncsSource()
    const out = execFileSync(
      'bash',
      ['-c', `${fnSrc}\nfleet_test_verify_land_priority "$1" && echo land || echo normal`, 'driver', join(freshDir(), 'develop.lock')],
      { encoding: 'utf-8' },
    ).trim()
    expect(out).toBe('normal')
  })

  it('THE PROPERTY: a REAL ancestor chain (bash -c at every hop) that holds the flock AND names marveen-land.sh grants land', () => {
    const out = verifyUnderRealAncestorChain({ lockFile: join(freshDir(), 'develop.lock'), holdFlock: true, marker: 'store/marveen-land.sh' })
    expect(out).toBe('land')
  })

  it('CONTROL: holding the flock is not enough if the ancestor is not marveen-land.sh (impostor holder)', () => {
    const out = verifyUnderRealAncestorChain({ lockFile: join(freshDir(), 'develop.lock'), holdFlock: true, marker: 'unrelated-process' })
    expect(out).toBe('normal')
  })

  it('CONTROL: an open fd on the lock file is not enough without an actual flock (MikroB 25163 tightening)', () => {
    const out = verifyUnderRealAncestorChain({ lockFile: join(freshDir(), 'develop.lock'), holdFlock: false, marker: 'store/marveen-land.sh' })
    expect(out).toBe('normal')
  })

  it('F-3/V5: the depth bound is actually enforced against this REAL (not optimised-away) ancestor chain', () => {
    const lockFile = join(freshDir(), 'develop.lock')
    // the genuine holder sits 2 real forked hops up (P1); a bound of 1 cannot reach it.
    const tooShallow = verifyUnderRealAncestorChain({ lockFile, holdFlock: true, marker: 'store/marveen-land.sh', depth: 1 })
    expect(tooShallow).toBe('normal')
    const enoughDepth = verifyUnderRealAncestorChain({ lockFile, holdFlock: true, marker: 'store/marveen-land.sh', depth: 10 })
    expect(enoughDepth).toBe('land')
  })

  it('F-1: MARVEEN_LAND_DEVELOP_LOCK_FILE no longer has ANY effect on the real check (env-override bypass closed)', () => {
    // An attacker pointing the land-lock env var at their OWN self-flocked, self-impersonated
    // lock file must get NOTHING: production reads the canonical $ROOT-derived constant only, so
    // this attacker-controlled file is simply never consulted. Run through the REAL script
    // (--effective-priority), not the extracted function, so this is an end-to-end pin on the
    // actual call site CYBERSEC's probes hit -- not just the function the first round pinned.
    // Run DETACHED (runDetached, not a direct child) -- this test file is itself `bash
    // store/fleet-test.sh`'s own vitest suite, which during an actual land is invoked BY a real
    // marveen-land.sh; undetached, the ancestor walk under test can keep going past this test's
    // own fake p1/p2 and reach that real ancestor (see the hermeticity describe block below,
    // which reproduces and fixes exactly that failure).
    const dir = freshDir()
    const attackerLock = join(dir, 'attacker-controlled.lock')
    const p1Path = writeAttackerChain(SCRIPT)
    const out = runDetached(p1Path, ['store/marveen-land.sh'], { LOCKFILE: attackerLock })
    expect(out).toBe('normal')
  })

  it('F-2: FLEET_TEST_AGING_S is a hardcoded constant, not read from the caller env (structural pin)', () => {
    const codeOnly = SOURCE.split('\n')
      .filter((l) => !/^\s*#/.test(l))
      .join('\n')
    expect(codeOnly).toMatch(/\nFLEET_TEST_AGING_S=180\n/)
    expect(codeOnly).not.toMatch(/FLEET_TEST_AGING_S="\$\{FLEET_TEST_AGING_S/)
  })

  it('CONTROL: reverting FLEET_TEST_AGING_S to read from the caller env is rejected by the same reading', () => {
    const mutant = SOURCE.replace('FLEET_TEST_AGING_S=180', 'FLEET_TEST_AGING_S="${FLEET_TEST_AGING_S:-180}"')
    expect(mutant).not.toBe(SOURCE)
    const codeOnly = mutant
      .split('\n')
      .filter((l) => !/^\s*#/.test(l))
      .join('\n')
    expect(codeOnly).toMatch(/FLEET_TEST_AGING_S="\$\{FLEET_TEST_AGING_S/)
  })

  it('F-3/V4: the production call site and the land-lock constant are the one canonical path, not a second drifting copy', () => {
    const codeOnly = SOURCE.split('\n')
      .filter((l) => !/^\s*#/.test(l))
      .join('\n')
    expect(codeOnly).toMatch(/FLEET_TEST_LAND_LOCK_FILE="\$\{ROOT\}\/store\/\.marveen-land-develop\.lock"/)
    expect(codeOnly).toMatch(/fleet_test_verify_land_priority "\$FLEET_TEST_LAND_LOCK_FILE"/)
  })

  it('F-3/V6: inode binding -- a DIFFERENT file cannot be mistaken for the real lock file by path text alone', () => {
    const dir = freshDir()
    const realLock = join(dir, 'develop.lock')
    const decoy = join(dir, 'develop.lock.decoy') // never flocked
    writeFileSync(decoy, '')
    const fnSrc = verifyFuncsSource()
    // Flock the REAL file from THIS test process directly (no ancestor chain needed -- this
    // checks fleet_test_pid_holds_lock_inode's own inode comparison, not the ancestor walk).
    const driver = `
${fnSrc}
exec {FD}>>"$1"
flock "$FD" || exit 9
real_inode="$(stat -c '%i' "$1")"
decoy_inode="$(stat -c '%i' "$2")"
fleet_test_pid_holds_lock_inode "$$" "$real_inode" && echo "real=yes" || echo "real=no"
fleet_test_pid_holds_lock_inode "$$" "$decoy_inode" && echo "decoy=yes" || echo "decoy=no"
`
    const out = execFileSync('bash', ['-c', driver, 'driver', realLock, decoy], { encoding: 'utf-8' })
    expect(out).toContain('real=yes')
    expect(out).toContain('decoy=no')
  })

  it('this file names no real install path anywhere (MikroB msg 25163 constraint)', () => {
    const text = readFileSync(join(ROOT, 'src', '__tests__', 'fleet-test-land-priority-verified.test.ts'), 'utf-8')
    expect(text).not.toMatch(/\/home\/neon\/marveen(?!-agent-worktrees)/)
  })
})

describe('F-1 HERMETICITY (round 3, real land-run failure): detaching the probe survives a genuine land ancestor', () => {
  /** Builds the "fake land" outer process: it holds a REAL flock on the REAL canonical develop
   * lock (the path derived live from SOURCE's own ROOT, never typed in this file -- see
   * productionRootValue) and carries 'store/marveen-land.sh' in its own argv, i.e. it satisfies
   * the production check's (a) and (c) criteria exactly like a genuine marveen-land.sh would. It
   * then runs the given target DETACHED (double-fork + setsid, same technique as runDetached) as
   * its OWN immediate child -- so without detaching, this process is a real, qualifying ancestor
   * sitting right above the attacker's chain; with detaching, the attacker's chain is orphaned
   * away from it before the production check ever walks.
   *
   * The flock on the real canonical path is NON-BLOCKING (`flock -n`): this is the one real,
   * shared, machine-wide file every actual land also locks, so a genuinely concurrent real land
   * (however unlikely mid-test) must never be made to wait on this test, nor vice versa. If the
   * lock is not free right now, the helper returns the sentinel string 'INCONCLUSIVE-CONTENDED'
   * instead of hanging or corrupting anything -- the caller treats that as "could not run this
   * round, not a failure" rather than asserting on it.
   *
   * CLOSES ITS OWN COPY of the canon fd in the outer wrapper BEFORE forking the detached chain
   * (same discipline as marveen-land.sh's run_fg_killable, card 81c6fbb5 Q3) -- measured live:
   * without this, the fake-land process's open+flocked fd is inherited across every fork down to
   * the attacker's own p1 (nobody in the chain marks it close-on-exec or closes it), so
   * fleet_test_pid_holds_lock_inode sees a "held" lock on p1 merely because it kept a COPY of the
   * fd, regardless of detaching p1's ancestry -- inheritance and ancestry are not the same thing,
   * and detaching only fixes the latter. p1 ALSO already carries 'store/marveen-land.sh' in its
   * own argv (for the original F-1 test's cmdline-match requirement), so that inherited-fd
   * artifact alone was enough to satisfy the production check for real, independent of detaching.
   * Closing the outer wrapper's copy before it forks anything removes the artifact at the source,
   * exactly like production does. */
  function runNestedUnderFakeLand(targetPath: string, args: string[], env: Record<string, string>): string {
    const canon = join(productionRootValue(), 'store', '.marveen-land-develop.lock')
    const dir = freshDir()
    const outFile = join(dir, 'nested-out')
    const doneFile = join(dir, 'nested-done')
    const runnerPath = join(dir, 'runner.sh')
    const outerWrapperPath = join(dir, 'detach.sh')
    // Same fix as runDetached: poll for a DONE marker the runner writes as its own last step,
    // never "$OUT has any content" -- fleet-test.sh can write intermediate lines before its
    // final answer, and polling on mere non-empty size races ahead and truncates the capture.
    writeFileSync(runnerPath, `#!/usr/bin/env bash\nset -uo pipefail\nbash "${targetPath}" "$@" >"${outFile}" 2>&1\n: > "${doneFile}"\n`)
    writeFileSync(
      outerWrapperPath,
      `#!/usr/bin/env bash\nset -uo pipefail\neval "exec \${CANON_LOCK_FD}>&-" 2>/dev/null || true\n( setsid bash "${runnerPath}" "$@" </dev/null & )\ndeadline=$((SECONDS + 8))\nwhile [ ! -e "${doneFile}" ] && [ $SECONDS -lt $deadline ]; do sleep 0.02; done\ncat "${outFile}" 2>/dev/null\n`,
    )
    const fakeLandPath = join(dir, 'fake-land.sh')
    writeFileSync(
      fakeLandPath,
      `#!/usr/bin/env bash\nset -uo pipefail\nexec {FD}>>"$CANON"\nflock -n "$FD" || { echo INCONCLUSIVE-CONTENDED; exit 0; }\nCANON_LOCK_FD="$FD" bash "$OUTER_WRAPPER" "$@"\n`,
    )
    return execFileSync('bash', [fakeLandPath, 'store/marveen-land.sh', ...args], {
      encoding: 'utf-8',
      env: { ...process.env, ...env, CANON: canon, OUTER_WRAPPER: outerWrapperPath },
    }).trim()
  }

  it('fixed script: the attacker probe still reports normal nested under a real land-holding ancestor', () => {
    const dir = freshDir()
    const attackerLock = join(dir, 'attacker-controlled.lock')
    const p1Path = writeAttackerChain(SCRIPT)
    const out = runNestedUnderFakeLand(p1Path, ['store/marveen-land.sh'], { LOCKFILE: attackerLock })
    if (out === 'INCONCLUSIVE-CONTENDED') {
      console.warn('F-1 hermeticity (nested): real canonical develop lock was held by someone else -- skipping this round, not a failure')
      return
    }
    expect(out).toBe('normal')
  })

  it('CONTROL (non-vacuity): the F-1 mutant (env-override bypass reinstated) still says land, nested the same way', () => {
    const mutantScript = materializeMutantScript()
    const dir = freshDir()
    const attackerLock = join(dir, 'attacker-controlled.lock')
    const p1Path = writeAttackerChain(mutantScript)
    const out = runNestedUnderFakeLand(p1Path, ['store/marveen-land.sh'], { LOCKFILE: attackerLock })
    if (out === 'INCONCLUSIVE-CONTENDED') {
      console.warn('F-1 hermeticity (nested, mutant): real canonical develop lock was held by someone else -- skipping this round, not a failure')
      return
    }
    expect(out).toBe('land')
  })

  it('CONTROL (non-vacuity): the same F-1 mutant still says land when run detached and standalone (not nested)', () => {
    const mutantScript = materializeMutantScript()
    const dir = freshDir()
    const attackerLock = join(dir, 'attacker-controlled.lock')
    const p1Path = writeAttackerChain(mutantScript)
    const out = runDetached(p1Path, ['store/marveen-land.sh'], { LOCKFILE: attackerLock })
    expect(out).toBe('land')
  })
})

describe('fleet-test.sh timeout message distinguishes a LAND-blocked wait (card e99c3dc1, point 2)', () => {
  it('fleet_test_any_land_ticket_pending: true iff a rank-0 ticket file is present', () => {
    const fnSrc = extractFunction('fleet_test_any_land_ticket_pending')
    const dir = freshDir()
    const run = (): boolean => {
      try {
        execFileSync('bash', ['-c', `${fnSrc}\nfleet_test_any_land_ticket_pending "$1"`, 'driver', dir])
        return true
      } catch {
        return false
      }
    }
    expect(run()).toBe(false) // empty dir
    writeFileSync(join(dir, '1-000000000001.111.1'), '')
    expect(run()).toBe(false) // only a normal (rank 1) ticket
    writeFileSync(join(dir, '0-000000000002.222.2'), '')
    expect(run()).toBe(true) // a land (rank 0) ticket is now present
  })

  it('the timeout branch checks fleet_test_any_land_ticket_pending and names it in its own die() message', () => {
    const codeOnly = SOURCE.split('\n')
      .filter((l) => !/^\s*#/.test(l))
      .join('\n')
    const timeoutGuard = codeOnly.indexOf('-ge "$LOCK_WAIT_SECONDS"')
    const landCheck = codeOnly.indexOf('fleet_test_any_land_ticket_pending "$TREE_TICKET_DIR"')
    const landMessage = codeOnly.indexOf('queued behind a LAND ticket')
    expect(timeoutGuard).toBeGreaterThan(-1)
    expect(landCheck).toBeGreaterThan(timeoutGuard)
    expect(landMessage).toBeGreaterThan(landCheck)
  })

  it('CONTROL: a timeout branch with the land-check deleted is rejected by the same reading', () => {
    const mutant = SOURCE.replace(
      /if fleet_test_any_land_ticket_pending "\$TREE_TICKET_DIR"; then\n\s*die 3 "timed out[^\n]*queued behind a LAND ticket[^\n]*"\n\s*fi\n/,
      '',
    )
    expect(mutant).not.toBe(SOURCE) // the replace must actually have matched something
    const codeOnly = mutant
      .split('\n')
      .filter((l) => !/^\s*#/.test(l))
      .join('\n')
    expect(codeOnly.indexOf('queued behind a LAND ticket')).toBe(-1)
  })
})
