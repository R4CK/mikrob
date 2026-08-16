// Card 24246085 (self-audit finding, bf67711e-era card 317b39f7): scripts/hooks/telegram-image-resize.sh
// was the SUPERSEDED predecessor of scripts/hooks/channel-image-resize.sh. The installer
// (scripts/install-channel-image-hook.sh) actively MIGRATES existing installs away from it -- deletes
// it from ~/.claude/hooks and strips it from settings.json -- yet the repo kept shipping a fresh copy
// into every new checkout, so every install got a file its own installer immediately wants gone.
//
// Fixed by deleting the repo copy. The two things worth pinning: the dead file is actually gone, and
// the MIGRATION LOGIC itself (which many already-installed users still depend on to clean up their
// own ~/.claude/hooks) was untouched -- it targets $HOME, not this repo file, so removing the repo
// copy could not have broken it, but nothing stopped a future edit from doing so by accident.
import { describe, it, expect } from 'vitest'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { REPO_ROOT } from './helpers/repo-location.js'

describe('telegram-image-resize.sh removal (card 24246085)', () => {
  it('the superseded repo hook file is gone', () => {
    expect(existsSync(join(REPO_ROOT, 'scripts/hooks/telegram-image-resize.sh'))).toBe(false)
  })

  it('its live successor still ships', () => {
    expect(existsSync(join(REPO_ROOT, 'scripts/hooks/channel-image-resize.sh'))).toBe(true)
  })

  it('the installer still migrates an EXISTING deployed copy off already-installed machines', () => {
    // This branch operates on $HOME/.claude/hooks, not on anything in this repo -- it must survive
    // the repo file's deletion untouched, or already-installed users lose their cleanup path.
    const installer = readFileSync(join(REPO_ROOT, 'scripts/install-channel-image-hook.sh'), 'utf-8')
    expect(installer).toMatch(/OLD_HOOK="\$HOME\/\.claude\/hooks\/telegram-image-resize\.sh"/)
    expect(installer).toMatch(/Migrate old hook/i)
  })

  it('no installer references the repo-local telegram-image-resize.sh path', () => {
    // The migration guard above only proves the $HOME-side logic survives; this proves nothing else
    // in the install surface tries to copy the now-deleted repo file into a fresh install.
    const candidates = [
      'install.sh', 'install-linux.sh', 'install-macos.sh', 'update.sh',
      'scripts/install-channel-image-hook.sh', 'scripts/install-telegram-image-hook.sh',
    ]
    for (const rel of candidates) {
      const p = join(REPO_ROOT, rel)
      if (!existsSync(p)) continue
      const src = readFileSync(p, 'utf-8')
      expect(src).not.toMatch(/scripts\/hooks\/telegram-image-resize\.sh/)
    }
  })
})
