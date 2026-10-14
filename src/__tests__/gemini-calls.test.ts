import { describe, it, expect } from 'vitest'
import {
  parseLedgerLines,
  dedupeCalls,
  latestRatings,
  buildCallRows,
  computeQuota,
  buildSummary,
  HOURLY_LIMIT,
  type RawRow,
} from '../web/routes/gemini-calls.js'

describe('gemini-calls: ledger parsing (card 64788453)', () => {
  it('skips malformed lines without throwing', () => {
    const rows = parseLedgerLines(['{"a":1}', 'not json', '[1,2]', '', '   ', '{"b":2}'])
    expect(rows).toEqual([{ a: 1 }, { b: 2 }])
  })

  it('dedupeCalls keeps the LAST row per hivas_id (started -> ok)', () => {
    const rows = dedupeCalls([
      { hivas_id: 'x', ido: '2026-10-14T05:00:00.000+02:00', status: 'started', seged: 'agy' },
      { hivas_id: 'x', ido: '2026-10-14T05:00:00.000+02:00', status: 'ok', seged: 'agy' },
    ])
    expect(rows).toHaveLength(1)
    expect(rows[0]!.status).toBe('ok')
  })

  it('dedupeCalls excludes rating rows (tipus=ertekeles)', () => {
    const rows = dedupeCalls([
      { hivas_id: 'x', ido: 'a', status: 'ok', seged: 'agy' },
      { tipus: 'ertekeles', hivas: 'a', eredmeny: 'elfogadva' },
    ])
    expect(rows).toHaveLength(1)
  })

  it('latestRatings keys by the hivas field, last one wins', () => {
    const ratings = latestRatings([
      { tipus: 'ertekeles', hivas: 'call-1', eredmeny: 'javitva', pont: 4 },
      { tipus: 'ertekeles', hivas: 'call-1', eredmeny: 'elfogadva', pont: 8 },
    ])
    expect(ratings.get('call-1')).toMatchObject({ eredmeny: 'elfogadva', pont: 8 })
  })
})

describe('gemini-calls: buildCallRows (card 64788453)', () => {
  it('only includes agy rows, never codex', () => {
    const rows = buildCallRows([
      { hivas_id: '1', ido: '2026-10-14T05:50:00.000+02:00', seged: 'agy', modell: 'gemini-3.8-flash-medium', hivo: 'backend', kartya: 'c1', feladattipus: 'kod', status: 'ok', duracio_s: 3.6, tokens_total: 11857 },
      { hivas_id: '2', ido: '2026-10-14T05:51:00.000+02:00', seged: 'codex', modell: 'gpt-5', hivo: 'backend', kartya: 'c2', feladattipus: 'kod', status: 'ok' },
    ])
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ model: 'gemini-3.8-flash-medium', caller: 'backend', cardId: 'c1', taskType: 'kod', status: 'ok', durationS: 3.6, tokens: 11857 })
  })

  it('attaches the matching rating by ido<->hivas, and null when unrated', () => {
    const rows = buildCallRows([
      { hivas_id: '1', ido: '2026-10-14T05:50:00.000+02:00', seged: 'agy', status: 'ok' },
      { hivas_id: '2', ido: '2026-10-14T05:51:00.000+02:00', seged: 'agy', status: 'ok' },
      { tipus: 'ertekeles', hivas: '2026-10-14T05:50:00.000+02:00', eredmeny: 'elfogadva', pont: 7, velemeny: 'jo volt' },
    ])
    const rated = rows.find((r) => r.ts === Date.parse('2026-10-14T05:50:00.000+02:00'))
    const unrated = rows.find((r) => r.ts === Date.parse('2026-10-14T05:51:00.000+02:00'))
    expect(rated?.rating).toEqual({ result: 'elfogadva', score: 7, opinion: 'jo volt' })
    expect(unrated?.rating).toBeNull()
  })

  it('sorts newest first', () => {
    const rows = buildCallRows([
      { hivas_id: '1', ido: '2026-10-14T05:00:00.000+02:00', seged: 'agy', status: 'ok' },
      { hivas_id: '2', ido: '2026-10-14T05:30:00.000+02:00', seged: 'agy', status: 'ok' },
    ])
    expect(rows.map((r) => r.ts)).toEqual([...rows.map((r) => r.ts)].sort((a, b) => b - a))
  })

  it('drops a row with an unparsable timestamp rather than throwing', () => {
    const rows = buildCallRows([{ hivas_id: '1', ido: 'nem-datum', seged: 'agy', status: 'ok' }])
    expect(rows).toHaveLength(0)
  })

  it('round-trips through parseLedgerLines (realistic input)', () => {
    const lines = [
      JSON.stringify({ hivas_id: '1', ido: '2026-10-14T05:50:00.000+02:00', seged: 'agy', modell: 'gemini-3.8-flash-medium', status: 'ok' } satisfies RawRow),
    ]
    expect(buildCallRows(parseLedgerLines(lines))).toHaveLength(1)
  })
})

describe('gemini-calls: computeQuota (fleet-wide rolling 60-minute cap)', () => {
  const now = Date.parse('2026-10-14T06:00:00.000+02:00')
  const windowStart = now - 60 * 60 * 1000

  it('counts only non-blocked calls within the last 60 minutes', () => {
    const calls = [
      { ts: now - 10 * 60 * 1000, status: 'ok' },
      { ts: now - 20 * 60 * 1000, status: 'ok' },
      { ts: now - 90 * 60 * 1000, status: 'ok' }, // outside the window
      { ts: now - 5 * 60 * 1000, status: 'blocked' }, // blocked -- does not count
    ]
    const q = computeQuota(calls, now)
    expect(q).toMatchObject({ used: 2, limit: HOURLY_LIMIT, windowStart })
    expect(q.nextFreeAt).toBeNull()
  })

  it('at the limit, nextFreeAt is when the OLDEST in-window call ages out', () => {
    const calls = Array.from({ length: HOURLY_LIMIT }, (_, i) => ({
      ts: now - (50 - i * 5) * 60 * 1000,
      status: 'ok',
    }))
    const q = computeQuota(calls, now)
    expect(q.used).toBe(HOURLY_LIMIT)
    const oldest = Math.min(...calls.map((c) => c.ts))
    expect(q.nextFreeAt).toBe(oldest + 60 * 60 * 1000)
  })
})

describe('gemini-calls: buildSummary', () => {
  it('buckets by model and task type, counting ok/error/blocked', () => {
    const calls = [
      { model: 'gemini-3.8-flash-medium', taskType: 'kod', status: 'ok' },
      { model: 'gemini-3.8-flash-medium', taskType: 'kod', status: 'error' },
      { model: 'gemini-3.8-flash-medium', taskType: 'kutatas', status: 'blocked' },
    ]
    const s = buildSummary(calls)
    expect(s.byModel['gemini-3.8-flash-medium']).toEqual({ calls: 3, ok: 1, error: 1, blocked: 1 })
    expect(s.byTaskType['kod']).toEqual({ calls: 2, ok: 1, error: 1, blocked: 0 })
    expect(s.byTaskType['kutatas']).toEqual({ calls: 1, ok: 0, error: 0, blocked: 1 })
  })
})
