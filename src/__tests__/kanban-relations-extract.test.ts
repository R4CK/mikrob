// Card 6cd61430 (Fazis fe3eff9f): marker extraction, the live hook, and the reconcile sweep.
//
// The fixtures are VERBATIM strings from the real corpus wherever a rule was derived from it --
// the whole design rests on measurements of what the fleet actually writes, so a test built from
// invented text would prove the parser matches my imagination, not the board.
import { describe, it, expect, beforeEach } from 'vitest'
import {
  cardEdges,
  commentEdges,
  dedupeEdges,
  edgeKey,
  gateShasIn,
  MARKER_SOURCE,
  type RelationEdge,
} from '../kanban-relations.js'
import {
  initDatabase,
  getDb,
  createKanbanCard,
  updateKanbanCard,
  addKanbanComment,
  deleteKanbanCard,
  reconcileKanbanRelations,
} from '../db.js'

const keys = (edges: readonly RelationEdge[]): string[] => edges.map(edgeKey).sort()

const rows = (): RelationEdge[] =>
  getDb()
    .prepare(
      `SELECT from_type, from_id, to_type, to_id, relation_type
         FROM kanban_relations WHERE source = ? ORDER BY from_id, to_id, relation_type`,
    )
    .all(MARKER_SOURCE) as RelationEdge[]

beforeEach(() => {
  initDatabase(':memory:')
})

describe('Gate-SHA lines (rule 4b)', () => {
  it('reads a plain line-start declaration', () => {
    expect(gateShasIn('REVIEW: kesz\nGate-SHA: 0f417136\n\nbody')).toEqual(['0f417136'])
  })

  it('keeps EVERY sha of a multi-commit line, not just the last one', () => {
    // The difference from gate-pretriage-candidates.py, which must pick ONE commit to gate. The
    // real comment this comes from (card 9d7a247a's own REVIEW) states three.
    expect(gateShasIn('Gate-SHA: e7c2726d, 0f417136, 24efcfea')).toEqual([
      'e7c2726d',
      '0f417136',
      '24efcfea',
    ])
  })

  it('IGNORES a mid-sentence mention -- the property rule 4b exists for', () => {
    // Verbatim from card e76c1b7e. Rule 4b anchors on the line start precisely so an agent can
    // discuss the convention without triggering anything; a relation written from this line would
    // claim a card was gated on a commit nobody named.
    expect(gateShasIn('Ide kellene egy Gate-SHA: sor lenne a REVIEW-ban.')).toEqual([])
    expect(gateShasIn('elirtuk, a Gate-SHA: ab30810, 55ed33e) mar nem aktualis')).toEqual([])
  })

  it('drops a self-edge: an 8-hex card id on the line is not a commit', () => {
    // Card ids in this fleet are 8 hex characters and read as short shas -- the documented
    // confusion the whole `Gate-SHA:` line was introduced to end.
    expect(commentEdges('6cd61430', 'Gate-SHA: 6cd61430')).toEqual([])
  })

  it('does not repeat a sha stated twice in one comment', () => {
    expect(gateShasIn('Gate-SHA: 0f417136\n...\nGate-SHA: 0f417136')).toEqual(['0f417136'])
  })
})

describe('Pair-FE / Pair-BE (rule 8a)', () => {
  it('reads a pair stated MID-LINE, after other prose', () => {
    // Verbatim from cards 37e30adb and 17d8865f. A line-start anchor -- the obvious reading of
    // rule 8a's "a leiras ELSO nehany soraban" -- loses both of these real pairs. This test is the
    // reason the anchor is on the label instead, so a future tightening cannot silently undo it.
    expect(keys(cardEdges({ id: '37e30adb', description: 'Peti GO (8779c351 epic, 2026-08-20). Pair-FE: 7a1a8aec' })))
      .toEqual(['card 37e30adb card 7a1a8aec pair-fe'])
    expect(keys(cardEdges({ id: '17d8865f', description: 'Fazis: bc465e33. Pair-BE: d8d55452\n\nSuperadmin settings oldal' })))
      .toEqual(['card 17d8865f card d8d55452 pair-be'])
  })

  it('IGNORES the cards that talk ABOUT the convention', () => {
    // Verbatim from fe3eff9f / 6cd61430 (the label pair written as prose) and 3bd18e70 (a label
    // followed by a Hungarian sentence). The hex requirement after the colon is what rejects all
    // three; a "rest of the line" parser would have written an edge for each.
    expect(cardEdges({ id: 'x1', description: 'jelolesekbol: Gate-SHA:, Pair-FE:/Pair-BE:, blockedBy JSON, parent_id' })).toEqual([])
    expect(cardEdges({ id: '3bd18e70', description: 'Szulo: fe3eff9f. Pair-BE: a FELADAT-3 API-ra epul.' }).filter(e => e.relation_type !== 'child-of')).toEqual([])
  })

  it('IGNORES the prose values that mean "there is no pair"', () => {
    // All four verbatim: 1ba4997b, 183588b0, cb5cef0f, 48d891b4. 40-plus cards in the corpus use
    // one of these shapes.
    for (const value of ['nincs (frontend-only)', 'n/a', '-', 'N/A (infra refactor)']) {
      expect(cardEdges({ id: 'c1', description: `Pair-BE: ${value}` })).toEqual([])
    }
  })

  it('records the direction as STATED, so both halves of a real pair survive', () => {
    // 77fd0f07 <-> 03d2ae9c, a real pair from the board. Two rows, not one symmetric row: which
    // side carries the marker is what rule 8a's QA checklist asks about.
    expect(keys([
      ...cardEdges({ id: '77fd0f07', description: 'Pair-FE: 03d2ae9c' }),
      ...cardEdges({ id: '03d2ae9c', description: 'Pair-BE: 77fd0f07' }),
    ])).toEqual([
      'card 03d2ae9c card 77fd0f07 pair-be',
      'card 77fd0f07 card 03d2ae9c pair-fe',
    ])
  })
})

