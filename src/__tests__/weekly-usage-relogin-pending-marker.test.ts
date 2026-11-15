// A relogin in flight leaves the mikrob-usage-probe panel sitting on a /login dialog, not a
// shell prompt. Before this fix, weekly-usage-panel-read.sh typed "/usage" into that panel on its
// own timer regardless -- measured 2026-10-14: two /login flows in a row died with "Login
// interrupted" because the reader's keystroke landed on the waiting dialog.
//
// Fix v1: weekly-usage-relogin.sh's `start` wrote a pending marker (bare epoch seconds) BEFORE
// touching the panel, and a successful `--paste` cleared it; weekly-usage-panel-read.sh checked
// the marker FIRST, before any tmux call, and skipped while it was fresh (inside
// WU_RELOGIN_PENDING_TTL_SEC).
//
// QA FAIL (card f3343af0, 2026-11-15): that marker could be PLANTED. Nothing tied it to a real
// relogin -- any process able to write a file (store/ is shared-trust) could point
// WU_RELOGIN_PENDING_MARKER at an arbitrary path, or (once we lock the path down) just write to the
// fixed path directly, and keep a fresh epoch forever to suppress every read indefinitely.
//
// Fix v2 (this file): the marker path is FIXED in production -- the env override only takes effect
// under WU_RELOGIN_TEST_MODE=1 -- and a marker is honored only when it is a regular file (not a
// symlink), owned by the current user, mode 0600, and names (line 1) the PID of a process that is
// BOTH alive and whose /proc cmdline contains "weekly-usage-relogin.sh". `start` backgrounds a
// detached --hold-marker child (its own session, via setsid) that writes the marker with ITS OWN
// pid and holds it for up to the TTL, so the pid stays alive for the real duration of a pending
// relogin (which can be minutes -- `start` itself only runs ~15-25s). A successful `--paste` still
// clears the marker; the holder self-expires it on TTL otherwise, and only if the marker still
// names its own pid (so it never clobbers a newer holder's marker).
//
// Driven against a PATH shim for `tmux` (and a no-op `sleep`), same technique as
// weekly-usage-panel-size.test.ts: these cases never touch the real mikrob-usage-probe panel.
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { execFileSync, spawn, spawnSync, type ChildProcess } from 'node:child_process'
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  rmSync,
  chmodSync,
  readFileSync,
  readdirSync,
  existsSync,
  statSync,
  symlinkSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const STORE = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'store')
const READER = join(STORE, 'weekly-usage-panel-read.sh')
const RELOGIN = join(STORE, 'weekly-usage-relogin.sh')

let dir: string
let log: string
let marker: string
let skipStreakFile: string
let holders: ChildProcess[]

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'usage-relogin-pending-'))
  log = join(dir, 'tmux.log')
  marker = join(dir, 'pending-marker')
  // card f3343af0 delta-gate (Cybersec MEDIUM-3): runReader always passes this explicitly, inside
  // this test's own mktemp dir, never the live store/.weekly-usage-relogin-skip-streak -- a stale
  // file there would make the first tick of a REAL relogin escalate immediately.
  skipStreakFile = join(dir, 'skip-streak')
  holders = []
  // Always-succeeding tmux shim: has-session/new-session/send-keys/resize-window all exit 0,
  // capture-pane prints a benign line. Good enough for the "did it even try to touch the panel"
  // and "did start/paste manage the marker" assertions below -- none of these cases need a real
  // login flow or weekly-bar parse.
  writeFileSync(
    join(dir, 'tmux'),
    `#!/usr/bin/env bash
echo "$*" >> "${log}"
case "$1" in
  has-session) exit 0 ;;
  capture-pane) echo "Claude Max  auto mode on" ;;
esac
exit 0
`,
  )
  writeFileSync(join(dir, 'sleep'), '#!/usr/bin/env bash\nexit 0\n')
  chmodSync(join(dir, 'tmux'), 0o755)
  chmodSync(join(dir, 'sleep'), 0o755)
})

afterEach(() => {
  for (const h of holders) {
    try {
      h.kill('SIGKILL')
    } catch {
      /* already gone */
    }
  }
  rmSync(dir, { recursive: true, force: true })
})

