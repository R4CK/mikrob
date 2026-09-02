// Card 69396b63 (Fazis fe3eff9f, FELADAT 3/4): the READ side of kanban_relations -- the row query,
// the two two-hop answers, and the route wiring.
//
// EVERY FIXTURE CARRIES DECOYS, and that is the point of its shape. A join like "cards that touched
// file X" is four predicates wide (two node types, two relation types) and reads correct at a
// glance; a fixture holding only the rows that SHOULD match would pass with any one of them
// deleted. So the table below also holds: another file, another card, the same sha under the wrong
// relation_type, and a same-named node of the wrong type. Drop a predicate and one of those
// surfaces in the answer.
import { describe, it, expect, beforeEach } from 'vitest'
import {
  initDatabase,
  createKanbanCard,
  getDb,
  queryKanbanRelations,
  cardsTouchingFile,
  filesTouchedByCard,
  gateShaTargets,
} from '../db.js'
import {
  cardEdges,
  commentEdges,
  parseQualifiedPath,
  NODE_CARD,
  NODE_FILE,
  NODE_SHA,
  REL_CHILD_OF,
  REL_GATE_SHA,
  REL_PAIR_FE,
  REL_RESOLVED_IN,
  REL_TOUCHES_FILE,
} from '../kanban-relations.js'
import { qualifyPath, gitSweepEdges } from '../kanban-relations-git.js'
import { parseRelationQuery, RELATION_LIMIT_DEFAULT, RELATION_LIMIT_MAX, tryHandleKanban } from '../web/routes/kanban.js'
import type { RouteContext } from '../web/routes/types.js'

const NOW = 1_788_000_000

