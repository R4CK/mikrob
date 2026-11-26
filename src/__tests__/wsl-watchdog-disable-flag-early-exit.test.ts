// Card 035d02fc: startup.sh's early exit on store/.wsl-watchdog-disabled is the primary defense
// against a manual Disable being silently undone at the next logon (card 58badae1 B2) -- it means
// a deliberately disabled watchdog does not even re-render its files, let alone re-register the
// Scheduled Task. That early exit was shipped (58badae1) but never pinned by any test: a rewrite
// that drops the check, or that calls the installer unconditionally before/regardless of it, would
// have gone unnoticed until the next real Disable window. startup.sh runs real systemctl/dashboard
// calls at live logon, so this pins the SOURCE (same static-text approach already used for the
// umask drop-in wiring in this file's sibling), not an executed run.
import { describe, it, expect } from 'vitest'
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const REPO_ROOT = join(import.meta.dirname, '..', '..')
const SCRIPT = join(REPO_ROOT, 'scripts', 'startup.sh')

// card 035d02fc, item D ("the selftest is not run anywhere"): install-wsl-watchdog.selftest.sh
// lives under scripts/, not store/, so store-selftests-all-run.test.ts's store/*.selftest.sh glob
// never discovers it -- every one of its 70+ cases (including the F1 set-e regression, the N-iso
// /mnt/ escape guards, and the OK-match/N2 pins added by this card) was correct and green but
// never actually invoked by anything that runs in CI. Wiring it here closes that gap directly,
// the same way umask-dropin.test.ts wires its own store/ selftest.
describe('install-wsl-watchdog.selftest.sh actually runs', () => {
  // Card 3f6bb903: the selftest now exercises real subprocesses (dry-run
  // re-renders, backgrounded `sleep infinity` processes for the holder-ensure
  // behavioural checks) on top of its existing ~90 static-text-pin checks --
  // normally ~1.5s, but under shared fleet-test CPU contention it can exceed
  // vitest's 5000ms DEFAULT test timeout even though execFileSync's own
  // timeout option below was already set to 120s (the intent was always to
  // allow a slow run; only the vitest-level timeout was never raised to match).
  it('passes when invoked', () => {
    const out = execFileSync(
      'bash',
      [join(REPO_ROOT, 'scripts', 'install-wsl-watchdog.selftest.sh')],
      { encoding: 'utf-8', timeout: 120_000 },
    )
    expect(out).toContain('PASS')
    expect(out).not.toContain('FAIL')
  }, 120_000)
})

describe('startup.sh: WSL watchdog disable-flag early exit', () => {
  const src = readFileSync(SCRIPT, 'utf-8')
  const lines = src.split('\n')

  it('checks store/.wsl-watchdog-disabled before doing anything else with the installer', () => {
    const checkIdx = lines.findIndex((l) => l.includes('store/.wsl-watchdog-disabled'))
    const installIdx = lines.findIndex((l) => l.includes('install-wsl-watchdog.sh'))
    expect(checkIdx, 'disable-flag check not found in startup.sh').toBeGreaterThan(-1)
    expect(installIdx, 'install-wsl-watchdog.sh reference not found in startup.sh').toBeGreaterThan(-1)
    expect(checkIdx).toBeLessThan(installIdx)
  })

  it('the disabled branch never reaches the installer call (pinned as an if/else, not two ifs)', () => {
    const checkLineIdx = lines.findIndex((l) => /if \[ -f "\$INSTALL_DIR\/store\/\.wsl-watchdog-disabled" \]/.test(l))
    expect(checkLineIdx, 'exact disable-flag if-guard line not found verbatim').toBeGreaterThan(-1)
    // The next non-empty, non-comment line inside this guard's scope must be a log line, and the
    // installer call must live under its own `else`, not a second independent `if`, or a mutant
    // that drops the `else` (making both branches run unconditionally) would stay invisible to a
    // substring-only check.
    const scopedTail = lines.slice(checkLineIdx).join('\n')
    expect(scopedTail).toContain('else\n')
    const elseIdx = checkLineIdx + lines.slice(checkLineIdx).findIndex((l) => l.trim() === 'else')
    const installIdxAfterElse = lines.slice(elseIdx).findIndex((l) => l.includes('install-wsl-watchdog.sh'))
    expect(installIdxAfterElse, 'install-wsl-watchdog.sh call not found inside the else branch').toBeGreaterThan(-1)
  })

  it('logs the skip distinctly, referencing the originating card', () => {
    expect(src).toContain('skipping (card 58badae1 B2)')
  })

  it('install-wsl-watchdog.sh independently re-checks the same flag (defense in depth)', () => {
    const installer = readFileSync(join(REPO_ROOT, 'scripts', 'install-wsl-watchdog.sh'), 'utf-8')
    expect(installer).toContain('DISABLE_FLAG')
    expect(installer).toContain('.wsl-watchdog-disabled')
  })
})
