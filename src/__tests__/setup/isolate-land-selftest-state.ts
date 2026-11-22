// GLOBAL SUITE SEAM: no land/gate selftest may reach the live dashboard, the live
// gate-check endpoint, or the live store/land-runs.jsonl journal by default.
//
// Card 1634bf55 (CYBERED NO-GO, comment 37616, F-1/F-2). The card's first fix only
// edited the two files it suspected (store-selftests-all-run.test.ts's
// execWithKillRetry, landing-downward-check.test.ts's selftest() + two describes).
// Two more files it never touched -- src/__tests__/agent-worktree-marveen.test.ts and
// src/__tests__/landing-gate-verdict-check.test.ts -- spawn real land/gate scripts via
// a plain `{ ...process.env, ... }` without ever setting KANBAN_COMMENT_API/
// KANBAN_COMMENT_TOKEN_FILE/GATE_CHECK_API/GATE_CHECK_TOKEN_FILE/LAND_RUN_JOURNAL_FILE,
// so they inherit whatever this worker's ambient env happens to be -- during a
// fleet-test, that is the REAL dashboard and the REAL journal (measured by cybered:
// agent-worktree-marveen alone reproduced the exact 3-message shape of live messages
// 23383-23385 and appended 64 rows to the journal; landing-gate-verdict-check appended
// 8 more). A per-file fix only covers the file someone remembers to edit -- this is the
// "Strukturális védelem a fegyelem helyett" fix instead: force every worker's own
// process.env dead for these keys before any test module imports (wired as a vitest
// `setupFiles` entry, see vitest.config.ts), so a plain `{ ...process.env, X }` spread
// anywhere in the suite inherits dead values. A specific test that wants a working
// stub still wins: it re-points one of these keys afterward in its OWN call's env
// object, and that spread is applied after process.env, same as before this file
// existed.
export const DEAD_LAND_SELFTEST_ENV = Object.freeze({
  KANBAN_COMMENT_API: 'http://127.0.0.1:1',
  KANBAN_COMMENT_TOKEN_FILE: '/nonexistent/no-such-dir/no-token',
  GATE_CHECK_API: 'http://127.0.0.1:1',
  GATE_CHECK_TOKEN_FILE: '/nonexistent/no-such-dir/no-token',
  LAND_RUN_JOURNAL_FILE: '/nonexistent/no-such-dir/land-runs.jsonl',
})

// Exported (not just a module-load side effect) so the proof test can call the REAL
// mechanism directly against a simulated ambient leak, instead of redefining its own
// copy of these values -- a copy would stay green if this file's logic broke, which is
// exactly what F-3 found wrong with the card's first proof test.
export function applyDeadLandSelftestEnv(env: NodeJS.ProcessEnv = process.env): void {
  for (const [key, value] of Object.entries(DEAD_LAND_SELFTEST_ENV)) {
    env[key] = value
  }
}

applyDeadLandSelftestEnv()
