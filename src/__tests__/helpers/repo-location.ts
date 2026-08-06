// Where is THIS checkout? (card 252e36d3)
//
// Several suites assert that hook registration SUCCEEDS -- that a scaffold writes a PreToolUse entry,
// that isUnsafeHookCommand accepts a real script path, that the boot-prune leaves a good file alone.
// All of them derive the script path from this file's own location, so their premise is "the checkout
// lives somewhere durable".
//
// That premise is FALSE when the suite runs from a /tmp worktree, and the failure is the product
// working CORRECTLY: after the 2026-07-14 fleet-freeze incident (a second checkout in /tmp wrote hook
// paths into the shared ~/.claude/settings.json; reboot cleared /tmp; every UserPromptSubmit then
// blocked), the registration guard REFUSES any /tmp-rooted hook command. So from a /tmp checkout the
// guard rejects its own scripts and 13 tests go red for a reason that has nothing to do with the code
// under test.
//
// This bit us for real: a red "14 failing tests at HEAD" baseline was reported and tracked as a
// quality defect, when 13 of the 14 were purely an artifact of measuring inside a /tmp worktree. Only
// 1 was a genuine failure. Hence: the affected suites SKIP with a stated reason instead of failing,
// and each file carries an always-running meta-test that says out loud whether it was armed -- a CI
// log must never be silently ambiguous about which of the two happened.
//
// WHERE TO RUN THE SUITE: a git worktree OUTSIDE /tmp, e.g.
//   git worktree add --detach ~/mikrob-test HEAD && ln -s <install>/node_modules ~/mikrob-test/
// The live install refuses to run the suite at all (separate guard), so a worktree is required; it
// just must not be under /tmp.

import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

/** Repo root of the checkout this test file belongs to. */
export const REPO_ROOT = resolve(join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..'))

/** True when this checkout lives under a temp dir, so hook-registration assertions cannot hold. */
export const REPO_UNDER_TMP = /^\/(tmp|var\/folders|private\/var\/folders)\//.test(REPO_ROOT)

/** Reason string for a skipped suite -- always printed, never a silent skip. */
export const TMP_SKIP_REASON =
  `checkout is under a temp dir (${REPO_ROOT}); the /tmp hook-registration guard ` +
  'correctly rejects its own script paths there, so these assertions cannot hold. ' +
  'Run the suite from a worktree outside /tmp.'
