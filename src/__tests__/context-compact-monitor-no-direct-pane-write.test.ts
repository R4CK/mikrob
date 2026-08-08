// Card 9cfed589 (Cybered's cron-shell-pane-writers survey, 7560bb6a/3325f71): this monitor wrote
// straight into a tmux pane from a scheduled-task process, the SAME race fleet-nudger.sh had
// (card 7560bb6a, see fleet-nudger-no-direct-pane-write.test.ts) -- an in-process pane mutex
// cannot reach a separate process, and the old line sent the text and the Enter as two calls with
// a `sleep 1` between them, a full second in which another writer's keystrokes could land in the
// middle of '/compact'.
//
// This is NOT a copy-paste of the nudger fix: /api/messages wraps every delivery with a
// "[Uzenet @X-tol ...]" trusted-peer prefix (agent-message-wrap.ts), so a literal '/compact' sent
// through it would arrive as prose, not as the built-in slash command Claude Code only recognizes
// as the first thing typed into an idle input. The fix here is POST /api/agents/:name/compact
// instead -- a new route mirroring the existing /api/agents/:name/auth/init, which already sends a
// literal '/login' the same way, through sendPromptToSession's in-process pane lock.
//
// Asserted against the script text: there is no unit to import, and the property IS textual.
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'store', 'context-compact-monitor.sh')
const src = readFileSync(SCRIPT, 'utf-8')
/** Lines that actually run, so a mention inside an explanatory comment does not count as a write. */
const code = src
  .split('\n')
  .filter((l) => !/^\s*#/.test(l))
  .join('\n')

describe('context-compact-monitor.sh never writes into a pane directly (card 9cfed589)', () => {
  it('sends no keystrokes to any tmux pane', () => {
    // The exact regression: this is the line the card's survey flagged as still open.
    expect(code, 'the monitor is writing into a pane again -- an in-process lock cannot reach a scheduled-task process').not.toMatch(
      /tmux[^\n]*send[-\s]keys/,
    )
  })

  it('has no sleep between a text write and an Enter -- the one-second interleave window', () => {
    expect(code).not.toMatch(/send[-\s]keys[^\n]*;\s*sleep/)
  })

  it('delivers through the agent-scoped compact API instead', () => {
    // Positive half: without it, deleting the fix entirely would pass the two checks above.
    expect(code).toMatch(/\/api\/agents\/\$\{?agent\}?\/compact/)
    expect(code).toMatch(/-X POST/)
  })

  it('never puts the bearer token in argv', () => {
    // The pre-existing property (card edb7559f): /proc/<pid>/cmdline is world-readable. The
    // request must keep using the 0600 header file already set up for the token-usage refresh.
    expect(code).not.toMatch(/-H\s+['"]?Authorization:/)
    expect(code).toMatch(/-H "@\$HDR_FILE"/)
  })

  it('skips the compact rather than crashing when no token is available', () => {
    // Under `set -u`, an unguarded reference to an unset HDR_FILE would abort the WHOLE run (every
    // remaining agent in the loop), not just this one compact.
    expect(code).toMatch(/HDR_FILE=""/)
    expect(code).toMatch(/\[\s*-z\s*"\$HDR_FILE"\s*\]/)
  })

  it('still resolves the ceiling reading from the DB before acting -- the fix did not remove the guard rails', () => {
    expect(code).toContain('token_usage')
    expect(code).toContain('COOLDOWN')
  })
})
