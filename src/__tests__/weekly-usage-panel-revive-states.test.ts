// revive_pane() in weekly-usage-panel-read.sh used to collapse to two states: the ready banner
// seen (OK), or a 90s timeout read as "refresh token likely expired" (card 90424157 F1). Four
// documented false-expired cases (cold-boot network delay, CLI banner drift, wrong key on the
// trust prompt, and a fourth unexplained one) all hit the timeout path with no real auth
// failure, each paging Peti for a needless browser OAuth. A timeout alone is "could not
// confirm", not "expired".
//
// Fix: a timeout now actively probes with `/status` and only reports EXPIRED if that positively
// confirms it ("Login ... Expired - log in again", the one documented request-time string for a
// dead refresh token, per code.claude.com/docs/en/authentication.md). No confirmation either way
// -> UNKNOWN, not EXPIRED -- callers must not treat it as a real auth failure.
//
// Driven against a PATH shim for `tmux` (and a no-op `sleep`), exactly like
// weekly-usage-panel-size.test.ts: these cases never touch the real mikrob-usage-probe panel.
import { describe, it, expect, afterEach } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, writeFileSync, rmSync, chmodSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const STORE = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'store')
const READER = join(STORE, 'weekly-usage-panel-read.sh')

let dir: string
let log: string

afterEach(() => rmSync(dir, { recursive: true, force: true }))

/**
 * banner: the ready-banner text to show on every capture-pane call (OK case), or '' to never
 * show it.
 * statusLine: what capture-pane returns AFTER a `/status` send-keys has been logged (EXPIRED vs
 * UNKNOWN case); ignored when banner is non-empty, since the loop then never reaches /status.
 */
function setupShim(banner: string, statusLine: string) {
  dir = mkdtempSync(join(tmpdir(), 'usage-panel-revive-'))
  log = join(dir, 'tmux.log')
  writeFileSync(
    join(dir, 'tmux'),
    `#!/usr/bin/env bash
echo "$*" >> "${log}"
case "$1" in
  has-session) exit 1 ;;
  new-session) exit 0 ;;
  send-keys) exit 0 ;;
  resize-window) exit 0 ;;
  capture-pane)
    if [ -n "${banner}" ]; then
      echo "${banner}"
    elif grep -qE '/status Enter$' "${log}"; then
      echo "${statusLine}"
    else
      echo "$ (bash prompt, nothing interesting)"
    fi
    ;;
esac
exit 0
`,
  )
  writeFileSync(join(dir, 'sleep'), '#!/usr/bin/env bash\nexit 0\n')
  chmodSync(join(dir, 'tmux'), 0o755)
  chmodSync(join(dir, 'sleep'), 0o755)
}

function runReader(): { stderr: string; code: number; calls: string[] } {
  let stderr = ''
  let code = 0
  try {
    execFileSync('bash', [READER], {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, PATH: `${dir}:${process.env.PATH}` },
    })
  } catch (e) {
    const err = e as { status?: number; stderr?: Buffer }
    code = err.status ?? -1
    stderr = err.stderr ? err.stderr.toString('utf-8') : ''
  }
  const calls = existsSync(log) ? readFileSync(log, 'utf-8').trim().split('\n') : []
  return { stderr, code, calls }
}

describe('revive_pane three states (card 90424157 F1)', () => {
  it('OK: the ready banner is seen -- no /status probe is ever sent', () => {
    setupShim('Claude Max  auto mode on', '')
    const { stderr, calls } = runReader()
    expect(stderr).toMatch(/no Peti login needed/)
    expect(calls.some((c) => c.includes('/status'))).toBe(false)
  })

  it('EXPIRED: no banner within the timeout, but /status positively confirms a dead refresh token', () => {
    setupShim('', 'Login       Expired - log in again')
    const { stderr, code } = runReader()
    expect(code).not.toBe(0)
    expect(stderr).toMatch(/EXPIRED:.*login expired/)
    expect(stderr).toMatch(/claude \/login Max needed/)
  })

  it('UNKNOWN: no banner within the timeout, and /status does not confirm expiry either -- NOT reported as expired', () => {
    setupShim('', '$ (bash prompt, nothing interesting)')
    const { stderr, code } = runReader()
    expect(code).not.toBe(0)
    expect(stderr).toMatch(/UNKNOWN:/)
    expect(stderr).not.toMatch(/EXPIRED/)
    expect(stderr).not.toMatch(/login expired/)
  })

  it('UNKNOWN and EXPIRED both actively probe with /status before concluding anything', () => {
    setupShim('', 'Login       Expired - log in again')
    const { calls } = runReader()
    expect(calls.some((c) => /^send-keys .*\/status Enter$/.test(c))).toBe(true)
  })
})
