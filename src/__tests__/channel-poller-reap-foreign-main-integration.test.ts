// Card 5760a278 (follow-up to 35e1d876): reapForeignMainPollers used to resolve tmux/ps directly,
// so no test could drive it end-to-end (channel-poller-reap-own-uid.test.ts says so explicitly:
// "reapForeignMainPollers is held by the pure layer only"). RedHat GO on 35e1d876 noted mutants R2
// (own-uid filter) and R4 (BUN_RUN_WRAPPER_RE anchor) survived -- nothing exercised reapForeignMainPollers
// itself, only its pure findForeignMainPollers helper. These tests drive the full function through the
// seams it now takes (mainSessionPanePids, psEww, procs, ownerOf/ownUid, kill).
import { describe, it, expect } from 'vitest'
import { reapForeignMainPollers, type ProcRow } from '../web/channel-poller-reap.js'

const LEGIT_PANE = 35264 // the main session's pane-leader claude
const LEGIT_POLLER = 35352 // owned by LEGIT_PANE -- must never be reaped
const LEGIT_WRAPPER = 35346

const THIEF_PANE = 44000 // a foreign claude contending for the main bot token
const THIEF_POLLER = 44001
const THIEF_WRAPPER = 44050

// Candidate that passes the env-scan filter but whose immediate parent is a plain shell, not the
// `bun run --cwd ... start` wrapper (R4: the BUN_RUN_WRAPPER_RE anchor).
const STRAY_PID = 44099
const STRAY_SHELL = 44098

const PROCS: ProcRow[] = [
  { pid: LEGIT_POLLER, ppid: LEGIT_WRAPPER, command: 'bun server.ts' },
  { pid: LEGIT_WRAPPER, ppid: LEGIT_PANE, command: 'bun run --cwd .../telegram/0.0.6 start' },
  { pid: LEGIT_PANE, ppid: 1135, command: '/opt/homebrew/bin/claude --channels plugin:telegram@...' },
  { pid: THIEF_POLLER, ppid: THIEF_WRAPPER, command: 'bun server.ts' },
  { pid: THIEF_WRAPPER, ppid: THIEF_PANE, command: 'bun run --cwd .../telegram/0.0.6 start' },
  { pid: THIEF_PANE, ppid: 1135, command: '/opt/homebrew/bin/claude' },
  { pid: STRAY_PID, ppid: STRAY_SHELL, command: 'cat /tmp/some-file' },
  { pid: STRAY_SHELL, ppid: THIEF_PANE, command: 'sh -c cat /tmp/some-file' },
  { pid: 1135, ppid: 1, command: 'tmux new-session -d -s marveen-channels' },
]

function psEwwLineFor(pid: number): string {
  return `${pid} CLAUDE_PLUGIN_ROOT=/home/x/.claude/plugins/telegram/0.0.6 OTHER=1`
}

const PS_EWW = [LEGIT_POLLER, THIEF_POLLER, STRAY_PID].map(psEwwLineFor).join('\n')

function baseOpts(overrides: Partial<Parameters<typeof reapForeignMainPollers>[0]> = {}) {
  return {
    provider: 'telegram' as const,
    mainSession: 'marveen-channels',
    mainSessionPanePids: () => new Set([LEGIT_PANE]),
    psEww: () => PS_EWW,
    procs: () => PROCS,
    ownUid: 1000,
    ownerOf: () => 1000,
    kill: () => true,
    ...overrides,
  }
}

describe('reapForeignMainPollers (end-to-end, synthetic seams)', () => {
  it('reaps the thief poller, spares the legit main poller and the non-poller stray', () => {
    const reaped = reapForeignMainPollers(baseOpts())
    expect(reaped).toEqual([THIEF_POLLER])
  })

  it('fail-safe: empty legit pane set reaps nothing', () => {
    const reaped = reapForeignMainPollers(baseOpts({ mainSessionPanePids: () => new Set() }))
    expect(reaped).toEqual([])
  })

  // R2 pin: the thief poller belongs to another uid (ownerOf returns a uid that does not match
  // ownUid). Without the own-uid split (splitByOwner) this would still be signalled.
  it('UID filter: a foreign-owned thief is identified but never signalled', () => {
    const reaped = reapForeignMainPollers(baseOpts({
      ownUid: 1000,
      ownerOf: (pid) => (pid === THIEF_POLLER ? 2000 : 1000),
    }))
    expect(reaped).toEqual([])
  })

  // R4 pin: STRAY_PID matches the env-scan candidate filter but its immediate parent is not the
  // bun-run wrapper -- findForeignMainPollers must exclude it, end-to-end through this function.
  it('BUN_RUN_WRAPPER_RE anchor: a non-poller descendant sharing the inherited env is never reaped', () => {
    const psEwwWithStrayOnly = [THIEF_POLLER, STRAY_PID].map(psEwwLineFor).join('\n')
    const reaped = reapForeignMainPollers(baseOpts({ psEww: () => psEwwWithStrayOnly }))
    expect(reaped).toEqual([THIEF_POLLER])
    expect(reaped).not.toContain(STRAY_PID)
  })
})
