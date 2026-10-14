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
let tmuxTmpDir: string

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
  // Card 55b622b7: a fresh, empty socket directory per test, so `tmux ls` inside the script
  // (step 1, limit-banner check) never sees the REAL fleet tmux server and its live agent panes.
  tmuxTmpDir = mkdtempSync(join(tmpdir(), 'pre-dispatch-tmux-'))
})
afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
  rmSync(tmuxTmpDir, { recursive: true, force: true })
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

/** Run the copied script. Card 55b622b7: tmux is NOT absent on this fleet -- the script's step 1
 *  (limit-banner check) reads whichever tmux server TMUX_TMPDIR points at, and the ambient one is
 *  the REAL fleet server with live agent panes. Point it at this test's own empty tmuxTmpDir (and
 *  drop the inherited TMUX client variable, which only affects "am I attached", not which server
 *  `tmux ls` queries) so step 1 always finds zero sessions here, regardless of real fleet state.
 *  spawnSync, not execFileSync: the script EXITS 0 on a hold, and execFileSync only surfaces stderr
 *  when the command fails -- so the warnings under test would have been invisible. */
function run(): { stdout: string; stderr: string } {
  const env: NodeJS.ProcessEnv = { ...process.env, TMUX_TMPDIR: tmuxTmpDir }
  delete env.TMUX
  const r = spawnSync('bash', [script], { encoding: 'utf-8', env })
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

const hasTmux = spawnSync('tmux', ['-V']).status === 0

describe('the warnings above do not depend on the live fleet tmux state (card 55b622b7, F1 fix 366ebbb2)', () => {
  // Card 17905a6d's comment assumed tmux is absent in the test env. It is not: this fleet's
  // agents run in real tmux panes on the ambient server, and the script's step 1 (limit-banner
  // check) reads THAT server unless isolated. Measured on origin/develop @ 2952e71b: 4/6 tests in
  // this file went red whenever any live agent pane carried a limit banner, because step 1's
  // DISPATCH:HOLD:limit-banner(...) exits before step 2 (the warnings under test) ever runs.
  //
  // Card 366ebbb2 (55b622b7 WhiteHat2 F1): the original fix for the above created its fake-banner
  // session on the REAL live fleet tmux server, briefly visible there (~1-30s) to six other fleet
  // consumers that scan `^agent-` sessions (pre-dispatch HOLD, quota-limit-monitor, quota-check
  // restart probe). This version never touches the real server: it points THIS TEST PROCESS's own
  // ambient tmux env (not just the env handed to the script under test) at a private decoy
  // directory, then creates the fake-banner session there. That preserves the mutation property
  // (requirement 2 below) without ever creating a session the real fleet can see: if run()'s own
  // isolation (its explicit TMUX_TMPDIR override) were removed, spawnSync would fall back to
  // inheriting this process's env -- which is now the decoy, so the test still turns red for the
  // right reason, never by touching the live server.
  const sessionName = `agent-pdwtest-${process.pid}`
  let decoyTmuxTmpDir: string
  let origTmuxTmpDir: string | undefined
  let origTmux: string | undefined

  beforeEach(() => {
    decoyTmuxTmpDir = mkdtempSync(join(tmpdir(), 'pre-dispatch-decoy-ambient-'))
    origTmuxTmpDir = process.env.TMUX_TMPDIR
    origTmux = process.env.TMUX
    process.env.TMUX_TMPDIR = decoyTmuxTmpDir
    delete process.env.TMUX
  })

  afterEach(() => {
    spawnSync('tmux', ['kill-session', '-t', sessionName])
    if (origTmuxTmpDir === undefined) delete process.env.TMUX_TMPDIR
    else process.env.TMUX_TMPDIR = origTmuxTmpDir
    if (origTmux !== undefined) process.env.TMUX = origTmux
    rmSync(decoyTmuxTmpDir, { recursive: true, force: true })
  })

  function waitForPaneText(text: string, timeoutMs = 2000): boolean {
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      const r = spawnSync('tmux', ['capture-pane', '-t', sessionName, '-p', '-S', '-20'], {
        encoding: 'utf-8',
      })
      if (String(r.stdout ?? '').includes(text)) return true
      spawnSync('sleep', ['0.05'])
    }
    return false
  }

  // F2 (card 366ebbb2): a machine without tmux installed must skip, not fail.
  ;(hasTmux ? it : it.skip)(
    'still surfaces the stage-2 warning with a fake limit banner on a private decoy ambient server',
    () => {
      writeState({ thresholds: { newDevStop: 99, testStop: 10 }, percent: 50, flagActive: false })
      // Named "agent-..." (matches the script's own `^agent-|^mikrob-channels$` filter), created on
      // THIS process's now-decoy ambient server (see beforeEach) -- never the real fleet server.
      const started = spawnSync('tmux', [
        'new-session', '-d', '-s', sessionName, 'bash', '-c',
        'printf "Session limit reached. Upgrade your plan.\\n"; sleep 30',
      ])
      expect(started.status).toBe(0)
      expect(waitForPaneText('Session limit reached')).toBe(true)

      const { stdout, stderr } = run()
      // If run()'s tmux isolation failed, step 1 would hit this session and exit here instead.
      expect(stdout).not.toContain('DISPATCH:HOLD:limit-banner')
      expect(stderr).toContain('REJECTED as non-monotonic')
    },
  )
})