describe('parent_id', () => {
  it('becomes a child-of edge', () => {
    expect(keys(cardEdges({ id: '6cd61430', parent_id: 'fe3eff9f' })))
      .toEqual(['card 6cd61430 card fe3eff9f child-of'])
  })

  it('ignores an empty or self-referential parent', () => {
    expect(cardEdges({ id: 'c1', parent_id: '' })).toEqual([])
    expect(cardEdges({ id: 'c1', parent_id: '   ' })).toEqual([])
    expect(cardEdges({ id: 'c1', parent_id: 'c1' })).toEqual([])
  })
})

describe('blockedBy is NOT extracted', () => {
  it('produces nothing from the prose that mentions it -- and could not, by schema', () => {
    // Verbatim from card 38788337, which DEFINES blockedBy as a derived API response field. The
    // dispatching card named it as a source; the corpus has no such marker, and the only edge it
    // could produce would be relation_type 'blocks', which the table's trigger refuses.
    const text = 'egy szarmaztatott `blocked: boolean` mezo (+ opcionalisan `blockedBy: [{id,title,status}]`)'
    expect(cardEdges({ id: 'c1', description: text })).toEqual([])
    expect(commentEdges('c1', text)).toEqual([])
  })

  it("the schema still refuses a 'blocks' edge, so nothing can smuggle one in later", () => {
    // A negative control on the constraint this decision leans on: if a later change made the
    // trigger stop firing, the reasoning above would quietly stop holding.
    expect(() =>
      getDb()
        .prepare(
          `INSERT OR IGNORE INTO kanban_relations
             (from_type, from_id, to_type, to_id, relation_type, source, created_at)
           VALUES ('card','a','card','b','blocks',?,1788000000)`,
        )
        .run(MARKER_SOURCE),
    ).toThrow(/does not carry "blocks"/)
  })
})

describe('the live hook', () => {
  it('records a Gate-SHA the moment the REVIEW comment lands', () => {
    createKanbanCard({ id: 'live01', title: 'c' })
    addKanbanComment('live01', 'backend', 'REVIEW: kesz\nGate-SHA: 0f417136')
    expect(keys(rows())).toEqual(['card live01 sha 0f417136 gate-sha'])
  })

  it('records the pair and the parent when the card is created', () => {
    createKanbanCard({ id: 'fe3eff9f', title: 'fazis' }) // parent_id carries a real FK
    createKanbanCard({ id: 'live02', title: 'c', description: 'Pair-FE: 03d2ae9c', parent_id: 'fe3eff9f' })
    expect(keys(rows())).toEqual([
      'card live02 card 03d2ae9c pair-fe',
      'card live02 card fe3eff9f child-of',
    ])
  })

  it('picks up a pair added by a later edit', () => {
    createKanbanCard({ id: 'live03', title: 'c' })
    expect(rows()).toEqual([])
    updateKanbanCard('live03', { description: 'Pair-FE: 03d2ae9c' })
    expect(keys(rows())).toEqual(['card live03 card 03d2ae9c pair-fe'])
  })

  it('CANNOT fail the comment write it hangs off', () => {
    // The isolation is the point: kanban_relations is a derived index the sweep rebuilds, the
    // comment is the artefact the whole gate flow runs on. Proven by removing the table under the
    // hook -- the harshest failure it can meet -- and checking the comment still lands.
    createKanbanCard({ id: 'live04', title: 'c' })
    getDb().exec('DROP TABLE kanban_relations')
    const comment = addKanbanComment('live04', 'backend', 'REVIEW\nGate-SHA: 0f417136')
    expect(comment.content).toContain('Gate-SHA: 0f417136')
    expect(
      (getDb().prepare('SELECT COUNT(*) AS n FROM kanban_comments WHERE card_id = ?').get('live04') as { n: number }).n,
    ).toBe(1)
  })
})

