// Card 612058c2 delta-gate (WhiteHat2 NO-GO H1 @c5e5ec28, comment 19879): the shared fleet-wide
// hourly Gemini-call budget the Ghost pipeline's two real network-call sites (gemini-orchestrator
// ranking, gemini-orchestrator-draft-review per-card review) must both spend from -- the SAME
// counter store/gemini-agy-call.sh uses, not a parallel one. These tests exercise the real
// flock + python3 subprocess (reserveGhostCallSlot IS the thing under test, not mockable from the
// inside), against a throwaway log/lock/seged-hivo copy -- never the real repo's files.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, rmSync, copyFileSync, writeFileSync, readFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { resolveHourlyLimit } from '../gemini-ghost-budget.js'

describe('resolveHourlyLimit() -- M2 regression (card 612058c2 NO-GO): fail-closed on bad env', () => {
  it('a valid positive integer string is used as-is', () => {
    expect(resolveHourlyLimit('3')).toBe(3)
  })
  it('undefined (env not set) falls back to the documented default (5)', () => {
    expect(resolveHourlyLimit(undefined)).toBe(5)
  })
  it('non-numeric text falls back to 5, not fail-open to unlimited', () => {
    expect(resolveHourlyLimit('abc')).toBe(5)
  })
  it('empty string falls back to 5 (Number("") is 0, rejected explicitly)', () => {
    expect(resolveHourlyLimit('')).toBe(5)
  })
  it('zero falls back to 5 (a zero cap would silently block every call forever)', () => {
    expect(resolveHourlyLimit('0')).toBe(5)
  })
  it('a negative number falls back to 5', () => {
    expect(resolveHourlyLimit('-1')).toBe(5)
  })
  it('a non-integer float falls back to 5', () => {
    expect(resolveHourlyLimit('2.5')).toBe(5)
  })
})

