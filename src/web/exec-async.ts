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

/**
 * How long to keep reading after the child's own `exit` before settling anyway.
 *
 * Generous on purpose: it is only ever paid when a pipe outlives the child (a daemonised
 * grandchild), because the ordinary case settles on 'close' well inside this window. A second of
 * latency in the pathological case is the price for never hanging in it.
 */
const PIPE_DRAIN_MS = 1_000

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
    let drainTimer: NodeJS.Timeout | undefined
    const finish = (status: number | null) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      if (drainTimer) clearTimeout(drainTimer)
      resolve({ stdout, stderr, status, timedOut })
    }
    child.on('error', () => finish(null))
    child.on('close', (code) => finish(timedOut ? null : code))

    // 'close' fires only after the child has exited AND every stdio pipe has closed. A child
    // that daemonises a grandchild (`setsid ... &`, and tmux does exactly this) leaves that
    // grandchild holding the inherited stdout/stderr write ends, so the pipes never close and
    // 'close' never fires -- the promise stayed pending FOREVER, and the timeout did not save
    // it either: the grandchild left the process group, so `kill(-pid)` misses it. Measured on
    // `setsid sleep 30 & exit 0`: unsettled after 10s with the timer long expired.
    //
    // 'exit' fires on the CHILD's own exit and owes nothing to the pipes, so it is the event
    // that actually bounds the call. The short drain window after it is for the ordinary case,
    // where output written just before exit is still in flight; in that case 'close' arrives
    // first anyway and clears this timer, so the normal path keeps its current latency. Only
    // the pathological shape pays the drain, and paying 1s beats hanging forever.
    child.on('exit', (code) => {
      if (settled || drainTimer) return
      drainTimer = setTimeout(() => {
        // Release OUR read ends. The grandchild keeps the write ends open for as long as it
        // lives; without this the fds would stay pinned in this process too.
        child.stdout?.destroy()
        child.stderr?.destroy()
        finish(timedOut ? null : code)
      }, PIPE_DRAIN_MS)
      drainTimer.unref?.()
    })
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