function runReader(env: Record<string, string> = {}): { stdout: string; code: number; calls: string[] } {
  let stdout = ''
  let code = 0
  try {
    stdout = execFileSync('bash', [READER], {
      stdio: ['ignore', 'pipe', 'pipe'],
      // Cybersec MEDIUM-3 (card f3343af0 delta-gate): a hang here (e.g. a future change that
      // blocks on an fd the fake tmux shim never closes) must fail the test outright, not hang
      // the whole run red-by-timeout at the CI level. 15s gives headroom over the 10s
      // WU_RELOGIN_FIFO_TIMEOUT_SEC used by the longest-running case below.
      timeout: 15_000,
      env: {
        ...process.env,
        PATH: `${dir}:${process.env.PATH}`,
        WU_RELOGIN_TEST_MODE: '1',
        WU_RELOGIN_PENDING_MARKER: marker,
        WU_RELOGIN_SKIP_STREAK_FILE: skipStreakFile,
        ...env,
      },
    }).toString('utf-8')
  } catch (e) {
    const err = e as { status?: number; stdout?: Buffer }
    code = err.status ?? -1
    stdout = err.stdout ? err.stdout.toString('utf-8') : ''
  }
  const calls = existsSync(log) ? readFileSync(log, 'utf-8').trim().split('\n').filter(Boolean) : []
  return { stdout, code, calls }
}

function runRelogin(mode: string, env: Record<string, string> = {}, input?: string) {
  let stdout = ''
  let stderr = ''
  let code = 0
  try {
    stdout = execFileSync('bash', [RELOGIN, mode], {
      input,
      stdio: [input !== undefined ? 'pipe' : 'ignore', 'pipe', 'pipe'],
      // Cybersec MEDIUM-3 (card f3343af0 delta-gate): same reasoning as runReader -- a hang in
      // `start`'s FIFO handshake must fail the test, not hang the run. 15s gives headroom over
      // the 10s WU_RELOGIN_FIFO_TIMEOUT_SEC used by the longest-running case below.
      timeout: 15_000,
      env: {
        ...process.env,
        PATH: `${dir}:${process.env.PATH}`,
        WU_RELOGIN_TEST_MODE: '1',
        WU_RELOGIN_PENDING_MARKER: marker,
        ...env,
      },
    }).toString('utf-8')
  } catch (e) {
    const err = e as { status?: number; stdout?: Buffer; stderr?: Buffer }
    code = err.status ?? -1
    stdout = err.stdout ? err.stdout.toString('utf-8') : ''
    stderr = err.stderr ? err.stderr.toString('utf-8') : ''
  }
  return { stdout, stderr, code }
}

// Spawns a REAL --hold-marker child against the test marker path, with a long TTL so it stays
// alive for the test's duration, and waits for the marker file to actually land before returning
// its pid. This is the exact production writer (not a fake pid) -- it is what makes the
// "pid alive and names weekly-usage-relogin.sh" cases faithful rather than simulated.
//
// --hold-marker now REFUSES unless it is handed a real handshake FIFO (MEDIUM-1 fix, card
// f3343af0), so this helper sets one up itself and drains it with `cat` the same way `start`'s
// own FIFO write has a reader -- otherwise --hold-marker's `printf x > fifo` would block forever
// with nothing on the other end.
async function spawnHolder(ttlSec = 120): Promise<number> {
  const fifo = join(dir, `hold-fifo-${Math.random().toString(36).slice(2)}`)
  execFileSync('mkfifo', [fifo])
  const drain = spawn('cat', [fifo], { stdio: 'ignore' })
  holders.push(drain)
  const h = spawn('bash', [RELOGIN, '--hold-marker'], {
    env: {
      ...process.env,
      PATH: `${dir}:${process.env.PATH}`,
      WU_RELOGIN_TEST_MODE: '1',
      WU_RELOGIN_PENDING_MARKER: marker,
      WU_RELOGIN_PENDING_TTL_SEC: String(ttlSec),
      WU_RELOGIN_HOLD_SIGNAL_FIFO: fifo,
    },
    stdio: 'ignore',
  })
  holders.push(h)
  for (let i = 0; i < 100; i++) {
    if (existsSync(marker)) break
    await new Promise((r) => setTimeout(r, 20))
  }
  if (!existsSync(marker)) throw new Error('holder never wrote the marker')
  const pid = h.pid
  if (pid === undefined) throw new Error('holder has no pid')
  return pid
}

