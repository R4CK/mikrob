// RedHat delta re-gate (comment 23081, GO on 6eb41295), non-blocking item 2: the CLI
// switch/--limit wiring (scripts/kg-backfill.ts, now src/kg/backfill-cli.ts) had no shipped test
// -- only backfill.ts's injected-deps tests did, so a later edit could silently reopen it.
// Drives the REAL runBackfillCli() with every collaborator mocked: no DB, no IO, no LLM call.
import { describe, it, expect, vi } from 'vitest'
import type Database from 'better-sqlite3'
import { runBackfillCli, resolveLimit, type BackfillCliDeps } from '../kg/backfill-cli.js'
import { getSettingDefinition } from '../config-registry.js'
import type { BackfillBatchResult } from '../kg/backfill.js'

const batchDef = getSettingDefinition('KG_BACKFILL_BATCH')!

function fakeDb(): Database.Database {
  return {} as Database.Database
}

function makeDeps(overrides: Partial<BackfillCliDeps> = {}): { deps: BackfillCliDeps; logs: string[]; warns: string[] } {
  const logs: string[] = []
  const warns: string[] = []
  const settings = new Map<string, string | number>([
    ['KG_BACKFILL_BATCH', 20],
    ['KG_MAX_SOLUTIONS_PER_CARD', 3],
  ])
  const report: BackfillBatchResult = {
    candidates: 0,
    processed: 0,
    active: 0,
    draft: 0,
    failed: 0,
    skipped: 0,
    haltedOnGpuHold: false,
    captureDisabled: false,
    elapsedSec: 0,
  }
  const deps: BackfillCliDeps = {
    captureEnabled: () => true,
    getEffectiveSettingValue: (key) => settings.get(key) ?? '',
    getSettingDefinition: (key) => (key === 'KG_BACKFILL_BATCH' ? batchDef : undefined),
    initDatabase: vi.fn(),
    getDb: vi.fn(() => fakeDb()),
    openKgDb: vi.fn(() => fakeDb()),
    kgDbPath: () => '/fake/kg.db',
    runBackfillBatch: vi.fn(() => report),
    listCandidates: vi.fn(() => []),
    gpuGate: vi.fn(() => ({ admit: true, detail: 'ok' })),
    runCapture: vi.fn(),
    captureDeps: vi.fn(() => ({ closureCheck: vi.fn(), draftFn: vi.fn(), now: () => 0, extractor: 'x' })) as unknown as BackfillCliDeps['captureDeps'],
    now: () => 1000,
    log: (msg) => logs.push(msg),
    warn: (msg) => warns.push(msg),
    ...overrides,
  }
  return { deps, logs, warns }
}

describe('runBackfillCli', () => {
  it('--help prints the help text and touches nothing', () => {
    const { deps, logs } = makeDeps()
    runBackfillCli(['--help'], deps)
    expect(logs.some((l) => l.includes('kg-backfill --'))).toBe(true)
    expect(deps.initDatabase).not.toHaveBeenCalled()
  })

  it('E1: KG_CAPTURE_ENABLED off -> SKIPPED, no database opened, no batch run', () => {
    const { deps, logs } = makeDeps({ captureEnabled: () => false })
    runBackfillCli([], deps)
    expect(logs).toEqual(['SKIPPED -- KG_CAPTURE_ENABLED off. Nothing read or written.'])
    expect(deps.initDatabase).not.toHaveBeenCalled()
    expect(deps.getDb).not.toHaveBeenCalled()
    expect(deps.openKgDb).not.toHaveBeenCalled()
    expect(deps.runBackfillBatch).not.toHaveBeenCalled()
  })

  it('E2: the switch-read throwing is fail-closed too (captureEnabled itself encodes that; the CLI just trusts it)', () => {
    const { deps } = makeDeps({
      captureEnabled: () => {
        throw new Error('must not reach the CLI -- defaultCaptureEnabled catches this itself')
      },
    })
    expect(() => runBackfillCli([], deps)).toThrow()
  })

  it('switch on: opens both databases and runs the batch with the resolved limit', () => {
    const { deps } = makeDeps()
    runBackfillCli(['--limit', '7'], deps)
    expect(deps.initDatabase).toHaveBeenCalledTimes(1)
    expect(deps.getDb).toHaveBeenCalledTimes(1)
    expect(deps.openKgDb).toHaveBeenCalledTimes(1)
    expect(deps.runBackfillBatch).toHaveBeenCalledWith(expect.anything(), 7, expect.anything())
  })

  it('E6: a trailing --limit with no value falls back to the configured default', () => {
    const { deps } = makeDeps()
    runBackfillCli(['--limit'], deps)
    expect(deps.runBackfillBatch).toHaveBeenCalledWith(expect.anything(), 20, expect.anything())
  })

  it('--db/--kg-db are forwarded', () => {
    const { deps } = makeDeps()
    runBackfillCli(['--db', '/tmp/x.db', '--kg-db', '/tmp/x-kg.db'], deps)
    expect(deps.initDatabase).toHaveBeenCalledWith('/tmp/x.db')
    expect(deps.openKgDb).toHaveBeenCalledWith('/tmp/x-kg.db')
  })

  it('prints the report fields on a normal run', () => {
    const { deps, logs } = makeDeps({
      runBackfillBatch: vi.fn(
        (): BackfillBatchResult => ({
          candidates: 3,
          processed: 3,
          active: 1,
          draft: 1,
          failed: 1,
          skipped: 0,
          haltedOnGpuHold: true,
          captureDisabled: false,
          elapsedSec: 5,
        }),
      ),
    })
    runBackfillCli([], deps)
    expect(logs.join('\n')).toContain('candidates:  3')
    expect(logs.join('\n')).toContain('HALTED')
  })
})

