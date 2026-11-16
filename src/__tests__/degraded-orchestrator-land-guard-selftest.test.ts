// Card d5638d28 round 3 (RedHat NO-GO 32245 F4a): store/degraded-orchestrator-land-guard.selftest.sh
// runs the REAL marveen-land.sh against real fixtures, and it only guards anything if it actually
// runs -- same reason as decisions-tail-append-guard-selftest.test.ts, whose header explains the
// pattern. Before this test, nothing in src/, scripts/, fleet-test.sh or package.json referenced
// the selftest, so a regression (the marveen-land guard-call removal, the widened actor allowlist)
// stayed red ONLY when someone ran it by hand.
import { describe, it, expect } from 'vitest'
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

const REPO_ROOT = join(import.meta.dirname, '..', '..')
const SCRIPT = join(REPO_ROOT, 'store', 'degraded-orchestrator-land-guard.selftest.sh')

describe('degraded-orchestrator-land-guard.selftest.sh', () => {
  it('the script exists', () => {
    expect(existsSync(SCRIPT)).toBe(true)
  })

  it('its selftest passes -- real marveen-land.sh, real fixtures', () => {
    const out = execFileSync('bash', [SCRIPT], { encoding: 'utf-8', timeout: 60_000 })
    expect(out).toMatch(/\d+ passed, 0 failed/)
    expect(out).not.toContain('FAIL case')
  }, 60_000)

  // Card d5638d28 round 3 (RedHat NO-GO 32245 F4b): marveen-land.sh does NOT source
  // degraded-orchestrator-land-guard-lib.sh (contrary to the lib's own header, which the lib
  // itself does not claim -- it is a separate, hand-kept-equal copy for the inline version).
  // mopsion-land.sh and mopsi-land.sh DO source it. Since there is no single source for
  // marveen-land.sh's own copy, pin the two copies' `degraded_orchestrator_is_on` function bodies
  // byte-for-byte equal (ignoring only the DEGRADED_ORCHESTRATOR_SWITCH default-path literal,
  // which legitimately differs: marveen-land.sh's own $MAIN-relative default vs the lib's
  // hardcoded /home/neon/marveen path) -- so a fix applied to one copy and forgotten in the other
  // (exactly the class of bug this card exists for) fails this test, not just a live gate.
  it('marveen-land.sh\'s inline degraded_orchestrator_is_on is byte-equal to the shared lib copy', () => {
    const extractFn = (src: string): string => {
      const start = src.indexOf('degraded_orchestrator_is_on() {')
      expect(start).toBeGreaterThan(-1)
      const end = src.indexOf('\n}\n', start)
      expect(end).toBeGreaterThan(start)
      return src.slice(start, end)
    }
    const landSrc = readFileSync(join(REPO_ROOT, 'store', 'marveen-land.sh'), 'utf-8')
    const libSrc = readFileSync(join(REPO_ROOT, 'store', 'degraded-orchestrator-land-guard-lib.sh'), 'utf-8')
    expect(extractFn(landSrc)).toBe(extractFn(libSrc))
  })

  it('mopsion-land.sh and mopsi-land.sh source the shared lib', () => {
    for (const lander of ['mopsion-land.sh', 'mopsi-land.sh']) {
      const src = readFileSync(join(REPO_ROOT, 'store', lander), 'utf-8')
      expect(src).toContain('degraded-orchestrator-land-guard-lib.sh')
      expect(src).toContain('check_degraded_orchestrator_guard')
    }
  })
})
