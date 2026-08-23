// Card 51878c59: a non-status card edit used to leave no trace at all.
//
// THE INCIDENT THIS ANSWERS. On card 8d673233 a [50%] marker appeared in the TITLE, the board
// showed progress nobody had made, and afterwards NOBODY could say who wrote it -- the offload
// script was suspected and independently cleared (card 8b925388: three HTTP calls, none of them a
// title write). The reason it was unanswerable is here: updateKanbanCard only wrote to
// kanban_card_events when the STATUS changed, so every other field moved silently.
//
// That matters more than "an edit is untracked", because the fleet keeps its PROGRESS marker in
// the title ([NN%], working rule 2). The field that says how far along a piece of work is had no
// audit at all.
import { describe, it, expect, beforeEach } from 'vitest'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Readable } from 'node:stream'
import type http from 'node:http'
import {
  initDatabase,
  createKanbanCard,
  getKanbanCard,
  updateKanbanCard,
  moveKanbanCard,
  getKanbanCardEvents,
  getKanbanCardFieldEvents,
  archiveKanbanCard,
  unarchiveKanbanCard,
  FIELD_AUDIT_VALUE_MAX,
} from '../db.js'
import { tryHandleKanban } from '../web/routes/kanban.js'
import type { RouteContext } from '../web/routes/types.js'
import {
  newTransferRows, FIELD_EVENT_COLUMNS, STATUS_EVENT_COLUMNS,
} from '../web/fleet-transfer-dedup.js'

function fakeCtx(path: string, method: string, body?: unknown): { ctx: RouteContext; out: { status: number; body: any } } {
  const out: { status: number; body: any } = { status: 0, body: null }
  const res: any = {
    writeHead(status: number) { out.status = status; return res },
    end(chunk?: string) { if (chunk) out.body = JSON.parse(chunk) },
  }
  const req = Readable.from(body === undefined ? [] : [Buffer.from(JSON.stringify(body))]) as unknown as http.IncomingMessage
  const url = new URL(`http://localhost:3420${path}`)
  return { ctx: { req, res, path: url.pathname, method, url } as RouteContext, out }
}

beforeEach(() => {
  initDatabase(':memory:')
  createKanbanCard({ id: 'c1', title: 'Original title', priority: 'normal' })
})

describe('a non-status card edit is attributable (card 51878c59)', () => {
  it('THE INCIDENT SHAPE: a [NN%] written into the title names who did it, and when', () => {
    updateKanbanCard('c1', { title: '[50%] Original title' }, { actor: 'someone' })
    const ev = getKanbanCardFieldEvents('c1')
    expect(ev).toHaveLength(1)
    expect(ev[0]!.field).toBe('title')
    expect(ev[0]!.old_value).toBe('Original title')
    expect(ev[0]!.new_value).toBe('[50%] Original title')
    expect(ev[0]!.actor).toBe('someone')
    expect(ev[0]!.created_at).toBeGreaterThan(0)
  })

  it('an edit with NO actor is still recorded -- as an unnamed one, not as nothing', () => {
    // `actor` is self-declared and optional, so a null here is honest. Dropping the row instead
    // would restore exactly the hole this card is about: an edit that happened and left no trace.
    updateKanbanCard('c1', { title: 'Renamed' }, {})
    const ev = getKanbanCardFieldEvents('c1')
    expect(ev).toHaveLength(1)
    expect(ev[0]!.actor).toBeNull()
  })

  it('several fields changed at once produce one row EACH, not one lumped row', () => {
    updateKanbanCard('c1', { title: 'T2', priority: 'high', assignee: 'backend' }, { actor: 'mikrob' })
    const fields = getKanbanCardFieldEvents('c1').map((e) => e.field).sort()
    expect(fields).toEqual(['assignee', 'priority', 'title'])
  })

  it('a write that changes NOTHING records nothing', () => {
    updateKanbanCard('c1', { title: 'Original title' }, { actor: 'someone' })
    expect(getKanbanCardFieldEvents('c1')).toEqual([])
  })

  it('STATUS is not duplicated here -- kanban_card_events already owns it', () => {
    // Auditing it in both places would make the two disagree the first time one of them changed.
    moveKanbanCard('c1', 'in_progress', 0, 'someone')
    expect(getKanbanCardEvents('c1')).toHaveLength(1)
    expect(getKanbanCardFieldEvents('c1').map((e) => e.field)).not.toContain('status')
  })

  it('a status change made through updateKanbanCard still lands in the STATUS table only', () => {
    updateKanbanCard('c1', { status: 'in_progress' }, { actor: 'someone' })
    expect(getKanbanCardEvents('c1')).toHaveLength(1)
    expect(getKanbanCardFieldEvents('c1')).toEqual([])
  })

  it('sort_order is deliberately NOT audited -- a drag rewrites it on every card that shifted', () => {
    // Auditing it would bury the edits somebody actually wants to find under reordering noise.
    updateKanbanCard('c1', { sort_order: 42 }, { actor: 'someone' })
    expect(getKanbanCardFieldEvents('c1')).toEqual([])
  })

  it('the trail is ordered oldest-first, so a reader can follow what happened', () => {
    updateKanbanCard('c1', { title: 'A' }, { actor: 'first' })
    updateKanbanCard('c1', { title: 'B' }, { actor: 'second' })
    const ev = getKanbanCardFieldEvents('c1')
    expect(ev.map((e) => e.actor)).toEqual(['first', 'second'])
    expect(ev.map((e) => e.new_value)).toEqual(['A', 'B'])
    // ...and each row carries the value it REPLACED, so the chain reconstructs without guessing.
    expect(ev[1]!.old_value).toBe('A')
  })
})

