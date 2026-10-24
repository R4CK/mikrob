// GLOBAL SUITE SEAM: no test may reach the operator's real ~/.ssh by default.
//
// ENROLL813 (2026-09-15). `POST /api/security/bridge-enroll` calls bridgeEnroll()
// with no deps, so it resolved homedir()/.ssh -- and bridge-enroll.test.ts has one
// branch ("Positive control on the same route") that hits that route BEFORE the
// file sets MARVEEN_SSH_DIR. Every full suite run therefore enrolled exactly one
// REAL `marveen-remote` key, and stayed green while doing it: the branch's only
// assertion (`not.toMatch(/Invalid host/)`) is satisfied by a SUCCESSFUL
// enrollment just as well as by the refusal it meant to rule out. 62 keys piled
// up across the fleet before anyone looked (three installs: 13, 51 and 4).
//
// Why the existing live-install gate could not have caught this -- worth stating,
// because it makes this file look redundant next to assert-not-live-install.ts:
// that gate inspects the CHECKOUT (store/.dashboard-token & co in the repo root)
// and tells you to run from a clean worktree under your HOME. But ~/.ssh is
// HOME-scoped, not checkout-scoped. Following its advice to the letter still
// wrote the operator's authorized_keys. A checkout-scoped gate cannot protect a
// home-scoped asset; this seam is the home-scoped half.
//
// This seam alone would NOT have prevented all 62 keys, and the measurement says
// so: with this file ON and the fail-closed guards OFF, the original test file
// still wrote one key to the real ~/.ssh/authorized_keys (13 tests green). The
// reason is the original afterEach, which does an unconditional
// `delete process.env.MARVEEN_SSH_DIR` -- that drops the suite-level default
// after the first test, and the positive control then falls back to the home
// directory. Point 4 of the PR body describes the same hole; this comment used
// to contradict it.
//
// What actually holds is the combination: this seam, PLUS the afterEach that
// restores the previous value instead of deleting it, PLUS the fail-closed
// guards in src/ssh-dir.ts and src/remote-enroll-fs.ts. It is a setupFile (every
// worker, before any test module imports) rather than a per-file beforeEach
// somebody can forget, which is what gives it the reach -- not sufficiency.
//
// Scoped, not blanket: an existing MARVEEN_SSH_DIR is respected, so a test that
// wants its own directory keeps it.
import { existsSync, mkdirSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

function isPidAlive(pid: number): boolean {
  if (existsSync('/proc')) return existsSync(`/proc/${pid}`)
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

// WhiteHat F1 (card 2564e877, gate on 87fd2f19): VITEST_POOL_ID restarts at 1 for every
// `vitest run`, so two CONCURRENT full-suite runs (CLAUDE.md rule 17 allows up to 2 at
// once) land on the same w1/w2/... path -- the entry-time rmSync below then wipes the
// OTHER run's directory mid-run, a false red unrelated to any real test failure.
// runId namespaces by the invoking run (process.ppid, stable across a run's workers,
// distinct between separate `vitest run` invocations) so slot reuse only collides within
// a single run, same as before. Exported so default-ssh-dir-seam.test.ts can call it
// directly without re-triggering the module's own side effect below.
export function resolveSeamDir(
  root: string = join(tmpdir(), 'marveen-ssh-seam'),
  runId: string = String(process.ppid || process.pid)
): string {
  // Prune directories left by runs whose main process is gone, so the per-run
  // namespacing above doesn't bring back the unbounded accumulation this seam was
  // built to avoid (1813 stale dirs, measured 2026-09-15, see below).
  try {
    for (const entry of readdirSync(root)) {
      const m = /^r(\d+)$/.exec(entry)
      if (!m || m[1] === runId || isPidAlive(Number(m[1]))) continue
      rmSync(join(root, entry), { recursive: true, force: true })
    }
  } catch {
    // root does not exist yet -- nothing to prune
  }
  // VITEST_POOL_ID is the pool slot, documented as 1..maxWorkers; process.pid is the
  // fallback for a runner that does not set it. The segment is sanitised because it
  // ends up in a path.
  const slot = (process.env.VITEST_POOL_ID || String(process.pid)).replace(/[^A-Za-z0-9_-]/g, '_')
  return join(root, `r${runId}`, `w${slot}`)
}

if (!process.env.MARVEEN_SSH_DIR) {
  // Bounded and reused, NOT mkdtemp. The first version of this file made a fresh
  // random directory per worker and cleaned it from a `process.on('exit')` hook.
  // That hook does not fire in vitest's per-file isolated workers, so one full
  // suite run left one empty /tmp/marveen-ssh-seam-* directory per test FILE --
  // 436 of them for 443 files -- and 1813 had piled up unnoticed by the time
  // anyone counted (both measured 2026-09-15).
  // Shipping that would have been this PR's own thesis -- silent accumulation
  // nobody looks at -- reproduced inside the fix for it.
  const seamDir = resolveSeamDir()
  // Cleared on ENTRY, not on exit. Two things follow from that, both wanted:
  // a slot is handed to the next test file once this one is done, and wiping it
  // here is what keeps one file's authorized_keys out of the next file's
  // assertions -- without depending on a hook that never runs. Concurrent
  // workers never share a slot WITHIN a run, so no worker can wipe another
  // worker's directory; resolveSeamDir's runId namespacing keeps separate
  // concurrent RUNS apart too (F1 above).
  rmSync(seamDir, { recursive: true, force: true })
  mkdirSync(seamDir, { recursive: true })
  process.env.MARVEEN_SSH_DIR = seamDir
}