function relate(
  fromType: string,
  fromId: string,
  toType: string,
  toId: string,
  relationType: string,
  source = 'marker-v1',
): void {
  getDb()
    .prepare(
      `INSERT OR IGNORE INTO kanban_relations
         (from_type, from_id, to_type, to_id, relation_type, source, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(fromType, fromId, toType, toId, relationType, source, NOW)
}

const FILE_X = qualifyPath('marveen', 'src/db.ts')
const FILE_Y = qualifyPath('cleancore', 'src/db.ts') // SAME path, other repo: the collision the qualifier exists for

/** card-a and card-d touch FILE_X (via sha1 / sha3); card-b touches FILE_Y only. */
function seed(): void {
  createKanbanCard({ id: 'card-a', title: 'A card', status: 'done', assignee: 'backend', project: 'MikroB' })
  createKanbanCard({ id: 'card-b', title: 'B card', status: 'planned', assignee: 'qa' })
  createKanbanCard({ id: 'card-c', title: 'C card', status: 'planned' })

  relate(NODE_CARD, 'card-a', NODE_SHA, 'sha1', REL_GATE_SHA)
  relate(NODE_CARD, 'card-a', NODE_SHA, 'sha2', REL_GATE_SHA)
  relate(NODE_CARD, 'card-b', NODE_SHA, 'sha9', REL_GATE_SHA)
  // card-d states sha3 but has NO kanban_cards row: the LEFT JOIN case.
  relate(NODE_CARD, 'card-d', NODE_SHA, 'sha3', REL_GATE_SHA)

  relate(NODE_SHA, 'sha1', NODE_FILE, FILE_X, REL_TOUCHES_FILE, 'git-v1')
  relate(NODE_SHA, 'sha3', NODE_FILE, FILE_X, REL_TOUCHES_FILE, 'git-v1')
  relate(NODE_SHA, 'sha9', NODE_FILE, FILE_Y, REL_TOUCHES_FILE, 'git-v1')

  // --- decoys: every one of these is reachable if a single predicate is dropped ---
  // wrong relation_type on the card hop (card -> sha, but child-of)
  relate(NODE_CARD, 'card-c', NODE_SHA, 'sha1', REL_CHILD_OF)
  // wrong relation_type on the file hop (sha -> file, but resolved-in)
  relate(NODE_SHA, 'sha2', NODE_FILE, FILE_X, REL_RESOLVED_IN, 'git-v1')
  // right relation_type, WRONG node type on the far end (a repo that is NAMED like the file)
  relate(NODE_SHA, 'sha2', 'repo', FILE_X, REL_TOUCHES_FILE, 'git-v1')
  // right types, wrong direction (a file that points AT a sha)
  relate(NODE_FILE, FILE_X, NODE_SHA, 'sha9', REL_TOUCHES_FILE, 'git-v1')
  // an ordinary card-to-card edge, so the plain row query has something else to not match
  relate(NODE_CARD, 'card-b', NODE_CARD, 'card-a', REL_PAIR_FE)
}

beforeEach(() => {
  initDatabase(':memory:')
  seed()
})

describe('the relation vocabulary is shared by the writers and the readers', () => {
  // Not decoration: db.ts cannot import kanban-relations-git.ts (that module shells out to git and
  // is kept off the request path), so the file/repo strings it joins on are spelled in a DIFFERENT
  // file from the one that writes them. A drift there returns ZERO edges -- indistinguishable from
  // "this card touched nothing" -- so the producers are pinned to the constants the readers use.
  it('the marker extractor emits exactly the constants', () => {
    expect(commentEdges('card-x', 'Gate-SHA: abc1234')[0]).toMatchObject({
      from_type: NODE_CARD,
      to_type: NODE_SHA,
      relation_type: REL_GATE_SHA,
    })
    const edges = cardEdges({ id: 'card-x', description: 'Pair-FE: deadbeef', parent_id: 'card-p' })
    expect(edges.map((e) => e.relation_type)).toEqual([REL_PAIR_FE, REL_CHILD_OF])
    expect(edges.every((e) => e.from_type === NODE_CARD && e.to_type === NODE_CARD)).toBe(true)
  })

  it('the git sweep emits exactly the constants (measured on a repo it cannot resolve)', () => {
    // No repo resolves 'ffffffff', so this exercises the resolved-in branch without touching git
    // history: the point here is the STRINGS, not the resolution.
    const { edges } = gitSweepEdges(['ffffffff'], [])
    expect(edges).toHaveLength(1)
    expect(edges[0]).toMatchObject({ from_type: NODE_SHA, to_type: 'repo', relation_type: REL_RESOLVED_IN })
  })

  it('parseQualifiedPath is the inverse of qualifyPath, colons in the path included', () => {
    expect(parseQualifiedPath(qualifyPath('marveen', 'src/db.ts'))).toEqual({ repo: 'marveen', path: 'src/db.ts' })
    expect(parseQualifiedPath(qualifyPath('cleancore', 'a/b:c.ts'))).toEqual({ repo: 'cleancore', path: 'a/b:c.ts' })
    // Not repo-qualified: admitted as such rather than split into a guessed repo.
    expect(parseQualifiedPath('README.md')).toEqual({ repo: null, path: 'README.md' })
  })

  it('gateShaTargets still reads the same edges after taking the constants', () => {
    expect(gateShaTargets()).toEqual(['sha1', 'sha2', 'sha3', 'sha9'])
  })
})

describe('queryKanbanRelations -- the row query', () => {
  it('filters are AND-combined and match only the stated column', () => {
    const res = queryKanbanRelations({
      filters: { from_type: [NODE_CARD], relation_type: [REL_GATE_SHA] },
      limit: 100,
      offset: 0,
    })
    expect(res.edges.map((e) => `${e.from_id}->${e.to_id}`)).toEqual([
      'card-a->sha1',
      'card-a->sha2',
      'card-b->sha9',
      'card-d->sha3',
    ])
    // The decoys share ONE of the two predicates each, so a dropped AND shows up here.
    expect(res.edges.some((e) => e.relation_type !== REL_GATE_SHA)).toBe(false)
  })

  it('a comma list is an OR within one column', () => {
    const res = queryKanbanRelations({ filters: { from_id: ['card-a', 'card-b'] }, limit: 100, offset: 0 })
    expect(new Set(res.edges.map((e) => e.from_id))).toEqual(new Set(['card-a', 'card-b']))
  })

  it('total counts the WHOLE match while edges are bounded, and offset pages a stable order', () => {
    const all = queryKanbanRelations({ filters: { relation_type: [REL_GATE_SHA] }, limit: 100, offset: 0 })
    expect(all.total).toBe(4)
    const first = queryKanbanRelations({ filters: { relation_type: [REL_GATE_SHA] }, limit: 2, offset: 0 })
    expect(first.total).toBe(4) // total is NOT the page size
    expect(first.edges).toHaveLength(2)
    const second = queryKanbanRelations({ filters: { relation_type: [REL_GATE_SHA] }, limit: 2, offset: 2 })
    expect(second.edges).toHaveLength(2)
    // The two pages are disjoint and together reproduce the unpaged answer, in the same order.
    expect([...first.edges, ...second.edges].map((e) => `${e.from_id}->${e.to_id}`)).toEqual(
      all.edges.map((e) => `${e.from_id}->${e.to_id}`),
    )
  })

  it('no filter returns the whole table, still bounded by limit', () => {
    // Counted straight from SQLite rather than written in as a number: a hardcoded total would
    // have to be edited every time a fixture row is added, and the edit that silently makes it
    // agree again is exactly how this assertion would stop meaning "the WHOLE table".
    const rows = (getDb().prepare('SELECT COUNT(*) AS n FROM kanban_relations').get() as { n: number }).n
    expect(rows).toBeGreaterThan(3) // the bound below is only meaningful if it actually bounds
    const res = queryKanbanRelations({ limit: 3, offset: 0 })
    expect(res.total).toBe(rows)
    expect(res.edges).toHaveLength(3)
  })

  it('a filter VALUE carrying SQL is bound, not interpolated', () => {
    const res = queryKanbanRelations({ filters: { from_id: ["' OR 1=1 --"] }, limit: 100, offset: 0 })
    expect(res.total).toBe(0)
    expect(res.edges).toEqual([])
  })
})

describe('cardsTouchingFile -- which cards touched this file (two hops)', () => {
  it('walks card -> sha -> file and groups by card', () => {
    const res = cardsTouchingFile(FILE_X)
    expect(res.file).toBe(FILE_X)
    expect(res.cardCount).toBe(2)
    expect(res.shaCount).toBe(2)
    expect(res.cards.map((c) => c.id)).toEqual(['card-a', 'card-d'])
    expect(res.cards[0]).toMatchObject({ id: 'card-a', title: 'A card', status: 'done', assignee: 'backend', shas: ['sha1'] })
  })

  it('does NOT return the card of a DIFFERENT file with the same path in another repo', () => {
    // card-b touches cleancore:src/db.ts. Both files have the identical path; only the repo
    // qualifier separates them, which is the whole reason to_id is qualified.
    expect(cardsTouchingFile(FILE_X).cards.map((c) => c.id)).not.toContain('card-b')
    expect(cardsTouchingFile(FILE_Y).cards.map((c) => c.id)).toEqual(['card-b'])
  })

  it('an edge naming a card the board no longer holds is REPORTED with null fields, not dropped', () => {
    const orphan = cardsTouchingFile(FILE_X).cards.find((c) => c.id === 'card-d')
    expect(orphan).toBeDefined()
    expect(orphan!.title).toBeNull()
    expect(orphan!.status).toBeNull()
  })

  it('a file nothing touched answers empty rather than everything', () => {
    expect(cardsTouchingFile('marveen:does/not/exist.ts')).toEqual({
      file: 'marveen:does/not/exist.ts',
      shaCount: 0,
      cardCount: 0,
      cards: [],
    })
  })
})

describe('filesTouchedByCard -- which files this card touched (the mirror)', () => {
  it('walks card -> sha -> file and groups by file, split into repo and path', () => {
    const res = filesTouchedByCard('card-a')
    expect(res.fileCount).toBe(1)
    expect(res.files[0]).toEqual({ id: FILE_X, repo: 'marveen', path: 'src/db.ts', shas: ['sha1'] })
  })

  it('lists every stated sha, including one that resolved to no file', () => {
    // sha2 has NO touches-file edge (its only file-shaped edges are decoys). A card whose shas are
    // all unresolvable must not read as a card that stated none.
    const res = filesTouchedByCard('card-a')
    expect(res.shas).toEqual(['sha1', 'sha2'])
    expect(res.shaCount).toBe(2)
    expect(res.files.flatMap((f) => f.shas)).toEqual(['sha1'])
  })

  it('a card with no relations at all answers empty', () => {
    expect(filesTouchedByCard('card-c')).toEqual({
      card: 'card-c',
      shaCount: 0,
      fileCount: 0,
      shas: [],
      files: [],
    })
  })
})

describe('parseRelationQuery -- fail-closed on anything it does not understand', () => {
  const parse = (qs: string) => parseRelationQuery(new URL(`http://x/api/kanban/relations${qs}`))

  it('an unknown parameter is refused, and the message names it AND the accepted set', () => {
    const r = parse('?fromid=card-a')
    expect(r.ok).toBe(false)
    if (r.ok) throw new Error('expected a refusal')
    expect(r.error).toContain('fromid')
    expect(r.error).toContain('from_id')
  })

  it('accepts the six filter columns plus limit and offset', () => {
    const r = parse('?from_type=card&from_id=a&to_type=sha&to_id=b&relation_type=gate-sha&source=marker-v1&limit=7&offset=2')
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.query.limit).toBe(7)
    expect(r.query.offset).toBe(2)
    expect(r.query.filters).toEqual({
      from_type: ['card'], from_id: ['a'], to_type: ['sha'], to_id: ['b'],
      relation_type: ['gate-sha'], source: ['marker-v1'],
    })
  })

  it('defaults the bounds when they are absent', () => {
    const r = parse('')
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.query).toEqual({ limit: RELATION_LIMIT_DEFAULT, offset: 0 })
  })

  it('clamps an over-large limit rather than refusing it', () => {
    const r = parse(`?limit=${RELATION_LIMIT_MAX + 1000}`)
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.query.limit).toBe(RELATION_LIMIT_MAX)
  })

  it.each(['0', '-1', 'abc', '5abc', '1.5', '1e9', ''])('refuses limit=%s', (raw) => {
    const r = parse(`?limit=${encodeURIComponent(raw)}`)
    expect(r.ok).toBe(false)
  })

  it.each(['-1', 'abc', '2abc'])('refuses offset=%s', (raw) => {
    const r = parse(`?offset=${encodeURIComponent(raw)}`)
    expect(r.ok).toBe(false)
  })

  it('offset=0 is accepted (it is a valid value, unlike limit=0)', () => {
    const r = parse('?offset=0')
    expect(r.ok).toBe(true)
  })
})

