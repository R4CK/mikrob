// Cybersec LOW L2 (card ef6a8031, comment 11261; fixed on card e47dc04a): the batch-3 upstream
// merge (ed4633c2) added a new block to install-macos.sh that calls
// scripts/install-channel-keepalive-probe.sh --load at the end of a fresh macOS install --
// the same not-adopted keepalive feature update.sh's own leak (install_keepalive_probe_timer)
// shipped alongside, fixed on card ef6a8031. The block itself was removed on that card, but
// nothing pinned its absence: a future merge could silently reintroduce it on install-macos.sh
// alone (a different file than the one update-unit-maintenance-order.test.ts watches), and
// nothing would go red. This test closes that gap.
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const ROOT = join(__dirname, '..', '..')
const INSTALL_MACOS = readFileSync(join(ROOT, 'install-macos.sh'), 'utf-8')

describe('install-macos.sh never auto-wires the not-adopted keepalive probe', () => {
  it('does not call install-channel-keepalive-probe.sh', () => {
    expect(INSTALL_MACOS).not.toMatch(/install-channel-keepalive-probe\.sh/)
  })

  it('has zero "channel-keepalive" occurrences at all', () => {
    // Stronger than the needle above on its own merits (card 12th code-quality rule): a renamed
    // call site, or a differently-worded wiring of the same feature, still names the channel
    // keepalive probe somewhere. NOT a bare "keepalive" check -- this file legitimately carries
    // two unrelated `<key>KeepAlive</key>` launchd plist entries (the daemon's own respawn
    // directive, nothing to do with the channel probe), and a blanket substring check would
    // false-positive on those forever. "channel-keepalive" is specific to the feature that
    // leaked and matches neither plist key.
    expect(INSTALL_MACOS.toLowerCase()).not.toMatch(/channel-keepalive/)
  })
})
