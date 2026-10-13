/**
 * D1 static-assertion tests for scripts/verify-channels-health.sh
 *
 * These are STRUCTURAL tests (not behavioral) — they grep the real script file
 * for required patterns (and the absence of the old broken pattern) without
 * executing it.  Full behavioral verification requires tmux mocking and a
 * live process tree, which is out of scope for this unit layer.
 *
 * AC source: docs/channel-watchdog-prompt.md D1 — Definition of Done
 *
 *   D1-DoD-1: The global `pgrep -af 'bun server.ts'` fallback is removed entirely.
 *   D1-DoD-2: Session-absent path fails with a note and fail=1 (not silently passes).
 *   D1-DoD-3: Only descendants of the pane PID are considered — the walk uses
 *             pgrep -P rooted at #{pane_pid}.
 *   D1-DoD-4: CLAUDE_PID derivation (lines for --channels plugin:) is preserved
 *             for checks (b) and (c).
 */

import { describe, it, expect } from 'vitest'
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { tmpdir } from 'node:os'
import { execFileSync } from 'node:child_process'

const __dirname = dirname(fileURLToPath(import.meta.url))
// PROJECT_ROOT two directories up from src/__tests__
const SCRIPT_PATH = join(__dirname, '../../scripts/verify-channels-health.sh')

function readScript(): string {
  return readFileSync(SCRIPT_PATH, 'utf-8')
}

