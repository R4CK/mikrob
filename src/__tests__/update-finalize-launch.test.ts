import { describe, it, expect } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, chmodSync, symlinkSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

// cf8d047a (MEDIUM F1, source 3caa7e9f CYBERSEC GO 1dec4841): the `A || B &` launcher
// used to run the finalizer a SECOND time whenever the FIRST run's own exit code was
// non-zero -- `systemd-run --scope` relays the wrapped command's exit status, and the
// finalizer legitimately exits 1/6 on a failed/rolled-back update. Measured with the
// real store/update-finalize.sh: a rollback flipped the result file from
// rolled-back/6 back to success/0 a moment later, sent two contradicting
// notifications, and restarted services a third time.
//
// The fix: the finalizer writes "$RESULT_FILE.started" as its very first statement,
// and the launcher's fallback only runs when that marker is ABSENT (systemd-run never
// got the finalizer running at all), not merely when the first attempt exited non-zero.
//
// The block is extracted VERBATIM from update.sh and run in bash with setsid and
// systemd-run stubbed on PATH, so the test measures the shipped text.

const ROOT = join(__dirname, '..', '..')
const UPDATE_SH = readFileSync(join(ROOT, 'update.sh'), 'utf-8')

function extractBlock(): string {
  const start = UPDATE_SH.indexOf('rm -f "$RESULT_FILE.started"')
  expect(start, 'finalizer-launch block not found in update.sh').toBeGreaterThan(-1)
  const end = UPDATE_SH.indexOf('\n\necho ""\n', start)
  expect(end, 'block end marker not found').toBeGreaterThan(start)
  return UPDATE_SH.slice(start, end)
}

/** Runs the block with stubbed setsid/systemd-run and a controllable fake finalizer. */
function run(opts: {
  systemdRun?: 'forward' | 'fail-to-launch' | 'absent'
  finalizeExitCode?: number
}): { startedCount: number, resultFileStarted: boolean } {
  const dir = mkdtempSync(join(tmpdir(), 'update-finalize-launch-'))
  const bin = join(dir, 'bin')
  mkdirSync(bin)
  mkdirSync(join(dir, 'store'))

  // This box has a REAL /usr/bin/systemd-run (WSL), so a plain `PATH="$bin:/usr/bin:/bin"`
  // would silently defeat the 'absent' case -- `command -v systemd-run` would find the
  // real binary and exercise the if-branch's (possibly failing) real bus connection
  // instead of the elif setsid-only branch the test name promises. Build a curated PATH
  // with only the few external commands the block actually needs, symlinked from the
  // real ones, so 'absent' means absent regardless of what else is installed.
  const safeBin = join(dir, 'safe-bin')
  mkdirSync(safeBin)
  for (const cmd of ['bash', 'touch', 'rm']) {
    symlinkSync(`/usr/bin/${cmd}`, join(safeBin, cmd))
  }
  const pathEntries = opts.systemdRun === 'absent' ? [bin, safeBin] : [bin, safeBin, '/usr/bin', '/bin']

  writeFileSync(join(bin, 'setsid'), '#!/bin/bash\nexec "$@"\n', { mode: 0o755 })
  chmodSync(join(bin, 'setsid'), 0o755)

  if (opts.systemdRun === 'forward') {
    // Real systemd-run --scope: strips its own flags, execs the wrapped command, and
    // relays ITS exit code -- the exact behavior that makes the old `||` ambiguous.
    writeFileSync(join(bin, 'systemd-run'), `#!/bin/bash
args=()
for a in "$@"; do
  case "$a" in
    --user|--scope|--collect|--quiet) continue ;;
    *) args+=("$a") ;;
  esac
done
exec "\${args[@]}"
`, { mode: 0o755 })
    chmodSync(join(bin, 'systemd-run'), 0o755)
  } else if (opts.systemdRun === 'fail-to-launch') {
    // systemd-run itself never got the finalizer running (e.g. no dbus session) --
    // the marker is never written.
    writeFileSync(join(bin, 'systemd-run'), '#!/bin/bash\nexit 1\n', { mode: 0o755 })
    chmodSync(join(bin, 'systemd-run'), 0o755)
  }
  // 'absent': no systemd-run on PATH at all -> the elif setsid-only branch runs.

  const resultFile = join(dir, 'store', 'update.last-result')
  const callLog = join(dir, 'store', 'finalize-calls.log')
  const finalizeScript = join(dir, 'store', 'update-finalize.sh')
  writeFileSync(finalizeScript, `#!/bin/bash
RESULT_FILE="$5"
touch "$RESULT_FILE.started"
echo "RAN" >> "${callLog}"
exit ${opts.finalizeExitCode ?? 0}
`, { mode: 0o755 })
  chmodSync(finalizeScript, 0o755)

  const script = `
set -eu
PATH="${pathEntries.join(':')}"
INSTALL_DIR="${dir}"
RESULT_FILE="${resultFile}"
BUILT_COMMIT_FILE="${dir}/store/built-commit"
OLD_VERSION_FULL="old-full"; OLD_VERSION="old"; NEW_VERSION="new"
NODE_PIN_DIR=""
FINALIZE_SCRIPT="${finalizeScript}"
FINALIZE_ARGS=("$INSTALL_DIR" "$OLD_VERSION_FULL" "$OLD_VERSION" "3420" "$RESULT_FILE" "$BUILT_COMMIT_FILE" "$NEW_VERSION" "$NODE_PIN_DIR" "0")
FINALIZE_LOG="${dir}/store/update-finalize.log"
XDG_RUN="/run"
${extractBlock()}
wait
echo "REACHED_END"
`
  execFileSync('/bin/bash', ['-c', script], { encoding: 'utf-8' })

  let calls = ''
  try { calls = readFileSync(callLog, 'utf-8') } catch { /* no calls at all */ }
  const startedCount = calls.split('\n').filter((l) => l === 'RAN').length
  let resultFileStarted = false
  try { readFileSync(`${resultFile}.started`, 'utf-8'); resultFileStarted = true } catch { /* absent */ }
  return { startedCount, resultFileStarted }
}

describe('update.sh finalizer launch (cf8d047a)', () => {
  it('normal success: runs exactly once', () => {
    const r = run({ systemdRun: 'forward', finalizeExitCode: 0 })
    expect(r.startedCount).toBe(1)
    expect(r.resultFileStarted).toBe(true)
  })

  it('THE BUG THIS FIXES -- rollback (exit 6): still runs exactly once, not twice', () => {
    const r = run({ systemdRun: 'forward', finalizeExitCode: 6 })
    expect(r.startedCount).toBe(1)
    expect(r.resultFileStarted).toBe(true)
  })

  it('failed (exit 1), finalizer itself ran: still runs exactly once, not twice', () => {
    const r = run({ systemdRun: 'forward', finalizeExitCode: 1 })
    expect(r.startedCount).toBe(1)
  })

  it('systemd-run never launches anything: the fallback runs it exactly once', () => {
    const r = run({ systemdRun: 'fail-to-launch' })
    expect(r.startedCount).toBe(1)
    expect(r.resultFileStarted).toBe(true)
  })

  it('no systemd-run on PATH at all: the setsid-only branch runs it exactly once', () => {
    const r = run({ systemdRun: 'absent' })
    expect(r.startedCount).toBe(1)
  })
})
