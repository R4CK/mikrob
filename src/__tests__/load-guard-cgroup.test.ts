// load-guard-cgroup-apply.sh: the pure decision + cpu.max write layer for the "hard" tier cgroup
// throttle (card d7a28a0a, Feladat 2 of the load-brake phase 19f3bbb5). Exercises the real CLI
// against throwaway scope directories and state/config files -- --target-json is the test-only
// override the script documents for exactly this purpose (mirrors --metrics-json in
// load-guard-eval.test.ts), so real tmux/kanban discovery (load-guard-cgroup-target.sh) is never
// touched here, same split as load-guard-read.sh vs. load-guard-eval.sh.
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const STORE = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'store')
const APPLY_SCRIPT = join(STORE, 'load-guard-cgroup-apply.sh')

let dir: string
let statePath: string
let configPath: string
let scopeX: string
let scopeY: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'load-guard-cgroup-'))
  statePath = join(dir, 'cgroup-state.json')
  configPath = join(dir, 'config.json')
  scopeX = join(dir, 'tmux-spawn-x.scope')
  scopeY = join(dir, 'tmux-spawn-y.scope')
  mkdirSync(scopeX)
  mkdirSync(scopeY)
  writeFileSync(configPath, JSON.stringify({ cgroup_throttle: { enabled: true, quota_pct: 25 } }))
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

function run(action: string, target: { target: string | null; scope: string | null }): { throttled: string | null; changed: boolean; scope: string | null } {
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
  ]).toString()
  return JSON.parse(out)
}

function cpuMax(scope: string): string | null {
  const p = join(scope, 'cpu.max')
  return existsSync(p) ? readFileSync(p, 'utf-8').trim() : null
}

describe('load-guard-cgroup-apply: applying the throttle', () => {
  it('hard tier + a resolved target writes quota_pct into the scope cpu.max', () => {
    const r = run('cgroup_throttle', { target: 'fullstack', scope: scopeX })
    expect(r.throttled).toBe('fullstack')
    expect(r.changed).toBe(true)
    expect(cpuMax(scopeX)).toBe('25000 100000')
  })

  it('a custom quota_pct in config is honored', () => {
    writeFileSync(configPath, JSON.stringify({ cgroup_throttle: { enabled: true, quota_pct: 10 } }))
    run('cgroup_throttle', { target: 'fullstack', scope: scopeX })
    expect(cpuMax(scopeX)).toBe('10000 100000')
  })

  it('hard tier but no eligible target (null) throttles nobody, does not crash', () => {
    const r = run('cgroup_throttle', { target: null, scope: null })
    expect(r.throttled).toBeNull()
    expect(r.changed).toBe(false)
  })

  it('re-asserts the same value on a repeat tick (idempotent write), changed=false the 2nd time', () => {
    run('cgroup_throttle', { target: 'fullstack', scope: scopeX })
    writeFileSync(join(scopeX, 'cpu.max'), 'max\n') // simulate something else resetting it
    const r = run('cgroup_throttle', { target: 'fullstack', scope: scopeX })
    expect(r.changed).toBe(false)
    expect(cpuMax(scopeX)).toBe('25000 100000') // re-asserted despite the out-of-band reset
  })
})

describe('load-guard-cgroup-apply: releasing the throttle', () => {
  it('dropping out of hard (e.g. to soft) releases a previously throttled scope back to max', () => {
    run('cgroup_throttle', { target: 'fullstack', scope: scopeX })
    const r = run('stop_new_dispatch', { target: null, scope: null })
    expect(r.throttled).toBeNull()
    expect(r.changed).toBe(true)
    expect(cpuMax(scopeX)).toBe('max')
  })

  it('dropping to log_only (watch) also releases', () => {
    run('cgroup_throttle', { target: 'fullstack', scope: scopeX })
    run('log_only', { target: null, scope: null })
    expect(cpuMax(scopeX)).toBe('max')
  })
})

describe('load-guard-cgroup-apply: hand-off between two different targets', () => {
  it('a new lowest-priority target releases the old scope and applies the new one, never both throttled', () => {
    run('cgroup_throttle', { target: 'fullstack', scope: scopeX })
    const r = run('cgroup_throttle', { target: 'jogasz', scope: scopeY })
    expect(r.throttled).toBe('jogasz')
    expect(r.changed).toBe(true)
    expect(cpuMax(scopeX)).toBe('max')
    expect(cpuMax(scopeY)).toBe('25000 100000')
  })
})

describe('load-guard-cgroup-apply: kill switch (KOCKAZAT #3 mitigation)', () => {
  it('cgroup_throttle.enabled=false in config throttles nobody even at hard tier with a valid target', () => {
    writeFileSync(configPath, JSON.stringify({ cgroup_throttle: { enabled: false, quota_pct: 25 } }))
    const r = run('cgroup_throttle', { target: 'fullstack', scope: scopeX })
    expect(r.throttled).toBeNull()
    expect(cpuMax(scopeX)).toBeNull()
  })

  it('flipping enabled=false while a throttle is already active releases it on the next tick', () => {
    run('cgroup_throttle', { target: 'fullstack', scope: scopeX })
    writeFileSync(configPath, JSON.stringify({ cgroup_throttle: { enabled: false, quota_pct: 25 } }))
    const r = run('cgroup_throttle', { target: 'fullstack', scope: scopeX })
    expect(r.throttled).toBeNull()
    expect(cpuMax(scopeX)).toBe('max')
  })
})

describe('load-guard-cgroup-apply: CONTROL -- critical tier alone (sigstop layer not built yet) does not throttle', () => {
  it('sigstop_freeze action with a target present still does not apply a cgroup throttle', () => {
    const r = run('sigstop_freeze', { target: 'fullstack', scope: scopeX })
    expect(r.throttled).toBeNull()
    expect(cpuMax(scopeX)).toBeNull()
  })
})
