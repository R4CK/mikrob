// Card 8ab5eef3: the default tmux server died 9 times in one day from "Reload requested"
// journal bursts tied to `systemctl --user daemon-reload` calls reachable from the test suite.
// 54765aa6 fixed the first one (store/ensure-umask-dropin.sh); this card found and sealed the
// rest. Every test-reachable daemon-reload must go through a SYSTEMCTL_BIN-style override seam
// (same pattern as store/ensure-umask-dropin.sh and scripts/gpu-crashloop-guard.sh's
// GPU_GUARD_SYSTEMCTL) so a selftest can stub the real binary instead of hitting the live user
// bus. This guard fails if a NEW bare `systemctl --user daemon-reload` call lands in any of these
// files without going through its seam.
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const REPO_ROOT = join(import.meta.dirname, '..', '..')

// Files known to call `systemctl --user daemon-reload` for real (not just in a comment, an echo
// string, or a test's own stub/log-grep), each with the override var it must use.
const SEAMED_FILES: Array<{ file: string; seamVar: string }> = [
  { file: 'store/ensure-umask-dropin.sh', seamVar: 'SYSTEMCTL_BIN' },
  { file: 'scripts/gpu-crashloop-guard.sh', seamVar: 'SYSTEMCTL' },
  { file: 'scripts/migrate-main-agent-id.sh', seamVar: 'SYSTEMCTL_BIN' },
  { file: 'scripts/retire-progress-watchdog.sh', seamVar: 'SYSTEMCTL_BIN' },
  { file: 'scripts/install-guard-timers.sh', seamVar: 'SYSTEMCTL_BIN' },
  { file: 'scripts/install-mopsion-suite-guard-timer.sh', seamVar: 'SYSTEMCTL_BIN' },
  { file: 'scripts/install-telegram-progress-hook.sh', seamVar: 'SYSTEMCTL_BIN' },
]

describe('systemctl --user daemon-reload: every real call goes through its seam (card 8ab5eef3)', () => {
  for (const { file, seamVar } of SEAMED_FILES) {
    it(`${file}: defines the ${seamVar} override and never calls bare systemctl for daemon-reload`, () => {
      const src = readFileSync(join(REPO_ROOT, file), 'utf-8')
      expect(src, `${file} must define ${seamVar}="\${${seamVar}:-systemctl}"`).toContain(`${seamVar}:-systemctl`)

      // Any line that actually ISSUES daemon-reload must call it via the seam var ("$SEAM" or
      // "${SEAM}"), not the bare word `systemctl`. Lines are comments (#...), echo'd advice
      // strings, or the seam's own default-assignment are excluded by shape, not by name, so a
      // real new bare call elsewhere in the file still trips this.
      const bareCalls = src
        .split('\n')
        .filter((l) => /daemon-reload/.test(l))
        .filter((l) => !/^\s*#/.test(l))
        .filter((l) => !new RegExp(`${seamVar}:-systemctl`).test(l))
        .filter((l) => /\bsystemctl\b/.test(l) && !new RegExp(`\\$\\{?${seamVar}\\}?`).test(l))
        // echo/log lines only ever DESCRIBE the command to a human, they do not run it
        .filter((l) => !/^\s*(echo|log|console\.)/.test(l.trim()))

      expect(bareCalls, `bare systemctl daemon-reload call(s) bypassing ${seamVar}:\n${bareCalls.join('\n')}`).toEqual([])
    })
  }

  it('src/__tests__/update-env-allowlist.test.ts proves bus reachability without issuing a reload', () => {
    const src = readFileSync(join(REPO_ROOT, 'src/__tests__/update-env-allowlist.test.ts'), 'utf-8')
    expect(src).not.toMatch(/spawnSync\('systemctl',\s*\['--user',\s*'daemon-reload'\]/)
    expect(src).toContain("spawnSync('systemctl', ['--user', 'show-environment']")
  })
})
