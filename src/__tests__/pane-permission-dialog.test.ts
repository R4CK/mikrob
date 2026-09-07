import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  detectsPermissionDialog,
  detectsBlockingMenu,
  detectsModelConsentDialog,
  detectsFirstRunGate,
} from '../pane-state.js'

const SRC_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')

/** Source with line comments stripped: a call named only in a comment satisfies
 *  a naive presence check (cards 06d36307, 2f0c7d24). */
function codeOf(relPath: string): string {
  return readFileSync(join(SRC_ROOT, relPath), 'utf-8')
    .split('\n')
    .map((l) => l.replace(/\/\/.*$/, ''))
    .join('\n')
}

// A REAL tool-permission prompt captured from THIS install: Claude Code
// v2.1.263, `tmux capture-pane -p`, 2026-09-06. Not hand-written chrome -- the
// card (dbba0424) required the defect to be MEASURED here before anything was
// ported, because the upstream report alone is not evidence about our copy.
//
// The pane is screen-filling, which is the normal state of a working fleet
// session: the dialog renders at the bottom and its footer is the last line.
const PERMISSION_PANE = [
  "",
  "",
  "────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────",
  " Bash command",
  "",
  "   cat /etc/hostname",
  "   Show system hostname",
  "",
  " Do you want to proceed?",
  " ❯ 1. Yes",
  "   2. Yes, allow reading from /etc from this project",
  "   3. No",
  "",
  " Esc to cancel · Tab to amend",
  "",
].join('\n')

// The SAME dialog in a freshly-started session, where the conversation has not
// filled the screen yet, so tmux pads the capture with 11 trailing blank lines.
// Kept verbatim because it is the reason a hand-written fixture proves nothing:
// detectsBlockingMenu slices the last 8 lines RAW, so here it sees only blanks.
const PERMISSION_PANE_PADDED = [
  "",
  " ▐▛███▛█   Claude Code v2.1.263",
  "▝▜██████▀  Haiku 4.5 · Claude API",
  "  ▝▝ ▝▝    ~/marveen",
  "",
  "  Updated to latest. Got 67 features, 425 bugfixes, and 199 other changes.",
  "  code.claude.com/docs/en/changelog for details",
  "",
  "⚠ CLAUDE.md is over the 40.0k-char limit (85.8k chars) · /memory to free up context",
  "",
  "  Fable 5.1 writes better code and reports progress on long tasks. Switch anytime with /model.",
  "",
  "❯ Run exactly this shell command with the Bash tool and nothing else: cat /etc/hostname",
  "",
  "● Getting hostname from /etc/hostname",
  "  ⎿  $ cat /etc/hostname",
  "",
  "────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────",
  " Bash command",
  "",
  "   cat /etc/hostname",
  "   Get hostname from /etc/hostname",
  "",
  " Do you want to proceed?",
  " ❯ 1. Yes",
  "   2. Yes, allow reading from /etc from this project",
  "   3. No",
  "",
  " Esc to cancel · Tab to amend",
  "",
  "",
  "",
  "",
  "",
  "",
  "",
  "",
  "",
  "",
  "",
  "",
].join('\n')

// A genuine stuck menu (the /mcp manager). This one MUST keep its Escape.
const STUCK_MENU_PANE = [
  '  Manage MCP servers',
  '  1. context7',
  '  2. playwright',
  '  ↑/↓ to navigate · Esc to cancel',
].join('\n')

// The model usage-credit consent dialog (FABLEFALL1), which has its own
// answer-it-safely branch and must keep it.
const CONSENT_PANE = [
  '  Fable 5 now uses usage credits',
  '    1. Continue with Fable 5',
  '  ❯ 2. Switch to Sonnet 5 and continue',
  '  Enter to confirm · Esc to cancel',
].join('\n')