describe('reserveGhostCallSlot() -- real flock+python3 against a throwaway root', () => {
  const __dirname = dirname(fileURLToPath(import.meta.url))
  const REAL_SEGED_HIVO = join(__dirname, '..', '..', 'scripts', 'seged-hivo.py')
  let td: string
  let savedEnv: Record<string, string | undefined>

  beforeEach(() => {
    td = mkdtempSync(join(tmpdir(), 'gemini-ghost-budget-test-'))
    mkdirSync(join(td, 'scripts'), { recursive: true })
    mkdirSync(join(td, 'store'), { recursive: true })
    // Copied, not symlinked (scripts/seged-hivo.py's own ROOT is __file__-based -- a symlink
    // would resolve back to the real repo and defeat the sandbox, same reasoning as
    // gemini-agy-call.selftest.sh and gemini-ghost-runner.selftest.sh). ROOT = parent.parent of
    // the script file, so ROOT=td, STORE=td/store, LOG=td/store/seged-hivo-naplo.jsonl.
    copyFileSync(REAL_SEGED_HIVO, join(td, 'scripts', 'seged-hivo.py'))
    writeFileSync(join(td, 'store', 'seged-hivo-naplo.jsonl'), '')
    savedEnv = {
      GEMINI_AGY_HOURLY_LOCK: process.env.GEMINI_AGY_HOURLY_LOCK,
      SEGED_HIVO_HELPERS: process.env.SEGED_HIVO_HELPERS,
      GEMINI_AGY_HOURLY_LIMIT: process.env.GEMINI_AGY_HOURLY_LIMIT,
    }
    process.env.GEMINI_AGY_HOURLY_LOCK = join(td, 'gemini-agy-call.hourly.lock')
    process.env.SEGED_HIVO_HELPERS = join(td, 'scripts', 'seged-hivo.py')
    vi.resetModules()
  })

  afterEach(() => {
    for (const [k, v] of Object.entries(savedEnv)) {
      if (v === undefined) delete process.env[k]
      else process.env[k] = v
    }
    rmSync(td, { recursive: true, force: true })
    vi.resetModules()
  })

  const ledgerPath = () => join(td, 'store', 'seged-hivo-naplo.jsonl')

  function appendRow(agoSeconds: number, status: string, hivo = 'quota-bridge-ghost', seged = 'agy'): void {
    const ts = new Date(Date.now() - agoSeconds * 1000).toISOString()
    const row = { ido: ts, hivas_id: Math.random().toString(16).slice(2), seged, hivo, kartya: 'x', feladattipus: 'kod', status }
    const existing = readFileSync(ledgerPath(), 'utf-8')
    writeFileSync(ledgerPath(), existing + JSON.stringify(row) + '\n')
  }

  async function freshReserveGhostCallSlot() {
    process.env.GEMINI_AGY_HOURLY_LIMIT = process.env.GEMINI_AGY_HOURLY_LIMIT ?? '5'
    const mod = await import('../gemini-ghost-budget.js')
    return mod.reserveGhostCallSlot
  }

  it('a fresh (empty) ledger allows a reservation and appends exactly one new row', async () => {
    const reserveGhostCallSlot = await freshReserveGhostCallSlot()
    const ok = reserveGhostCallSlot('card1')
    expect(ok).toBe(true)
    const rows = readFileSync(ledgerPath(), 'utf-8').trim().split('\n').filter(Boolean)
    expect(rows.length).toBe(1)
    const parsed = JSON.parse(rows[0]!)
    expect(parsed.hivo).toBe('quota-bridge-ghost')
    expect(parsed.seged).toBe('agy')
    expect(parsed.kartya).toBe('card1')
  }, 20_000)

  it('the 6th reservation within the hour (default limit 5) is refused -- no new row appended', async () => {
    const reserveGhostCallSlot = await freshReserveGhostCallSlot()
    const results: boolean[] = []
    for (let i = 0; i < 6; i++) results.push(reserveGhostCallSlot('card1'))
    expect(results).toEqual([true, true, true, true, true, false])
    const rows = readFileSync(ledgerPath(), 'utf-8').trim().split('\n').filter(Boolean)
    expect(rows.length).toBe(5)
  }, 30_000)

  // H1's actual bug (card 612058c2 Teendo 3, "nem uj szamlalo"): a pre-existing row from a
  // DIFFERENT caller (e.g. gemini-agy-call.sh's own "agy:<model>" rows, hivo != 'quota-bridge-
  // ghost') tagged on the SAME seged='agy' engine must count toward the SAME shared budget --
  // the pre-delta version counted only hivo==='quota-bridge-ghost' rows and let the two add up
  // past the real ceiling instead of sharing it.
  it('pre-existing rows from gemini-agy-call.sh (different hivo, same seged=agy) count toward the SAME budget', async () => {
    for (let i = 0; i < 5; i++) appendRow(i * 60, 'ok', 'backend2')
    const reserveGhostCallSlot = await freshReserveGhostCallSlot()
    const ok = reserveGhostCallSlot('card1')
    expect(ok).toBe(false)
  }, 20_000)

  it('a status=blocked row (own or foreign) does not count toward the budget', async () => {
    for (let i = 0; i < 5; i++) appendRow(i * 60, 'blocked', 'backend2')
    const reserveGhostCallSlot = await freshReserveGhostCallSlot()
    const ok = reserveGhostCallSlot('card1')
    expect(ok).toBe(true)
  }, 20_000)

  it('a row older than the 1h window does not count toward the budget', async () => {
    for (let i = 0; i < 5; i++) appendRow(3600 + i * 60, 'ok', 'backend2')
    const reserveGhostCallSlot = await freshReserveGhostCallSlot()
    const ok = reserveGhostCallSlot('card1')
    expect(ok).toBe(true)
  }, 20_000)

  // M2 regression (WhiteHat2, card 612058c2 NO-GO): a non-numeric limit must fail CLOSED to the
  // documented default (5), never fail OPEN to "no cap".
  it('a non-numeric GEMINI_AGY_HOURLY_LIMIT falls back to the default cap of 5, not unlimited (M2)', async () => {
    process.env.GEMINI_AGY_HOURLY_LIMIT = 'not-a-number'
    const reserveGhostCallSlot = await freshReserveGhostCallSlot()
    const results: boolean[] = []
    for (let i = 0; i < 6; i++) results.push(reserveGhostCallSlot('card1'))
    expect(results).toEqual([true, true, true, true, true, false])
  }, 30_000)
})
