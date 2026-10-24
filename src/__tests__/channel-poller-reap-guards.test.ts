// Card cf075d41: three guards against stopping the wrong process, on top of the
// upstream poller selection (selectReapablePollers) and the own-uid layer.
//
// On a shared host one uid runs many agents, and the pid space wraps. Three
// shapes passed the reapers before:
//   (i)   a stale bot.pid that names a live process which is not a plugin
//         process (bot.pid is exempt from the runtime check);
//   (ii)  a detached node/npx job that inherited the owning agent's state-dir
//         variable, outside the plugin root (it passes the runtime check);
//   (iii) a detached `claude --channels` that sits ABOVE a live pane leader
//         (the orphan test only looks up from the claude);
// and (iv), the positive control, a real orphan is still stopped.
//
// macOS (PR1829MACRED1015): the stand-in poller is a node job, never /bin/sleep.
// On macOS `ps axeww` does not show the environment of an Apple-signed binary
// (/bin/sleep, /bin/bash, even a copy outside /bin), so such a stand-in never
// carries the plugin markers the reaper requires and is never a candidate.
// Measured on macOS 26.5. Real pollers are bun/node, whose environment ps shows.
// The real-process cases assert liveness FIRST, so on the code without the
// guards they fail because the process was stopped, not on a missing export.
// A real tmux server is never touched: a fake tmux answers every query.
import { describe, it, expect, afterAll, vi } from 'vitest'
import { spawn } from 'node:child_process'
import { mkdirSync, writeFileSync, chmodSync, mkdtempSync, rmSync, readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import {
  parseStateDirPollerPids,
  isPluginPollerPid,
  paneAncestorPids,
  reapChannelOrphans,
  reapDetachedChannelClaudes,
  type ProcRow,
} from '../web/channel-poller-reap.js'
import { channelStateDir } from '../channel-provider.js'
import { logger } from '../logger.js'

describe('cf075d41 pure: the plugin markers and the pane ancestors', () => {
  const ps = [
    '  101 ?  S  0:00 bun server.ts TELEGRAM_STATE_DIR=/a/telegram CLAUDE_PLUGIN_ROOT=/c/plugins/cache/x/telegram/0.0.7',
    '  102 ?  S  0:00 node build.js TELEGRAM_STATE_DIR=/a/telegram HOME=/h',
    '  103 ?  S  0:00 bun server.ts TELEGRAM_STATE_DIR=/a/telegram-old CLAUDE_PLUGIN_ROOT=/c/plugins/cache/x/telegram/0.0.7',
    '  104 ?  S  0:00 bun server.ts TELEGRAM_STATE_DIR=/a/telegram CLAUDE_PLUGIN_ROOT=/c/plugins/cache/x/telegram-inline/1.0',
    '  105 ?  S  0:00 sleep 300 HOME=/h',
  ].join('\n')

  it('an env-scan candidate needs the state dir AND the plugin root, both exact', () => {
    expect(parseStateDirPollerPids(ps, 'TELEGRAM_STATE_DIR', '/a/telegram', '/telegram')).toEqual([101])
  })

  it('bot.pid is a plugin process only with the plugin root marker', () => {
    expect(isPluginPollerPid(ps, 101, '/telegram')).toBe(true)
    expect(isPluginPollerPid(ps, 102, '/telegram')).toBe(false)
    expect(isPluginPollerPid(ps, 105, '/telegram')).toBe(false)
    expect(isPluginPollerPid(ps, 999, '/telegram')).toBe(false) // not in the snapshot
  })

  it('the pane ancestors hold the parent and the grandparent of a pane', () => {
    const procs: ProcRow[] = [
      { pid: 10, ppid: 1, command: 'tmux new-session' },
      { pid: 20, ppid: 10, command: 'claude --channels plugin:telegram@x' },
      { pid: 30, ppid: 20, command: 'bash' },
      { pid: 40, ppid: 1, command: 'claude --channels plugin:telegram@y' },
    ]
    expect([...paneAncestorPids(procs, new Set([30]))].sort()).toEqual([10, 20])
  })
})

// ---------------------------------------------------------------------------
// Real processes, fake tmux.
const tmp = mkdtempSync(join(tmpdir(), 'reap-guards-'))
const agentDir = join(tmp, 'agent')
const chanDir = channelStateDir('telegram', agentDir)
mkdirSync(chanDir, { recursive: true })
const pluginRoot = join(tmp, 'plugins', 'cache', 'official', 'telegram', '0.0.1')
const fakeTmux = join(tmp, 'fake-tmux')
const kids: number[] = []

// The test runner's own environment may carry either marker; every process here
// gets exactly the markers its case names.
function baseEnv(): Record<string, string> {
  const env: Record<string, string> = {}
  for (const [k, v] of Object.entries(process.env)) {
    if (v !== undefined && k !== 'TELEGRAM_STATE_DIR' && k !== 'CLAUDE_PLUGIN_ROOT') env[k] = v
  }
  return env
}
function spawnWith(cmd: string, args: string[], extra: Record<string, string>): number {
  const p = spawn(cmd, args, { detached: true, stdio: 'ignore', env: { ...baseEnv(), ...extra } })
  p.unref()
  kids.push(p.pid!)
  return p.pid!
}
// 'server.ts' is an inert positional arg here (node ignores it after -e <script>) -- it exists so
// this stand-in satisfies isPollerArgv's argv-shape check too (card 8d625ccd, RedHat NO-GO 22524:
// the fork's own argv layer is layered back on top of the plugin-marker check it tests here).
const nodeJob = (extra: Record<string, string>) => spawnWith(process.execPath, ['-e', 'setInterval(() => {}, 1000); setTimeout(() => process.exit(0), 300000)', 'server.ts'], extra)
function fakeTmuxPrints(body: string): void {
  writeFileSync(fakeTmux, `#!/bin/sh\n${body}\n`)
  chmodSync(fakeTmux, 0o755)
}
const alive = (pid: number): boolean => { try { process.kill(pid, 0); return true } catch { return false } }
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
const clearBotPid = () => { rmSync(join(chanDir, 'bot.pid'), { force: true }) }

afterAll(() => {
  for (const k of kids) { try { process.kill(k, 'SIGKILL') } catch { /* gone */ } }
  rmSync(tmp, { recursive: true, force: true })
})

describe('cf075d41 reapChannelOrphans on real processes', () => {
  it('(i) a stale bot.pid naming a live process that is not a plugin process: NOT stopped', async () => {
    const stranger = spawnWith(process.execPath, ['-e', 'setInterval(() => {}, 1000); setTimeout(() => process.exit(0), 300000)'], {})
    await sleep(150)
    writeFileSync(join(chanDir, 'bot.pid'), String(stranger))
    fakeTmuxPrints('echo 4242')
    const r = reapChannelOrphans('telegram', agentDir, { tmuxPath: fakeTmux })
    await sleep(600)
    expect(alive(stranger)).toBe(true)
    expect(r.reaped).not.toContain(stranger)
    expect(r.source.fromBotPid).toBeNull()
    expect(r.skippedNotPlugin).toContain(stranger)
    clearBotPid()
  })

  it('(ii) a detached node job with the inherited state dir, outside the plugin root: NOT stopped', async () => {
    clearBotPid()
    const job = nodeJob({ TELEGRAM_STATE_DIR: chanDir })
    await sleep(300)
    fakeTmuxPrints('echo 4242')
    const info = vi.spyOn(logger, 'info')
    const r = reapChannelOrphans('telegram', agentDir, { tmuxPath: fakeTmux })
    await sleep(600)
    expect(alive(job)).toBe(true)
    expect(r.reaped).not.toContain(job)
    expect(r.source.fromEnvScan).not.toContain(job)
    expect(r.skippedNotPlugin).toContain(job)
    const line = info.mock.calls.find(([, m]) => String(m).includes('are not plugin processes (cf075d41)'))
    expect(line?.[0]).toMatchObject({ skippedNotPlugin: r.skippedNotPlugin.length })
    expect(JSON.stringify(line?.[0])).not.toContain(String(job)) // a count, not a line per pid
    info.mockRestore()
    process.kill(job, 'SIGKILL'); await sleep(150)
  })

  it('(v) card b89fbac6: a plugin process carrying BOTH markers but failing the argv-shape check is spared, via the env scan AND via bot.pid', async () => {
    // Unlike (i)/(ii), this process passes every check EXCEPT isPollerArgv: it has
    // CLAUDE_PLUGIN_ROOT (so isPluginPollerPid/parseStateDirPollerPids both say yes) and the state
    // dir, but no 'server.ts' argv element, so filterPollerPids's own argv-shape check is the ONLY
    // thing standing between it and a kill. Pins reapChannelOrphans's own two filterPollerPids call
    // sites (fromBotPid, fromEnvScan) -- WhiteHat 22621/4 mutants: dropping either call left this
    // candidate reaped despite every existing fixture already satisfying isPollerArgv by construction.
    clearBotPid()
    const notAPollerArgv = spawnWith(
      process.execPath,
      ['-e', 'setInterval(() => {}, 1000); setTimeout(() => process.exit(0), 300000)'],
      { TELEGRAM_STATE_DIR: chanDir, CLAUDE_PLUGIN_ROOT: pluginRoot },
    )
    await sleep(300)
    fakeTmuxPrints('echo 4242')
    const r1 = reapChannelOrphans('telegram', agentDir, { tmuxPath: fakeTmux })
    await sleep(600)
    expect(alive(notAPollerArgv)).toBe(true)
    expect(r1.reaped).not.toContain(notAPollerArgv)
    expect(r1.source.fromEnvScan).not.toContain(notAPollerArgv)

    writeFileSync(join(chanDir, 'bot.pid'), String(notAPollerArgv))
    const r2 = reapChannelOrphans('telegram', agentDir, { tmuxPath: fakeTmux })
    await sleep(600)
    expect(alive(notAPollerArgv)).toBe(true)
    expect(r2.reaped).not.toContain(notAPollerArgv)
    expect(r2.source.fromBotPid).toBeNull()

    clearBotPid()
    process.kill(notAPollerArgv, 'SIGKILL'); await sleep(150)
  })

  it('(vi) card b89fbac6, RedHat NO-GO 23465: a non-bun/node process whose argv literally contains server.ts is spared, via the env scan AND via bot.pid', async () => {
    // Every (v)-style fixture above fails isPollerArgv because it has NO server.ts argv element at
    // all -- that leaves the exe check (isPollerArgv's `exe !== 'bun' && exe !== 'node'`) completely
    // unexercised by a real process: dropping it survived 103/103 green (RedHat's measured mutant
    // B9). This process's exe is /bin/sh, not bun/node, but its argv DOES contain the literal token
    // 'server.ts' (as a positional arg after `-c`) -- the one shape that distinguishes the exe check
    // from the server.ts-element check.
    clearBotPid()
    const notBunOrNode = spawnWith('/bin/sh', ['-c', 'sleep 300', 'server.ts'], { TELEGRAM_STATE_DIR: chanDir, CLAUDE_PLUGIN_ROOT: pluginRoot })
    await sleep(300)
    fakeTmuxPrints('echo 4242')
    const r1 = reapChannelOrphans('telegram', agentDir, { tmuxPath: fakeTmux })
    await sleep(600)
    expect(alive(notBunOrNode)).toBe(true)
    expect(r1.reaped).not.toContain(notBunOrNode)
    expect(r1.source.fromEnvScan).not.toContain(notBunOrNode)

    writeFileSync(join(chanDir, 'bot.pid'), String(notBunOrNode))
    const r2 = reapChannelOrphans('telegram', agentDir, { tmuxPath: fakeTmux })
    await sleep(600)
    expect(alive(notBunOrNode)).toBe(true)
    expect(r2.reaped).not.toContain(notBunOrNode)
    expect(r2.source.fromBotPid).toBeNull()

    clearBotPid()
    process.kill(notBunOrNode, 'SIGKILL'); await sleep(150)
  })

  it('(iv) positive control: a real orphan poller (state dir AND plugin root) is still stopped, via the env scan and via bot.pid', async () => {
    clearBotPid()
    const scanned = nodeJob({ TELEGRAM_STATE_DIR: chanDir, CLAUDE_PLUGIN_ROOT: pluginRoot })
    // node, not /bin/sleep: see the macOS note in the header. 'server.ts' trailing arg: see nodeJob.
    const listed = spawnWith(process.execPath, ['-e', 'setInterval(() => {}, 1000); setTimeout(() => process.exit(0), 300000)', 'server.ts'], { TELEGRAM_STATE_DIR: chanDir, CLAUDE_PLUGIN_ROOT: pluginRoot })
    await sleep(300)
    writeFileSync(join(chanDir, 'bot.pid'), String(listed))
    fakeTmuxPrints('echo 4242')
    const r = reapChannelOrphans('telegram', agentDir, { tmuxPath: fakeTmux })
    await sleep(600)
    expect(alive(scanned)).toBe(false)
    expect(alive(listed)).toBe(false)
    expect(r.reaped).toEqual(expect.arrayContaining([scanned, listed]))
    expect(r.source.fromBotPid).toBe(listed)
    clearBotPid()
  })
})

// The detached-claude path, with a needle that exists only in this test's argv
// (a fake tmux makes every real `claude --channels` on the host look detached).
describe('cf075d41 reapDetachedChannelClaudes on real processes', () => {
  const needle = (tag: string) => `plugin:telegram@guards-cf075d41-${tag}-${process.pid}-${Date.now()}`
  async function claudeWithChild(tag: string, n: string): Promise<{ claude: number; child: number }> {
    const childFile = join(tmp, `dc-${tag}.pid`)
    const claude = spawnWith('/bin/bash', ['-c',
      `exec -a claude /bin/bash -c 'sleep 300 & echo $! > ${childFile}; wait' x --channels ${n}`], {})
    for (let i = 0; i < 40 && !existsSync(childFile); i++) await sleep(50)
    const child = parseInt(readFileSync(childFile, 'utf-8').trim(), 10)
    kids.push(child)
    return { claude, child }
  }

  it('(iii) a detached claude --channels that is the parent of a live pane leader: NOT stopped', async () => {
    const n = needle('pane-parent')
    const { claude, child } = await claudeWithChild('pane-parent', n)
    fakeTmuxPrints(`echo ${child}`) // the child is a live pane leader
    const warn = vi.spyOn(logger, 'warn')
    const reaped = reapDetachedChannelClaudes({ tmuxPath: fakeTmux, channelNeedle: n })
    await sleep(600)
    expect(alive(claude)).toBe(true)
    expect(alive(child)).toBe(true)
    expect(reaped).toEqual([])
    const line = warn.mock.calls.find(([, m]) => String(m).includes('ancestor of a live pane'))
    expect(line?.[0]).toMatchObject({ skippedPaneAncestor: [claude] })
    warn.mockRestore()
  })

  it('(iv) positive control: a detached claude --channels with no live pane under it is still stopped', async () => {
    const n = needle('orphan')
    const { claude } = await claudeWithChild('orphan', n)
    fakeTmuxPrints('echo 4242')
    const reaped = reapDetachedChannelClaudes({ tmuxPath: fakeTmux, channelNeedle: n })
    await sleep(600)
    expect(reaped).toEqual([claude])
    expect(alive(claude)).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// The seams (review of #1829): the same guards on a handed snapshot. No process is
// started and no tmux is asked: `psEww`, `procs`, `panePids` and `tmuxServerPid`
// stand for the host, and the kill seam records the signals against a fake process
// table (a pid in it answers, a SIGTERM or SIGKILL ends it, any other pid is ESRCH).
describe('cf075d41 seams: the reapers read a handed snapshot, not the host', () => {
  const sAgent = join(tmp, 'seam-agent')
  const sChan = channelStateDir('telegram', sAgent)
  mkdirSync(sChan, { recursive: true })
  const root = '/c/plugins/cache/x/telegram/0.0.7'
  const POLLER = 3_900_001, STRANGER = 3_900_002, JOB = 3_900_003, PANE = 3_900_010, SERVER = 3_900_020
  const psEww = () => [
    `${POLLER} ?  S  0:00 bun server.ts TELEGRAM_STATE_DIR=${sChan} CLAUDE_PLUGIN_ROOT=${root}`,
    `${STRANGER} ?  S  0:00 sleep 300 HOME=/h`,
    `${JOB} ?  S  0:00 node build.js TELEGRAM_STATE_DIR=${sChan} HOME=/h`,
  ].join('\n')
  const procs = (): ProcRow[] => [
    { pid: SERVER, ppid: 1, command: 'tmux new-session -d' },
    { pid: PANE, ppid: SERVER, command: 'bash' },
    { pid: POLLER, ppid: 1, command: 'bun server.ts' },
    { pid: STRANGER, ppid: 1, command: 'sleep 300' },
    { pid: JOB, ppid: 1, command: 'node build.js' },
  ]
  function fakeKill(pids: number[]) {
    const live = new Set(pids)
    const signalled: number[] = []
    const kill = (pid: number, signal: NodeJS.Signals | 0) => {
      if (!live.has(pid)) throw Object.assign(new Error('kill ESRCH'), { code: 'ESRCH' })
      if (signal !== 0) { signalled.push(pid); live.delete(pid) }
    }
    return { signalled, kill }
  }
  // Synthetic pids (3_900_00x), never real processes: readArgv's /proc read would ENOENT on all of
  // them, which would silently fail every candidate closed instead of exercising the plugin-marker/
  // argv combination this block tests. argvOf hands back the same shape the ps-row command column
  // already states, per pid (card 8d625ccd, RedHat NO-GO 22524, the seam the fix needed).
  const argvByPid = new Map<number, string[]>([
    [POLLER, ['bun', 'server.ts']],
    [STRANGER, ['sleep', '300']],
    [JOB, ['node', 'build.js']],
  ])
  const handed = (kill: (pid: number, signal: NodeJS.Signals | 0) => void) =>
    ({
      psEww, procs, panePids: () => new Set([PANE]), tmuxServerPid: () => SERVER, ownUid: 1000, ownerOf: () => 1000, kill,
      argvOf: (pid: number) => argvByPid.get(pid) ?? null,
    })

  it('(s1) the snapshot decides: the orphan plugin poller is signalled; the stale bot.pid and the inherited-env job are not', () => {
    writeFileSync(join(sChan, 'bot.pid'), String(STRANGER))
    const k = fakeKill([POLLER, STRANGER, JOB])
    const r = reapChannelOrphans('telegram', sAgent, handed(k.kill))
    expect(r.reaped).toEqual([POLLER])
    expect([...r.skippedNotPlugin].sort()).toEqual([STRANGER, JOB].sort())
    expect(k.signalled).toEqual([POLLER])
    rmSync(join(sChan, 'bot.pid'), { force: true })
  })

  it('(s2) an empty pane list from the seam is a failed tmux query: nothing is signalled', () => {
    const k = fakeKill([POLLER])
    const r = reapChannelOrphans('telegram', sAgent, { ...handed(k.kill), panePids: () => new Set<number>() })
    expect(r.reaped).toEqual([])
    expect(k.signalled).toEqual([])
  })

  it('(s3) a null server pid from the seam is a failed tmux query: nothing is signalled', () => {
    const k = fakeKill([POLLER])
    const r = reapChannelOrphans('telegram', sAgent, { ...handed(k.kill), tmuxServerPid: () => null })
    expect(r.reaped).toEqual([])
    expect(k.signalled).toEqual([])
  })

  it('(s4) reapDetachedChannelClaudes: a detached claude above a live pane is spared, one with no pane under it is signalled', () => {
    const needle = 'plugin:telegram@seam-cf075d41'
    const ABOVE = 3_900_101, ITS_PANE = 3_900_102, ALONE = 3_900_103
    const rows: ProcRow[] = [
      { pid: ABOVE, ppid: 1, command: `claude --channels ${needle}` },
      { pid: ITS_PANE, ppid: ABOVE, command: 'bash' },
      { pid: ALONE, ppid: 1, command: `claude --channels ${needle}` },
    ]
    const k = fakeKill([ABOVE, ITS_PANE, ALONE])
    const reaped = reapDetachedChannelClaudes({
      channelNeedle: needle, procs: () => rows, panePids: () => new Set([ITS_PANE]), ownUid: 1000, ownerOf: () => 1000, kill: k.kill,
    })
    expect(reaped).toEqual([ALONE])
    expect(k.signalled).toEqual([ALONE])
  })
})
