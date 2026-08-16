// pre-dispatch-check.sh operator warnings (card 17905a6d, two Cybersec LOW findings).
//
// (1) A hand-edited, NON-MONOTONIC threshold file was silently rejected: the operator believed their
//     numbers were in force while the defaults were.
// (2) The hard-stop FLAG is fail-open by design (a corrupt flag must not park the whole fleet), but
//     PARKING is driven by that flag -- so a corrupt one means dispatch is correctly held while nobody
//     parks, and the fleet burns the shared quota idle-but-running. The script computes the same
//     verdict itself, so it can at least SAY the two disagree.
//
// The script is copied into a temp directory with fixture state files, so these run against the real
// script without touching the live store.
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { spawnSync } from 'node:child_process'
import { copyFileSync, mkdtempSync, rmSync, writeFileSync, chmodSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'

const STORE_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'store')
const REAL = join(STORE_DIR, 'pre-dispatch-check.sh')

let dir: string
let script: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'pre-dispatch-'))
  script = join(dir, 'pre-dispatch-check.sh')
  copyFileSync(REAL, script)
  chmodSync(script, 0o755)
  // The script sources $STORE/session-limit-pattern.sh, where $STORE is its OWN dirname (card
  // 115c21e7) -- since $0 resolves to this temp copy, the sibling must be copied alongside it too,
  // the same way the fixture state files below are, or the script dies on `source` under
  // `set -euo pipefail` before it ever reaches the logic under test.
  copyFileSync(join(STORE_DIR, 'session-limit-pattern.sh'), join(dir, 'session-limit-pattern.sh'))
  copyFileSync(join(STORE_DIR, 'session-limit-pattern.json'), join(dir, 'session-limit-pattern.json'))
})
afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

const writeState = (o: {
  thresholds?: Record<string, number>
  percent?: number
  flagActive?: boolean
}) => {
  if (o.thresholds) writeFileSync(join(dir, 'weekly-threshold-config.json'), JSON.stringify(o.thresholds))
  if (o.percent !== undefined) {
    writeFileSync(join(dir, 'weekly-usage.json'), JSON.stringify({ percent: o.percent, reset: '' }))
  }
  if (o.flagActive !== undefined) {
    writeFileSync(
      join(dir, 'weekly-hard-stop.json'),
      JSON.stringify({ active: o.flagActive, percent: o.percent ?? 0, testStop: 97 }),
    )
  }
}

/** Run the copied script; tmux is absent in the test env, which the script tolerates.
 *  spawnSync, not execFileSync: the script EXITS 0 on a hold, and execFileSync only surfaces stderr
 *  when the command fails -- so the warnings under test would have been invisible. */
function run(): { stdout: string; stderr: string } {
  const r = spawnSync('bash', [script], { encoding: 'utf-8' })
  return { stdout: String(r.stdout ?? ''), stderr: String(r.stderr ?? '') }
}

describe('a rejected threshold file is not silent (finding 2)', () => {
  it('WARNS that a non-monotonic config was rejected, naming both numbers', () => {
    writeState({ thresholds: { newDevStop: 99, testStop: 10 }, percent: 50, flagActive: false })
    const { stderr } = run()
    expect(stderr).toContain('REJECTED as non-monotonic')
    expect(stderr).toContain('99')
    expect(stderr).toContain('10')
    expect(stderr).toContain('90/97') // and says what is in force instead
  })

  it('warns ONCE, not once per threshold lookup', () => {
    writeState({ thresholds: { newDevStop: 99, testStop: 10 }, percent: 50, flagActive: false })
    const occurrences = run().stderr.split('REJECTED as non-monotonic').length - 1
    expect(occurrences).toBe(1)
  })

  it('says NOTHING when the config is valid', () => {
    writeState({ thresholds: { newDevStop: 90, testStop: 97 }, percent: 50, flagActive: false })
    expect(run().stderr).not.toContain('REJECTED')
  })
})

describe('a flag that disagrees with our own verdict is reported (finding 1)', () => {
  it('WARNS when we compute a hard stop but the flag is not active', () => {
    // The dangerous state: dispatch is held (this script decides that itself), but the parking logic
    // reads the flag -- so nobody parks and the fleet burns quota idle-but-running.
    writeState({ thresholds: { newDevStop: 90, testStop: 97 }, percent: 98, flagActive: false })
    const { stdout, stderr } = run()
    expect(stderr).toContain('role agents may NOT be parked')
    expect(stdout).toContain('HARD-STOP') // the primary control still holds dispatch
  })

  it('does NOT warn when the flag already agreed', () => {
    writeState({ thresholds: { newDevStop: 90, testStop: 97 }, percent: 98, flagActive: true })
    expect(run().stderr).not.toContain('may NOT be parked')
  })

  it('does not warn below the hard-stop level', () => {
    writeState({ thresholds: { newDevStop: 90, testStop: 97 }, percent: 92, flagActive: false })
    const { stdout, stderr } = run()
    expect(stderr).not.toContain('may NOT be parked')
    expect(stdout).toContain('new-dev-stop') // held for new dev only, gates still run
  })
})