describe('detectsPermissionDialog (PERMDENY905)', () => {
  it('MEASURED: the real prompt reaches the blind-Escape branch without this detector', () => {
    // This is the defect itself, on the real capture: the generic menu detector
    // matches, and neither of the two branches that run BEFORE the Escape claims
    // the pane. Everything downstream follows from these three facts.
    expect(detectsBlockingMenu(PERMISSION_PANE)).toBe(true)
    expect(detectsFirstRunGate(PERMISSION_PANE)).toBeNull()
    expect(detectsModelConsentDialog(PERMISSION_PANE)).toBe(false)
  })

  it('claims the real prompt', () => {
    expect(detectsPermissionDialog(PERMISSION_PANE)).toBe(true)
  })

  it('leaves a genuine stuck menu to the Escape branch', () => {
    expect(detectsBlockingMenu(STUCK_MENU_PANE)).toBe(true)
    expect(detectsPermissionDialog(STUCK_MENU_PANE)).toBe(false)
  })

  it('leaves the model-consent dialog to its own branch', () => {
    expect(detectsPermissionDialog(CONSENT_PANE)).toBe(false)
  })

  it('matches on the question+Yes shape when the footer marker is out of region', () => {
    // The footer term alone is not enough: a prompt whose "Tab to amend" line
    // has scrolled past the window still has to be claimed, or the Escape
    // branch takes it. This is the second, whole-pane term doing its job.
    const scrolled = [
      ' Do you want to proceed?',
      ' ❯ 1. Yes',
      '   2. Yes, and allow Claude to edit its own settings for this session',
      '   3. No',
      ...Array.from({ length: 10 }, () => '   tool output line'),
      ' Esc to cancel',
    ].join('\n')
    expect(detectsBlockingMenu(scrolled)).toBe(true)
    expect(detectsPermissionDialog(scrolled)).toBe(true)
  })

  it('needs more than the question alone', () => {
    const pane = [
      ' Do you want to proceed?',
      ' Esc to cancel',
    ].join('\n')
    expect(detectsPermissionDialog(pane)).toBe(false)
  })

  it('ignores a busy pane that quotes the prompt', () => {
    const pane = [
      ' Do you want to proceed?',
      ' ❯ 1. Yes',
      ' esc to interrupt',
    ].join('\n')
    expect(detectsPermissionDialog(pane)).toBe(false)
  })

  it('ignores a live idle prompt that quotes the prompt', () => {
    const pane = [
      ' Message said: "Do you want to proceed? ❯ 1. Yes ... Tab to amend"',
      '❯',
      '  ⏵⏵ bypass permissions on (shift+tab to cycle)',
    ].join('\n')
    expect(detectsPermissionDialog(pane)).toBe(false)
  })

  it('returns false on empty input', () => {
    expect(detectsPermissionDialog('')).toBe(false)
  })

  // UPDATED (card 4f15966e, backend, 2026-09-07): this test used to document a gap -- our
  // detectsBlockingMenu sliced the last 8 lines RAW, so the same dialog with blank padding below it
  // was not seen by the GATE at all. That gap is closed: detectsBlockingMenu now also reads its
  // footer through liveTailRegion (card 11b04357's blank-tail fix, landed here non-conflicting
  // during this merge, not scoped to detectsPermissionDialog alone as the archived conflict rule
  // for this file assumed). Both the gate and this detector now claim the padded capture.
  it('padded capture: both the gate and this detector claim it', () => {
    expect(detectsBlockingMenu(PERMISSION_PANE_PADDED)).toBe(true)
    expect(detectsPermissionDialog(PERMISSION_PANE_PADDED)).toBe(true)
  })
})

describe('channel-monitor wiring (the branch must exist and be ordered)', () => {
  const src = codeOf('web/channel-monitor.ts')

  it('probes the permission dialog on the re-captured pane', () => {
    expect(src).toMatch(/detectsPermissionDialog\(paneNow\)/)
  })

  it('sends NO keystroke on that branch', () => {
    const branch = src.slice(
      src.indexOf('detectsPermissionDialog(paneNow)'),
      src.indexOf("send-keys', '-t', t.session, 'Escape'"),
    )
    expect(branch.length).toBeGreaterThan(0)
    expect(branch).not.toMatch(/send-keys/)
  })

  it('runs AFTER model-consent and BEFORE the blind Escape', () => {
    const consent = src.indexOf('detectsModelConsentDialog(paneNow)')
    const permission = src.indexOf('detectsPermissionDialog(paneNow)')
    const escape = src.indexOf("send-keys', '-t', t.session, 'Escape'")
    expect(consent).toBeGreaterThan(-1)
    expect(permission).toBeGreaterThan(consent)
    expect(escape).toBeGreaterThan(permission)
  })
})