describe('the three follow-up findings on this trail (card 7fd6dd23, Cybersec)', () => {
  it('F-1 THE DEAD FIELD: archiving writes an audit row -- it used to be declared and unreachable', () => {
    // archived_at was in the audited-field list and could never fire: archiveKanbanCard writes the
    // column with its OWN update, so nothing reached updateKanbanCard's comparison loop. Measured
    // before the fix: zero rows in either table after an archive. A declared-but-unreachable audit
    // field claims coverage it does not have, which is worse than an honest gap -- a reader stops
    // looking.
    expect(archiveKanbanCard('c1', { actor: 'mikrob' })).toEqual({ ok: true })
    const ev = getKanbanCardFieldEvents('c1')
    expect(ev).toHaveLength(1)
    expect(ev[0]!.field).toBe('archived_at')
    expect(ev[0]!.old_value).toBeNull()
    expect(ev[0]!.new_value).not.toBeNull()
    expect(ev[0]!.actor).toBe('mikrob')
  })

  it('F-1 the other direction: unarchiving is audited too, and keeps the value it cleared', () => {
    archiveKanbanCard('c1', { actor: 'mikrob' })
    const archivedAt = getKanbanCardFieldEvents('c1')[0]!.new_value
    expect(unarchiveKanbanCard('c1', { actor: 'someone' })).toBe(true)
    const last = getKanbanCardFieldEvents('c1').at(-1)!
    expect(last.field).toBe('archived_at')
    expect(last.old_value).toBe(archivedAt) // the chain reconstructs without guessing
    expect(last.new_value).toBeNull()
    expect(last.actor).toBe('someone')
  })

  it('F-1 CONTROL: a refused archive writes NO row', () => {
    // Otherwise the trail would record attempts as if they had happened.
    createKanbanCard({ id: 'parent', title: 'P' })
    createKanbanCard({ id: 'kid', title: 'K', parent_id: 'parent', status: 'planned' })
    expect(archiveKanbanCard('parent', { actor: 'mikrob' }).ok).toBe(false)
    expect(getKanbanCardFieldEvents('parent')).toEqual([])
  })

  it('F-3 a long value is CAPPED, and the cut is visible', () => {
    // Without a bound this table keeps every past version of a long description for ever, and the
    // endpoint hands them back. A cap and not a hash: a hash bounds the growth and destroys the one
    // thing the row is for -- saying what it used to say.
    const long = 'x'.repeat(FIELD_AUDIT_VALUE_MAX + 250)
    updateKanbanCard('c1', { description: long }, { actor: 'someone' })
    const stored = getKanbanCardFieldEvents('c1')[0]!.new_value!
    expect(stored.length).toBeLessThan(long.length)
    expect(stored).toContain('levágva') // a truncated value must not read as the whole one
  })

  it('F-3 a value at the limit is stored WHOLE -- the cap must not clip what fits', () => {
    const exact = 'y'.repeat(FIELD_AUDIT_VALUE_MAX)
    updateKanbanCard('c1', { description: exact }, { actor: 'someone' })
    expect(getKanbanCardFieldEvents('c1')[0]!.new_value).toBe(exact)
  })
})

