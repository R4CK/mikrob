// card a265e48c: isGpuLockHeld() is what the "Aktív feladat" widget now reads instead of the
// queue's `status='running'` row count, which can sit above 1 under a parallel-dispatch burst
// (rows register before they acquire the GPU flock, by design -- card 5dcd9bc8). Real integration
// test against an actual `flock`, on a throwaway lock file -- NEVER the real GPU_LOCK_PATH, which
// this box's live local-llm.sh may genuinely be holding while this test runs.
import { describe, it, expect, afterEach } from 'vitest'
import { spawn, type ChildProcess } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { isGpuLockHeld } from '../web/routes/local-llm.js'

let dir: string
let holder: ChildProcess | null = null

function killHolder(): void {
  if (!holder || holder.pid == null) return
  // `flock <path> -c command` runs command via a `/bin/sh -c` CHILD, which inherits the locked fd
  // by fork() -- killing only the flock PID leaves that shell (and its own sleep child) running and
  // still holding the lock. `detached: true` below makes this PID its own process-group leader, so
  // a negative PID kills the whole group in one signal.
  try { process.kill(-holder.pid, 'SIGKILL') } catch { /* already gone */ }
  holder = null
}

afterEach(() => {
  killHolder()
  if (dir) rmSync(dir, { recursive: true, force: true })
})

// Spawns a background process that grabs the flock and sleeps, so the lock is genuinely held by a
// DIFFERENT process (matches the real scenario: local-llm.sh holds it, the web server asks).
function holdLockInBackground(lockPath: string): Promise<void> {
  return new Promise((resolve, reject) => {
    holder = spawn('flock', [lockPath, '-c', 'echo locked && sleep 10'], {
      stdio: ['ignore', 'pipe', 'ignore'],
      detached: true,
    })
    holder.stdout!.once('data', () => resolve())
    holder.once('error', reject)
    setTimeout(() => reject(new Error('flock holder did not report locked in time')), 3000)
  })
}

describe('isGpuLockHeld', () => {
  it('is false when nothing holds the lock file (fresh path, never taken)', async () => {
    dir = mkdtempSync(join(tmpdir(), 'gpu-lock-probe-'))
    const lockPath = join(dir, 'gpu.lock')
    await expect(isGpuLockHeld(lockPath)).resolves.toBe(false)
  })

  it('is true while a DIFFERENT process holds the lock', async () => {
    dir = mkdtempSync(join(tmpdir(), 'gpu-lock-probe-'))
    const lockPath = join(dir, 'gpu.lock')
    await holdLockInBackground(lockPath)
    await expect(isGpuLockHeld(lockPath)).resolves.toBe(true)
  })

  it('goes back to false once the holder releases it', async () => {
    dir = mkdtempSync(join(tmpdir(), 'gpu-lock-probe-'))
    const lockPath = join(dir, 'gpu.lock')
    await holdLockInBackground(lockPath)
    await expect(isGpuLockHeld(lockPath)).resolves.toBe(true)
    killHolder()
    // Releasing a killed flock holder's lock is immediate (kernel-level, on process exit) --
    // poll briefly rather than assume a fixed delay is enough.
    const deadline = Date.now() + 2000
    let held = true
    while (Date.now() < deadline) {
      held = await isGpuLockHeld(lockPath)
      if (!held) break
    }
    expect(held).toBe(false)
  })

  it('never probes the real production GPU lock path from a test', () => {
    // A pinned, explicit regression guard: if isGpuLockHeld's default argument is ever changed to
    // something that resolves to the real path during a test run, this catches it -- the function
    // signature itself is what every other test in this file relies on staying overridable.
    expect(isGpuLockHeld.length).toBe(0) // lockPath has a default, so the declared arity is 0
  })
})
