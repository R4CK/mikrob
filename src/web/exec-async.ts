import { spawn } from 'node:child_process'
import { logger } from '../logger.js'

// Non-blocking child execution for code that runs on the dashboard's event loop.
//
// WHY THIS EXISTS
// A synchronous child (`execFileSync`/`execSync`/`spawnSync`) freezes the ENTIRE Node
// event loop -- HTTP server, pollers, timers -- for the child's full lifetime. On a
// scheduled task that meant a 60s dashboard outage (card 955f014e); in an HTTP route
// handler it is worse, because a single inbound request triggers it.
//
// WHY NOT PLAIN execFile+timeout
// Node's `timeout` sends SIGTERM to the process it spawned and nothing further. Bash
// EXECs a simple command, so the signal lands on the real work -- but add a pipeline,
// a redirection, or a script that spawns its own children and bash forks: the shell
// dies and the grandchildren are orphaned, still holding the resource the timeout was
// supposed to release. `killSignal: 'SIGKILL'` does not help; it changes the signal,
// not the recipient. `git fetch` is exactly this shape (it spawns ssh / git-remote-*).
//
// So the child gets its own process GROUP (`detached: true`) and the timeout kills the
// group (`process.kill(-pid)`), which reaches the grandchildren too.
export interface ExecAsyncResult {
  stdout: string
  stderr: string
  /** null when the process was killed by a signal or failed to spawn. */
  status: number | null
  timedOut: boolean
}

export interface ExecAsyncOptions {
  cwd?: string
  timeoutMs?: number
  env?: NodeJS.ProcessEnv
  maxBuffer?: number
}

/**
 * Run a child without blocking the event loop, killing the whole process group on timeout.
 * Never rejects: a non-zero exit, a timeout and a spawn failure all resolve, so callers
 * handle outcomes as data instead of wrapping every call in try/catch.
 */
export function execFileAsync(
  file: string,
  args: readonly string[],
  opts: ExecAsyncOptions = {},
): Promise<ExecAsyncResult> {
  const timeoutMs = opts.timeoutMs && opts.timeoutMs > 0 ? opts.timeoutMs : 30_000
  return new Promise((resolve) => {
    let timedOut = false
    let stdout = ''
    let stderr = ''
    const maxBuffer = opts.maxBuffer ?? 1024 * 1024
    // spawn, not execFile: `detached` is a spawn option, and the process GROUP is the
    // whole point -- execFile's own `timeout` would SIGTERM the direct child only.
    const child = spawn(file, [...args], {
      cwd: opts.cwd,
      env: opts.env,
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    const cap = (buf: string, chunk: string) => (buf.length >= maxBuffer ? buf : (buf + chunk).slice(0, maxBuffer))
    child.stdout?.setEncoding('utf-8')
    child.stderr?.setEncoding('utf-8')
    child.stdout?.on('data', (c: string) => { stdout = cap(stdout, c) })
    child.stderr?.on('data', (c: string) => { stderr = cap(stderr, c) })

    const timer = setTimeout(() => {
      timedOut = true
      if (child.pid == null) return
      try {
        // negative pid = the whole process group, so a forked bash's children die too
        process.kill(-child.pid, 'SIGKILL')
      } catch {
        try { child.kill('SIGKILL') } catch { /* nothing left to kill */ }
      }
      logger.warn({ file, timeoutMs }, 'child exceeded its timeout; process group killed')
    }, timeoutMs)
    timer.unref?.()

    let settled = false
    const finish = (status: number | null) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve({ stdout, stderr, status, timedOut })
    }
    child.on('error', () => finish(null))
    child.on('close', (code) => finish(timedOut ? null : code))
  })
}

/** Convenience for the common "give me stdout, throw on failure" shape. */
export async function execFileAsyncOutput(
  file: string,
  args: readonly string[],
  opts: ExecAsyncOptions = {},
): Promise<string> {
  const r = await execFileAsync(file, args, opts)
  if (r.timedOut) throw new Error(`${file} timed out after ${opts.timeoutMs ?? 30_000}ms`)
  if (r.status !== 0) throw new Error(`${file} exited ${r.status}: ${r.stderr.trim().slice(0, 200)}`)
  return r.stdout
}
