// load-guard-sigstop-apply.sh: the pure decision + SIGSTOP/SIGCONT signal layer for the "critical"
// tier freeze (card 2bfbf805, Feladat 3 of the load-brake phase 19f3bbb5). Exercises the real CLI
// against a THROWAWAY spawned child process and state/config files -- --target-json is the
// test-only override the script documents for exactly this purpose (mirrors --scope-json in
// load-guard-cgroup.test.ts), so real tmux/kanban discovery (load-guard-sigstop-target.sh) is
// never touched here. The spawned child is `sleep`, never anything of this repo's own -- signaling
// it is safe regardless of what else is running on the test box.
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFileSync, spawn, type ChildProcess } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const STORE = join(fileURLToPath(import.meta.url), '..', '..', '..', 'store')
const APPLY_SCRIPT = join(STORE, 'load-guard-sigstop-apply.sh')
const TARGET_SCRIPT = join(STORE, 'load-guard-sigstop-target.sh')

let dir: string
let statePath: string
let configPath: string
let children: ChildProcess[] = []

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'load-guard-sigstop-'))
  statePath = join(dir, 'sigstop-state.json')
  configPath = join(dir, 'config.json')
  children = []
  writeFileSync(configPath, JSON.stringify({ sigstop_freeze: { enabled: true, max_freeze_seconds: 90 } }))
})

afterEach(() => {
  for (const c of children) {
    if (c.pid) {
      try {
        process.kill(c.pid, 'SIGCONT')
      } catch {
        /* already gone */
      }
      try {
        process.kill(c.pid, 'SIGKILL')
      } catch {
        /* already gone */
      }
    }
  }
  rmSync(dir, { recursive: true, force: true })
})

function spawnSleeper(): number {
  const c = spawn('sleep', ['300'])
  children.push(c)
  if (!c.pid) throw new Error('failed to spawn the throwaway sleep child')
  return c.pid
}

function procState(pid: number): string {
  return execFileSync('ps', ['-o', 'stat=', '-p', String(pid)]).toString().trim()
}

function run(
  action: string,
  target: { target: string | null; pid: number | null },
  now: number,
): { frozen: string | null; changed: boolean; pid: number | null; forced_release: boolean } {
  const out = execFileSync('bash', [
    APPLY_SCRIPT,
    '--action',
    action,
    '--target-json',
    JSON.stringify(target),
    '--state',
    statePath,
    '--config',
    configPath,
    '--now',
    String(now),
  ]).toString()
  return JSON.parse(out)
}

describe('load-guard-sigstop-apply: applying the freeze', () => {
  it('critical tier + a resolved target actually SIGSTOPs the pid', () => {
    const pid = spawnSleeper()
    const r = run('sigstop_freeze', { target: 'fullstack', pid }, 1000)
    expect(r.frozen).toBe('fullstack')
    expect(r.changed).toBe(true)
    expect(procState(pid)).toMatch(/^T/)
  })

  it('critical tier but no eligible target (null) freezes nobody, does not crash', () => {
    const r = run('sigstop_freeze', { target: null, pid: null }, 1000)
    expect(r.frozen).toBeNull()
    expect(r.changed).toBe(false)
  })

  it('re-asserts the freeze on a repeat tick (idempotent), changed=false the 2nd time', () => {
    const pid = spawnSleeper()
    run('sigstop_freeze', { target: 'fullstack', pid }, 1000)
    const r = run('sigstop_freeze', { target: 'fullstack', pid }, 1010)
    expect(r.changed).toBe(false)
    expect(procState(pid)).toMatch(/^T/)
  })
})

describe('load-guard-sigstop-apply: releasing the freeze', () => {
  it('dropping out of critical (e.g. back to hard) releases a frozen pid', () => {
    const pid = spawnSleeper()
    run('sigstop_freeze', { target: 'fullstack', pid }, 1000)
    const r = run('cgroup_throttle', { target: null, pid: null }, 1010)
    expect(r.frozen).toBeNull()
    expect(r.changed).toBe(true)
    expect(procState(pid)).not.toMatch(/^T/)
  })

  it('dropping to log_only (watch) also releases', () => {
    const pid = spawnSleeper()
    run('sigstop_freeze', { target: 'fullstack', pid }, 1000)
    run('log_only', { target: null, pid: null }, 1010)
    expect(procState(pid)).not.toMatch(/^T/)
  })
})

describe('load-guard-sigstop-apply: hand-off between two different targets', () => {
  it('a new pick releases the old pid and freezes the new one, never both frozen', () => {
    const pidA = spawnSleeper()
    const pidB = spawnSleeper()
    run('sigstop_freeze', { target: 'fullstack', pid: pidA }, 1000)
    const r = run('sigstop_freeze', { target: 'jogasz', pid: pidB }, 1010)
    expect(r.frozen).toBe('jogasz')
    expect(procState(pidA)).not.toMatch(/^T/)
    expect(procState(pidB)).toMatch(/^T/)
  })
})

describe('load-guard-sigstop-apply: kill switch', () => {
  it('sigstop_freeze.enabled=false in config freezes nobody even at critical tier with a valid target', () => {
    writeFileSync(configPath, JSON.stringify({ sigstop_freeze: { enabled: false, max_freeze_seconds: 90 } }))
    const pid = spawnSleeper()
    const r = run('sigstop_freeze', { target: 'fullstack', pid }, 1000)
    expect(r.frozen).toBeNull()
    expect(procState(pid)).not.toMatch(/^T/)
  })

  it('flipping enabled=false while frozen releases it on the next tick', () => {
    const pid = spawnSleeper()
    run('sigstop_freeze', { target: 'fullstack', pid }, 1000)
    writeFileSync(configPath, JSON.stringify({ sigstop_freeze: { enabled: false, max_freeze_seconds: 90 } }))
    const r = run('sigstop_freeze', { target: 'fullstack', pid }, 1010)
    expect(r.frozen).toBeNull()
    expect(procState(pid)).not.toMatch(/^T/)
  })
})

