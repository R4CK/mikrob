// stuck_incidents: the schema, its append-only trigger, and its ROLLBACK path (card ac28bc6e,
// parent f92671df).
//
// Non-vacuous on the three things that can actually go wrong here:
//   - the append-only rule is enforced by the DATABASE, not by the one TypeScript caller, because
//     the rows that historically went wrong in this schema came from agents writing directly with
//     the sqlite3 CLI (see the timestamp-integrity block in db.ts);
//   - ONE STALL IS ONE ROW -- the unique partial index is what stops a 10-minute heartbeat from
//     turning an hour-long stall into six "incidents";
//   - rule 11: the DOWN path is exercised, not assumed. Dropping the table must not stop the fleet
//     from HANDLING stuck cards, because a logging fault is not a reason to stop the control.
import { afterEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type Database from 'better-sqlite3'
import { initDatabase, getDb } from '../db.js'

/** A fresh in-memory DB carrying the REAL schema, through the same entry point production uses --
 *  not a hand-written subset, which would let every test below pass against a table shape that
 *  does not exist in production. */
function freshDb(): Database.Database {
  initDatabase(':memory:')
  return getDb()
}

/** A PERSISTENT database for the cases that must survive a re-init. `:memory:` cannot serve them:
 *  initDatabase() opens a NEW in-memory database each time, so "drop the table, run the schema
 *  again" on memory would silently be testing a fresh DB and prove nothing about an existing one.
 *  A temp FILE is also the real deployment shape -- the table is added to a store that already
 *  holds every other table. */
const tmpDirs: string[] = []
function persistentDb(): { path: string; db: Database.Database } {
  const dir = mkdtempSync(join(tmpdir(), 'stuck-incidents-'))
  tmpDirs.push(dir)
  const path = join(dir, 'test.db')
  initDatabase(path)
  return { path, db: getDb() }
}

afterEach(() => {
  while (tmpDirs.length > 0) {
    try {
      rmSync(tmpDirs.pop()!, { recursive: true, force: true })
    } catch {
      /* best effort */
    }
  }
})

const insert = (db: Database.Database, over: Record<string, unknown> = {}): number => {
  const row = {
    card_id: 'card-1',
    assignee_at_detection: 'backend3',
    detected_at: 1_700_000_000,
    stalled_ms_at_detection: 900_000,
    action: 'redispatch',
    action_detail: null,
    ...over,
  }
  const r = db
    .prepare(
      `INSERT INTO stuck_incidents
         (card_id, assignee_at_detection, detected_at, stalled_ms_at_detection, action, action_detail)
       VALUES (@card_id, @assignee_at_detection, @detected_at, @stalled_ms_at_detection, @action, @action_detail)`,
    )
    .run(row)
  return Number(r.lastInsertRowid)
}

describe('stuck_incidents -- shape', () => {
  it('exists on a FRESH database', () => {
    const db = freshDb()
    const t = db
      .prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='stuck_incidents'`)
      .get()
    expect(t).toBeTruthy()
  })

  it('is created on an EXISTING database too -- the initialiser is idempotent', () => {
    // The real deployment path, on a PERSISTENT store: the table is added to a database that
    // already holds every other table, and re-running the initialiser changes nothing.
    const { path, db } = persistentDb()
    db.prepare(
      `INSERT INTO kanban_cards (id, title, status, created_at, updated_at) VALUES (?,?,?,?,?)`,
    ).run('c-pre', 'existing row', 'planned', 1_700_000_000, 1_700_000_000)
    initDatabase(path)
    const again = getDb()
    expect(
      again.prepare(`SELECT name FROM sqlite_master WHERE name='stuck_incidents'`).get(),
    ).toBeTruthy()
    // The pre-existing data is still there -- this really was the same store, not a fresh one.
    expect(again.prepare(`SELECT id FROM kanban_cards WHERE id='c-pre'`).get()).toEqual({
      id: 'c-pre',
    })
  })

  it('records a detection with its decision, including a DENY that did nothing', () => {
    const db = freshDb()
    insert(db, { action: 'none_denied', action_detail: 'DENY:agent-busy' })
    const row = db.prepare(`SELECT * FROM stuck_incidents WHERE card_id='card-1'`).get() as Record<
      string,
      unknown
    >
    expect(row['action']).toBe('none_denied')
    // The point of the whole table: a deliberate non-action says WHY, instead of being
    // indistinguishable from the control never having run.
    expect(row['action_detail']).toBe('DENY:agent-busy')
    expect(row['detections']).toBe(1)
    expect(row['resolved_at']).toBeNull()
  })

  it('accepts an UNKNOWN deny reason -- the guard may grow reasons, and a new one must be recordable', () => {
    const db = freshDb()
    expect(() =>
      insert(db, { action: 'none_denied', action_detail: 'DENY:some-future-reason' }),
    ).not.toThrow()
  })
})

describe('stuck_incidents -- ONE STALL IS ONE ROW', () => {
  it('refuses a SECOND unresolved incident for the same card', () => {
    // Without this, the 10-minute heartbeat would turn one hour-long stall into six rows and
    // "how often did this card get stuck" would be measuring the heartbeat frequency.
    const db = freshDb()
    insert(db)
    expect(() => insert(db, { detected_at: 1_700_000_600 })).toThrow(/UNIQUE|constraint/i)
  })

  it('ALLOWS a new incident once the previous one is resolved -- it is not a one-per-card cap', () => {
    // The negative control for the case above: if the index were unconditional rather than partial,
    // a card could only ever be stuck once in its life and the repeat question would be unanswerable.
    const db = freshDb()
    const first = insert(db)
    db.prepare(`UPDATE stuck_incidents SET resolved_at=? WHERE id=?`).run(1_700_000_500, first)
    expect(() => insert(db, { detected_at: 1_700_001_000 })).not.toThrow()
    expect(
      db.prepare(`SELECT COUNT(*) c FROM stuck_incidents WHERE card_id='card-1'`).get(),
    ).toEqual({ c: 2 })
  })

  it('two DIFFERENT cards may each hold an open incident', () => {
    const db = freshDb()
    insert(db, { card_id: 'card-a' })
    expect(() => insert(db, { card_id: 'card-b' })).not.toThrow()
  })
})

describe('stuck_incidents -- append-only, enforced by the DATABASE', () => {
  it('refuses to rewrite the detection facts', () => {
    const db = freshDb()
    const id = insert(db)
    for (const sql of [
      `UPDATE stuck_incidents SET card_id='other' WHERE id=?`,
      `UPDATE stuck_incidents SET detected_at=1 WHERE id=?`,
      `UPDATE stuck_incidents SET stalled_ms_at_detection=1 WHERE id=?`,
      `UPDATE stuck_incidents SET action='redispatch2' WHERE id=?`,
    ]) {
      expect(() => db.prepare(sql).run(id), sql).toThrow(/append-only/)
    }
  })

  it('ALLOWS the one write that is meant to happen later: resolution, from NULL', () => {
    const db = freshDb()
    const id = insert(db)
    expect(() =>
      db
        .prepare(`UPDATE stuck_incidents SET resolved_at=?, resolved_by_event_id=? WHERE id=?`)
        .run(1_700_000_900, 42, id),
    ).not.toThrow()
    const row = db.prepare(`SELECT * FROM stuck_incidents WHERE id=?`).get(id) as Record<
      string,
      unknown
    >
    expect(row['resolved_at']).toBe(1_700_000_900)
    expect(row['resolved_by_event_id']).toBe(42)
  })

  it('ALLOWS bumping detections on an open incident (that is how re-observation is recorded)', () => {
    const db = freshDb()
    const id = insert(db)
    expect(() =>
      db.prepare(`UPDATE stuck_incidents SET detections = detections + 1 WHERE id=?`).run(id),
    ).not.toThrow()
    expect(db.prepare(`SELECT detections d FROM stuck_incidents WHERE id=?`).get(id)).toEqual({
      d: 2,
    })
  })

  it('refuses to UN-resolve or RE-point a resolution', () => {
    // Both directions matter: clearing resolved_at would reopen a closed incident and let a second
    // open row exist under the unique index, quietly breaking one-stall-one-row.
    const db = freshDb()
    const id = insert(db)
    db.prepare(`UPDATE stuck_incidents SET resolved_at=? WHERE id=?`).run(1_700_000_900, id)
    expect(() =>
      db.prepare(`UPDATE stuck_incidents SET resolved_at=NULL WHERE id=?`).run(id),
    ).toThrow(/append-only/)
    expect(() =>
      db.prepare(`UPDATE stuck_incidents SET resolved_at=? WHERE id=?`).run(1_700_009_999, id),
    ).toThrow(/append-only/)
  })

  it('the trigger fires for a DIRECT sqlite write, not only for the app', () => {
    // The reason it is a trigger at all: the rows that went wrong in this schema historically came
    // from agents writing straight into SQLite, where a TypeScript-side guard is not in the path.
    const db = freshDb()
    const id = insert(db)
    expect(() => db.exec(`UPDATE stuck_incidents SET action='tampered' WHERE id=${id}`)).toThrow(
      /append-only/,
    )
  })
})

describe('stuck_incidents -- DELETE is refused (card 878cd292, the trigger folded in with the first producer)', () => {
  it('refuses a DELETE outright', () => {
    const db = freshDb()
    const id = insert(db)
    expect(() => db.prepare(`DELETE FROM stuck_incidents WHERE id=?`).run(id)).toThrow(/append-only/)
    expect(db.prepare(`SELECT COUNT(*) c FROM stuck_incidents`).get()).toEqual({ c: 1 })
  })

  it('the trigger fires for a DIRECT sqlite exec too, not only a prepared statement', () => {
    const db = freshDb()
    const id = insert(db)
    expect(() => db.exec(`DELETE FROM stuck_incidents WHERE id=${id}`)).toThrow(/append-only/)
  })

  it('a DELETE that matches NOTHING is not an error -- only an actual row deletion is refused', () => {
    const db = freshDb()
    expect(() => db.prepare(`DELETE FROM stuck_incidents WHERE id=999999`).run()).not.toThrow()
  })

  it('STATED RESIDUAL, still open: INSERT OR REPLACE bypasses BOTH triggers, unchanged by this card', () => {
    // Not a bug in what this card shipped -- a documented boundary. Closing it needs
    // `recursive_triggers = ON`, global to all 14 triggers in this schema, which is its own
    // blast-radius question this card does not take on (see the db.ts comment on the new trigger).
    // This test exists so the residual stays PROVEN, not merely asserted in a comment -- if a future
    // change silently closes or reopens it, this is the assertion that would need to change too.
    const db = freshDb()
    const id = insert(db)
    expect(() =>
      db
        .prepare(
          `INSERT OR REPLACE INTO stuck_incidents
             (id, card_id, assignee_at_detection, detected_at, stalled_ms_at_detection, action, action_detail, detections, resolved_at, resolved_by_event_id)
           VALUES (?, 'replaced', 'attacker', 999, 999, 'redispatch', NULL, 1, NULL, NULL)`,
        )
        .run(id),
    ).not.toThrow()
    const row = db.prepare(`SELECT * FROM stuck_incidents WHERE id=?`).get(id) as Record<
      string,
      unknown
    >
    expect(row['card_id']).toBe('replaced') // every column rewritten, including the ones the
    expect(row['action']).toBe('redispatch') // UPDATE trigger protects -- REPLACE never sees it
  })
})

describe('stuck_incidents -- ROLLBACK path (code-quality rule 11)', () => {
  it('DOWN: the table can be dropped, and the rest of the schema still works', () => {
    const db = freshDb()
    db.exec(`DROP TABLE stuck_incidents`)
    expect(db.prepare(`SELECT name FROM sqlite_master WHERE name='stuck_incidents'`).get()).toBeUndefined()
    // The neighbouring tables the stuck monitor actually depends on are untouched.
    for (const t of ['kanban_cards', 'kanban_card_events', 'kanban_card_field_events']) {
      expect(db.prepare(`SELECT name FROM sqlite_master WHERE name=?`).get(t), t).toBeTruthy()
    }
  })

  it('DOWN then UP restores it, and BOTH triggers come back with it', () => {
    const { path, db } = persistentDb()
    db.exec(`DROP TABLE stuck_incidents`)
    initDatabase(path) // the redeploy after a rollback
    const back = getDb()
    const id = insert(back)
    // The triggers are part of the table's contract; a rollback that restored the table WITHOUT
    // them would look identical until the first tampering write or delete.
    expect(() => back.exec(`UPDATE stuck_incidents SET action='x' WHERE id=${id}`)).toThrow(
      /append-only/,
    )
    expect(() => back.exec(`DELETE FROM stuck_incidents WHERE id=${id}`)).toThrow(/append-only/)
  })

  it('DROPPING the table does not break reading the cards the stuck monitor works from', () => {
    // The invariant the rollback has to preserve: logging is not the control. Losing the incident
    // log must never stop the fleet from FINDING and handling stuck cards.
    const db = freshDb()
    db.prepare(
      `INSERT INTO kanban_cards (id, title, status, created_at, updated_at) VALUES (?,?,?,?,?)`,
    ).run('c-live', 'a card', 'in_progress', 1_700_000_000, 1_700_000_000)
    db.exec(`DROP TABLE stuck_incidents`)
    const rows = db.prepare(`SELECT id FROM kanban_cards WHERE status='in_progress'`).all()
    expect(rows).toEqual([{ id: 'c-live' }])
  })
})
