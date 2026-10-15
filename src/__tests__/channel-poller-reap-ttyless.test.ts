import { spawn, execFileSync, type ChildProcess } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { channelStateDir } from '../channel-provider.js'
import { collectPollerEvidence } from '../web/channel-poller-reap.js'

// Card PSEWWMACOSBLIND1007. An orphaned channel poller is a process whose tmux
// pane is gone, i.e. a process WITHOUT a controlling terminal. On macOS
// `ps eww -e` drops every such process (measured 2026-10-07: 255 rows vs 981
// for `ps axeww`), so the env scan never saw the orphan it exists to find.
// This drives the real scan against a real detached process: a source-text pin
// on the command string would not catch a regression to a blind form.

let children: ChildProcess[] = []
let agentDir: string | null = null

afterEach(() => {
  for (const child of children) {
    if (child.pid) {
      try { process.kill(child.pid, 'SIGKILL') } catch { /* already gone */ }
    }
  }
  children = []
  if (agentDir) rmSync(agentDir, { recursive: true, force: true })
  agentDir = null
})

function ttyOf(pid: number): string {
  return execFileSync('/bin/ps', ['-o', 'tty=', '-p', String(pid)], { encoding: 'utf-8' }).trim()
}

function spawnDetached(env: NodeJS.ProcessEnv, argv: string[] = ['-e', 'setTimeout(() => {}, 30000)']): number {
  // detached: true -> setsid(), so the child has no controlling terminal,
  // whatever terminal (if any) the test runner itself has.
  const child = spawn(process.execPath, argv, {
    detached: true,
    stdio: 'ignore',
    env,
  })
  children.push(child)
  expect(child.pid).toBeGreaterThan(1)
  return child.pid!
}

// isPollerArgv (card 8c94283b) requires argv[0] basename bun/node AND a later arg basename
// "server.ts" -- the env-var needle alone is not a poller identifier (channel-poller-reap.ts's
// own comment). A real channel poller is launched as `bun server.ts`/`node .../server.ts`; this
// spawns that exact shape so the test fixture is a poller by BOTH signals, not only the env one.
function spawnDetachedPoller(env: NodeJS.ProcessEnv, dir: string): number {
  const scriptPath = join(dir, 'server.ts')
  writeFileSync(scriptPath, 'setTimeout(() => {}, 30000)')
  return spawnDetached(env, [scriptPath])
}

describe('env scan sees pollers without a controlling terminal', () => {
  it('collectPollerEvidence finds a detached (tty-less) plugin poller, but not a detached background job', async () => {
    agentDir = mkdtempSync(join(tmpdir(), 'psaxeww-agent-'))
    const chanDir = channelStateDir('telegram', agentDir)
    const base: NodeJS.ProcessEnv = { ...process.env, TELEGRAM_STATE_DIR: chanDir }
    delete base.CLAUDE_PLUGIN_ROOT

    // Shape of an orphaned channel poller: launched by Claude Code as a plugin.
    const poller = spawnDetachedPoller({ ...base, CLAUDE_PLUGIN_ROOT: join(agentDir, 'plugins/cache/x/telegram/0.0.6') }, agentDir)
    // Shape of an agent's background job (e.g. a long node script from its Bash
    // tool): it inherited the state dir, but it is not a plugin (Geri's review).
    const job = spawnDetached(base)
    // Give the kernel a moment to expose the new processes' environments to ps.
    await new Promise((r) => setTimeout(r, 300))

    // Self-check of the fixture: the probes really are tty-less. Without this,
    // a runner that somehow handed them a tty would make the test pass on the
    // blind form too.
    expect(['??', '?']).toContain(ttyOf(poller))
    expect(['??', '?']).toContain(ttyOf(job))

    const evidence = collectPollerEvidence('telegram', agentDir, 999_999_999)
    expect(evidence.envScanPids).toContain(poller)
    expect(evidence.rows.map((r) => r.pid)).toContain(poller)
    expect(evidence.envScanPids).not.toContain(job)
  })
})

// The behavioural test above drives one call site (collectPollerEvidence ->
// listPollerPidsByStateDir). The other two callers of the same scan cannot be
// driven cheaply (one needs a live tmux main session, the other is channels.sh
// run as a whole), so they are pinned to the shared form here: every executable
// ps env scan in the reaper goes through PS_ENV_SCAN_CMD, and the channels.sh
// second pass uses `ps axeww`.
describe('every env-scan call site uses the tty-inclusive form', () => {
  const here = dirname(fileURLToPath(import.meta.url))
  const codeLines = (path: string, comment: string) =>
    readFileSync(path, 'utf-8').split('\n').filter((l) => !l.trim().startsWith(comment))

  it('channel-poller-reap.ts has no literal ps env scan outside PS_ENV_SCAN_CMD', () => {
    const lines = codeLines(join(here, '../web/channel-poller-reap.ts'), '//')
    expect(lines.filter((l) => /\/bin\/ps eww/.test(l))).toEqual([])
    const scans = lines.filter((l) => l.includes('execSync(PS_ENV_SCAN_CMD'))
    expect(scans.length).toBe(2)
  })

  it('channels.sh second reap pass (CLAUDE_PLUGIN_ROOT) scans with ps axeww', () => {
    const lines = codeLines(join(here, '../../scripts/channels.sh'), '#')
    // Two assignments to the same name, by design: the scan line, then a reassignment that
    // filters it through _reap_poller_pids -- only the FIRST is the actual ps scan.
    const pass2 = lines.filter((l) => l.startsWith('ORPHAN_PIDS2='))
    expect(pass2.length).toBe(2)
    expect(pass2[0]).toContain('/bin/ps axeww ')
  })
})
