// Every timestamp in this schema is a unix epoch INTEGER, and every reader assumes it (card
// a06314ea). A row written as "2026-07-31 14:53:49" TEXT fails nowhere and silently poisons the
// epoch arithmetic in the stuck-card monitor and the re-dispatch guard -- which is how it surfaced.
//
// The API never writes text. The bad rows came from agents writing DIRECTLY into SQLite with
// datetime('now') or a Python ISO string, so the guard has to live in the database.
import { describe, it, expect, beforeEach } from 'vitest'
import { initDatabase, createKanbanCard, addKanbanComment, getDb } from '../db.js'

beforeEach(() => {
  initDatabase(':memory:')
})

describe('the database refuses a non-epoch timestamp', () => {
  it('rejects a TEXT created_at on a direct INSERT (the sqlite3-CLI path)', () => {
    const db = getDb()
    expect(() =>
      db
        .prepare(
          "INSERT INTO kanban_cards (id, title, status, priority, sort_order, created_at, updated_at) VALUES ('x','T','planned','normal',0,'2026-07-31 14:53:49',1)",
        )
        .run(),
    ).toThrow(/unix epoch INTEGER/)
  })

  it('rejects a TEXT updated_at on a direct UPDATE', () => {
    createKanbanCard({ id: 'c1', title: 'T', assignee: 'backend' })
    const db = getDb()
    expect(() =>
      db.prepare("UPDATE kanban_cards SET updated_at = '2026-07-31 14:53:49' WHERE id = 'c1'").run(),
    ).toThrow(/unix epoch INTEGER/)
  })

  it('rejects a TEXT comment timestamp too (5 real rows arrived that way)', () => {
    createKanbanCard({ id: 'c1', title: 'T', assignee: 'backend' })
    const db = getDb()
    expect(() =>
      db
        .prepare(
          "INSERT INTO kanban_comments (card_id, author, content, created_at) VALUES ('c1','fron-ted','REVIEW: kész','2026-07-24T13:44:31.820486+00:00')",
        )
        .run(),
    ).toThrow(/unix epoch INTEGER/)
  })

  it('the error says what to use instead', () => {
    const db = getDb()
    expect(() =>
      db
        .prepare(
          "INSERT INTO kanban_cards (id, title, status, priority, sort_order, created_at, updated_at) VALUES ('x','T','planned','normal',0,'nope',1)",
        )
        .run(),
    ).toThrow(/unixepoch\(\)/)
  })
})

describe('ordinary writes are unaffected', () => {
  it('the normal API paths still work', () => {
    createKanbanCard({ id: 'c1', title: 'T', assignee: 'backend' })
    addKanbanComment('c1', 'backend', 'REVIEW: kész.')
    const db = getDb()
    const card = db.prepare("SELECT typeof(created_at) t1, typeof(updated_at) t2 FROM kanban_cards WHERE id='c1'").get() as { t1: string; t2: string }
    expect([card.t1, card.t2]).toEqual(['integer', 'integer'])
    const comment = db.prepare("SELECT typeof(created_at) t FROM kanban_comments WHERE card_id='c1'").get() as { t: string }
    expect(comment.t).toBe('integer')
  })

  it('an epoch INTEGER written directly is accepted', () => {
    const db = getDb()
    expect(() =>
      db
        .prepare(
          "INSERT INTO kanban_cards (id, title, status, priority, sort_order, created_at, updated_at) VALUES ('x','T','planned','normal',0,1784963060,1784963060)",
        )
        .run(),
    ).not.toThrow()
  })
})
