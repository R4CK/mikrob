// Card e3cf26d0 (WhiteHat msg 19821 LOW-2, on d5638d28): the 3 landers that SOURCE the shared
// store/degraded-orchestrator-land-guard-lib.sh (mopsion-land.sh, mopsi-land.sh, and
// cleancore-land.sh -- a symlink to mopsion-land.sh) used a bare `.` with no exit-status check.
// None of these scripts set `set -e`, only `set -uo pipefail`: `-u` aborts on an UNBOUND
// VARIABLE, not on a missing/failed command, so a missing lib left
// check_degraded_orchestrator_guard undefined, the resulting "command not found" did not stop
// the script, and the guard silently never ran -- fail-open on the one failure mode that matters
// most (the check itself cannot run). This pins the fix: each of the 3 names now refuses
// (non-zero, before any git operation) when the lib cannot be sourced.
//
// The real store/ directory is never touched. A scratch dir holds a symlink farm of every
// sibling file the landers source, built from the real store/ dir, MINUS the lib under test --
// `$0` when a script is invoked as `bash <path>` is the path string given, not its resolved
// realpath, so `dirname "$0"` inside the symlinked script still resolves to the scratch dir even
// though the file content was read by following the chain back to the real store/ tree.
import { describe, it, expect, afterEach } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, readdirSync, symlinkSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { STORE_DIR } from '../config.js'

const OMIT = 'degraded-orchestrator-land-guard-lib.sh'
let scratch: string | undefined

afterEach(() => {
  if (scratch) rmSync(scratch, { recursive: true, force: true })
  scratch = undefined
})

function farmWithoutGuardLib(): string {
  scratch = mkdtempSync(join(tmpdir(), 'land-guard-lib-missing-'))
  for (const entry of readdirSync(STORE_DIR)) {
    if (entry === OMIT) continue
    const src = join(STORE_DIR, entry)
    if (statSync(src).isDirectory()) continue // these landers only source flat *.sh siblings
    symlinkSync(src, join(scratch, entry))
  }
  return scratch
}

// Card e3cf26d0 round 4 (cybersec2 LOW, comment 32575): a lib that SOURCES CLEANLY but never
// defines check_degraded_orchestrator_guard (empty/truncated file -- a non-atomic write or
// truncated deploy is enough) is a different trigger than a missing file, and the fix above
// alone does not catch it: `. lib` returns 0, so the `if ! . lib` check never fires.
function farmWithEmptyGuardLib(): string {
  scratch = mkdtempSync(join(tmpdir(), 'land-guard-lib-empty-'))
  for (const entry of readdirSync(STORE_DIR)) {
    const src = join(STORE_DIR, entry)
    if (statSync(src).isDirectory()) continue
    if (entry === OMIT) {
      writeFileSync(join(scratch, entry), '') // sources cleanly, defines nothing
      continue
    }
    symlinkSync(src, join(scratch, entry))
  }
  return scratch
}

function run(dir: string, script: string): { status: number; out: string } {
  try {
    const out = execFileSync('bash', [join(dir, script), '--dry-run', 'no-such-agent-e3cf26d0'], {
      encoding: 'utf-8',
      stdio: 'pipe',
      timeout: 15_000,
    })
    return { status: 0, out }
  } catch (e) {
    const err = e as { status?: number; stdout?: string; stderr?: string }
    return { status: err.status ?? -1, out: String(err.stdout ?? '') + String(err.stderr ?? '') }
  }
}

describe.each(['mopsion-land.sh', 'mopsi-land.sh', 'cleancore-land.sh'])(
  '%s refuses when degraded-orchestrator-land-guard-lib.sh cannot be sourced (card e3cf26d0)',
  (script) => {
    it('refuses with its own die() message, not a later, unrelated failure', () => {
      const dir = farmWithoutGuardLib()
      const { status, out } = run(dir, script)
      expect(status).toBe(3)
      // The marker is the die() call's OWN text, not bash's "No such file or directory" line --
      // that line is present even on the OLD, fail-open code (it still prints to stderr before
      // continuing), so asserting on it alone would pass against the vulnerable script too.
      // Measured: before this card's fix, the old code kept going past the sourcing failure and
      // died later instead, with a DIFFERENT message (and, by the coincidence of this probe's
      // setup, also exit 3) -- proving the check itself is live and not accidentally green only
      // because of that downstream failure's own exit code.
      expect(out).toContain('refusing to land without this check (card e3cf26d0)')
      expect(out).not.toContain('degraded-orchestrator mode is ON')
    })
  },
)

describe.each(['mopsion-land.sh', 'mopsi-land.sh', 'cleancore-land.sh'])(
  '%s refuses when degraded-orchestrator-land-guard-lib.sh sources but defines nothing (card e3cf26d0 round 4)',
  (script) => {
    it('refuses with its own die() message, not a later, unrelated failure', () => {
      const dir = farmWithEmptyGuardLib()
      const { status, out } = run(dir, script)
      expect(status).toBe(3)
      expect(out).toContain('sourced but did not define check_degraded_orchestrator_guard')
      expect(out).not.toContain('degraded-orchestrator mode is ON')
    })
  },
)