describe('reader side: pending marker gates the keystroke (card f3343af0)', () => {
  it('a fresh, valid marker (live pid naming this script): SKIP, exit 0, never calls tmux', async () => {
    await spawnHolder()
    const { stdout, code, calls } = runReader()
    expect(stdout).toMatch(/^SKIP: relogin pending/)
    expect(code).toBe(0)
    expect(calls).toHaveLength(0)
  })

  it('an expired marker (older than the TTL): no SKIP, reader proceeds to touch the panel', async () => {
    const pid = await spawnHolder()
    writeFileSync(marker, `${pid}\n${Math.floor(Date.now() / 1000) - 120}\n`, { mode: 0o600 })
    const { stdout, calls } = runReader({ WU_RELOGIN_PENDING_TTL_SEC: '60' }) // shorter than the marker's age -> stale
    expect(stdout).not.toMatch(/SKIP/)
    expect(calls.some((c) => c.includes('has-session'))).toBe(true)
  })

  it('no marker file at all: no SKIP, reader proceeds normally', () => {
    const { stdout, calls } = runReader()
    expect(stdout).not.toMatch(/SKIP/)
    expect(calls.some((c) => c.includes('has-session'))).toBe(true)
  })

  describe('plant case (QA FAIL, card f3343af0 follow-up): a fresh epoch alone is not enough', () => {
    it('a marker with a DEAD pid (process never existed): no SKIP, treated as not-pending', () => {
      // A pid that is astronomically unlikely to be alive, let alone named weekly-usage-relogin.sh.
      writeFileSync(marker, `999999\n${Math.floor(Date.now() / 1000)}\n`, { mode: 0o600 })
      const { stdout, calls } = runReader()
      expect(stdout).not.toMatch(/SKIP/)
      expect(calls.some((c) => c.includes('has-session'))).toBe(true)
    })

    it('a marker naming a LIVE pid whose cmdline does NOT match this script: no SKIP', async () => {
      // This test runner process itself is alive, but its cmdline is node/vitest, not
      // weekly-usage-relogin.sh -- the cmdline check must refuse it even though the pid is real.
      writeFileSync(marker, `${process.pid}\n${Math.floor(Date.now() / 1000)}\n`, { mode: 0o600 })
      const { stdout, calls } = runReader()
      expect(stdout).not.toMatch(/SKIP/)
      expect(calls.some((c) => c.includes('has-session'))).toBe(true)
    })

    it('a marker that is a SYMLINK (even to an otherwise-valid marker): no SKIP', async () => {
      await spawnHolder() // writes a genuinely valid marker at `marker`
      const real = join(dir, 'real-marker')
      const content = readFileSync(marker, 'utf-8')
      rmSync(marker)
      writeFileSync(real, content, { mode: 0o600 })
      symlinkSync(real, marker)
      const { stdout, calls } = runReader()
      expect(stdout).not.toMatch(/SKIP/)
      expect(calls.some((c) => c.includes('has-session'))).toBe(true)
    })

    it('a marker with the right pid+epoch but loose permissions (0644): no SKIP', async () => {
      const pid = await spawnHolder()
      chmodSync(marker, 0o644)
      const { stdout, calls } = runReader()
      expect(stdout).not.toMatch(/SKIP/)
      expect(calls.some((c) => c.includes('has-session'))).toBe(true)
      void pid
    })

    it('the env override is IGNORED outside WU_RELOGIN_TEST_MODE -- resolves to the hardcoded production path', () => {
      // No side effects: --debug-marker-path only prints the path this run would use, it never
      // touches the real marker file, so this is safe to run unconditionally.
      const out = execFileSync('bash', [RELOGIN, '--debug-marker-path'], {
        env: { ...process.env, PATH: `${dir}:${process.env.PATH}`, WU_RELOGIN_PENDING_MARKER: marker },
      })
        .toString('utf-8')
        .trim()
      expect(out).toBe('/home/neon/marveen/store/.weekly-usage-relogin-pending')
      expect(out).not.toBe(marker)
    })

    it('the env override DOES take effect once WU_RELOGIN_TEST_MODE=1 is also set', () => {
      const out = execFileSync('bash', [RELOGIN, '--debug-marker-path'], {
        env: {
          ...process.env,
          PATH: `${dir}:${process.env.PATH}`,
          WU_RELOGIN_TEST_MODE: '1',
          WU_RELOGIN_PENDING_MARKER: marker,
        },
      })
        .toString('utf-8')
        .trim()
      expect(out).toBe(marker)
    })
  })
})

