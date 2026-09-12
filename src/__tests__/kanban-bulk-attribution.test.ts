// Card 4bbb5167, the sixth finding of audit 6980f9c7: a MASS status change had no attribution.
// 1796 of the board's 1880 status events carry no actor, 1501 of those closed a card to `done`,
// and the event table had nowhere to record a reason at all -- so reversing the triage depended on
// an input file happening to have preserved the previous status.
//
// WHAT THE CARD ASKED FOR AND WHAT IS ACTUALLY THERE. The card says "make actor+reason mandatory
// on the bulk paths (batch-close, batch-status-change)". Measured before writing any code: there
// are no bulk paths. The board has exactly one status door per verb (POST /api/kanban/:id/move and
// PUT /api/kanban/:id), no endpoint anywhere accepts a list of card ids, and no committed script
// loops over them. A mass close is N ordinary writes. So the only thing that separates it from
// ordinary work is its SHAPE, and that is what the guard measures.
//
// THE THRESHOLD IS MEASURED, NOT CHOSEN. Densest 60-second window per day over the real 1880
// events: 1, 289, 111, 15, 2. The three-digit days are the triage this audit is about; the 15 is a
// deliberate bulk sweep that already named an actor; ordinary fleet work sits at 1-2.
import { describe, it, expect, beforeEach } from 'vitest'
import { Readable } from 'node:stream'
import {
  initDatabase,
  createKanbanCard,
  moveKanbanCard,
  updateKanbanCard,
  getKanbanCard,
  getKanbanCardEvents,
  bulkAttributionRequired,
  BULK_ATTRIBUTION_THRESHOLD,
  BULK_ATTRIBUTION_MESSAGE,
  getDb,
} from '../db.js'
import { tryHandleKanban } from '../web/routes/kanban.js'
import type { RouteContext } from '../web/routes/types.js'

const N = BULK_ATTRIBUTION_THRESHOLD

function card(id: string) {
  createKanbanCard({ id, title: `card ${id}`, status: 'planned' })
  return id
}

/** Status events currently on the board -- the burst window reads this same table. */
function eventCount(): number {
  return (getDb().prepare('SELECT COUNT(*) AS n FROM kanban_card_events').get() as { n: number }).n
}

/** Drive the board up to exactly `n` status events through the ordinary, unattributed path. */
function burstTo(n: number) {
  for (let i = 0; i < n; i++) {
    expect(moveKanbanCard(card(`burst${i}`), 'in_progress', 0), `move ${i + 1} of ${n}`).toBe(true)
  }
  expect(eventCount()).toBe(n)
}

beforeEach(() => { initDatabase(':memory:') })

describe('single-card work is untouched (card 4bbb5167)', () => {
  // THE CONTROL, and the most important case here. A guard that demanded attribution from every
  // write would satisfy every refusal test below while breaking the documented path in all 15
  // agents' CLAUDE.md -- which sends neither field. 95% of the board's history came through it.
  it(`the first ${N} unattributed moves all go through`, () => {
    burstTo(N)
  })

  it('an unattributed move on a quiet board is allowed, whatever it does', () => {
    for (const to of ['in_progress', 'waiting', 'done'] as const) {
      initDatabase(':memory:')
      expect(moveKanbanCard(card('x'), to, 0)).toBe(true)
      expect(getKanbanCard('x')!.status).toBe(to)
    }
  })
})

describe('a burst must say who and why (card 4bbb5167)', () => {
  it(`the write after ${N} events in the window is refused, and changes NOTHING`, () => {
    burstTo(N)
    const victim = card('victim')
    expect(moveKanbanCard(victim, 'done', 0)).toBe(false)
    expect(getKanbanCard(victim)!.status, 'a refused write must not move the card').toBe('planned')
    expect(eventCount(), 'a refused write must not leave an event row').toBe(N)
  })

  it('actor alone is not enough, and reason alone is not enough', () => {
    burstTo(N)
    expect(moveKanbanCard(card('a'), 'done', 0, 'mikrob')).toBe(false)
    expect(moveKanbanCard(card('b'), 'done', 0, undefined, false, 'triage batch 2/3')).toBe(false)
    expect(eventCount()).toBe(N)
  })

  it('both together pass, and the reason is stored where the audit can read it', () => {
    burstTo(N)
    const id = card('ok')
    expect(moveKanbanCard(id, 'done', 0, 'mikrob', false, 'triázs-köteg 2/3, QA PASS')).toBe(true)
    const [ev] = getKanbanCardEvents(id)
    expect(ev!.actor).toBe('mikrob')
    expect(ev!.reason).toBe('triázs-köteg 2/3, QA PASS')
  })

  it('whitespace is not an answer -- " " satisfies neither field', () => {
    burstTo(N)
    expect(moveKanbanCard(card('ws'), 'done', 0, '   ', false, '   ')).toBe(false)
    expect(moveKanbanCard(card('ws2'), 'done', 0, 'mikrob', false, '\t\n ')).toBe(false)
  })

  it('force is not the way past it -- that is a different claim', () => {
    // `force` says "I know a guard is in the way". It does not say who I am or why. The three
    // sibling guards on this state machine treat force+allowlisted-actor as the override; this one
    // has no override at all, because answering it IS the action it asks for.
    burstTo(N)
    expect(moveKanbanCard(card('f'), 'done', 0, 'mikrob', true)).toBe(false)
  })
})

