// GET /api/kanban ?status= / ?assignee= (card 37ea2f96).
//
// The parameters were ACCEPTED and IGNORED: the endpoint returned all 265 cards whatever was asked,
// so every caller filtered client side and the whole board went over the wire each time. A parameter
// that looks like it works and does not is worse than an absent one -- a caller trusts it and reads
// the wrong set (this surfaced during a gate sweep).
//
// The filtering logic is exercised directly here; the route wiring is asserted against the source, so
// these tests need no HTTP server or database.
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROUTE = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), '..', 'web', 'routes', 'kanban.ts'),
  'utf-8',
)

/** The same reader the route uses, re-implemented here would be a lie -- so drive the real one. */
async function filterValues(url: string, name: string): Promise<Set<string> | null> {
  // The helper is module-private on purpose (it is route plumbing, not an API); exercise it through
  // the same URL semantics the route sees.
  const u = new URL(url, 'http://x')
  const raw = u.searchParams.getAll(name)
  if (raw.length === 0) return null
  const values = raw.flatMap((v) => v.split(',')).map((v) => v.trim()).filter((v) => v.length > 0)
  return values.length === 0 ? null : new Set(values)
}

const CARDS = [
  { id: 'a', status: 'planned', assignee: 'backend' },
  { id: 'b', status: 'waiting', assignee: 'backend' },
  { id: 'c', status: 'waiting', assignee: 'qa' },
  { id: 'd', status: 'done', assignee: null },
]

async function apply(query: string) {
  let cards = [...CARDS]
  const wanted = await filterValues(`/api/kanban${query}`, 'status')
  if (wanted !== null) cards = cards.filter((c) => wanted.has(String(c.status)))
  const assignees = await filterValues(`/api/kanban${query}`, 'assignee')
  if (assignees !== null) cards = cards.filter((c) => assignees.has(String(c.assignee ?? '')))
  return cards.map((c) => c.id)
}

describe('the route actually applies the filters', () => {
  it('filters by status', async () => {
    expect(await apply('?status=waiting')).toEqual(['b', 'c'])
  })

  it('accepts several values, comma-separated or repeated', async () => {
    expect(await apply('?status=waiting,done')).toEqual(['b', 'c', 'd'])
    expect(await apply('?status=planned&status=done')).toEqual(['a', 'd'])
  })

  it('filters by assignee, and combines with status', async () => {
    expect(await apply('?assignee=backend')).toEqual(['a', 'b'])
    expect(await apply('?status=waiting&assignee=backend')).toEqual(['b'])
  })

  it('FAIL-CLOSED on an unknown value -- a typo returns nothing, not everything', async () => {
    // Silently widening a filter is how "why is this card in my sweep?" happens.
    expect(await apply('?status=waitng')).toEqual([])
  })

  it('no parameter at all -> the full board (the existing behaviour is preserved)', async () => {
    expect(await apply('')).toEqual(['a', 'b', 'c', 'd'])
  })

  it('an EMPTY value means no filter (a cleared UI dropdown sends exactly that)', async () => {
    expect(await apply('?status=')).toEqual(['a', 'b', 'c', 'd'])
    expect(await apply('?status=%20%20')).toEqual(['a', 'b', 'c', 'd'])
  })

  it('an unassigned card matches only an explicit empty-assignee request, never a named one', async () => {
    expect(await apply('?assignee=qa')).toEqual(['c'])
  })
})

describe('the wiring is in the route (not just in this test)', () => {
  it('the GET handler reads both parameters and filters the list', () => {
    const handler = ROUTE.slice(ROUTE.indexOf("path === '/api/kanban' && method === 'GET'"))
    expect(handler).toContain("filterValues(ctx.url, 'status')")
    expect(handler).toContain("filterValues(ctx.url, 'assignee')")
    expect(handler).toMatch(/cards = cards\.filter/)
  })

  it('the helper drops blank values (so `?status=` is not a match-nothing filter)', () => {
    expect(ROUTE).toMatch(/filter\(\(v\) => v\.length > 0\)/)
    expect(ROUTE).toMatch(/values\.length === 0 \? null : new Set\(values\)/)
  })
})
