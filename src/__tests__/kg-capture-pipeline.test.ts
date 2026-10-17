// MT-05 (card c991508f): EK-MT-2, EK-MT-3, EK-MT-4 -- the three behaviours the capture pipeline
// must prove. Every I/O boundary (closureCheck, draftFn) is injected, so none of this needs a real
// gate-closure-check.py subprocess or a real Ollama call (injected-port-adapters skill).
import { describe, it, expect, beforeEach, vi } from 'vitest'
import Database from 'better-sqlite3'

const card = { id: 'card-1', title: 'Fix the thing', description: null as string | null, project: null as string | null }
let comments: Array<{ id: number; author: string; content: string; created_at: number; automated: boolean }> = []

vi.mock('../db.js', () => ({
  getKanbanCard: (id: string) => (id === card.id ? card : undefined),
  getKanbanComments: (id: string) => (id === card.id ? comments : []),
}))

import { migrate } from '../kg/store.js'
import { enqueueCapture } from '../kg/capture.js'
import { runCapture, type CaptureDeps, type ClosureResult } from '../kg/capture-pipeline.js'

// A real worker always claims a pending kg_capture_queue row (enqueued by the kanban move hook)
// BEFORE calling runCapture -- the mark*/markCaptureFailed functions UPDATE an existing row and
// are a silent no-op if none exists. Every test enqueues first to match that real invariant.
function freshKgDb(): Database.Database {
  const db = new Database(':memory:')
  migrate(db)
  enqueueCapture(db, card.id, 'closed', 0)
  return db
}

const REVIEW_CONTENT = 'REVIEW: fixed the off-by-one in the queue drain loop.\nGate-SHA: abc1234'

function deps(overrides: Partial<CaptureDeps> = {}): CaptureDeps {
  return {
    closureCheck: (): ClosureResult => ({ verdict: 'AGREE', sha: 'abc1234' }),
    draftFn: () => JSON.stringify([{ title: 'off-by-one fix', body: 'fixed the loop bound' }]),
    now: () => 1000,
    extractor: 'local-llm:kg-capture@v1',
    ...overrides,
  }
}

beforeEach(() => {
  card.title = 'Fix the thing'
  card.description = null
  card.project = null
  comments = [{ id: 1, author: 'backend', content: REVIEW_CONTENT, created_at: 500, automated: false }]
})