describe('F-2: a fleet transfer carries the field trail, not just the status one (card 7fd6dd23)', () => {
  // A SHAPE test on the source for the two halves that need a live DB and filesystem to drive --
  // importFleet is exercised by its own suite with mocked modules. What matters here is that the
  // export READS the table and the payload key stays OPTIONAL; the import's dedup rule is tested
  // for real below, against the extracted helper it now uses.
  const SRC = readFileSync(
    join(dirname(fileURLToPath(import.meta.url)), '..', 'web', 'fleet-transfer.ts'),
    'utf-8',
  )
  const exec = SRC.split('\n').filter((l) => !/^\s*(\/\/|\*)/.test(l)).join('\n')

  it('the export READS the table', () => {
    expect(exec).toMatch(/SELECT \* FROM kanban_card_field_events/)
  })

  it('the import WRITES it', () => {
    expect(exec).toMatch(/INSERT INTO kanban_card_field_events/)
  })

  it('the payload key is OPTIONAL, so an export taken before this existed still imports', () => {
    // The existing fleet-transfer fixtures have no cardFieldEvents key at all. If the field were
    // required, this change would break every stored export rather than extend it.
    expect(SRC).toMatch(/cardFieldEvents\?:/)
    expect(exec).toMatch(/fleet\.kanban\?\.cardFieldEvents \?\? \[\]/)
  })
})

describe('L-1: archiving twice must not erase when it was archived (card 394fb5ce)', () => {
  it('THE DEFECT: a second archive keeps the ORIGINAL timestamp instead of overwriting it', () => {
    expect(archiveKanbanCard('c1', { actor: 'mikrob' })).toEqual({ ok: true })
    const first = getKanbanCard('c1')!.archived_at
    expect(first).toBeTruthy()

    const again = archiveKanbanCard('c1', { actor: 'someone-else' })
    expect(again).toEqual({ ok: false, reason: 'already-archived' })
    expect(getKanbanCard('c1')!.archived_at).toBe(first)
  })

  it('THE DEFECT, audit half: it no longer claims a second time that the card was not archived', () => {
    // Both rows used to read null -> T, so the trail asserted twice that the card had NOT been
    // archived before -- while the second write was busy replacing the row that said when it was.
    archiveKanbanCard('c1', { actor: 'mikrob' })
    archiveKanbanCard('c1', { actor: 'someone-else' })
    const rows = getKanbanCardFieldEvents('c1').filter((e) => e.field === 'archived_at')
    expect(rows).toHaveLength(1)
    expect(rows[0]!.actor).toBe('mikrob')
  })

  it('CONTROL: a genuinely missing card is still not-found, not already-archived', () => {
    // The two answers must not collapse into one, or the fix would hide the real error case.
    expect(archiveKanbanCard('no-such-card')).toEqual({ ok: false, reason: 'not-found' })
  })

  it('CONTROL: archive still WORKS, and archive -> unarchive -> archive gives a fresh timestamp', () => {
    archiveKanbanCard('c1', { actor: 'mikrob' })
    expect(unarchiveKanbanCard('c1', { actor: 'mikrob' })).toBe(true)
    expect(getKanbanCard('c1')!.archived_at).toBeNull()
    expect(archiveKanbanCard('c1', { actor: 'mikrob' })).toEqual({ ok: true })
    expect(getKanbanCard('c1')!.archived_at).toBeTruthy()
    expect(getKanbanCardFieldEvents('c1').filter((e) => e.field === 'archived_at')).toHaveLength(3)
  })
})

describe('L-2: the ROUTE passes the actor through, and nothing else was testing that (card 394fb5ce)', () => {
  // The db layer's actor handling is covered above. What was uncovered is the wiring: if the route
  // stopped reading `actor` from the body, every archive made through the API would be logged with
  // a null actor, the table would keep working, and no test would notice.
  it('POST /archive names the actor from the body', async () => {
    const { ctx, out } = await Promise.resolve(fakeCtx('/api/kanban/c1/archive', 'POST', { actor: 'mikrob' }))
    expect(await tryHandleKanban(ctx)).toBe(true)
    expect(out.status).toBe(200)
    const rows = getKanbanCardFieldEvents('c1').filter((e) => e.field === 'archived_at')
    expect(rows).toHaveLength(1)
    expect(rows[0]!.actor).toBe('mikrob')
  })

  it('POST /unarchive names the actor from the body', async () => {
    archiveKanbanCard('c1', { actor: 'mikrob' })
    const { ctx, out } = fakeCtx('/api/kanban/c1/unarchive', 'POST', { actor: 'someone' })
    expect(await tryHandleKanban(ctx)).toBe(true)
    expect(out.status).toBe(200)
    expect(getKanbanCardFieldEvents('c1').at(-1)!.actor).toBe('someone')
  })

  it('CONTROL: no body still writes the row, with an unnamed actor', async () => {
    // Otherwise this pair could pass by dropping unattributed archives entirely, which is the hole
    // card 7fd6dd23 closed.
    const { ctx } = fakeCtx('/api/kanban/c1/archive', 'POST')
    expect(await tryHandleKanban(ctx)).toBe(true)
    const rows = getKanbanCardFieldEvents('c1').filter((e) => e.field === 'archived_at')
    expect(rows).toHaveLength(1)
    expect(rows[0]!.actor).toBeNull()
  })

  it('the route answers idempotently on a second archive instead of 404-ing about a card that exists', async () => {
    archiveKanbanCard('c1', { actor: 'mikrob' })
    const { ctx, out } = fakeCtx('/api/kanban/c1/archive', 'POST', { actor: 'mikrob' })
    expect(await tryHandleKanban(ctx)).toBe(true)
    expect(out.status).toBe(200)
    expect(out.body).toEqual({ ok: true, alreadyArchived: true })
  })
})