describe('resolveLimit (RedHat 23081 item 4: the CONFIGURED default must be clamped too)', () => {
  it('a valid configured default with no --limit is used as-is', () => {
    expect(resolveLimit(batchDef, 50, undefined, () => {})).toBe(50)
  })

  it('an out-of-range configured default (hand-edited override / stray env value) falls back to the registry default, not the raw value', () => {
    const warns: string[] = []
    expect(resolveLimit(batchDef, 100000, undefined, (m) => warns.push(m))).toBe(20)
    expect(warns.length).toBe(1)
  })

  it('a non-numeric configured default falls back to the registry default', () => {
    expect(resolveLimit(batchDef, 'abc', undefined, () => {})).toBe(20)
  })

  it('a valid --limit overrides a valid configured default', () => {
    expect(resolveLimit(batchDef, 50, '5', () => {})).toBe(5)
  })

  it('an invalid --limit falls back to the validated configured default, not to the raw configured value', () => {
    const warns: string[] = []
    // configured default itself is out of range (100000 -> clamps to registry default 20),
    // AND --limit is invalid: the final value must be 20 (the validated fallback), never 100000.
    expect(resolveLimit(batchDef, 100000, 'abc', (m) => warns.push(m))).toBe(20)
    expect(warns.length).toBe(2)
  })

  it.each(['abc', '0', '-5', '1000', '', ' '])('invalid --limit %j falls back, never to the whole corpus', (bad) => {
    const result = resolveLimit(batchDef, 20, bad, () => {})
    expect(result).toBe(20)
  })

  it('--limit 10x is parsed as 10 by the shared validator (documented edge case, not a bug)', () => {
    expect(resolveLimit(batchDef, 20, '10x', () => {})).toBe(10)
  })
})

describe('defaultCaptureEnabled (direct unit test -- RedHat 23081/23045: no shipped test called it directly)', () => {
  it('reads the real settings-store KG_CAPTURE_ENABLED switch, fail-closed', async () => {
    vi.resetModules()
    vi.doMock('../settings-store.js', () => ({
      getEffectiveSettingValue: (key: string) => {
        if (key !== 'KG_CAPTURE_ENABLED') throw new Error(`unexpected key ${key}`)
        return '1'
      },
    }))
    const { defaultCaptureEnabled } = await import('../kg/backfill.js')
    expect(defaultCaptureEnabled()).toBe(true)
    vi.doUnmock('../settings-store.js')
    vi.resetModules()
  })

  it.each([
    ['0', false],
    ['', false],
    ['true', false], // only the literal string '1' admits -- matches kg-capture-hook.ts's strictness
  ] as const)('%j -> %s', async (raw, expected) => {
    vi.resetModules()
    vi.doMock('../settings-store.js', () => ({ getEffectiveSettingValue: () => raw }))
    const { defaultCaptureEnabled } = await import('../kg/backfill.js')
    expect(defaultCaptureEnabled()).toBe(expected)
    vi.doUnmock('../settings-store.js')
    vi.resetModules()
  })

  it('a throwing settings-store read is fail-closed (false), not a thrown exception', async () => {
    vi.resetModules()
    vi.doMock('../settings-store.js', () => ({
      getEffectiveSettingValue: () => {
        throw new Error('config-overrides.json unreadable')
      },
    }))
    const { defaultCaptureEnabled } = await import('../kg/backfill.js')
    expect(defaultCaptureEnabled()).toBe(false)
    vi.doUnmock('../settings-store.js')
    vi.resetModules()
  })
})