describe('D1 — verify-channels-health.sh static assertions', () => {

  // D1-DoD-1: The old global fallback must not appear anywhere in the script.
  // Mental-revert evidence: if the old fallback were reintroduced, this test
  // would fail because the forbidden pattern would be present in the script.
  it("D1-DoD-1: does NOT contain the old global 'pgrep -af bun server.ts' fallback", () => {
    const src = readScript()
    // The old offending line was: pgrep -af 'bun server.ts' | awk '{print $1}' | head -1
    // Match broadly: any pgrep with -af and 'bun server.ts' (not rooted at a specific PID).
    expect(src).not.toMatch(/pgrep\s+-af\s+'bun server\.ts'/)
    // Also ensure the original awk extraction pattern from the global scan is gone.
    expect(src).not.toMatch(/pgrep -af.*bun server\.ts.*awk/)
  })

  // D1-DoD-2: When the session is not found, the script must fail with a note
  // and set fail=1. The pane-absent guard uses `tmux list-panes -t "$SESSION"`.
  it('D1-DoD-2: has session-absent guard that sets fail=1 when pane PID is empty', () => {
    const src = readScript()
    // The guard checks PANE_PID is empty and then notes failure and sets fail=1.
    expect(src).toMatch(/PANE_PID=.*tmux list-panes.*pane_pid/)
    expect(src).toMatch(/-z.*PANE_PID/)
    expect(src).toMatch(/fail=1/)
  })

  // D1-DoD-3: The (a)-check walks descendants of the pane PID using pgrep -P,
  // rooted at the pane shell's PID — never a global scan.
  it('D1-DoD-3: walks process tree rooted at pane PID via pgrep -P', () => {
    const src = readScript()
    // The loop uses pgrep -P $_p to walk descendants.
    expect(src).toMatch(/pgrep\s+-P/)
    // The root variable is the pane PID from tmux list-panes.
    expect(src).toMatch(/#{pane_pid}/)
  })

  // D1-DoD-4: CLAUDE_PID derivation (for checks (b)/(c)) must still be present.
  // The derivation matches '--channels plugin:' in the process list.
  it('D1-DoD-4: preserves CLAUDE_PID derivation for --channels plugin: (used by (b) and (c))', () => {
    const src = readScript()
    expect(src).toMatch(/--channels plugin:/)
    expect(src).toMatch(/CLAUDE_PID/)
  })

  // D1-DoD-5: Script exits 0 only when all checks pass; exits 1 on any failure.
  // The convention is `exit "$fail"` where fail starts at 0.
  it('D1-DoD-5: uses exit "$fail" so 0 = HEALTHY, 1 = any failure', () => {
    const src = readScript()
    expect(src).toMatch(/exit.*\$fail/)
    expect(src).toMatch(/fail=0/)
  })

  // Card d95f71c9 point 4: check (e) flags a running main agent that is missing
  // one of the three respawn-protective env vars, checking KEY presence only
  // (never reading a value, even though none of these three are secret).
  it('check (e): verifies presence of the three respawn-protective env var KEYS without reading values', () => {
    const src = readScript()
    expect(src).toMatch(/CLAUDE_CODE_DISABLE_FEEDBACK_SURVEY/)
    expect(src).toMatch(/CLAUDE_CODE_ENABLE_PROMPT_SUGGESTION/)
    expect(src).toMatch(/CLAUDE_CODE_DISABLE_AGENT_VIEW/)
    // Key-only extraction: cut on the first "=" of each NUL-split environ record,
    // never the raw grep-the-whole-line-with-value pattern check (c) uses for PATH.
    // `cut -z` first (NUL-anchored), THEN tr to newlines (L2 fix, WhiteHat2 NO-GO
    // 17930 on card d95f71c9) -- the reverse order let a newline embedded in some
    // OTHER var's VALUE forge a fake key line.
    expect(src).toMatch(/cut -z -d= -f1/)
    // F2 (WhiteHat2 NO-GO 17930): the MCP_* tuning vars, whose absence was the
    // card's original measured symptom, must be checked too, not just the three
    // CLAUDE_CODE_* vars.
    expect(src).toMatch(/MCP_SERVER_CONNECTION_BATCH_SIZE/)
    expect(src).toMatch(/MCP_CONNECTION_NONBLOCKING/)
    expect(src).toMatch(/MCP_TIMEOUT/)
  })

  // Card d95f71c9 L1/L2: behavioral coverage of the ACTUAL key-extraction pipeline
  // (extracted from the real file by regex, not retyped), run against a synthetic
  // NUL-separated environ blob -- so a regression to the pre-fix (newline-forgeable,
  // key-only-partial) form is caught by execution, not just by text presence.
  describe('check (e) key-extraction pipeline, executed against a synthetic environ', () => {
    function extractPipeline(): string {
      const src = readScript()
      const m = src.match(/_keys="\$\(([^)]*cut -z -d= -f1[^)]*)\)"/)
      expect(m, 'could not find the (e) key-extraction assignment in the real script').toBeTruthy()
      return m![1]
    }

    function runPipeline(environBuf: Buffer): string {
      const dir = mkdtempSync(join(tmpdir(), 'vch-environ-'))
      const environPath = join(dir, 'environ')
      writeFileSync(environPath, environBuf)
      try {
        // The extracted pipeline already redirects from the real (hardcoded)
        // /proc/$CLAUDE_PID/environ path -- point that SAME redirect at the
        // fixture file instead of also appending a second one (a second `<` on
        // the trailing `tr` would bypass `cut` entirely, reading the raw file
        // unprocessed -- caught exactly this way on the first version of this test).
        const cmd = extractPipeline().replace('"/proc/$CLAUDE_PID/environ"', `"${environPath}"`)
        const out = execFileSync('bash', ['-c', cmd])
        return out.toString()
      } finally {
        rmSync(dir, { recursive: true, force: true })
      }
    }

    it('finds every real key, including the MCP_* set', () => {
      const buf = Buffer.from(
        [
          'CLAUDE_CODE_DISABLE_FEEDBACK_SURVEY=1',
          'CLAUDE_CODE_ENABLE_PROMPT_SUGGESTION=false',
          'CLAUDE_CODE_DISABLE_AGENT_VIEW=1',
          'MCP_SERVER_CONNECTION_BATCH_SIZE=10',
          'MCP_CONNECTION_NONBLOCKING=1',
          'MCP_TIMEOUT=60000',
        ].join('\0') + '\0',
      )
      const keys = runPipeline(buf).split('\n').filter(Boolean)
      expect(keys).toEqual([
        'CLAUDE_CODE_DISABLE_FEEDBACK_SURVEY',
        'CLAUDE_CODE_ENABLE_PROMPT_SUGGESTION',
        'CLAUDE_CODE_DISABLE_AGENT_VIEW',
        'MCP_SERVER_CONNECTION_BATCH_SIZE',
        'MCP_CONNECTION_NONBLOCKING',
        'MCP_TIMEOUT',
      ])
    })

    it('an embedded newline inside another var\'s VALUE cannot forge a fake key line (L2)', () => {
      // SOME_VAR's value itself contains a newline followed by a string shaped
      // exactly like the var this check requires -- if the pipeline converted to
      // newlines BEFORE splitting on '=', this forged line would read as a real
      // key and the missing-var check would wrongly pass.
      const buf = Buffer.from(
        ['SOME_VAR=before\nCLAUDE_CODE_DISABLE_FEEDBACK_SURVEY=forged', 'REAL_ONE=1'].join('\0') + '\0',
      )
      const keys = runPipeline(buf).split('\n').filter(Boolean)
      expect(keys).not.toContain('CLAUDE_CODE_DISABLE_FEEDBACK_SURVEY')
      expect(keys).toEqual(['SOME_VAR', 'REAL_ONE'])
    })

    it('a genuinely missing key is absent from the extracted set', () => {
      const buf = Buffer.from(['CLAUDE_CODE_DISABLE_AGENT_VIEW=1'].join('\0') + '\0')
      const keys = runPipeline(buf).split('\n').filter(Boolean)
      expect(keys).not.toContain('CLAUDE_CODE_DISABLE_FEEDBACK_SURVEY')
      expect(keys).not.toContain('MCP_TIMEOUT')
    })
  })
})