describe('L-3: a transfer must not merge two events that share a second (card 394fb5ce)', () => {
  const rows = (...vals: Array<[string, string, string]>) =>
    vals.map(([field, oldV, newV]) => ({
      card_id: 'c1', field, old_value: oldV, new_value: newV, actor: 'mikrob', created_at: 1_000,
    }))

  it('THE DEFECT: two edits of the SAME field in the SAME second both cross', () => {
    // The old key was (card_id, created_at, field) and an existence check. These two rows share it,
    // so the second was skipped and the trail silently reported one edit where two happened.
    const payload = rows(['title', 'A', 'B'], ['title', 'B', 'C'])
    expect(newTransferRows(payload, [], FIELD_EVENT_COLUMNS)).toHaveLength(2)
  })

  it('IDEMPOTENCE: re-importing the same payload inserts nothing', () => {
    const payload = rows(['title', 'A', 'B'], ['title', 'B', 'C'])
    expect(newTransferRows(payload, payload, FIELD_EVENT_COLUMNS)).toEqual([])
  })

  it('a PARTIAL overlap carries only what is missing', () => {
    const payload = rows(['title', 'A', 'B'], ['title', 'B', 'C'])
    const fresh = newTransferRows(payload, [payload[0]!], FIELD_EVENT_COLUMNS)
    expect(fresh).toHaveLength(1)
    expect(fresh[0]!.old_value).toBe('B')
  })

  it('THE KEY WIDTH: a target row that shares the OLD narrow key must not consume a different event', () => {
    // Measured, because the first version of this suite did not catch it: multiplicity ALONE fixes
    // the reported defect, so narrowing the key back to (card_id, field, created_at) left every
    // other test here green. It is not an equivalent change. Here the target already holds the
    // SECOND edit; under the narrow key that one existing row is spent matching the FIRST payload
    // row, so A -> B is dropped and B -> C is inserted a second time. The card loses an edit and
    // gains a duplicate, which is the merge this fix is about, one step further along.
    const payload = rows(['title', 'A', 'B'], ['title', 'B', 'C'])
    const fresh = newTransferRows(payload, [payload[1]!], FIELD_EVENT_COLUMNS)
    expect(fresh).toHaveLength(1)
    expect(fresh[0]!.old_value).toBe('A')
  })

  it('MULTIPLICITY: two byte-identical source rows produce two target rows, not one', () => {
    // A wider key alone would not fix this -- an existence check can never carry a second copy.
    const dup = rows(['title', 'A', 'B'], ['title', 'A', 'B'])
    expect(newTransferRows(dup, [], FIELD_EVENT_COLUMNS)).toHaveLength(2)
    expect(newTransferRows(dup, [dup[0]!], FIELD_EVENT_COLUMNS)).toHaveLength(1)
  })

  it('a missing optional column reads the same as an explicit null, so a re-import is still a no-op', () => {
    // The payload arrives from JSON (absent key -> undefined), the target from SQLite (NULL). If
    // those compared unequal, every row with an empty actor would be re-inserted on every import.
    const fromJson = [{ card_id: 'c1', field: 'title', old_value: null, new_value: 'B', created_at: 7 }]
    const fromDb = [{ card_id: 'c1', field: 'title', old_value: null, new_value: 'B', actor: null, created_at: 7 }]
    expect(newTransferRows(fromJson, fromDb, FIELD_EVENT_COLUMNS)).toEqual([])
  })

  it('the STATUS trail got the same rule -- it had the same key shape', () => {
    const back = { card_id: 'c1', from_status: 'planned', to_status: 'in_progress', actor: 'mikrob', created_at: 5 }
    const forth = { card_id: 'c1', from_status: 'in_progress', to_status: 'planned', actor: 'mikrob', created_at: 5 }
    expect(newTransferRows([back, forth], [], STATUS_EVENT_COLUMNS)).toHaveLength(2)
    expect(newTransferRows([back, forth], [back, forth], STATUS_EVENT_COLUMNS)).toEqual([])
  })
})
