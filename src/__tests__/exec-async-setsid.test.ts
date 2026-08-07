// Card 4afb44c8 (Cybered, HIGH): execFileAsync's promise could stay pending FOREVER.
//
// `finish()` was only reachable from 'close', and 'close' waits for the child to exit AND for
// every stdio pipe to close. A child that daemonises a grandchild -- `setsid ... &`, which is
// exactly what tmux does -- hands that grandchild the inherited stdout/stderr write ends, so the
// pipes stay open for as long as the grandchild lives. The timeout was no safety net either: the
// grandchild left the process group, so `process.kill(-pid)` never reached it, and killing the
// group did not close the pipes.
//
// These tests spawn REAL processes on purpose. The defect is in event timing between a process
// and its pipes; a mocked child would have to reproduce that timing to be worth anything, and a
// mock that reproduces the bug is just the bug written twice.
import { describe, it, expect, afterAll } from 'vitest'
import { execFileAsync } from '../web/exec-async.js'
import { execFile } from 'node:child_process'

// The grandchild must OUTLIVE the test's patience. With a short sleep the pipes would close on
// their own and the test would pass even with the fix removed -- vacuous in the worst way, since
// it is the hang it is supposed to catch. The marker makes the orphan identifiable for cleanup.
const ORPHAN_MARKER = 'EXEC_ASYNC_SETSID_TEST_ORPHAN'
const DAEMONISE = `setsid env ${ORPHAN_MARKER}=1 sleep 120 & exit 0`

afterAll(async () => {
  await new Promise<void>((r) => execFile('pkill', ['-f', ORPHAN_MARKER], () => r()))
})

describe('a daemonised grandchild must not pin the promise open (card 4afb44c8)', () => {
  it(
    'settles on the CHILD exit, not on the pipes closing',
    async () => {
      const t0 = Date.now()
      const r = await execFileAsync('bash', ['-c', DAEMONISE], { timeoutMs: 6000 })
      const ms = Date.now() - t0
      // Before the fix this never resolved at all; the assertion that matters is that it did.
      expect(r.status).toBe(0)
      // The child exited cleanly, so this is NOT a timeout -- the grandchild is meant to survive.
      expect(r.timedOut).toBe(false)
      // Well inside the 6s timeout: settling AT the timeout would mean the timer saved us, which
      // it cannot here (the grandchild is outside the process group), and settling after it would
      // mean the hang is still there.
      expect(ms).toBeLessThan(4000)
    },
    15_000,
  )

  it(
    'still returns output written before the child exited',
    async () => {
      const r = await execFileAsync('bash', ['-c', `echo before; ${DAEMONISE}`], { timeoutMs: 6000 })
      expect(r.stdout.trim()).toBe('before')
      expect(r.status).toBe(0)
    },
    15_000,
  )
})

describe('the ordinary shapes keep their existing behaviour and latency', () => {
  it('a successful command returns status 0 and its stdout, promptly', async () => {
    const t0 = Date.now()
    const r = await execFileAsync('bash', ['-c', 'echo hello'], { timeoutMs: 6000 })
    expect(r).toMatchObject({ status: 0, timedOut: false })
    expect(r.stdout.trim()).toBe('hello')
    // The drain window is 1s and must NOT be paid here: 'close' arrives first and clears it.
    expect(Date.now() - t0).toBeLessThan(500)
  })

  it('a failing command reports its exit code, not an exception', async () => {
    const r = await execFileAsync('bash', ['-c', 'echo out; exit 3'], { timeoutMs: 6000 })
    expect(r).toMatchObject({ status: 3, timedOut: false })
    expect(r.stdout.trim()).toBe('out')
  })

  it(
    'a genuinely hung child still times out and is reported as such',
    async () => {
      const t0 = Date.now()
      const r = await execFileAsync('bash', ['-c', 'sleep 30'], { timeoutMs: 1500 })
      expect(r.timedOut).toBe(true)
      expect(r.status).toBeNull()
      expect(Date.now() - t0).toBeGreaterThanOrEqual(1400)
    },
    15_000,
  )
})
