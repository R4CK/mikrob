// Card 40d2d2f9: port upstream's channel-keepalive-probe systemd wiring into install-linux.sh.
//
// WHY. store/.channel-keepalive has two intended producers: organic inbound traffic (covers busy
// periods) and scripts/channel-keepalive-probe.sh (covers quiet periods). The probe script and its
// placeholder units under scripts/systemd/ already shipped, but nothing in the installer wrote or
// enabled the real units -- so on a real host the ONLY producer was inbound traffic, and a quiet
// (but healthy) overnight channel aged past the dashboard's 45-minute liveness ceiling. Upstream
// measured 13 false restarts in one night from exactly this gap.
//
// Paired with this: the ${MORN_UNIT}.timer (07:27) is now dropped from the enable list, because the
// seeded scheduled-tasks/reggeli-napindito task already delivers the morning briefing at 07:30 --
// confirmed on THIS install's own /api/schedules, not assumed from upstream's fork.
import { describe, it, expect } from 'vitest'
import { execFileSync } from 'node:child_process'
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

const ROOT = join(__dirname, '..', '..')
const LINUX = readFileSync(join(ROOT, 'install-linux.sh'), 'utf-8')
const PLACEHOLDER_SERVICE = readFileSync(join(ROOT, 'scripts', 'systemd', 'channel-keepalive-probe.service'), 'utf-8')
const PLACEHOLDER_TIMER = readFileSync(join(ROOT, 'scripts', 'systemd', 'channel-keepalive-probe.timer'), 'utf-8')

/** Slice a region [from marker .. end marker], searched FROM the start offset. */
function sliceBetween(src: string, startMarker: string, endMarker: string): string {
  const start = src.indexOf(startMarker)
  if (start < 0) throw new Error(`start marker not found: ${startMarker}`)
  const end = src.indexOf(endMarker, start + startMarker.length)
  if (end < 0) throw new Error(`end marker not found after start: ${endMarker}`)
  return src.slice(start, end + endMarker.length)
}

describe('KEEPALIVE_UNIT is derived from SERVICE_ID like its siblings', () => {
  it('declares KEEPALIVE_UNIT next to the other unit names', () => {
    expect(LINUX).toContain('KEEPALIVE_UNIT="${SERVICE_ID}-channel-keepalive-probe"')
  })
})

describe('the generated .service matches the already-shipped placeholder', () => {
  const unit = sliceBetween(LINUX, 'cat >"$SYSTEMD_DIR/${KEEPALIVE_UNIT}.service" <<EOF', '\nEOF')

  it('runs the same probe script the repo already ships', () => {
    expect(unit).toContain('ExecStart=$INSTALL_DIR/scripts/channel-keepalive-probe.sh')
    expect(PLACEHOLDER_SERVICE).toContain('ExecStart=/path/to/marveen/scripts/channel-keepalive-probe.sh')
  })

  it('is a oneshot, not a long-running service', () => {
    expect(unit).toMatch(/^Type=oneshot$/m)
  })

  it('logs to its own file, matching the placeholder path shape', () => {
    expect(unit).toContain('StandardOutput=append:$INSTALL_DIR/store/channel-keepalive-probe.log')
    expect(unit).toContain('StandardError=append:$INSTALL_DIR/store/channel-keepalive-probe.log')
  })

  it('orders itself after the channels unit -- fork addition over upstream, matching the shipped placeholder', () => {
    expect(unit).toMatch(/^After=\$\{CHAN_UNIT\}\.service$/m)
    expect(PLACEHOLDER_SERVICE).toContain('After=marveen-channels.service')
  })
})

describe('the generated .timer matches the already-shipped placeholder cadence', () => {
  const timer = sliceBetween(LINUX, 'cat >"$SYSTEMD_DIR/${KEEPALIVE_UNIT}.timer" <<EOF', '\nEOF')

  it('fires at the same cadence as the placeholder (90s boot delay, every 3 minutes)', () => {
    expect(timer).toMatch(/^OnBootSec=90s$/m)
    expect(timer).toMatch(/^OnUnitActiveSec=3min$/m)
    expect(timer).toMatch(/^AccuracySec=20s$/m)
    expect(PLACEHOLDER_TIMER).toContain('OnBootSec=90s')
    expect(PLACEHOLDER_TIMER).toContain('OnUnitActiveSec=3min')
    expect(PLACEHOLDER_TIMER).toContain('AccuracySec=20s')
  })

  it('has no Requires=/Wants= on the service -- the [Timer] binds by name on elapse', () => {
    expect(timer).not.toMatch(/^Requires=/m)
    expect(timer).not.toMatch(/^Wants=/m)
  })
})