describe('writer side: relogin.sh manages the marker (card f3343af0)', () => {
  it('start writes a fresh pending marker, owned 0600, naming a live pid, before touching the panel', () => {
    runRelogin('start')
    expect(existsSync(marker)).toBe(true)
    const [pidLine, tsLine] = readFileSync(marker, 'utf-8').trim().split('\n')
    expect(Math.abs(Date.now() / 1000 - Number(tsLine))).toBeLessThan(10)
    const pid = Number(pidLine)
    expect(pid).toBeGreaterThan(0)

    const st = statSync(marker)
    expect(st.mode & 0o777).toBe(0o600)

    // The held pid must actually be alive and its cmdline must name this script -- i.e. the
    // marker `start` just wrote must pass the reader's own validity check. `start` itself already
    // drove tmux (ensure_pane + the login flow), so the log is non-empty BEFORE this call -- check
    // the DELTA the reader itself adds, not the file's cumulative content.
    const callsBeforeRead = log && existsSync(log) ? readFileSync(log, 'utf-8').trim().split('\n').filter(Boolean).length : 0
    const { stdout, calls } = runReader()
    expect(stdout).toMatch(/^SKIP: relogin pending/)
    expect(calls.length - callsBeforeRead).toBe(0)

    // Clean up the detached holder so it doesn't outlive the test.
    try {
      process.kill(pid, 'SIGKILL')
    } catch {
      /* already gone */
    }
  })

  it('a successful --paste clears the pending marker', () => {
    runRelogin('start')
    expect(existsSync(marker)).toBe(true)
    const holdPid = Number(readFileSync(marker, 'utf-8').trim().split('\n')[0])
    // capture-pane must report success for the --paste branch to take the clear-marker path.
    writeFileSync(
      join(dir, 'tmux'),
      `#!/usr/bin/env bash
echo "$*" >> "${log}"
case "$1" in
  has-session) exit 0 ;;
  capture-pane) echo "Login successful" ;;
esac
exit 0
`,
    )
    chmodSync(join(dir, 'tmux'), 0o755)
    const { stdout } = runRelogin('--paste', {}, 'ABC123\n')
    expect(stdout).toMatch(/OK: login successful/)
    expect(existsSync(marker)).toBe(false)
    try {
      process.kill(holdPid, 'SIGKILL')
    } catch {
      /* already gone */
    }
  })

  it('a failed --paste leaves the pending marker in place', () => {
    runRelogin('start')
    expect(existsSync(marker)).toBe(true)
    const holdPid = Number(readFileSync(marker, 'utf-8').trim().split('\n')[0])
    writeFileSync(
      join(dir, 'tmux'),
      `#!/usr/bin/env bash
echo "$*" >> "${log}"
case "$1" in
  has-session) exit 0 ;;
  capture-pane) echo "something else entirely" ;;
esac
exit 0
`,
    )
    chmodSync(join(dir, 'tmux'), 0o755)
    runRelogin('--paste', {}, 'ABC123\n')
    expect(existsSync(marker)).toBe(true)
    try {
      process.kill(holdPid, 'SIGKILL')
    } catch {
      /* already gone */
    }
  })

  it('--hold-marker self-expires the marker after the TTL, but only if it still names its own pid', async () => {
    const pid = await spawnHolder(1) // 1s TTL -- but `sleep` is PATH-shimmed to a no-op, so it expires near-instantly
    // Give the holder a moment to run its post-sleep self-expire check.
    for (let i = 0; i < 200 && existsSync(marker); i++) {
      await new Promise((r) => setTimeout(r, 20))
    }
    expect(existsSync(marker)).toBe(false)
    void pid
  })
})

