// Integration pin for the 2026-09-26 06:44 fleet outage (card 4dc7d966, QA2 FAIL 7160).
//
// channel-poller-reap.test.ts tests isPollerArgv / filterPollerPids as pure functions. QA2 showed
// that is not enough: reverting the WIRING in listPollerPidsByStateDir back to the bare
// parsePollerPidsFromPs(...) -- exactly the code that reaped the tmux server -- left all 17 tests
// green. These tests drive reapChannelOrphans end to end with a mocked `ps`, /proc and bot.pid,
// so removing filterPollerPids from EITHER call site (env scan or bot.pid) turns them red.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

const TMUX_SERVER = 4101
const MAIN_CLAUDE = 4102
const MCP_CHILD = 4103
const POLLER = 4104
const STRANGER = 4105

const fsState = vi.hoisted(() => ({
  argv: new Map<number, string[]>(),
  botPid: null as number | null,
}))
const psState = vi.hoisted(() => ({ out: '' }))

vi.mock('node:child_process', async (orig) => {
  const real = await orig<typeof import('node:child_process')>()
  return {
    ...real,
    execSync: vi.fn(() => psState.out),
    execFileSync: vi.fn(() => ''),
  }
})

vi.mock('node:fs', async (orig) => {
  const real = await orig<typeof import('node:fs')>()
  return {
    ...real,
    existsSync: vi.fn((p: string) => (String(p).endsWith('bot.pid') ? fsState.botPid != null : real.existsSync(p))),
    readFileSync: vi.fn((p: string, enc?: unknown) => {
      const s = String(p)
      const m = s.match(/^\/proc\/(\d+)\/cmdline$/)
      if (m) {
        const argv = fsState.argv.get(Number(m[1]))
        if (!argv) throw new Error('ENOENT')
        return argv.join('\0') + '\0'
      }
      if (s.endsWith('bot.pid')) {
        if (fsState.botPid == null) throw new Error('ENOENT')
        return String(fsState.botPid)
      }
      return real.readFileSync(p, enc as BufferEncoding)
    }),
  }
})

const { reapChannelOrphans } = await import('../web/channel-poller-reap.js')
const { channelStateDir, channelStateDirEnvVar } = await import('../channel-provider.js')

const AGENT_DIR = '/tmp/reap-integration-agent'

function psRow(pid: number, cmd: string, env: string): string {
  return `${String(pid).padStart(6)} pts/1    S      0:00 ${cmd} ${env}`
}

const spyOnKill = () => vi.spyOn(process, 'kill').mockImplementation(() => true)
let killSpy: ReturnType<typeof spyOnKill>

beforeEach(() => {
  const needle = `${channelStateDirEnvVar('telegram')}=${channelStateDir('telegram', AGENT_DIR)}`
  // Every row carries the needle -- that is the outage: channels.sh exports it before exec claude,
  // so the tmux server, the main claude and its MCP children all inherit it.
  psState.out = [
    '   PID TTY      STAT   TIME COMMAND',
    psRow(TMUX_SERVER, 'tmux new-session -d -s mikrob-channels', needle),
    psRow(MAIN_CLAUDE, 'claude --channels plugin:telegram', needle),
    psRow(MCP_CHILD, 'node /opt/mcp/server.js', needle),
    psRow(POLLER, 'bun server.ts', needle),
  ].join('\n')
  fsState.argv = new Map([
    [TMUX_SERVER, ['tmux', 'new-session', '-d', '-s', 'mikrob-channels']],
    [MAIN_CLAUDE, ['claude', '--channels', 'plugin:telegram']],
    [MCP_CHILD, ['node', '/opt/mcp/server.js']],
    [POLLER, ['bun', 'server.ts']],
    [STRANGER, ['sshd', '-D']],
  ])
  fsState.botPid = null
  killSpy = spyOnKill()
})

afterEach(() => {
  killSpy.mockRestore()
})

describe('reapChannelOrphans wiring (06:44 outage pin)', () => {
  it('env scan: only the poller is reaped, never what merely inherited the env needle', () => {
    const r = reapChannelOrphans('telegram', AGENT_DIR)
    expect(r.source.fromEnvScan).toEqual([POLLER])
    expect(r.reaped).toEqual([POLLER])
    const killed = new Set(killSpy.mock.calls.map((c) => c[0]))
    for (const pid of [TMUX_SERVER, MAIN_CLAUDE, MCP_CHILD]) {
      expect(killed.has(pid), `pid ${pid} must never be signalled`).toBe(false)
    }
  })

  it('bot.pid naming an unrelated process after a reboot is not reaped', () => {
    fsState.botPid = STRANGER
    const r = reapChannelOrphans('telegram', AGENT_DIR)
    expect(r.source.fromBotPid).toBeNull()
    expect(r.reaped).not.toContain(STRANGER)
    expect(killSpy.mock.calls.some((c) => c[0] === STRANGER)).toBe(false)
  })

  it('bot.pid naming the tmux server is not reaped', () => {
    fsState.botPid = TMUX_SERVER
    const r = reapChannelOrphans('telegram', AGENT_DIR)
    expect(r.source.fromBotPid).toBeNull()
    expect(r.reaped).toEqual([POLLER])
  })

  it('bot.pid naming the real poller is still reaped (the fix did not switch the reaper off)', () => {
    fsState.botPid = POLLER
    const r = reapChannelOrphans('telegram', AGENT_DIR)
    expect(r.source.fromBotPid).toBe(POLLER)
    expect(r.reaped).toEqual([POLLER])
  })
})
