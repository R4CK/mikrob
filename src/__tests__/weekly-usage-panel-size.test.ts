// The /usage probe panel must be tall enough for the weekly bar to be on-screen (card 8fbc5273).
//
// capture-pane only sees the visible area. Since Claude Code v2.1.282 /usage prints extra blocks
// above "Current week (all models)", so on tmux's default 80x24 the weekly line is off-screen and
// every read FAILs. The panel does not survive a reboot, and the revive path used to recreate it
// without a size -- measured 2026-09-25 23:00 -> 09-26 06:50: 455 minutes of FAIL after one boot.
//
// The reader is driven against a PATH shim for `tmux` (and a no-op `sleep`), so these cases never
// touch the real mikrob-usage-probe panel: the shim records every tmux call and reports the panel
// as gone, which forces the revive branch.
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

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'usage-panel-size-'))
  log = join(dir, 'tmux.log')
  // has-session: panel gone. capture-pane: the ready banner while reviving, then nothing for the
  // /usage snapshot, so the reader stops at "empty capture" before it could ever POST.
  writeFileSync(
    join(dir, 'tmux'),
    `#!/usr/bin/env bash
echo "$*" >> "${log}"
case "$1" in
  has-session) exit 1 ;;
  capture-pane) grep -q '/usage' "${log}" || echo "Claude Max" ;;
esac
exit 0
`,
  )
  writeFileSync(join(dir, 'sleep'), '#!/usr/bin/env bash\nexit 0\n')
  chmodSync(join(dir, 'tmux'), 0o755)
  chmodSync(join(dir, 'sleep'), 0o755)
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

function runReader(): { code: number; calls: string[] } {
  let code = 0
  try {
    execFileSync('bash', [READER], {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, PATH: `${dir}:${process.env.PATH}` },
    })
  } catch (e) {
    code = (e as { status?: number }).status ?? -1
  }
  const calls = existsSync(log) ? readFileSync(log, 'utf-8').trim().split('\n') : []
  return { code, calls }
}

describe('weekly-usage-panel-read.sh panel size', () => {
  it('recreates a dead panel with an explicit size, not the 80x24 default', () => {
    const { calls } = runReader()
    const create = calls.find((c) => c.startsWith('new-session'))
    expect(create).toBeDefined()
    expect(create).toMatch(/-x 200\b/)
    expect(create).toMatch(/-y 60\b/)
  })

  it('re-asserts the size before every /usage read, so a panel created elsewhere is healed', () => {
    const { calls } = runReader()
    const resize = calls.findIndex((c) => /^resize-window .*-y 60\b/.test(c))
    const usage = calls.findIndex((c) => c.startsWith('send-keys') && c.includes('/usage'))
    expect(resize).toBeGreaterThanOrEqual(0)
    expect(usage).toBeGreaterThan(resize)
  })

  it('never POSTs when the capture is empty (the shim stops it before the dashboard)', () => {
    const { code } = runReader()
    expect(code).toBe(1)
  })
})

describe('weekly-usage-relogin.sh panel size', () => {
  it('every panel creation carries an explicit height', () => {
    const src = readFileSync(RELOGIN, 'utf-8')
    const creates = src.split('\n').filter((l) => /^\s*tmux new-session\b/.test(l))
    expect(creates.length).toBeGreaterThan(0)
    for (const l of creates) expect(l).toMatch(/-y \d+/)
  })

  it('the /login widening keeps the height instead of dropping it', () => {
    const src = readFileSync(RELOGIN, 'utf-8')
    expect(src).toMatch(/^\s*tmux resize-window -t "\$PANE" -x 500 -y 60\b/m)
  })
})
