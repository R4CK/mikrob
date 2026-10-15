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
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const REPO_ROOT = join(import.meta.dirname, '..', '..')
const SCRIPT = join(REPO_ROOT, 'scripts', 'muszertar', 'titok-kapu.py')

describe('titok-kapu.py --onteszt runs in CI (card 09117e0a M2/N6)', () => {
  it('passes its own self-test (0 bukas)', () => {
    const out = execFileSync('python3', [SCRIPT, '--onteszt'], { encoding: 'utf-8', timeout: 60_000 })
    expect(out).toMatch(/OSSZESEN: 0 bukas\./)
  })

  it('P1 pin: the bare-file-args branch (run_gate path) does not let TITOK-KAPU-KIVETEL exempt a real-shaped secret', () => {
    // main() resolves its own root from __file__ (_marveen_root() has no override, by design --
    // that is exactly what M1 closed), so this test must not point it at the real, SHARED
    // checkout at all: two fleet-test.sh runs can share that checkout (CLAUDE.md rule 17, up to 2
    // concurrent slots) and race each other's throwaway store/.dashboard-token fixture there
    // (measured: fleet-test.sh --ref 469f041a failed on exactly that race). Instead, copy the
    // script (a symlink would not do -- Path.resolve() follows a symlink back to the real
    // checkout, confirmed empirically) into its own throwaway root at the same relative depth, so
    // __file__ resolution lands entirely inside this test's own tempdir and nothing else can ever
    // touch its store/.dashboard-token.
    const dir = mkdtempSync(join(tmpdir(), 'titok-kapu-p1-'))
    try {
      const scriptDir = join(dir, 'scripts', 'muszertar')
      mkdirSync(scriptDir, { recursive: true })
      const sandboxScript = join(scriptDir, 'titok-kapu.py')
      copyFileSync(SCRIPT, sandboxScript)
      mkdirSync(join(dir, 'store'), { recursive: true })
      writeFileSync(join(dir, 'store', '.dashboard-token'), 'x'.repeat(64) + '\n')

      const file = join(dir, 'sandbox.txt')
      writeFileSync(file, 'kulcs = "sk-ant-api03-' + 'A'.repeat(30) + '9zQ"  # TITOK-KAPU-KIVETEL\n')
      let status = 0
      try {
        execFileSync('python3', [sandboxScript, file], { encoding: 'utf-8', timeout: 30_000 })
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
  })

  it('M2p pin: a missing dashboard-token file is a HARD ERROR (exit 2) in file-argument mode, not a silent skip', () => {
    // RedHat NO-GO M2p (card 09117e0a, komment 18915): vizsgal_szoveg()'s fail_closed=True
    // default is what makes main()'s file-args branch (the one run_gate() actually calls) abort
    // with TITOK-KAPU HIBA when the fleet's own dashboard-token is unreadable, instead of quietly
    // running the regex checks alone as if nothing were missing (fail-open). Same isolated-copy
    // sandbox as the P1 pin above, deliberately WITHOUT a store/.dashboard-token this time.
    const dir = mkdtempSync(join(tmpdir(), 'titok-kapu-m2p-'))
    try {
      const scriptDir = join(dir, 'scripts', 'muszertar')
      mkdirSync(scriptDir, { recursive: true })
      const sandboxScript = join(scriptDir, 'titok-kapu.py')
      copyFileSync(SCRIPT, sandboxScript)
      // store/ is deliberately NOT created: no .dashboard-token anywhere under this sandbox root.

      const file = join(dir, 'clean.txt')
      writeFileSync(file, 'hello world, nothing secret here\n')
      let status = 0
      let stderr = ''
      try {
        execFileSync('python3', [sandboxScript, file], { encoding: 'utf-8', timeout: 30_000 })
      } catch (err) {
        const e = err as { status?: number; stderr?: string }
        status = e.status ?? -1
        stderr = e.stderr ?? ''
      }
      expect(
        status,
        'a missing fleet dashboard-token must stop the call (exit 2), not fall through as if the ' +
          'live-token check never existed -- if this is 0, vizsgal_szoveg()\'s fail_closed default flipped to False',
      ).toBe(2)
      expect(stderr).toMatch(/TITOK-KAPU HIBA/)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