// CYBERSEC GO conditions (comment 31727, card f3343af0): MEDIUM-2 (unbounded FIFO read hangs
// `start` forever if the holder dies before signalling) and MEDIUM-1 (a same-user decoy can keep
// the marker fresh forever, or a bare `--hold-marker &` needs no relogin at all).
describe('MEDIUM-2: the start/hold-marker FIFO handshake is bounded and fails closed (card f3343af0)', () => {
  it('start does not hang, does not touch the panel, and exits non-zero if the holder never signals', () => {
    // Simulate the holder dying before it can signal: `setsid` here never actually runs
    // --hold-marker at all, so nothing ever writes to the handshake FIFO.
    writeFileSync(join(dir, 'setsid'), '#!/usr/bin/env bash\nexit 0\n')
    chmodSync(join(dir, 'setsid'), 0o755)
    const { code } = runRelogin('start', { WU_RELOGIN_FIFO_TIMEOUT_SEC: '1' })
    expect(code).not.toBe(0)
    const calls = existsSync(log) ? readFileSync(log, 'utf-8').trim().split('\n').filter(Boolean) : []
    expect(calls.some((c) => c.includes('has-session'))).toBe(false)
  })

  it('start proceeds normally when the holder signals promptly (control: the timeout itself is not what blocks a healthy run)', async () => {
    // A `setsid` that actually runs --hold-marker (the real production shape), confirming the
    // bound does not false-positive on the happy path. The shimmed tmux here has no OAuth-URL
    // text for capture-pane to find, so `start` still exits non-zero overall (unrelated to this
    // fix) -- what matters is that the handshake succeeded and the panel WAS touched, not stuck.
    runRelogin('start', { WU_RELOGIN_FIFO_TIMEOUT_SEC: '10' })
    const calls = existsSync(log) ? readFileSync(log, 'utf-8').trim().split('\n').filter(Boolean) : []
    expect(calls.some((c) => c.includes('has-session'))).toBe(true)
    // Clean up the detached holder.
    if (existsSync(marker)) {
      const pid = Number(readFileSync(marker, 'utf-8').trim().split('\n')[0])
      try {
        process.kill(pid, 'SIGKILL')
      } catch {
        /* already gone */
      }
    }
  })
})

// FIFO leak (MikroB finding, card f3343af0 follow-up): `start` used to build its handshake FIFO
// with a bare `mktemp -u` path directly in /tmp root. Killing `start` between mkfifo and the old
// rm -f (a test timeout, a fleet-test kill) left that FIFO behind -- measured live: two leaked at
// 14:12 and 14:18, and kg-search.selftest.sh's `grep /tmp/tmp.*` blocked forever on one of them,
// timing out store-selftests-all-run and refusing three unrelated lands. Fix: the FIFO lives inside
// its own mktemp -d, cleaned up by a trap on EXIT/INT/TERM, not by the happy-path rm -f alone.
describe('FIFO leak fix: start cleans up its handshake dir even when killed mid-handshake (card f3343af0 follow-up)', () => {
  it('a SIGKILL mid-handshake never leaves a bare FIFO directly under TMPDIR, and a grep-style scan does not hang on whatever is left', async () => {
    // SIGKILL cannot be trapped or deferred (measured separately: even SIGTERM to `start` itself
    // does not interrupt it while blocked in the foreground `timeout`/`read`, since GNU timeout's
    // monitored child runs in its OWN process group and bash defers trap handling until the
    // foreground command it is waiting on returns) -- so nothing, old code or new, gets to run
    // any cleanup here. What still differs STRUCTURALLY: with the old bare `mktemp -u` path, the
    // thing left at the top level of TMPDIR is the FIFO itself, and kg-search.selftest.sh's own
    // scan pattern (`grep -slF ... /tmp/tmp.*`) opens it and blocks forever on the read (measured
    // live: two such leaks at 14:12 and 14:18 timed out store-selftests-all-run). With the FIFO
    // nested one level inside its own mktemp -d, the top-level leftover is a plain directory,
    // which that same grep skips immediately ("Is a directory") instead of opening.
    writeFileSync(join(dir, 'setsid'), '#!/usr/bin/env bash\nexit 0\n')
    chmodSync(join(dir, 'setsid'), 0o755)
    const tmproot = join(dir, 'tmproot')
    mkdirSync(tmproot)
    const child = spawn('bash', [RELOGIN, 'start'], {
      env: {
        ...process.env,
        PATH: `${dir}:${process.env.PATH}`,
        WU_RELOGIN_TEST_MODE: '1',
        WU_RELOGIN_PENDING_MARKER: marker,
        WU_RELOGIN_FIFO_TIMEOUT_SEC: '30',
        TMPDIR: tmproot,
      },
      stdio: 'ignore',
    })
    holders.push(child)
    // Control: confirm the FIFO dir really was created (under our own isolated TMPDIR, so no
    // concurrent process can produce a false positive) before we kill it mid-handshake.
    let created = false
    for (let i = 0; i < 100; i++) {
      if (readdirSync(tmproot).length > 0) {
        created = true
        break
      }
      await new Promise((r) => setTimeout(r, 20))
    }
    expect(created).toBe(true)
    child.kill('SIGKILL')
    await new Promise((resolve) => child.once('exit', resolve))
    const leftover = readdirSync(tmproot)
    expect(leftover.length).toBeGreaterThan(0) // control: the kill really did leave something behind
    for (const name of leftover) {
      expect(statSync(join(tmproot, name)).isFIFO()).toBe(false)
    }
    // Pin the actual observed symptom directly: a `timeout`-bounded run of the real scan shape
    // must not time out (rc 124) on whatever TMPDIR holds now.
    const scan = spawnSync('bash', ['-c', `timeout 3 grep -slF anything "${tmproot}"/tmp.* 2>/dev/null`])
    expect(scan.status).not.toBe(124)
  })
})