describe('the reconcile sweep', () => {
  it('is idempotent: a second run inserts and deletes nothing', () => {
    createKanbanCard({ id: 'r1', title: 'c', description: 'Pair-FE: 03d2ae9c' })
    addKanbanComment('r1', 'backend', 'REVIEW\nGate-SHA: 0f417136')
    const first = reconcileKanbanRelations({ apply: true })
    expect(first.missing).toBe(0) // the live hook already wrote them
    const second = reconcileKanbanRelations({ apply: true })
    expect(second.missing).toBe(0)
    expect(second.stale).toBe(0)
    expect(rows().length).toBe(2)
  })

  it('recovers an edge the live hook never had a chance to write', () => {
    // The ORDER failure an insert-only backfill cannot reach: rows inserted straight into SQLite
    // (an agent writing with the sqlite3 CLI, or any row predating this feature) bypass the hook.
    getDb()
      .prepare(
        `INSERT INTO kanban_cards (id, title, description, status, priority, sort_order, created_at, updated_at)
         VALUES ('r2','c','Pair-FE: 03d2ae9c','planned','normal',0,1788000000,1788000000)`,
      )
      .run()
    expect(rows()).toEqual([])
    const dry = reconcileKanbanRelations()
    expect(dry.missing).toBe(1)
    expect(dry.applied).toBe(false)
    expect(rows()).toEqual([]) // a dry run REPORTS the count and writes nothing
    reconcileKanbanRelations({ apply: true })
    expect(keys(rows())).toEqual(['card r2 card 03d2ae9c pair-fe'])
  })

  it('DELETES an edge whose marker was corrected -- the half a backfill cannot do', () => {
    createKanbanCard({ id: 'r3', title: 'c', description: 'Pair-FE: 03d2ae9c' })
    expect(keys(rows())).toEqual(['card r3 card 03d2ae9c pair-fe'])
    updateKanbanCard('r3', { description: 'Pair-FE: 7a1a8aec' }) // typo fixed
    // The live hook is insert-only, so BOTH edges are present until the sweep runs.
    expect(rows().length).toBe(2)
    const report = reconcileKanbanRelations({ apply: true })
    expect(report.stale).toBe(1)
    expect(keys(rows())).toEqual(['card r3 card 7a1a8aec pair-fe'])
  })

  it('re-parenting does not leave the old child-of behind', () => {
    createKanbanCard({ id: 'fe3eff9f', title: 'fazis' })
    createKanbanCard({ id: '9d7a247a', title: 'masik fazis' })
    createKanbanCard({ id: 'r4', title: 'c', parent_id: 'fe3eff9f' })
    updateKanbanCard('r4', { parent_id: '9d7a247a' })
    reconcileKanbanRelations({ apply: true })
    expect(keys(rows())).toEqual(['card r4 card 9d7a247a child-of'])
  })

  it('NEVER touches a row written under another source', () => {
    // The undo path (DELETE WHERE source='marker-v1') and the sweep both key on the tag. A hand-
    // inserted edge must survive a reconcile that states nothing about it.
    getDb()
      .prepare(
        `INSERT INTO kanban_relations (from_type, from_id, to_type, to_id, relation_type, source, created_at)
         VALUES ('card','manual','file','src/db.ts','touches-file','manual',1788000000)`,
      )
      .run()
    reconcileKanbanRelations({ apply: true })
    expect(
      (getDb().prepare("SELECT COUNT(*) AS n FROM kanban_relations WHERE source = 'manual'").get() as { n: number }).n,
    ).toBe(1)
  })

  it('agrees with the live hook on the same input -- the anti-drift check', () => {
    // Two code paths writing edges is how they diverge silently. They call ONE extractor, and this
    // pins it: what the hook wrote on the way in is exactly what a from-scratch recompute wants.
    createKanbanCard({ id: 'fe3eff9f', title: 'fazis' })
    createKanbanCard({ id: 'r5', title: 'c', description: 'Pair-FE: 03d2ae9c', parent_id: 'fe3eff9f' })
    addKanbanComment('r5', 'backend', 'REVIEW\nGate-SHA: e7c2726d, 0f417136')
    const viaHook = keys(rows())
    getDb().prepare('DELETE FROM kanban_relations WHERE source = ?').run(MARKER_SOURCE)
    reconcileKanbanRelations({ apply: true })
    expect(keys(rows())).toEqual(viaHook)
    expect(viaHook.length).toBe(4)
  })

  it('a deleted card does not come back through the sweep', () => {
    // deleteKanbanCard sweeps the card-side edges (card 9d7a247a). If the reconcile still read the
    // card's comments it would resurrect them; the comments go with the card, so it cannot.
    createKanbanCard({ id: 'fe3eff9f', title: 'fazis' })
    createKanbanCard({ id: 'r6', title: 'c', parent_id: 'fe3eff9f' })
    addKanbanComment('r6', 'backend', 'REVIEW\nGate-SHA: 0f417136')
    expect(rows().length).toBe(2)
    deleteKanbanCard('r6')
    reconcileKanbanRelations({ apply: true })
    expect(rows()).toEqual([])
  })
})

describe('dedupeEdges', () => {
  it('collapses by PRIMARY KEY identity and keeps the first occurrence', () => {
    const a = { from_type: 'card', from_id: 'x', to_type: 'sha', to_id: 'abc1234', relation_type: 'gate-sha' }
    expect(dedupeEdges([a, { ...a }])).toEqual([a])
  })
})
