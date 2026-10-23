// MT-06 (card 7c9be2d8): EK-MT-12 -- processed/active/draft/failed/skipped counts, and the GPU
// gate stops the batch before another local-LLM call rather than falling back online.
import { describe, it, expect } from 'vitest'
import Database from 'better-sqlite3'
import { migrate } from '../kg/store.js'
import { defaultListCandidates, runBackfillBatch, type BackfillDeps, type GpuGateResult } from '../kg/backfill.js'
import type { CaptureRunResult } from '../kg/capture-pipeline.js'

function freshKgDb(): Database.Database {
  const db = new Database(':memory:')
  migrate(db)
  return db
}

function freshMainDb(cards: Array<{ id: string; status: string; created_at: number }>): Database.Database {
  const db = new Database(':memory:')
  db.exec(`CREATE TABLE kanban_cards (id TEXT PRIMARY KEY, status TEXT, created_at INTEGER)`)
  const ins = db.prepare('INSERT INTO kanban_cards (id, status, created_at) VALUES (?, ?, ?)')
  for (const c of cards) ins.run(c.id, c.status, c.created_at)
  return db
}

const admit: GpuGateResult = { admit: true, detail: 'ADMIT ok' }
const hold: GpuGateResult = { admit: false, detail: 'HOLD gpu-util-hold' }

function captured(id: string, nodeIds: readonly string[]): CaptureRunResult {
  return { outcome: 'captured', reason: 'AGREE', solutionIds: nodeIds }
}
function failed(): CaptureRunResult {
  return { outcome: 'failed', reason: 'draft_parse_error', solutionIds: [] }
}
function skipped(): CaptureRunResult {
  return { outcome: 'skipped', reason: 'no REVIEW comment', solutionIds: [] }
}

describe('defaultListCandidates', () => {
  it('returns done cards oldest-first, excluding anything already in kg_capture_queue', () => {
    const mainDb = freshMainDb([
      { id: 'c1', status: 'done', created_at: 300 },
      { id: 'c2', status: 'done', created_at: 100 },
      { id: 'c3', status: 'in_progress', created_at: 50 },
      { id: 'c4', status: 'done', created_at: 200 },
    ])
    const kgDb = freshKgDb()
    kgDb
      .prepare(
        `INSERT INTO kg_capture_queue (card_id, reason, attempts, state, created_at, updated_at)
         VALUES ('c2', 'closed', 0, 'done', 1, 1)`,
      )
      .run()

    const out = defaultListCandidates(mainDb, kgDb, 10)
    expect(out).toEqual(['c4', 'c1'])
  })

  it('respects the limit', () => {
    const mainDb = freshMainDb([
      { id: 'c1', status: 'done', created_at: 1 },
      { id: 'c2', status: 'done', created_at: 2 },
      { id: 'c3', status: 'done', created_at: 3 },
    ])
    const kgDb = freshKgDb()
    expect(defaultListCandidates(mainDb, kgDb, 2)).toEqual(['c1', 'c2'])
  })
})