describe('load-guard-sigstop-apply: the max-90s forced release (network-timeout tradeoff, Peti-approved)', () => {
  it('a freeze sustained past max_freeze_seconds is force-released even though the action is still sigstop_freeze', () => {
    const pid = spawnSleeper()
    run('sigstop_freeze', { target: 'fullstack', pid }, 1000)
    run('sigstop_freeze', { target: 'fullstack', pid }, 1050) // still under 90s, stays frozen
    expect(procState(pid)).toMatch(/^T/)
    const r = run('sigstop_freeze', { target: 'fullstack', pid }, 1091) // 91s elapsed since 1000
    expect(r.forced_release).toBe(true)
    expect(r.frozen).toBeNull()
    expect(r.changed).toBe(true) // the release IS the transition -- must not read as a no-op
    expect(procState(pid)).not.toMatch(/^T/)
  })

  it('a custom max_freeze_seconds in config is honored', () => {
    writeFileSync(configPath, JSON.stringify({ sigstop_freeze: { enabled: true, max_freeze_seconds: 10 } }))
    const pid = spawnSleeper()
    run('sigstop_freeze', { target: 'fullstack', pid }, 1000)
    const r = run('sigstop_freeze', { target: 'fullstack', pid }, 1011)
    expect(r.forced_release).toBe(true)
    expect(procState(pid)).not.toMatch(/^T/)
  })
})

describe('load-guard-sigstop-apply: self-protection (defense in depth)', () => {
  it('never signals pid 1, even if a target-json claims it', () => {
    expect(() => run('sigstop_freeze', { target: 'init', pid: 1 }, 1000)).not.toThrow()
  })

  it('never signals pid 0', () => {
    expect(() => run('sigstop_freeze', { target: 'nobody', pid: 0 }, 1000)).not.toThrow()
  })
})

// load-guard-sigstop-target.sh: the rank + round-robin SELECTION logic, via --test-select (real
// tmux/kanban discovery is untested directly, same split as load-guard-cgroup-target.sh).
function select(
  candidates: Array<{ agent: string; session: string; pid: number }>,
  prevPick: string,
  kanbanJson: string,
): { target: string | null; pid: number | null; degraded: boolean } {
  const rotationState = join(dir, 'rotation-state.json')
  const out = execFileSync(
    'bash',
    [TARGET_SCRIPT, '--test-select', JSON.stringify(candidates), prevPick, rotationState],
    { input: kanbanJson },
  ).toString()
  return JSON.parse(out)
}

describe('load-guard-sigstop-target: rank picks the worst tier, round-robin picks among ties', () => {
  const CANDS = [
    { agent: 'backend', session: 'agent-backend', pid: 111 },
    { agent: 'fullstack', session: 'agent-fullstack', pid: 222 },
  ]

  it('a strictly lower-priority in_progress card wins over a higher one, no rotation needed', () => {
    const kanban = JSON.stringify([
      { status: 'in_progress', assignee: 'backend', priority: 'high' },
      { status: 'in_progress', assignee: 'fullstack', priority: 'low' },
    ])
    const r = select(CANDS, '', kanban)
    expect(r.target).toBe('fullstack')
    expect(r.degraded).toBe(false)
  })

  it('tied priority round-robins: the candidate AFTER prev_pick wins, wrapping around', () => {
    const kanban = JSON.stringify([
      { status: 'in_progress', assignee: 'backend', priority: 'low' },
      { status: 'in_progress', assignee: 'fullstack', priority: 'low' },
    ])
    expect(select(CANDS, '', kanban).target).toBe('backend') // first in stable (rank, agent) order
    expect(select(CANDS, 'backend', kanban).target).toBe('fullstack')
    expect(select(CANDS, 'fullstack', kanban).target).toBe('backend') // wraps around
  })

  it('a stale/foreign prev_pick (no longer a tied candidate) falls back to the front, not a crash', () => {
    const kanban = JSON.stringify([
      { status: 'in_progress', assignee: 'backend', priority: 'low' },
      { status: 'in_progress', assignee: 'fullstack', priority: 'low' },
    ])
    expect(select(CANDS, 'someone-else-entirely', kanban).target).toBe('backend')
  })

  it('unreachable kanban API (empty stdin) degrades to alphabetical, degraded=true, no rotation', () => {
    const r = select(CANDS, 'backend', '')
    expect(r.target).toBe('backend')
    expect(r.degraded).toBe(true)
  })

  it('a single eligible candidate never rotates -- always that one', () => {
    const one = [{ agent: 'backend', session: 'agent-backend', pid: 111 }]
    const kanban = JSON.stringify([{ status: 'in_progress', assignee: 'backend', priority: 'low' }])
    expect(select(one, 'backend', kanban).target).toBe('backend')
  })

  it('no candidates at all returns null, not a crash', () => {
    const r = select([], '', '[]')
    expect(r.target).toBeNull()
    expect(r.pid).toBeNull()
    expect(r.degraded).toBe(false)
  })
})
