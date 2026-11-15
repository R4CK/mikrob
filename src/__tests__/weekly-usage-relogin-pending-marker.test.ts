// A relogin in flight leaves the mikrob-usage-probe panel sitting on a /login dialog, not a
// shell prompt. Before this fix, weekly-usage-panel-read.sh typed "/usage" into that panel on its
// own timer regardless -- measured 2026-10-14: two /login flows in a row died with "Login
// interrupted" because the reader's keystroke landed on the waiting dialog.
//
// Fix: weekly-usage-relogin.sh's `start` writes a pending marker (epoch seconds) BEFORE touching
// the panel, and a successful `--paste` clears it; weekly-usage-panel-read.sh checks the marker
// FIRST, before any tmux call, and skips with "SKIP: relogin pending" while it is fresh (inside
// WU_RELOGIN_PENDING_TTL_SEC). A stale marker (older than the TTL) is ignored so a wedged relogin
// cannot block reads forever.
//
// Driven against a PATH shim for `tmux` (and a no-op `sleep`), same technique as
// weekly-usage-panel-size.test.ts: these cases never touch the real mikrob-usage-probe panel.
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, writeFileSync, rmSync, chmodSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const STORE = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'store')
const READER = join(STORE, 'weekly-usage-panel-read.sh')
const RELOGIN = join(STORE, 'weekly-usage-relogin.sh')

let dir: string
let log: string
let marker: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'usage-relogin-pending-'))
  log = join(dir, 'tmux.log')
  marker = join(dir, 'pending-marker')
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

afterEach(() => rmSync(dir, { recursive: true, force: true }))

function runReader(ttlSec?: number): { stdout: string; code: number; calls: string[] } {
  let stdout = ''
  let code = 0
  try {
    stdout = execFileSync('bash', [READER], {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: {
        ...process.env,
        PATH: `${dir}:${process.env.PATH}`,
        WU_RELOGIN_PENDING_MARKER: marker,
        ...(ttlSec !== undefined ? { WU_RELOGIN_PENDING_TTL_SEC: String(ttlSec) } : {}),
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
  let code = 0
  try {
    stdout = execFileSync('bash', [RELOGIN, mode], {
      input,
      stdio: [input !== undefined ? 'pipe' : 'ignore', 'pipe', 'pipe'],
      env: { ...process.env, PATH: `${dir}:${process.env.PATH}`, WU_RELOGIN_PENDING_MARKER: marker },
    }).toString('utf-8')
  } catch (e) {
    const err = e as { status?: number; stdout?: Buffer }
    code = err.status ?? -1
    stdout = err.stdout ? err.stdout.toString('utf-8') : ''
  }
  return { stdout, code }
}

describe('reader side: pending marker gates the keystroke (card f3343af0)', () => {
  it('a fresh marker: SKIP, exit 0, never calls tmux at all', () => {
    writeFileSync(marker, `${Math.floor(Date.now() / 1000)}\n`)
    const { stdout, code, calls } = runReader()
    expect(stdout).toMatch(/^SKIP: relogin pending/)
    expect(code).toBe(0)
    expect(calls).toHaveLength(0)
  })

  it('an expired marker (older than the TTL): no SKIP, reader proceeds to touch the panel', () => {
    const old = Math.floor(Date.now() / 1000) - 120
    writeFileSync(marker, `${old}\n`)
    const { stdout, calls } = runReader(60) // TTL shorter than the marker's age -> stale
    expect(stdout).not.toMatch(/SKIP/)
    expect(calls.some((c) => c.includes('has-session'))).toBe(true)
  })

  it('no marker file at all: no SKIP, reader proceeds normally', () => {
    const { stdout, calls } = runReader()
    expect(stdout).not.toMatch(/SKIP/)
    expect(calls.some((c) => c.includes('has-session'))).toBe(true)
  })
})

describe('writer side: relogin.sh manages the marker (card f3343af0)', () => {
  it('start writes a fresh pending marker before touching the panel', () => {
    runRelogin('start')
    expect(existsSync(marker)).toBe(true)
    const ts = parseInt(readFileSync(marker, 'utf-8').trim(), 10)
    expect(Math.abs(Date.now() / 1000 - ts)).toBeLessThan(10)
  })

  it('a successful --paste clears the pending marker', () => {
    writeFileSync(marker, `${Math.floor(Date.now() / 1000)}\n`)
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
  })

  it('a failed --paste leaves the pending marker in place', () => {
    writeFileSync(marker, `${Math.floor(Date.now() / 1000)}\n`)
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
  })
})