describe('what the guard must NOT treat as a state change (card 4bbb5167)', () => {
  it('a reorder inside one column still works mid-burst -- it changes no state', () => {
    burstTo(N)
    // burst0 is already in_progress; moving it to in_progress again is a sort_order write.
    expect(moveKanbanCard('burst0', 'in_progress', 7)).toBe(true)
    expect(eventCount(), 'a reorder writes no status event either').toBe(N)
  })

  it('an edit that carries no status is not a state change', () => {
    burstTo(N)
    expect(updateKanbanCard('burst0', { title: 'renamed mid-burst' })).toBe(true)
    expect(getKanbanCard('burst0')!.title).toBe('renamed mid-burst')
  })
})

describe('both doors, not one (card 4bbb5167)', () => {
  // updateKanbanCard is the OTHER status writer. Guarding /move alone would leave PUT wide open,
  // and the mass triage could simply have used it -- the same reasoning dependencyBlockers gives
  // for living in the writers rather than in the handlers.
  it('PUT-style status writes are guarded identically', () => {
    burstTo(N)
    const id = card('put')
    expect(updateKanbanCard(id, { status: 'done' })).toBe(false)
    expect(getKanbanCard(id)!.status).toBe('planned')
    expect(updateKanbanCard(id, { status: 'done' }, { actor: 'mikrob', reason: 'köteg-zárás' })).toBe(true)
    expect(getKanbanCardEvents(id)[0]!.reason).toBe('köteg-zárás')
  })
})

describe('the predicate itself (card 4bbb5167)', () => {
  it('answers false on a quiet board no matter what is supplied', () => {
    expect(bulkAttributionRequired(Math.floor(Date.now() / 1000))).toBe(false)
  })

  it('a refusal cannot ratchet: no row is written, so the window drains', () => {
    // The failure this rules out: if a refused write still recorded an event, a board that tipped
    // over the threshold once could never accept an unattributed status change again.
    burstTo(N)
    expect(moveKanbanCard(card('r'), 'done', 0)).toBe(false)
    const now = Math.floor(Date.now() / 1000)
    getDb().prepare('UPDATE kanban_card_events SET created_at = ?').run(now - 3600)
    expect(bulkAttributionRequired(now)).toBe(false)
    expect(moveKanbanCard('r', 'done', 0), 'the board accepts ordinary work again').toBe(true)
  })
})

// The refusal has to REACH the person who tripped it. The dashboard surfaces `body.error` as a
// toast (app-kanban.js kanbanMoveErrorMessage), so the 409 body is the whole user-facing surface:
// a bare `false` from the writer would fall through to the reviewed-card message, which names the
// wrong problem and tells the caller to send `force` -- the one thing that does not help here.
describe('the route answers with its own body (card 4bbb5167)', () => {
  function post(path: string, method: string, body: unknown) {
    const out: { status: number; body: any } = { status: 0, body: null }
    const res: any = {
      writeHead(status: number) { out.status = status; return res },
      end(chunk?: string) { if (chunk) out.body = JSON.parse(chunk) },
    }
    const req: any = Readable.from([Buffer.from(JSON.stringify(body))])
    const url = new URL(`http://localhost:3420${path}`)
    const ctx = { req, res, path: url.pathname, method, url } as RouteContext
    return { ctx, out }
  }

  it('409 bulk_attribution_required, with a message naming both fields', async () => {
    burstTo(N)
    const id = card('route')
    const { ctx, out } = post(`/api/kanban/${id}/move`, 'POST', { status: 'done' })
    expect(await tryHandleKanban(ctx)).toBe(true)
    expect(out.status).toBe(409)
    expect(out.body.code).toBe('bulk_attribution_required')
    expect(out.body.error).toBe(BULK_ATTRIBUTION_MESSAGE)
    expect(out.body.error).toContain('actor')
    expect(out.body.error).toContain('reason')
    expect(getKanbanCard(id)!.status).toBe('planned')
  })

  it('the same request WITH both fields is accepted and persists the reason', async () => {
    burstTo(N)
    const id = card('route2')
    const { ctx, out } = post(`/api/kanban/${id}/move`, 'POST', {
      status: 'done', actor: 'mikrob', reason: 'triázs-köteg 3/3',
    })
    expect(await tryHandleKanban(ctx)).toBe(true)
    expect(out.status).toBe(200)
    expect(getKanbanCardEvents(id)[0]!.reason).toBe('triázs-köteg 3/3')
  })

  it('a missing card still answers 404 mid-burst, not a bulk refusal', async () => {
    // Otherwise the guard would hide a typo'd id behind an unrelated diagnosis.
    burstTo(N)
    const { ctx, out } = post('/api/kanban/no-such-card/move', 'POST', { status: 'done' })
    expect(await tryHandleKanban(ctx)).toBe(true)
    expect(out.status).toBe(404)
  })
})