describe('MEDIUM-1a: --hold-marker refuses without a real handshake FIFO from start (card f3343af0)', () => {
  it('a bare --hold-marker with no FIFO env at all is refused, marker never written', () => {
    const { code } = runRelogin('--hold-marker')
    expect(code).not.toBe(0)
    expect(existsSync(marker)).toBe(false)
  })

  it('--hold-marker with the FIFO env pointing at a plain file (not a real FIFO) is refused', () => {
    const fakeFifo = join(dir, 'not-a-fifo')
    writeFileSync(fakeFifo, '')
    const { code } = runRelogin('--hold-marker', { WU_RELOGIN_HOLD_SIGNAL_FIFO: fakeFifo })
    expect(code).not.toBe(0)
    expect(existsSync(marker)).toBe(false)
  })

  it('--hold-marker DOES write the marker once given a real, start-style handshake FIFO (control)', async () => {
    const pid = await spawnHolder()
    expect(existsSync(marker)).toBe(true)
    try {
      process.kill(pid, 'SIGKILL')
    } catch {
      /* already gone */
    }
  })
})

describe('MEDIUM-1b: reader SKIP-streak escalation closes the same-user decoy (card f3343af0)', () => {
  it('a freshly-observed, genuinely valid marker still SKIPs, and starts a streak file near "now"', async () => {
    await spawnHolder()
    const streakFile = join(dir, 'skip-streak-fresh')
    const { stdout } = runReader({ WU_RELOGIN_SKIP_STREAK_FILE: streakFile })
    expect(stdout).toMatch(/^SKIP: relogin pending/)
    expect(existsSync(streakFile)).toBe(true)
    const val = Number(readFileSync(streakFile, 'utf-8').trim())
    expect(Math.abs(Date.now() / 1000 - val)).toBeLessThan(10)
  })

  it('a marker honored continuously for >= 2x the TTL stops SKIPping and escalates, even though the marker itself still looks fresh', async () => {
    await spawnHolder() // genuinely fresh, valid marker (live pid, right cmdline) -- the decoy's shape
    const streakFile = join(dir, 'skip-streak-stale')
    const longAgo = Math.floor(Date.now() / 1000) - 1000 // far past 2x any short test TTL below
    writeFileSync(streakFile, `${longAgo}\n`)
    const { stdout, calls } = runReader({
      WU_RELOGIN_PENDING_TTL_SEC: '60', // 2x TTL = 120s, well under the 1000s streak age
      WU_RELOGIN_SKIP_STREAK_FILE: streakFile,
    })
    expect(stdout).not.toMatch(/^SKIP/)
    expect(calls.some((c) => c.includes('has-session'))).toBe(true)
    expect(existsSync(streakFile)).toBe(false) // escalation resets the streak for the next cycle
  })

  it('a marker honored for LESS than 2x the TTL keeps SKIPping (control: not a hair-trigger)', async () => {
    await spawnHolder()
    const streakFile = join(dir, 'skip-streak-ok')
    const recently = Math.floor(Date.now() / 1000) - 5
    writeFileSync(streakFile, `${recently}\n`)
    const { stdout } = runReader({
      WU_RELOGIN_PENDING_TTL_SEC: '60', // 2x TTL = 120s, well above the 5s streak age
      WU_RELOGIN_SKIP_STREAK_FILE: streakFile,
    })
    expect(stdout).toMatch(/^SKIP: relogin pending/)
    expect(existsSync(streakFile)).toBe(true)
  })

  it('the streak file is cleared once the marker is no longer valid (relogin finished or expired)', async () => {
    const pid = await spawnHolder()
    const streakFile = join(dir, 'skip-streak-clear')
    runReader({ WU_RELOGIN_SKIP_STREAK_FILE: streakFile })
    expect(existsSync(streakFile)).toBe(true)
    rmSync(marker) // simulate a successful --paste clearing it
    runReader({ WU_RELOGIN_SKIP_STREAK_FILE: streakFile })
    expect(existsSync(streakFile)).toBe(false)
    try {
      process.kill(pid, 'SIGKILL')
    } catch {
      /* already gone */
    }
  })
})
