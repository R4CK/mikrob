import { describe, it, expect } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, chmodSync, symlinkSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

// d9f33249 (QA2 FAIL 27050 / cybersec2 27053): the finalizer-launch block only
// took the scope-protected branch (systemd-run --user --scope) when
// `[ -d "$XDG_RUN" ]` passed. The `${XDG_RUNTIME_DIR:-default}` fallback only
// fires when XDG_RUNTIME_DIR is UNSET or EMPTY -- a caller that sets it to a
// WRONG, non-empty value skipped the fallback, failed the `-d` check, and fell
// into the elif/plain-setsid branch with no cgroup escape: killed by
// `systemctl --user restart` under any KillMode other than process (measured
// on a real transient systemd --user unit, see d9f33249 REVIEW).
//
// The fix re-derives the real default ("/run/user/$(id -u)") whenever the
// externally-supplied value is not a usable directory, so the scope-protected
// branch is still used whenever a working runtime dir genuinely exists.
//
// Extracted VERBATIM from update.sh (the XDG_RUN re-derivation plus the full
// finalizer-launch decision), run in bash with setsid/systemd-run stubbed, so
// the test measures the shipped text, not a paraphrase of it.
//
// Relies on a REAL /run/user/<uid> existing on this host (true of every fleet
// box, which runs under systemd --user) -- same environmental assumption the
// sibling test (update-finalize-launch.test.ts) already documents for the
// real /usr/bin/systemd-run it also depends on.

const ROOT = join(__dirname, '..', '..')
const UPDATE_SH = readFileSync(join(ROOT, 'update.sh'), 'utf-8')

function extractBlock(): string {
  const start = UPDATE_SH.indexOf('XDG_RUN="${XDG_RUNTIME_DIR:-/run/user/$(id -u 2>/dev/null)}"')
  expect(start, 'XDG_RUN computation not found in update.sh').toBeGreaterThan(-1)
  const end = UPDATE_SH.indexOf('\n\necho ""\n', start)
  expect(end, 'block end marker not found').toBeGreaterThan(start)
  return UPDATE_SH.slice(start, end)
}

/** Runs the block with a caller-supplied XDG_RUNTIME_DIR, a recording systemd-run stub, real setsid. */
function run(opts: { xdgRuntimeDir: string | undefined }): { tookScopeBranch: boolean, finalizeRan: boolean } {
  const dir = mkdtempSync(join(tmpdir(), 'update-finalize-xdg-redrive-'))
  const bin = join(dir, 'bin')
  mkdirSync(bin)
  mkdirSync(join(dir, 'store'))

  const safeBin = join(dir, 'safe-bin')
  mkdirSync(safeBin)
  for (const cmd of ['bash', 'touch', 'rm', 'setsid', 'id']) {
    symlinkSync(`/usr/bin/${cmd}`, join(safeBin, cmd))
  }

  const resultFile = join(dir, 'store', 'update.last-result')
  const callLog = join(dir, 'store', 'finalize-calls.log')
  const scopeInvokedFile = join(dir, 'store', 'systemd-run-invoked')
  const finalizeScript = join(dir, 'store', 'update-finalize.sh')
  writeFileSync(finalizeScript, `#!/bin/bash
RESULT_FILE="$5"
touch "$RESULT_FILE.started"
echo "RAN" >> "${callLog}"
exit 0
`, { mode: 0o755 })
  chmodSync(finalizeScript, 0o755)

  // Records that it was invoked, then behaves like the real `systemd-run
  // --user --scope ...`: strips its own flags and execs the wrapped command.
  // This is what lets the test tell "scope branch attempted" apart from
  // "elif/plain-setsid branch, systemd-run never called at all" -- the real
  // binary's own success/failure (D-Bus availability) is irrelevant to that
  // question, and stubbing it keeps the test deterministic across hosts.
  writeFileSync(join(bin, 'systemd-run'), `#!/bin/bash
touch "${scopeInvokedFile}"
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

  const envAssign = opts.xdgRuntimeDir === undefined ? 'unset XDG_RUNTIME_DIR' : `XDG_RUNTIME_DIR="${opts.xdgRuntimeDir}"`

  const script = `
set -eu
PATH="${bin}:${safeBin}:/usr/bin:/bin"
${envAssign}
INSTALL_DIR="${dir}"
RESULT_FILE="${resultFile}"
BUILT_COMMIT_FILE="${dir}/store/built-commit"
OLD_VERSION_FULL="old-full"; OLD_VERSION="old"; NEW_VERSION="new"
NODE_PIN_DIR=""
FINALIZE_SCRIPT="${finalizeScript}"
FINALIZE_ARGS=("$INSTALL_DIR" "$OLD_VERSION_FULL" "$OLD_VERSION" "3420" "$RESULT_FILE" "$BUILT_COMMIT_FILE" "$NEW_VERSION" "$NODE_PIN_DIR" "0")
${extractBlock()}
wait
echo "REACHED_END"
`
  execFileSync('/bin/bash', ['-c', script], { encoding: 'utf-8' })

  let calls = ''
  try { calls = readFileSync(callLog, 'utf-8') } catch { /* no calls at all */ }
  const tookScopeBranch = (() => { try { readFileSync(scopeInvokedFile, 'utf-8'); return true } catch { return false } })()
  return { tookScopeBranch, finalizeRan: calls.includes('RAN') }
}

describe('update.sh finalizer launch: XDG_RUN re-derivation (d9f33249)', () => {
  it('unset XDG_RUNTIME_DIR: falls back to the real default, takes the scope branch', () => {
    const r = run({ xdgRuntimeDir: undefined })
    expect(r.tookScopeBranch).toBe(true)
    expect(r.finalizeRan).toBe(true)
  })

  it('THE BUG THIS FIXES -- bogus non-empty XDG_RUNTIME_DIR: re-derives the real default, still takes the scope branch', () => {
    const r = run({ xdgRuntimeDir: '/nonexistent/stale-xdg-runtime-dir' })
    expect(r.tookScopeBranch).toBe(true)
    expect(r.finalizeRan).toBe(true)
  })

  it('valid, real XDG_RUNTIME_DIR: used as-is, takes the scope branch', () => {
    const r = run({ xdgRuntimeDir: process.env.XDG_RUNTIME_DIR ?? `/run/user/${process.getuid?.() ?? 0}` })
    expect(r.tookScopeBranch).toBe(true)
    expect(r.finalizeRan).toBe(true)
  })
})
