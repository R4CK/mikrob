// Card 09117e0a, RedHat NO-GO M2 (comment 18611): N1's wiring -- main()'s bare-file-args branch
// (the ONLY branch run_gate() actually calls) passing kivetel_aktiv=False to vizsgal_fajl(), so
// the TITOK-KAPU-KIVETEL marker never exempts anything on that path -- had no CI pin. RedHat's P1
// mutant (reverting that one argument back to True) stayed green forever because titok-kapu.py
// lives under scripts/muszertar/, not store/, so store-selftests-all-run.test.ts's `.selftest.`
// discovery structurally never sees it (the N6 gap RedHat itself disclosed). This file closes both
// at once: it runs titok-kapu.py --onteszt in the suite (closing N6), and it pins the exact P1
// wiring with a direct CLI invocation in file-argument mode (closing M2).
import { describe, it, expect } from 'vitest'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const REPO_ROOT = join(import.meta.dirname, '..', '..')
const SCRIPT = join(REPO_ROOT, 'scripts', 'muszertar', 'titok-kapu.py')
const DASH_TOKEN = join(REPO_ROOT, 'store', '.dashboard-token')

describe('titok-kapu.py --onteszt runs in CI (card 09117e0a M2/N6)', () => {
  it('passes its own self-test (0 bukas)', () => {
    const out = execFileSync('python3', [SCRIPT, '--onteszt'], { encoding: 'utf-8', timeout: 60_000 })
    expect(out).toMatch(/OSSZESEN: 0 bukas\./)
  })

  it('P1 pin: the bare-file-args branch (run_gate path) does not let TITOK-KAPU-KIVETEL exempt a real-shaped secret', () => {
    // elo_titkok() runs before the MINTAK scan and is fail-closed by default, which needs the
    // real store/.dashboard-token to exist. A disposable fleet-test checkout usually lacks it
    // (it is untracked), so create a throwaway one ONLY if this checkout doesn't already have
    // it, and remove it again afterward -- an existing file is never touched.
    const createdDashToken = !existsSync(DASH_TOKEN)
    if (createdDashToken) writeFileSync(DASH_TOKEN, 'x'.repeat(64) + '\n')
    try {
      const dir = mkdtempSync(join(tmpdir(), 'titok-kapu-p1-'))
      try {
        const file = join(dir, 'sandbox.txt')
        writeFileSync(file, 'kulcs = "sk-ant-api03-' + 'A'.repeat(30) + '9zQ"  # TITOK-KAPU-KIVETEL\n')
        let status = 0
        try {
          execFileSync('python3', [SCRIPT, file], { encoding: 'utf-8', timeout: 30_000 })
        } catch (err) {
          status = (err as { status?: number }).status ?? -1
        }
        expect(
          status,
          'the marker must NOT exempt a real-shaped secret in file-argument mode (run_gate path) -- ' +
            'if this is 0, main() stopped passing kivetel_aktiv=False to vizsgal_fajl()',
        ).toBe(1)
      } finally {
        rmSync(dir, { recursive: true, force: true })
      }
    } finally {
      if (createdDashToken) unlinkSync(DASH_TOKEN)
    }
  })
})
