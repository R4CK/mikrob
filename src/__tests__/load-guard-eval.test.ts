// load-guard-eval.sh / load-guard-check.sh: the hysteresis-debounced state machine + admission
// gate for the load-brake phase (card 2597e3b7, Feladat 1 of 19f3bbb5). Exercises the real CLI
// against throwaway config/state files -- --metrics-json and --now are the test-only overrides
// the script documents for exactly this purpose, so production's real load-guard-read.sh / date
// are never touched here.
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const STORE = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'store')
const EVAL_SCRIPT = join(STORE, 'load-guard-eval.sh')
const CHECK_SCRIPT = join(STORE, 'load-guard-check.sh')
const DAEMON_SCRIPT = join(STORE, 'load-guard-daemon.sh')

const CONFIG = {
  watch: { loadavg_ratio: 0.85, psi_some_avg10: 30, action: 'log_only' },
  soft: { loadavg_ratio: 1.0, psi_some_avg10: 45, action: 'stop_new_dispatch' },
  hard: { loadavg_ratio: 1.3, psi_some_avg10: 60, sustained_seconds: 20, action: 'cgroup_throttle' },
  critical: {
    loadavg_ratio: 1.6,
    psi_some_avg10: 75,
    sustained_seconds: 30,
    action: 'sigstop_freeze',
  },
}

const NPROC = 12
const NOW = 1_800_000_000

/** metrics at a given loadavg1/nproc ratio, PSI left harmless-low so only the ratio axis fires. */
const metricsAtRatio = (ratio: number): string =>
  JSON.stringify({
    psi_some_avg10: 1,
    psi_full_avg10: 0,
    loadavg1: ratio * NPROC,
    loadavg5: ratio * NPROC,
    nproc: NPROC,
    source: 'loadavg',
  })

let dir: string
let configPath: string
let statePath: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'load-guard-'))
  configPath = join(dir, 'config.json')
  statePath = join(dir, 'state.json')
  writeFileSync(configPath, JSON.stringify(CONFIG))
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

function evalAt(
  ratio: number,
  at: number,
): { state: string; action: string; changed: boolean; since: number; instantaneous: string } {
  const out = execFileSync('bash', [
    EVAL_SCRIPT,
    '--config',
    configPath,
    '--state',
    statePath,
    '--metrics-json',
    metricsAtRatio(ratio),
    '--now',
    String(at),
  ]).toString()
  return JSON.parse(out)
}

describe('load-guard-eval: resting state and a single noisy reading', () => {
  it('a fresh state under every threshold stays watch, log_only, unchanged', () => {
    const r = evalAt(0.3, NOW)
    expect(r.state).toBe('watch')
    expect(r.action).toBe('log_only')
    expect(r.changed).toBe(false)
  })

  it('a single SOFT-level reading does NOT flip the state -- only records a pending candidate', () => {
    const r = evalAt(1.05, NOW)
    expect(r.state).toBe('watch')
    expect(r.changed).toBe(false)
    const state = JSON.parse(readFileSync(statePath, 'utf-8'))
    expect(state.pending).toEqual({ tier: 'soft', first_seen: NOW })
  })

  it('a spike that drops back below threshold before the debounce elapses never confirms', () => {
    evalAt(1.05, NOW) // pending: soft @ NOW
    const r = evalAt(0.3, NOW + 10) // drops back before soft's 30s default debounce
    expect(r.state).toBe('watch')
    expect(r.changed).toBe(false)
    const state = JSON.parse(readFileSync(statePath, 'utf-8'))
    expect(state.pending).toBeNull()
  })
})

describe('load-guard-eval: hysteresis confirms after the tier-specific sustain window', () => {
  it('SOFT (default 30s debounce): sustained past 30s confirms, short of it does not', () => {
    evalAt(1.05, NOW)
    const tooSoon = evalAt(1.05, NOW + 29)
    expect(tooSoon.state).toBe('watch')
    expect(tooSoon.changed).toBe(false)

    const confirmed = evalAt(1.05, NOW + 31)
    expect(confirmed.state).toBe('soft')
    expect(confirmed.action).toBe('stop_new_dispatch')
    expect(confirmed.changed).toBe(true)
    expect(confirmed.since).toBe(NOW + 31)
  })

  it('HARD uses its OWN sustained_seconds (20), not the 30s default', () => {
    evalAt(1.35, NOW)
    const at19 = evalAt(1.35, NOW + 19)
    expect(at19.state).toBe('watch')

    const at21 = evalAt(1.35, NOW + 21)
    expect(at21.state).toBe('hard')
    expect(at21.action).toBe('cgroup_throttle')
    expect(at21.changed).toBe(true)
  })

  it('CRITICAL uses its own 30s and is reached DIRECTLY from watch, skipping soft/hard', () => {
    evalAt(1.65, NOW)
    const at29 = evalAt(1.65, NOW + 29)
    expect(at29.state).toBe('watch')

    const at31 = evalAt(1.65, NOW + 31)
    expect(at31.state).toBe('critical')
    expect(at31.action).toBe('sigstop_freeze')
    expect(at31.instantaneous).toBe('critical')
  })

  it('recovery is symmetric: dropping back below threshold also needs its own sustain window', () => {
    evalAt(1.05, NOW)
    evalAt(1.05, NOW + 31) // confirmed soft @ NOW+31
    const dropStarts = NOW + 41 // this call is what STARTS the recovery's pending clock
    const first = evalAt(0.3, dropStarts)
    expect(first.state).toBe('soft')
    expect(first.changed).toBe(false)

    const soon = evalAt(0.3, dropStarts + 29) // 29s since the drop started -- under 30s
    expect(soon.state).toBe('soft')
    expect(soon.changed).toBe(false)

    const recovered = evalAt(0.3, dropStarts + 31) // 31s since the drop started -- confirms
    expect(recovered.state).toBe('watch')
    expect(recovered.action).toBe('log_only')
    expect(recovered.changed).toBe(true)
  })

  it('a re-spike DURING the pending window resets the pending clock (does not carry over stale time)', () => {
    evalAt(1.05, NOW) // pending soft @ NOW
    evalAt(0.3, NOW + 5) // drops -- pending cleared
    const r = evalAt(1.05, NOW + 6) // spikes again: this is a NEW pending, not a continuation
    expect(r.state).toBe('watch')
    const tooSoon = evalAt(1.05, NOW + 6 + 29)
    expect(tooSoon.state).toBe('watch')
    const confirmed = evalAt(1.05, NOW + 6 + 31)
    expect(confirmed.state).toBe('soft')
  })
})

