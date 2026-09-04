// Card fcf3a73a. Cybersec's lynis finding (card 02b2a499) was a channel `.env` at 0664 -- a bot
// token, world-readable. `chmod 600` fixed that one file; the cause is the live umask, measured at
// 0002 on this box, so the NEXT log, dump, scratch file or .env is born world-readable again.
//
// The drop-in this covers is inert until each unit restarts, which makes it exactly the kind of
// change that can rot unnoticed -- so its selftest runs on every landing, and the wiring that
// re-asserts it at boot is pinned here too.
import { describe, it, expect } from 'vitest'
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

const REPO_ROOT = join(import.meta.dirname, '..', '..')
const STORE = join(REPO_ROOT, 'store')
const SCRIPT = join(STORE, 'ensure-umask-dropin.sh')

describe('umask drop-in', () => {
  it('ships the script and its selftest', () => {
    expect(existsSync(SCRIPT)).toBe(true)
    expect(existsSync(join(STORE, 'ensure-umask-dropin.selftest.sh'))).toBe(true)
  })

  it('its selftest passes, and counts its cases', () => {
    const out = execFileSync('bash', [join(STORE, 'ensure-umask-dropin.selftest.sh')], {
      encoding: 'utf-8',
      timeout: 120_000,
    })
    expect(out).toMatch(/selftest: [1-9]\d* case\(s\), PASS/)
  })

  // THE WIRING: without this the drop-in is a one-off someone ran once, and the next fresh install
  // or unit regeneration silently loses it -- the same shape as the fork-local plugin edit an
  // upstream pull discarded (card d6be510a).
  it('startup.sh re-asserts it on the boot path', () => {
    const src = readFileSync(join(REPO_ROOT, 'scripts', 'startup.sh'), 'utf-8')
    expect(src).toContain('ensure-umask-dropin.sh')
  })

  it('changes config only -- it must never bounce a unit', () => {
    // startup.sh's own header is explicit that the logon path must not recycle the channels
    // session. A reload re-reads config and is safe; anything that stops or starts a unit is not.
    const src = readFileSync(SCRIPT, 'utf-8')
    expect(src).toContain('daemon-reload')
    const lifecycle = src.split('\n').filter((l) => /systemctl/.test(l) && !/daemon-reload/.test(l))
    expect(lifecycle, `unexpected systemctl lifecycle call:\n${lifecycle.join('\n')}`).toEqual([])
  })

  it('is versioned in the repo rather than edited into the unit files', () => {
    // The units under ~/.config/systemd/user/ are NOT in this repo. Editing them would be the exact
    // unversioned local change the update-safety rule forbids: lost on a fresh install, and gone
    // whenever the installer rewrites a unit. A drop-in survives regeneration.
    const src = readFileSync(SCRIPT, 'utf-8')
    expect(src).toContain('umask.conf')
    expect(src).toContain('UMask=')
  })
})
