// Card fa5ef179 -- the governance gate could be bypassed by INPUT SIZE ALONE.
//
// Cybersec measured it while gating f16b3165 and correctly called it pre-existing: the gate reached
// the right DENY, but at 96 KB it took 10.36 s and at 130 KB 19.54 s, while the hook is registered
// with `timeout: 10` and the caller treats a timed-out hook as NON-blocking. So a large inert filler
// pushed the evaluation past the deadline and the real payload was allowed unexamined.
//
// TWO SEPARATE THINGS ARE FIXED HERE, and the distinction matters for what these tests pin:
//   1. the CAUSE -- an accidental quadratic in the path-prefix pattern (`(?:\S*\/)?` scanning to
//      end-of-input at every position on space-free text). Removing it is what closes the bypass.
//   2. a BACKSTOP -- a fail-closed size ceiling, so that if some future pattern reintroduces an
//      amplification, the input an attacker may feed it is bounded. It denies rather than allowing,
//      which is the opposite of what the timeout does.
//
// The root cause BELOW both of these -- that a timed-out governance hook fails OPEN at all -- is a
// fleet-wide behaviour change and is Peti's call, raised separately. These tests deliberately do not
// assume it changes.
import { describe, expect, it } from 'vitest'
import { execFileSync } from 'node:child_process'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
// @ts-expect-error -- plain .mjs hook script, no types
import { gateDecision } from '../../scripts/self-pace-gate.mjs'

const SCHED = 'cron' + 'tab -'
const GATE = join(dirname(dirname(dirname(fileURLToPath(import.meta.url)))), 'scripts', 'self-pace-gate.mjs')

// The reported attack shape: inert filler with no whitespace, then a real scheduler call.
const attack = (segments: number): string => ':|'.repeat(segments) + ':;' + SCHED

const decide = (command: string): { deny: boolean; reason?: string } =>
  gateDecision('Bash', { command }) as { deny: boolean; reason?: string }

describe('the reported bypass: a large inert filler must not outrun the hook deadline', () => {
  it.each([
    ['48k segments (~96KB, measured 10.36s before)', 48000],
    ['65k segments (~130KB, measured 19.54s before)', 65000],
  ])('%s still DENIES, and fast enough to matter', (_name, segments) => {
    const cmd = attack(segments)
    const t0 = Date.now()
    const verdict = decide(cmd)
    const elapsed = Date.now() - t0
    // The verdict was always correct -- it just arrived too late to be applied.
    expect(verdict.deny, 'the gate must still reach DENY on this input').toBe(true)
    // The registered hook timeout is 10s. A 2s ceiling leaves a wide margin for a loaded machine
    // while still failing loudly if the quadratic ever returns (it was 10-19s).
    expect(elapsed, `took ${elapsed}ms; the hook timeout is 10000ms and the caller fails OPEN`).toBeLessThan(2000)
  })

  it('scales roughly LINEARLY, which is the property that actually prevents the bypass', () => {
    // A time bound alone can be met by a fast machine while the shape is still quadratic. Doubling
    // the input must not quadruple the work: measured 4x per doubling before the fix, ~2x after.
    const small = attack(16000)
    const large = attack(32000)
    const t1 = Date.now(); decide(small); const ms1 = Math.max(1, Date.now() - t1)
    const t2 = Date.now(); decide(large); const ms2 = Math.max(1, Date.now() - t2)
    expect(ms2 / ms1, `doubling the input multiplied the work by ${(ms2 / ms1).toFixed(1)}x`).toBeLessThan(3)
  })
})

describe('the fail-closed size ceiling (the backstop)', () => {
  it('DENIES a command larger than the ceiling instead of examining it', () => {
    const verdict = decide('echo ' + 'a'.repeat(1048600))
    expect(verdict.deny).toBe(true)
    // The reason is what lets the hook explain itself; a size refusal reported as a self-pace
    // violation would send the reader after the wrong bug.
    expect(verdict.reason).toBe('oversized')
  })

  it('leaves everything below the ceiling completely untouched', () => {
    expect(decide('echo ' + 'a'.repeat(1048500)).deny).toBe(false)
    expect(decide('ls -la').deny).toBe(false)
    expect(decide(`curl -sS -d @- http://x <<'J'\n${SCHED}\nJ`).deny).toBe(false)
    // ...and a real invocation under the ceiling is still caught on its merits, not its size.
    expect(decide(SCHED).deny).toBe(true)
  })

  it('measures BYTES, not UTF-16 units, because the work being bounded is over bytes', () => {
    // A 3-byte-per-character string is over the ceiling well before its String.length is.
    const multibyte = 'echo ' + 'é'.repeat(600000) // 2 bytes each -> ~1.2MB
    expect(decide(multibyte).reason).toBe('oversized')
  })
})

describe('the LIVE hook, not just the exported function', () => {
  it('emits a real deny envelope with an actionable message for an oversized command', () => {
    // deny() exits 0 and signals through a JSON envelope on stdout, so an exit-code check would
    // report every case as allowed. Read the envelope.
    const payload = JSON.stringify({ tool_name: 'Bash', tool_input: { command: 'echo ' + 'a'.repeat(1048600) } })
    const out = execFileSync(process.execPath, [GATE], { input: payload, encoding: 'utf-8' })
    const parsed = JSON.parse(out) as { hookSpecificOutput?: { permissionDecision?: string; permissionDecisionReason?: string } }
    expect(parsed.hookSpecificOutput?.permissionDecision).toBe('deny')
    const reason = parsed.hookSpecificOutput?.permissionDecisionReason ?? ''
    // Rule 12: the message must say what happened and what to do instead, not just refuse.
    expect(reason).toContain('Tul nagy')
    expect(reason.toLowerCase()).toContain('fajlba')
  })
})

describe('the path-prefix narrowing changed performance, NOT detection', () => {
  // The fix replaced `(?:\S*\/)?` with a bounded class. A narrower class matches fewer things and
  // could therefore deny LESS -- the direction that opens holes -- so every path spelling an
  // invocation can wear is pinned here. A 180-shape before/after sweep showed zero verdict changes
  // in either direction; these are the representative cases.
  it.each([
    ['bare', SCHED],
    ['absolute path', `/usr/bin/${SCHED}`],
    ['relative path', `./tools/${SCHED}`],
    ['inside an absolute-path shell wrapper', `/usr/local/bin/bash -c "${SCHED}"`],
    ['inside a relative-path shell wrapper', `./tools/sh -c '${SCHED}'`],
    ['piped into an absolute-path shell', `echo "${SCHED}" | /usr/local/bin/bash`],
    ['here-string into an absolute-path shell', `/usr/bin/bash <<< "${SCHED}"`],
    ['process substitution into an absolute-path shell', `/usr/local/bin/bash <(echo "${SCHED}")`],
  ])('still denies: %s', (_name, cmd) => {
    expect(decide(cmd).deny).toBe(true)
  })

  it.each([
    ['reading form with an absolute path', '/usr/bin/cron' + 'tab -l'],
    ['neutral absolute-path wrapper', '/usr/local/bin/bash -c "echo hi"'],
    ['legit payload through an absolute-path curl', `/usr/bin/curl -sS -d @- http://x <<'J'\n${SCHED}\nJ`],
  ])('still allows: %s', (_name, cmd) => {
    expect(decide(cmd).deny).toBe(false)
  })
})
