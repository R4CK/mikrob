// vitest `globalSetup` (card 5dcde7d3): runs ONCE, in the main process, before any worker starts
// -- unlike `setupFiles`, which vitest's default per-file isolation re-runs for EVERY test file
// (see assert-not-live-install.ts's own comment: "gates every worker"). That is exactly the
// timestamp assert-not-live-install.ts needs and could not get on its own: "when did THIS `vitest
// run` invocation start", stamped once, in one place, before the marker it is being asked to
// judge could possibly exist yet.
//
// WHY THIS EXISTS. Three independent, exhaustive instrumentation passes (initDatabase/
// initIngestDb call-site logging, a Module._load wrap of better-sqlite3's constructor, and an
// LD_PRELOAD libc interception of the entire open/rename/link family) each verified themselves
// working against real, known-legitimate opens, and each caught ZERO real opens of the live
// store/claudeclaw.db across multiple reliable reproductions of the flotta-wide block. MikroB's
// call (card 5dcde7d3): treat that as evidence the marker check itself cannot currently
// distinguish "a genuine live install" from "something this run's own suite left behind mid-run
// through a path none of the three methods could see" -- and fix THAT distinction structurally,
// rather than keep hunting for a write that resists every instrument aimed at it so far.
//
// The sentinel is written to a FIXED, checkout-derived path in the OS tmpdir (not under the
// checkout's own store/, which is exactly the directory under suspicion) so both this file (run
// once, main process) and assert-not-live-install.ts (run per-file, worker processes) can find it
// independently -- no IPC, no shared module state across process boundaries.
import { writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createHash } from 'node:crypto'

export function sentinelPathFor(repoRoot: string): string {
  const hash = createHash('sha256').update(repoRoot).digest('hex').slice(0, 16)
  return join(tmpdir(), `marveen-suite-run-start-${hash}`)
}

export default function globalSetup(): void {
  const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..')
  writeFileSync(sentinelPathFor(repoRoot), String(Date.now()))
}