describe('runBackfillBatch (EK-MT-12)', () => {
  it('tallies active/draft/failed/skipped and enqueues each processed card as backfill', () => {
    const kgDb = freshKgDb()
    kgDb.prepare(
      `INSERT INTO kg_nodes (id, type, project, title, status, source_ref, quality, extractor, created_at, updated_at)
       VALUES ('sol:c1:0', 'solution', 'marveen', 't', 'active', 'x', 0, 'x', 1, 1)`,
    ).run()
    kgDb.prepare(
      `INSERT INTO kg_nodes (id, type, project, title, status, source_ref, quality, extractor, created_at, updated_at)
       VALUES ('sol:c2:0', 'solution', 'marveen', 't', 'draft', 'x', 0, 'x', 1, 1)`,
    ).run()

    const calls: string[] = []
    const deps: BackfillDeps = {
      captureEnabled: () => true,
      listCandidates: () => ['c1', 'c2', 'c3', 'c4'],
      gpuGate: () => admit,
      runOne: (cardId) => {
        calls.push(cardId)
        if (cardId === 'c1') return captured('c1', ['sol:c1:0'])
        if (cardId === 'c2') return captured('c2', ['sol:c2:0'])
        if (cardId === 'c3') return failed()
        return skipped()
      },
      now: () => 1000,
    }

    const result = runBackfillBatch(kgDb, 10, deps)

    expect(result.candidates).toBe(4)
    expect(result.processed).toBe(4)
    expect(result.active).toBe(1)
    expect(result.draft).toBe(1)
    expect(result.failed).toBe(1)
    expect(result.skipped).toBe(1)
    expect(result.haltedOnGpuHold).toBe(false)
    expect(calls).toEqual(['c1', 'c2', 'c3', 'c4'])

    const rows = kgDb.prepare(`SELECT card_id, reason FROM kg_capture_queue ORDER BY card_id`).all() as Array<{
      card_id: string
      reason: string
    }>
    expect(rows.every((r) => r.reason === 'backfill')).toBe(true)
    expect(rows.map((r) => r.card_id)).toEqual(['c1', 'c2', 'c3', 'c4'])
  })

  it('EK-MT-12: a GPU HOLD stops the batch before the next local-LLM call, not an online fallback', () => {
    const kgDb = freshKgDb()
    const calls: string[] = []
    let gateCalls = 0
    const deps: BackfillDeps = {
      captureEnabled: () => true,
      listCandidates: () => ['c1', 'c2', 'c3'],
      gpuGate: () => {
        gateCalls++
        // ADMIT for c1, then HOLD -- c2/c3 must never be run.
        return gateCalls === 1 ? admit : hold
      },
      runOne: (cardId) => {
        calls.push(cardId)
        return captured(cardId, [])
      },
      now: () => 2000,
    }

    const result = runBackfillBatch(kgDb, 10, deps)

    expect(calls).toEqual(['c1'])
    expect(result.processed).toBe(1)
    expect(result.haltedOnGpuHold).toBe(true)

    // The cards never run must never even be enqueued -- a halted run leaves them untouched for
    // the next invocation to pick back up via defaultListCandidates (still not in the queue).
    const rows = kgDb.prepare(`SELECT card_id FROM kg_capture_queue`).all() as Array<{ card_id: string }>
    expect(rows.map((r) => r.card_id)).toEqual(['c1'])
  })

  it('CONTROL: without the GPU check, all three would have run -- the gate is what stops it', () => {
    const kgDb = freshKgDb()
    const calls: string[] = []
    const deps: BackfillDeps = {
      captureEnabled: () => true,
      listCandidates: () => ['c1', 'c2', 'c3'],
      gpuGate: () => admit,
      runOne: (cardId) => {
        calls.push(cardId)
        return captured(cardId, [])
      },
      now: () => 3000,
    }
    const result = runBackfillBatch(kgDb, 10, deps)
    expect(calls).toEqual(['c1', 'c2', 'c3'])
    expect(result.haltedOnGpuHold).toBe(false)
  })

  it('RedHat 23045 X1: KG_CAPTURE_ENABLED off -> zero reads, zero writes, zero LLM calls', () => {
    const kgDb = freshKgDb()
    const calls: string[] = []
    const deps: BackfillDeps = {
      captureEnabled: () => false,
      listCandidates: () => {
        throw new Error('must not be called when capture is disabled')
      },
      gpuGate: () => {
        throw new Error('must not be called when capture is disabled')
      },
      runOne: (cardId) => {
        calls.push(cardId)
        return captured(cardId, [])
      },
      now: () => 4000,
    }

    const result = runBackfillBatch(kgDb, 10, deps)

    expect(result.captureDisabled).toBe(true)
    expect(result.candidates).toBe(0)
    expect(result.processed).toBe(0)
    expect(calls).toEqual([])
    const rows = kgDb.prepare(`SELECT card_id FROM kg_capture_queue`).all()
    expect(rows).toEqual([])
  })
})

describe('defaultListCandidates (RedHat 23045 X2: invalid limit)', () => {
  it('returns no candidates for NaN, zero, or negative limit instead of the whole corpus', () => {
    const mainDb = freshMainDb([
      { id: 'c1', status: 'done', created_at: 1 },
      { id: 'c2', status: 'done', created_at: 2 },
    ])
    const kgDb = freshKgDb()
    expect(defaultListCandidates(mainDb, kgDb, NaN)).toEqual([])
    expect(defaultListCandidates(mainDb, kgDb, 0)).toEqual([])
    expect(defaultListCandidates(mainDb, kgDb, -5)).toEqual([])
    expect(defaultListCandidates(mainDb, kgDb, 1.5)).toEqual([])
  })
})
