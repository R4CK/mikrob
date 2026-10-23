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
import { resolveHourlyLimit, resolveDailyGhostLimit } from '../gemini-ghost-budget.js'

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

// F2 (WhiteHat GO, card 612058c2 Teendo @6b9f61eb, comment 19967): resolveDailyGhostLimit mirrors
// resolveHourlyLimit's fail-closed parsing, same reasoning, different default (20, matching
// seged-hivo.py's own documented agy_nap default -- this is a SEPARATE daily cap, not shared).
describe('resolveDailyGhostLimit() -- F2: fail-closed on bad env', () => {
  it('a valid positive integer string is used as-is', () => {
    expect(resolveDailyGhostLimit('7')).toBe(7)
  })
  it('undefined (env not set) falls back to the documented default (20)', () => {
    expect(resolveDailyGhostLimit(undefined)).toBe(20)
  })
  it('non-numeric text falls back to 20, not fail-open to unlimited', () => {
    expect(resolveDailyGhostLimit('abc')).toBe(20)
  })
  it('zero falls back to 20 (a zero cap would silently block every call forever)', () => {
    expect(resolveDailyGhostLimit('0')).toBe(20)
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
      GEMINI_AGY_HOURLY_LIMIT: process.env.GEMINI_AGY_HOURLY_LIMIT,
      GEMINI_AGY_GHOST_DAILY_LIMIT: process.env.GEMINI_AGY_GHOST_DAILY_LIMIT,
    }
    process.env.GEMINI_AGY_HOURLY_LOCK = join(td, 'gemini-agy-call.hourly.lock')
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

  // F-MikroB2 (card 6b7c2c25, WhiteHat GO 612058c2 komment 20243, delta on 19967): the real
  // writer (RESERVE_SCRIPT's `datetime.datetime.now().isoformat()`) stores a NAIVE LOCAL
  // timestamp, and the daily cap compares its date PREFIX against `datetime.now().astimezone()
  // .date()` -- also local. A row built from `Date.prototype.toISOString()` is UTC, so its date
  // prefix can disagree with the local calendar day whenever the local UTC offset is positive and
  // the test runs in the first hours of the local day (e.g. CEST/UTC+2, local 00:00-02:00 is
  // still yesterday in UTC) -- the test would then seed a row dated "yesterday" in UTC that the
  // production code reads as "today" (or vice versa), independent of the code under test.
  // localIsoNoOffset mirrors the real writer's format instead of UTC.
  function localIsoNoOffset(epochMs: number): string {
    const d = new Date(epochMs)
    const pad = (n: number, len = 2): string => String(n).padStart(len, '0')
    return (
      `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}` +
      `T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${pad(d.getMilliseconds(), 3)}`
    )
  }

  function appendRow(agoSeconds: number, status: string, hivo = 'quota-bridge-ghost', seged = 'agy'): void {
    const ts = localIsoNoOffset(Date.now() - agoSeconds * 1000)
    const row = { ido: ts, hivas_id: Math.random().toString(16).slice(2), seged, hivo, kartya: 'x', feladattipus: 'kod', status }
    const existing = readFileSync(ledgerPath(), 'utf-8')
    writeFileSync(ledgerPath(), existing + JSON.stringify(row) + '\n')
  }

  // F5 (card 6b7c2c25): the sandboxed seged-hivo.py copy is now passed as an explicit parameter,
  // not via an env-selected (and importlib-executed) path -- see gemini-ghost-budget.ts's own
  // comment on reserveGhostCallSlot's segedHivoPath parameter.
  async function freshReserveGhostCallSlot() {
    process.env.GEMINI_AGY_HOURLY_LIMIT = process.env.GEMINI_AGY_HOURLY_LIMIT ?? '5'
    const mod = await import('../gemini-ghost-budget.js')
    const sandboxedSegedHivo = join(td, 'scripts', 'seged-hivo.py')
    return (cardId: string, status: 'ok' | 'error' = 'ok') =>
      mod.reserveGhostCallSlot(cardId, status, sandboxedSegedHivo)
  }

  // F5 regression (card 6b7c2c25): with the explicit third parameter supplied (as every call in
  // this file's other tests does), a poisoned SEGED_HIVO_HELPERS must have no effect -- the
  // explicit param always wins. The DEFAULT (2-arg, production-shaped) call path is covered
  // separately below, where spawnSync is mocked so the real ROOT path can be asserted without
  // actually executing it.
  it('SEGED_HIVO_HELPERS env var is ignored when an explicit path is passed', async () => {
    process.env.SEGED_HIVO_HELPERS = '/nonexistent/should-be-ignored.py'
    const reserveGhostCallSlot = await freshReserveGhostCallSlot()
    const ok = reserveGhostCallSlot('card1')
    expect(ok).toBe(true)
    delete process.env.SEGED_HIVO_HELPERS
  }, 20_000)

  it('a fresh (empty) ledger allows a reservation and appends exactly one new row', async () => {
    const reserveGhostCallSlot = await freshReserveGhostCallSlot()
    const ok = reserveGhostCallSlot('card1')
    expect(ok).toBe(true)
    const rows = readFileSync(ledgerPath(), 'utf-8').trim().split('\n').filter(Boolean)
    expect(rows.length).toBe(1)
    const parsed = JSON.parse(rows[0]!)
    expect(parsed.hivo).toBe('quota-bridge-ghost')
    expect(parsed.seged).toBe('agy-ghost')
    expect(parsed.kartya).toBe('card1')
  }, 20_000)

  // F-RH-V1 regression (RedHat NO-GO/GO @c5e5ec28, comment 19880): scripts/seged-hivo.py's OWN
  // daily fleet-wide quota (quota_problem(), lim['agy_nap']) counts rows where seged==='agy'
  // literally -- a ghost row tagged 'agy' would silently consume MikroB's unrelated daily
  // jailed-CLI budget (20/day) even though it never goes through that engine at all. Reservation
  // rows must therefore NEVER be seged==='agy'.
  it('reserved rows are never tagged seged==="agy" -- must not pollute the unrelated daily agy_nap quota (F-RH-V1)', async () => {
    const reserveGhostCallSlot = await freshReserveGhostCallSlot()
    for (let i = 0; i < 3; i++) reserveGhostCallSlot(`card${i}`)
    const rows = readFileSync(ledgerPath(), 'utf-8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l))
    expect(rows.length).toBe(3)
    expect(rows.every((r) => r.seged === 'agy-ghost')).toBe(true)
    expect(rows.some((r) => r.seged === 'agy')).toBe(false)
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

  // H1 (RedHat NO-GO, card f0b3b674 komment 20369, Gate-SHA 44931ad6): same hole, same shape, for
  // the heavy-second-opinion path's 'agy-heavy' rows (store/offload-dispatch.sh's reserve_heavy_
  // gemini_slot) -- before the fix this reservation script did not count them, so 3 heavy rows
  // left 'used' undercounted and a 4th+5th direct Ghost reservation would be wrongly granted past
  // the real shared ceiling.
  it('3 pre-existing agy-heavy rows + 3 Ghost reservations -> the 6th overall call is refused', async () => {
    for (let i = 0; i < 3; i++) appendRow(i * 60, 'ok', 'offload-dispatch-heavy', 'agy-heavy')
    const reserveGhostCallSlot = await freshReserveGhostCallSlot()
    const results: boolean[] = []
    for (let i = 0; i < 3; i++) results.push(reserveGhostCallSlot('card1'))
    expect(results).toEqual([true, true, false])
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

  // F2 (WhiteHat GO, card 612058c2 Teendo @6b9f61eb, comment 19967): a day-wide ghost cap,
  // separate from and in ADDITION to the hourly one -- rows seeded 2h ago (outside the 1h hourly
  // window, so the hourly check alone would allow this) but still today's date must still be
  // blocked once the daily ghost limit is reached.
  it('the daily ghost cap blocks a reservation even when the HOURLY window is clear', async () => {
    process.env.GEMINI_AGY_GHOST_DAILY_LIMIT = '3'
    for (let i = 0; i < 3; i++) appendRow(7200 + i * 10, 'ok', 'quota-bridge-ghost', 'agy-ghost')
    const reserveGhostCallSlot = await freshReserveGhostCallSlot()
    const ok = reserveGhostCallSlot('card1')
    expect(ok).toBe(false)
    const rows = readFileSync(ledgerPath(), 'utf-8').trim().split('\n').filter(Boolean)
    expect(rows.length).toBe(3) // no new row appended on a CAPPED_DAILY refusal
  }, 20_000)

  it('below the daily ghost cap, a reservation outside the hourly window still succeeds (control)', async () => {
    process.env.GEMINI_AGY_GHOST_DAILY_LIMIT = '3'
    for (let i = 0; i < 2; i++) appendRow(7200 + i * 10, 'ok', 'quota-bridge-ghost', 'agy-ghost')
    const reserveGhostCallSlot = await freshReserveGhostCallSlot()
    const ok = reserveGhostCallSlot('card1')
    expect(ok).toBe(true)
  }, 20_000)

  // F-MikroB1 (card 6b7c2c25, WhiteHat GO 612058c2 komment 20243): pins the "today" condition
  // itself -- without it, these OLD ghost rows (outside the hourly window AND from a different
  // calendar day) would still count toward today's daily cap, wrongly blocking the reservation.
  // A mutant that drops the `str(row.get('ido', ''))[:10] == today` check reads this exact row
  // set as 3 daily-capped rows and fails this test.
  it('ghost rows from a PRIOR day (outside hourly window) do not count toward TODAY\'s daily cap', async () => {
    process.env.GEMINI_AGY_GHOST_DAILY_LIMIT = '3'
    for (let i = 0; i < 3; i++) appendRow(2 * 24 * 60 * 60 + i * 10, 'ok', 'quota-bridge-ghost', 'agy-ghost')
    const reserveGhostCallSlot = await freshReserveGhostCallSlot()
    const ok = reserveGhostCallSlot('card1')
    expect(ok).toBe(true)
  }, 20_000)

  it('a non-numeric GEMINI_AGY_GHOST_DAILY_LIMIT falls back to the default cap of 20, not unlimited (F2)', async () => {
    process.env.GEMINI_AGY_GHOST_DAILY_LIMIT = 'not-a-number'
    for (let i = 0; i < 20; i++) appendRow(7200 + i * 5, 'ok', 'quota-bridge-ghost', 'agy-ghost')
    const reserveGhostCallSlot = await freshReserveGhostCallSlot()
    const ok = reserveGhostCallSlot('card1')
    expect(ok).toBe(false)
  }, 20_000)
})

// F5 (card 6b7c2c25, WhiteHat GO 612058c2 komment 19967): the DEFAULT call path (no third
// argument -- what every real caller in gemini-orchestrator.ts and gemini-orchestrator-draft-
// review.ts actually uses) must resolve to the fixed ROOT-derived path, never to
// process.env.SEGED_HIVO_HELPERS. spawnSync is mocked here (not executed) so this can assert the
// exact path argument without ever touching a real file or the shared fleet log.
describe('reserveGhostCallSlot() default path (no explicit 3rd arg) ignores SEGED_HIVO_HELPERS (F5)', () => {
  const __dirname = dirname(fileURLToPath(import.meta.url))
  const REAL_ROOT = join(__dirname, '..', '..')
  const spawnSyncMock = vi.fn((_cmd: string, _args: string[]) => ({ status: 0, stdout: 'OK', stderr: '', error: undefined, signal: null, pid: 1, output: [] }))

  beforeEach(() => {
    vi.resetModules()
    spawnSyncMock.mockClear()
  })

  afterEach(() => {
    delete process.env.SEGED_HIVO_HELPERS
    vi.doUnmock('node:child_process')
    vi.resetModules()
  })

  it('passes the fixed ROOT-derived seged-hivo.py path, not a poisoned env value', async () => {
    process.env.SEGED_HIVO_HELPERS = '/nonexistent/should-be-ignored.py'
    vi.doMock('node:child_process', () => ({ spawnSync: spawnSyncMock }))
    const mod = await import('../gemini-ghost-budget.js')
    mod.reserveGhostCallSlot('card1')
    expect(spawnSyncMock).toHaveBeenCalledTimes(1)
    const args = spawnSyncMock.mock.calls[0]![1]
    expect(args).toContain(join(REAL_ROOT, 'scripts', 'seged-hivo.py'))
    expect(args).not.toContain('/nonexistent/should-be-ignored.py')
  })
})