describe('the enable list drops the redundant morning timer and adds the keepalive probe', () => {
  const enableBlock = sliceBetween(LINUX, 'if systemctl --user enable ', "2>/dev/null; then")

  it('enables the keepalive probe timer', () => {
    expect(enableBlock).toContain('"${KEEPALIVE_UNIT}.timer"')
  })

  it('no longer enables the morning timer (superseded by the seeded scheduled task)', () => {
    expect(enableBlock).not.toContain('"${MORN_UNIT}.timer"')
  })

  it('keeps the fork-only dashboard watchdog timer -- this port must not collide with it', () => {
    expect(enableBlock).toContain('"${WD_UNIT}.timer"')
  })

  it('still enables the two long-running services and the host watchdog', () => {
    expect(enableBlock).toContain('"${DASH_UNIT}"')
    expect(enableBlock).toContain('"${CHAN_UNIT}"')
    expect(enableBlock).toContain('"${SERVICE_ID}-host-watchdog.service"')
  })

  it('the printed fallback command matches what was actually requested (no stale MORN_UNIT reference)', () => {
    const fallback = sliceBetween(LINUX, 'echo -e "  ${DIM}Javitas most:${NC}"', '${NC}"\n  fi')
    expect(fallback).toContain('${KEEPALIVE_UNIT}.timer')
    expect(fallback).not.toContain('${MORN_UNIT}.timer')
  })
})

describe('the keepalive timer is started immediately, not left for the next boot', () => {
  it('is explicitly started, like the fork-only watchdog timer beside it', () => {
    const startBlock = sliceBetween(
      LINUX,
      'systemctl --user start "${DASH_UNIT}" "${CHAN_UNIT}" 2>/dev/null || true',
      'systemctl --user start "${KEEPALIVE_UNIT}.timer" 2>/dev/null || true',
    )
    expect(startBlock).toContain('systemctl --user start "${WD_UNIT}.timer" 2>/dev/null || true')
  })
})

describe('${MORN_UNIT}.timer is still written to disk, just not enabled', () => {
  it('the heredoc that writes it is untouched', () => {
    const timer = sliceBetween(LINUX, 'cat >"$SYSTEMD_DIR/${MORN_UNIT}.timer" <<EOF', '\nEOF')
    expect(timer).toMatch(/^OnCalendar=\*-\*-\* 07:27:00$/m)
  })

  it('documents WHY it is not enabled, naming the seeded task it would duplicate', () => {
    const before = LINUX.slice(0, LINUX.indexOf('cat >"$SYSTEMD_DIR/${MORN_UNIT}.timer" <<EOF'))
    const commentBlock = before.slice(before.lastIndexOf('# ${MORN_UNIT}.timer'))
    expect(commentBlock).toContain('reggeli-napindito')
    expect(commentBlock).toContain('40d2d2f9')
  })
})

describe('both heredocs actually render, executed for real', () => {
  function renderBoth(): { serviceOut: string; timerOut: string } {
    const dir = mkdtempSync(join(tmpdir(), 'keepalive-render-'))
    try {
      const serviceHeredoc = sliceBetween(LINUX, 'cat >"$SYSTEMD_DIR/${KEEPALIVE_UNIT}.service" <<EOF', '\nEOF')
      const timerHeredoc = sliceBetween(LINUX, 'cat >"$SYSTEMD_DIR/${KEEPALIVE_UNIT}.timer" <<EOF', '\nEOF')
      const probe = join(dir, 'probe.sh')
      writeFileSync(
        probe,
        [
          '#!/bin/bash',
          'set -e',
          `SYSTEMD_DIR="${dir}"`,
          'SERVICE_ID="testbot"',
          'BOT_NAME="TestBot"',
          'KEEPALIVE_UNIT="${SERVICE_ID}-channel-keepalive-probe"',
          'CHAN_UNIT="${SERVICE_ID}-channels"',
          'INSTALL_DIR="/opt/marveen"',
          'HOME="/home/tester"',
          'TZ_LINE="# no explicit TZ detected; inheriting host default"',
          serviceHeredoc,
          timerHeredoc,
        ].join('\n') + '\n',
      )
      execFileSync('bash', [probe], { encoding: 'utf-8' })
      return {
        serviceOut: readFileSync(join(dir, 'testbot-channel-keepalive-probe.service'), 'utf-8'),
        timerOut: readFileSync(join(dir, 'testbot-channel-keepalive-probe.timer'), 'utf-8'),
      }
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  }

  it('the rendered .service names the right unit, script path and ordering', () => {
    const { serviceOut } = renderBoth()
    expect(serviceOut).toContain('Description=TestBot token-free idle-path channel keepalive probe')
    expect(serviceOut).toContain('After=testbot-channels.service')
    expect(serviceOut).toContain('ExecStart=/opt/marveen/scripts/channel-keepalive-probe.sh')
  })

  it('the rendered .timer carries the measured cadence, unresolved variables all substituted', () => {
    const { timerOut } = renderBoth()
    expect(timerOut).toContain('OnBootSec=90s')
    expect(timerOut).toContain('OnUnitActiveSec=3min')
    expect(timerOut).not.toContain('${')
    expect(timerOut).not.toContain('$SERVICE_ID')
  })
})