// --- routes ---------------------------------------------------------------------------------

function fakeCtx(path: string, method = 'GET'): { ctx: RouteContext; out: { status: number; body: any } } {
  const out: { status: number; body: any } = { status: 200, body: null }
  const res: any = {
    writeHead(status: number) { out.status = status; return res },
    setHeader() { return res },
    end(chunk?: string) { if (chunk) out.body = JSON.parse(chunk) },
  }
  const url = new URL(`http://localhost:3420${path}`)
  const ctx = { req: { headers: {} } as any, res, path: url.pathname, method, url } as RouteContext
  return { ctx, out }
}

describe('GET /api/kanban/relations* routes', () => {
  it('serves the row query', async () => {
    const { ctx, out } = fakeCtx('/api/kanban/relations?relation_type=gate-sha')
    expect(await tryHandleKanban(ctx)).toBe(true)
    expect(out.status).toBe(200)
    expect(out.body.total).toBe(4)
    expect(out.body.edges).toHaveLength(4)
  })

  it('400s on an unknown parameter instead of serving the unfiltered table', async () => {
    const { ctx, out } = fakeCtx('/api/kanban/relations?fromid=card-a')
    expect(await tryHandleKanban(ctx)).toBe(true)
    expect(out.status).toBe(400)
    expect(out.body.error).toContain('fromid')
    expect(out.body.edges).toBeUndefined()
  })

  it('serves the two-hop answers', async () => {
    const cards = fakeCtx(`/api/kanban/relations/cards?file=${encodeURIComponent(FILE_X)}`)
    expect(await tryHandleKanban(cards.ctx)).toBe(true)
    expect(cards.out.status).toBe(200)
    expect(cards.out.body.cards.map((c: any) => c.id)).toEqual(['card-a', 'card-d'])

    const files = fakeCtx('/api/kanban/relations/files?card=card-a')
    expect(await tryHandleKanban(files.ctx)).toBe(true)
    expect(files.out.body.files[0].path).toBe('src/db.ts')
  })

  it.each([
    ['/api/kanban/relations/cards', 'file'],
    ['/api/kanban/relations/files', 'card'],
  ])('%s 400s without its anchor parameter', async (path, param) => {
    const { ctx, out } = fakeCtx(path)
    expect(await tryHandleKanban(ctx)).toBe(true)
    expect(out.status).toBe(400)
    expect(out.body.error).toContain(param)
  })

  // THE REGRESSION THIS COULD HAVE INTRODUCED, both ways (card ebf7d95c's lesson).
  it('is not shadowed by the generic /api/kanban/<id> matcher', async () => {
    const { ctx, out } = fakeCtx('/api/kanban/relations')
    expect(await tryHandleKanban(ctx)).toBe(true)
    expect(out.status).toBe(200)
    expect(out.body).toHaveProperty('edges')
    expect(out.body).not.toHaveProperty('error')
  })

  it('does not shadow the generic card route for a real card id', async () => {
    const { ctx, out } = fakeCtx('/api/kanban/card-a')
    expect(await tryHandleKanban(ctx)).toBe(true)
    expect(out.status).toBe(200)
    expect(out.body.id).toBe('card-a')
  })
})