describe('load-guard-check.sh: the ADMIT/HOLD gate callers actually use', () => {
  function checkAt(ratio: number, at: number): { code: number; stdout: string } {
    try {
      const stdout = execFileSync('bash', [
        CHECK_SCRIPT,
        '--config',
        configPath,
        '--state',
        statePath,
        '--metrics-json',
        metricsAtRatio(ratio),
        '--now',
        String(at),
      ]).toString()
      return { code: 0, stdout }
    } catch (err) {
      const e = err as { status: number; stdout: Buffer }
      return { code: e.status, stdout: e.stdout.toString() }
    }
  }

  it('ADMITs (exit 0) while under every threshold', () => {
    const r = checkAt(0.3, NOW)
    expect(r.code).toBe(0)
    expect(r.stdout.trim()).toBe('ADMIT watch')
  })

  it('a lone spike still ADMITs -- the confirmed state has not moved yet', () => {
    const r = checkAt(1.05, NOW)
    expect(r.code).toBe(0)
    expect(r.stdout.trim()).toBe('ADMIT watch')
  })

  it('HOLDs (exit 1) once SOFT is confirmed, and says which action is active', () => {
    checkAt(1.05, NOW)
    const r = checkAt(1.05, NOW + 31)
    expect(r.code).toBe(1)
    expect(r.stdout.trim()).toBe('HOLD soft (stop_new_dispatch)')
  })

  it('CONTROL: a confirmed HARD/CRITICAL state also HOLDs, not just SOFT', () => {
    checkAt(1.65, NOW)
    const r = checkAt(1.65, NOW + 31)
    expect(r.code).toBe(1)
    expect(r.stdout.trim()).toBe('HOLD critical (sigstop_freeze)')
  })
})

describe('load-guard-eval: PSI axis alone can trigger a tier, independent of loadavg', () => {
  const metricsAtPsi = (psi: number): string =>
    JSON.stringify({
      psi_some_avg10: psi,
      psi_full_avg10: 0,
      loadavg1: 0.1 * NPROC, // harmless-low on the ratio axis
      loadavg5: 0.1 * NPROC,
      nproc: NPROC,
      source: 'psi',
    })

  function evalPsiAt(psi: number, at: number): { state: string; action: string } {
    const out = execFileSync('bash', [
      EVAL_SCRIPT,
      '--config',
      configPath,
      '--state',
      statePath,
      '--metrics-json',
      metricsAtPsi(psi),
      '--now',
      String(at),
    ]).toString()
    return JSON.parse(out)
  }

  it('PSI over the SOFT threshold confirms soft even though loadavg ratio is nowhere near it', () => {
    evalPsiAt(50, NOW)
    const r = evalPsiAt(50, NOW + 31)
    expect(r.state).toBe('soft')
    expect(r.action).toBe('stop_new_dispatch')
  })
})

describe('load-guard-daemon.sh: logs ONLY on a state change (card edd8b398)', () => {
  let logPath: string

  beforeEach(() => {
    logPath = join(dir, 'load-guard.log')
  })

  function tickAt(ratio: number, at: number): void {
    execFileSync('bash', [
      DAEMON_SCRIPT,
      '--config',
      configPath,
      '--state',
      statePath,
      '--metrics-json',
      metricsAtRatio(ratio),
      '--now',
      String(at),
      '--log',
      logPath,
    ])
  }

  it('a resting tick with nothing changing writes NOTHING to the log', () => {
    tickAt(0.3, NOW)
    expect(existsSyncSafe(logPath)).toBe(false)
  })

  it('a spike that never gets confirmed (never sustained) also writes nothing', () => {
    tickAt(1.05, NOW)
    tickAt(1.05, NOW + 10) // still under soft's 30s debounce
    expect(existsSyncSafe(logPath)).toBe(false)
  })

  it('a confirmed transition appends exactly ONE line, not one per tick', () => {
    tickAt(1.05, NOW)
    tickAt(1.05, NOW + 10)
    tickAt(1.05, NOW + 20)
    tickAt(1.05, NOW + 31) // confirms here
    tickAt(1.05, NOW + 40) // already soft -- no further change, no further line

    const lines = readFileSync(logPath, 'utf-8').trim().split('\n')
    expect(lines).toHaveLength(1)
    expect(lines[0]).toContain('"state": "soft"')
    expect(lines[0]).toContain('"changed": true')
  })

  function existsSyncSafe(p: string): boolean {
    try {
      readFileSync(p)
      return true
    } catch {
      return false
    }
  }
})