describe('runCapture', () => {
  it('EK-MT-2: done + gate AGREE -> an ACTIVE solution anchored on the Gate-SHA, with produced + implemented_in edges', () => {
    const kgDb = freshKgDb()
    const result = runCapture({} as Database.Database, kgDb, card.id, 3, deps())
    expect(result.outcome).toBe('captured')
    expect(result.solutionIds).toHaveLength(1)
    const node = kgDb.prepare('SELECT * FROM kg_nodes WHERE id = ?').get(result.solutionIds[0]!) as Record<string, unknown>
    expect(node.status).toBe('active')
    expect(node.gate_sha).toBe('abc1234')
    const anchors = kgDb.prepare('SELECT * FROM kg_anchors WHERE node_id = ?').all(result.solutionIds[0]!) as Array<{ sha: string }>
    expect(anchors.length).toBeGreaterThanOrEqual(1)
    expect(anchors[0]!.sha).toBe('abc1234')
    const produced = kgDb.prepare("SELECT * FROM kg_edges WHERE rel = 'produced' AND dst = ?").get(result.solutionIds[0]!)
    expect(produced).toBeTruthy()
    const implementedIn = kgDb.prepare("SELECT * FROM kg_edges WHERE rel = 'implemented_in' AND src = ?").get(result.solutionIds[0]!)
    expect(implementedIn).toBeTruthy()
    kgDb.close()
  })

  it('EK-MT-2: at most KG_MAX_SOLUTIONS_PER_CARD nodes, even if the draft offers more', () => {
    const kgDb = freshKgDb()
    const manyDeps = deps({
      draftFn: () => JSON.stringify([{ title: 'a' }, { title: 'b' }, { title: 'c' }, { title: 'd' }, { title: 'e' }]),
    })
    const result = runCapture({} as Database.Database, kgDb, card.id, 3, manyDeps)
    expect(result.solutionIds).toHaveLength(3)
    kgDb.close()
  })

  it('EK-MT-3: NOSHA verdict -> solution created as draft, never active', () => {
    const kgDb = freshKgDb()
    const result = runCapture({} as Database.Database, kgDb, card.id, 3, deps({
      closureCheck: () => ({ verdict: 'NOSHA', sha: null }),
    }))
    expect(result.outcome).toBe('captured')
    const node = kgDb.prepare('SELECT * FROM kg_nodes WHERE id = ?').get(result.solutionIds[0]!) as Record<string, unknown>
    expect(node.status).toBe('draft')
    kgDb.close()
  })

  it('EK-MT-3: DISAGREE verdict -> solution created as draft, never active', () => {
    const kgDb = freshKgDb()
    const result = runCapture({} as Database.Database, kgDb, card.id, 3, deps({
      closureCheck: () => ({ verdict: 'DISAGREE', sha: null }),
    }))
    expect(result.outcome).toBe('captured')
    const node = kgDb.prepare('SELECT * FROM kg_nodes WHERE id = ?').get(result.solutionIds[0]!) as Record<string, unknown>
    expect(node.status).toBe('draft')
    kgDb.close()
  })

  it('EK-MT-4: a REVIEW carrying a known secret shape -> no node created, mutation-checked', () => {
    const kgDb = freshKgDb()
    comments = [{
      id: 2, author: 'backend', created_at: 500, automated: false,
      content: 'REVIEW: added the AWS key AKIAIOSFODNN7EXAMPLE to the config loader.',
    }]
    const result = runCapture({} as Database.Database, kgDb, card.id, 3, deps())
    expect(result.outcome).toBe('failed')
    expect(result.reason).toBe('secret')
    expect(result.solutionIds).toHaveLength(0)
    const q = kgDb.prepare('SELECT state, last_error FROM kg_capture_queue WHERE card_id = ?').get(card.id) as
      | { state: string; last_error: string }
      | undefined
    expect(q?.state).toBe('failed')
    expect(q?.last_error).toMatch(/secret/i)
    const allNodes = kgDb.prepare('SELECT COUNT(*) AS n FROM kg_nodes').get() as { n: number }
    expect(allNodes.n).toBe(0)
    kgDb.close()
  })

  it('a malformed draft (not a JSON array) fails the capture rather than guessing a node', () => {
    const kgDb = freshKgDb()
    const result = runCapture({} as Database.Database, kgDb, card.id, 3, deps({ draftFn: () => 'not json at all' }))
    expect(result.outcome).toBe('failed')
    expect(result.reason).toBe('draft_parse_error')
    const allNodes = kgDb.prepare('SELECT COUNT(*) AS n FROM kg_nodes').get() as { n: number }
    expect(allNodes.n).toBe(0)
    kgDb.close()
  })

  it('no REVIEW comment on the card -> skipped, not a failure', () => {
    const kgDb = freshKgDb()
    comments = [{ id: 3, author: 'backend', content: 'just a status update, no REVIEW', created_at: 500, automated: false }]
    const result = runCapture({} as Database.Database, kgDb, card.id, 3, deps())
    expect(result.outcome).toBe('skipped')
    const q = kgDb.prepare('SELECT state FROM kg_capture_queue WHERE card_id = ?').get(card.id) as { state: string } | undefined
    expect(q?.state).toBe('skipped')
    kgDb.close()
  })

  it('is idempotent: running capture twice for the same card upserts the same solution ids, no duplicates', () => {
    const kgDb = freshKgDb()
    runCapture({} as Database.Database, kgDb, card.id, 3, deps())
    const second = runCapture({} as Database.Database, kgDb, card.id, 3, deps())
    const count = kgDb.prepare("SELECT COUNT(*) AS n FROM kg_nodes WHERE type = 'solution'").get() as { n: number }
    expect(count.n).toBe(1)
    expect(second.solutionIds).toEqual(['sol:card-1:0'])
    kgDb.close()
  })
})
