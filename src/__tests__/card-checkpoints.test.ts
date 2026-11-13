// Card 8b9c2d40 (F1.2): card_checkpoints table + POST/GET /api/kanban/:id/checkpoints API.
// The POST route validates sha format (40 hex) and existence via `git cat-file -e`.
// A real repo SHA (HEAD) is used for the happy path; a syntactically-valid but non-existent SHA
// tests the cat-file rejection.
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { execFileSync } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  initDatabase, createKanbanCard, deleteKanbanCard,
  addKanbanCheckpoint, getKanbanCheckpoints, tryAddKanbanCheckpoint,
  migrateCardCheckpoints, dropCardCheckpoints, getDb,
} from '../db.js'
import { tryHandleKanban } from '../web/routes/kanban.js'
import type { RouteContext } from '../web/routes/types.js'

// Persistent DB for the down+re-up case that must survive a real redeploy (QA2 FAIL 29422 F2):
// `:memory:` cannot serve it -- initDatabase() opens a NEW in-memory database each time, so
// "drop the table, call initDatabase again" on :memory: silently tests a fresh DB and proves
// nothing. Same pattern as stuck-incidents-schema.test.ts's persistentDb().
const tmpDirs: string[] = []
function persistentDb(): { path: string } {
  const dir = mkdtempSync(join(tmpdir(), 'card-checkpoints-'))
  tmpDirs.push(dir)
  const path = join(dir, 'test.db')
  initDatabase(path)
  return { path }
}

// A SHA that actually exists in the repo (HEAD of the main clone or the worktree).
const REAL_SHA = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'] }).trim()
const FAKE_SHA  = '0'.repeat(40) // syntactically valid, almost certainly absent
// A SHA that exists but is NOT a commit (the tree object of HEAD).
const TREE_SHA  = execFileSync('git', ['cat-file', '-p', 'HEAD'], { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'] })
  .split('\n')[0].replace(/^tree /, '').trim()

beforeEach(() => {
  initDatabase(':memory:')
})

afterEach(() => {
  while (tmpDirs.length > 0) {
    try {
      rmSync(tmpDirs.pop()!, { recursive: true, force: true })
    } catch {
      // best-effort cleanup
    }
  }
})

// --- DB layer ---

describe('addKanbanCheckpoint / getKanbanCheckpoints (db layer)', () => {
  it('inserts a checkpoint and returns it with auto-incremented n=1', () => {
    createKanbanCard({ id: 'ck-1', title: 'Checkpoint card' })
    const row = addKanbanCheckpoint('ck-1', REAL_SHA, REAL_SHA, 'backend')
    expect(row.card_id).toBe('ck-1')
    expect(row.n).toBe(1)
    expect(row.sha).toBe(REAL_SHA)
    expect(row.head_sha).toBe(REAL_SHA)
    expect(row.agent).toBe('backend')
    expect(typeof row.created_at).toBe('number')
  })

  it('auto-increments n for successive checkpoints on the same card', () => {
    createKanbanCard({ id: 'ck-2', title: 'Checkpoint card 2' })
    addKanbanCheckpoint('ck-2', REAL_SHA, REAL_SHA, 'backend')
    const row2 = addKanbanCheckpoint('ck-2', REAL_SHA, REAL_SHA, 'backend')
    expect(row2.n).toBe(2)
  })

  it('getKanbanCheckpoints returns rows ordered by n ascending', () => {
    createKanbanCard({ id: 'ck-3', title: 'Order test' })
    addKanbanCheckpoint('ck-3', REAL_SHA, REAL_SHA, 'backend')
    addKanbanCheckpoint('ck-3', REAL_SHA, REAL_SHA, 'backend')
    const rows = getKanbanCheckpoints('ck-3')
    expect(rows.length).toBe(2)
    expect(rows[0].n).toBe(1)
    expect(rows[1].n).toBe(2)
  })

  it('getKanbanCheckpoints returns empty array for a card with no checkpoints', () => {
    createKanbanCard({ id: 'ck-4', title: 'No checkpoints' })
    expect(getKanbanCheckpoints('ck-4')).toEqual([])
  })

  it('deleteKanbanCard cascades to card_checkpoints (FK sweep)', () => {
    createKanbanCard({ id: 'ck-5', title: 'Delete test' })
    addKanbanCheckpoint('ck-5', REAL_SHA, REAL_SHA, 'backend')
    deleteKanbanCard('ck-5')
    // If FK sweep is missing, the DELETE would have thrown; reaching here means it passed.
    expect(getKanbanCheckpoints('ck-5')).toEqual([])
  })
})

// --- Down + re-up migration on the SAME db handle (M1, MikroB 29419) ---

describe('card_checkpoints migration down + re-up (same handle)', () => {
  it('drop then re-create removes rows but table is usable again', () => {
    // beforeEach gave us a fresh :memory: db via initDatabase(':memory:')
    createKanbanCard({ id: 'ck-6', title: 'Down migration test' })
    addKanbanCheckpoint('ck-6', REAL_SHA, REAL_SHA, 'backend')
    expect(getKanbanCheckpoints('ck-6').length).toBe(1)
    // down: remove the table from the CURRENT in-memory handle
    dropCardCheckpoints()
    // re-up: re-create the table on the SAME handle
    migrateCardCheckpoints()
    // row is gone (new empty table), table is usable
    expect(getKanbanCheckpoints('ck-6')).toEqual([])
    const row = addKanbanCheckpoint('ck-6', REAL_SHA, REAL_SHA, 'backend')
    expect(row.n).toBe(1)
  })
})

// --- Down + re-up on a PERSISTENT file DB via the real redeploy path (QA2 FAIL 29422, F1+F2) ---
// `:memory:` cannot prove this: initDatabase() opens a NEW in-memory database each call, so
// "drop, call initDatabase again" on :memory: silently tests a fresh DB. A tmpdir FILE plus a
// second initDatabase(path) call on the SAME path is the actual redeploy-after-rollback shape --
// same pattern QA2 pointed at in stuck-incidents-schema.test.ts lines 261-286.

describe('card_checkpoints DOWN migration on a persistent DB (code-quality rule 11)', () => {
  it('DOWN: the table can be dropped, and the rest of the schema still works', () => {
    persistentDb()
    const db = getDb()
    db.exec('DROP TABLE card_checkpoints')
    expect(db.prepare(`SELECT name FROM sqlite_master WHERE name='card_checkpoints'`).get()).toBeUndefined()
    // Neighbouring tables card_checkpoints' FK depends on are untouched.
    expect(db.prepare(`SELECT name FROM sqlite_master WHERE name='kanban_cards'`).get()).toBeTruthy()
  })

  it('DOWN then UP (redeploy) restores the table on the SAME persistent db file', () => {
    const { path } = persistentDb()
    createKanbanCard({ id: 'ck-down-1', title: 'Persistent down+up test' })
    addKanbanCheckpoint('ck-down-1', REAL_SHA, REAL_SHA, 'backend')
    expect(getKanbanCheckpoints('ck-down-1').length).toBe(1)

    // down: drop the table on the persistent file
    getDb().exec('DROP TABLE card_checkpoints')

    // up: the real redeploy path -- re-run initDatabase on the SAME path, not a fresh handle
    initDatabase(path)

    // the row written before the drop is gone (new table), but the table is back and usable,
    // and the card itself (a different table) survived the whole cycle untouched.
    expect(getKanbanCheckpoints('ck-down-1')).toEqual([])
    const row = addKanbanCheckpoint('ck-down-1', REAL_SHA, REAL_SHA, 'backend')
    expect(row.n).toBe(1)
  })

  it('DROPPING the table does not break reading cards (logging fault is not a reason to stop the control)', () => {
    persistentDb()
    createKanbanCard({ id: 'ck-down-2', title: 'Card survives checkpoint table loss' })
    getDb().exec('DROP TABLE card_checkpoints')
    const row = getDb().prepare(`SELECT id FROM kanban_cards WHERE id = ?`).get('ck-down-2')
    expect(row).toEqual({ id: 'ck-down-2' })
  })
})

// --- HTTP route layer ---

function fakeCtx(
  method: string,
  path: string,
  body?: string,
  delayMs = 0,
): { ctx: RouteContext; out: { status: number; body: any } } {
  const req = new EventEmitter() as unknown as RouteContext['req']
  const out: { status: number; body: any } = { status: 0, body: null }
  const res: any = {
    writeHead(status: number) { out.status = status; return res },
    end(chunk?: string) { if (chunk) out.body = JSON.parse(chunk) },
  }
  const url = new URL(`http://localhost:3420${path}`)
  if (body !== undefined) {
    const emit = () => {
      ;(req as unknown as EventEmitter).emit('data', Buffer.from(body))
      ;(req as unknown as EventEmitter).emit('end')
    }
    if (delayMs > 0) setTimeout(emit, delayMs)
    else process.nextTick(emit)
  }
  const ctx = { req, res, path: url.pathname, method, url } as RouteContext
  return { ctx, out }
}

describe('GET /api/kanban/:id/checkpoints', () => {
  it('returns empty array for a card with no checkpoints', async () => {
    createKanbanCard({ id: 'ck-r1', title: 'Route GET test' })
    const { ctx, out } = fakeCtx('GET', '/api/kanban/ck-r1/checkpoints')
    expect(await tryHandleKanban(ctx)).toBe(true)
    expect(out.status).toBe(200)
    expect(out.body).toEqual([])
  })

  it('404s for a card that does not exist', async () => {
    const { ctx, out } = fakeCtx('GET', '/api/kanban/no-such-card/checkpoints')
    expect(await tryHandleKanban(ctx)).toBe(true)
    expect(out.status).toBe(404)
  })
})

describe('POST /api/kanban/:id/checkpoints', () => {
  it('creates a checkpoint and returns 201 with the row', async () => {
    createKanbanCard({ id: 'ck-r2', title: 'Route POST test' })
    const { ctx, out } = fakeCtx('POST', '/api/kanban/ck-r2/checkpoints', JSON.stringify({
      sha: REAL_SHA, head_sha: REAL_SHA, agent: 'backend',
    }))
    expect(await tryHandleKanban(ctx)).toBe(true)
    expect(out.status).toBe(201)
    expect(out.body.card_id).toBe('ck-r2')
    expect(out.body.n).toBe(1)
    expect(out.body.sha).toBe(REAL_SHA)
  })

  it('404s for a card that does not exist', async () => {
    const { ctx, out } = fakeCtx('POST', '/api/kanban/no-such/checkpoints', JSON.stringify({
      sha: REAL_SHA, head_sha: REAL_SHA, agent: 'backend',
    }))
    expect(await tryHandleKanban(ctx)).toBe(true)
    expect(out.status).toBe(404)
  })

  it('400s when a required field is missing', async () => {
    createKanbanCard({ id: 'ck-r3', title: 'Missing field test' })
    const { ctx, out } = fakeCtx('POST', '/api/kanban/ck-r3/checkpoints', JSON.stringify({
      sha: REAL_SHA, head_sha: REAL_SHA,
      // agent missing
    }))
    expect(await tryHandleKanban(ctx)).toBe(true)
    expect(out.status).toBe(400)
  })

  it('400s when sha is not 40 hex characters', async () => {
    createKanbanCard({ id: 'ck-r4', title: 'Bad sha format test' })
    const { ctx, out } = fakeCtx('POST', '/api/kanban/ck-r4/checkpoints', JSON.stringify({
      sha: 'deadbeef', head_sha: REAL_SHA, agent: 'backend',
    }))
    expect(await tryHandleKanban(ctx)).toBe(true)
    expect(out.status).toBe(400)
  })

  // QA2 addendum (msg 18196, on card 8b9c2d40): `git cat-file -t` happily resolves a short,
  // UNAMBIGUOUS abbreviation of a real commit -- the 40-hex regex is what actually rejects it,
  // and until now nothing proved that case specifically (every other "bad sha" test used a
  // syntactically-unrelated string, not a genuinely resolvable short form of a REAL sha).
  it('400s when sha is a short (7-char) abbreviation of a REAL, resolvable commit', async () => {
    createKanbanCard({ id: 'ck-r4-short', title: 'Short sha abbreviation test' })
    const shortSha = REAL_SHA.slice(0, 7)
    // Sanity: confirm the harness picked a genuinely resolvable abbreviation, so a false pass
    // here cannot be blamed on an ambiguous/unresolvable prefix.
    expect(() =>
      execFileSync('git', ['cat-file', '-t', shortSha], { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'] }),
    ).not.toThrow()
    const { ctx, out } = fakeCtx('POST', '/api/kanban/ck-r4-short/checkpoints', JSON.stringify({
      sha: shortSha, head_sha: REAL_SHA, agent: 'backend',
    }))
    expect(await tryHandleKanban(ctx)).toBe(true)
    expect(out.status).toBe(400)
    expect(out.body.error).toMatch(/40 hex/)
  })

  it('400s when sha is syntactically valid but does not exist in the repo', async () => {
    createKanbanCard({ id: 'ck-r5', title: 'Nonexistent sha test' })
    const { ctx, out } = fakeCtx('POST', '/api/kanban/ck-r5/checkpoints', JSON.stringify({
      sha: FAKE_SHA, head_sha: REAL_SHA, agent: 'backend',
    }))
    expect(await tryHandleKanban(ctx)).toBe(true)
    expect(out.status).toBe(400)
  })

  it('400s when sha exists but is not a commit object (M2)', async () => {
    createKanbanCard({ id: 'ck-r6', title: 'Non-commit sha test' })
    const { ctx, out } = fakeCtx('POST', '/api/kanban/ck-r6/checkpoints', JSON.stringify({
      sha: TREE_SHA, head_sha: REAL_SHA, agent: 'backend',
    }))
    expect(await tryHandleKanban(ctx)).toBe(true)
    expect(out.status).toBe(400)
    expect(out.body.error).toMatch(/commit/)
  })

  it('400s when head_sha exists but is not a commit object (M2)', async () => {
    createKanbanCard({ id: 'ck-r7', title: 'Non-commit head_sha test' })
    const { ctx, out } = fakeCtx('POST', '/api/kanban/ck-r7/checkpoints', JSON.stringify({
      sha: REAL_SHA, head_sha: TREE_SHA, agent: 'backend',
    }))
    expect(await tryHandleKanban(ctx)).toBe(true)
    expect(out.status).toBe(400)
    expect(out.body.error).toMatch(/commit/)
  })

  it('400s on malformed JSON body (LOW)', async () => {
    createKanbanCard({ id: 'ck-r8', title: 'Malformed JSON test' })
    const { ctx, out } = fakeCtx('POST', '/api/kanban/ck-r8/checkpoints', 'not-json{')
    expect(await tryHandleKanban(ctx)).toBe(true)
    expect(out.status).toBe(400)
  })

  // --- F1 (Cybersec2 30439): type + case + agent-pattern validation ---

  it('F1: sha/head_sha are stored LOWERCASE even when submitted uppercase', async () => {
    createKanbanCard({ id: 'ck-f1-case', title: 'Uppercase sha test' })
    const { ctx, out } = fakeCtx('POST', '/api/kanban/ck-f1-case/checkpoints', JSON.stringify({
      sha: REAL_SHA.toUpperCase(), head_sha: REAL_SHA.toUpperCase(), agent: 'backend',
    }))
    expect(await tryHandleKanban(ctx)).toBe(true)
    expect(out.status).toBe(201)
    expect(out.body.sha).toBe(REAL_SHA.toLowerCase())
    expect(out.body.head_sha).toBe(REAL_SHA.toLowerCase())
  })

  it('F1: a non-string agent (object) 400s instead of an uncaught 500', async () => {
    createKanbanCard({ id: 'ck-f1-obj', title: 'Non-string agent test' })
    const { ctx, out } = fakeCtx('POST', '/api/kanban/ck-f1-obj/checkpoints', JSON.stringify({
      sha: REAL_SHA, head_sha: REAL_SHA, agent: {},
    }))
    expect(await tryHandleKanban(ctx)).toBe(true)
    expect(out.status).toBe(400)
  })

  it('F1: a non-string agent (number) 400s instead of silently coercing to a string', async () => {
    createKanbanCard({ id: 'ck-f1-num', title: 'Numeric agent test' })
    const { ctx, out } = fakeCtx('POST', '/api/kanban/ck-f1-num/checkpoints', JSON.stringify({
      sha: REAL_SHA, head_sha: REAL_SHA, agent: 5,
    }))
    expect(await tryHandleKanban(ctx)).toBe(true)
    expect(out.status).toBe(400)
  })

  it('F1: sha/head_sha as a single-element array 400s (typeof check, not just the hex regex)', async () => {
    createKanbanCard({ id: 'ck-f1-arr', title: 'Array sha test' })
    const { ctx, out } = fakeCtx('POST', '/api/kanban/ck-f1-arr/checkpoints', JSON.stringify({
      sha: [REAL_SHA], head_sha: REAL_SHA, agent: 'backend',
    }))
    expect(await tryHandleKanban(ctx)).toBe(true)
    expect(out.status).toBe(400)
  })

  it('F1: an agent value with control/XSS characters 400s', async () => {
    createKanbanCard({ id: 'ck-f1-xss', title: 'XSS agent test' })
    const { ctx, out } = fakeCtx('POST', '/api/kanban/ck-f1-xss/checkpoints', JSON.stringify({
      sha: REAL_SHA, head_sha: REAL_SHA, agent: '<img src=x onerror=alert(1)>',
    }))
    expect(await tryHandleKanban(ctx)).toBe(true)
    expect(out.status).toBe(400)
  })

  it('F1: an agent value over 64 characters 400s', async () => {
    createKanbanCard({ id: 'ck-f1-long', title: 'Long agent test' })
    const { ctx, out } = fakeCtx('POST', '/api/kanban/ck-f1-long/checkpoints', JSON.stringify({
      sha: REAL_SHA, head_sha: REAL_SHA, agent: 'a'.repeat(65),
    }))
    expect(await tryHandleKanban(ctx)).toBe(true)
    expect(out.status).toBe(400)
  })
})

// --- F2 (Cybersec2 30439): cap + insert must be one atomic statement ---

describe('tryAddKanbanCheckpoint (F2: atomic cap check)', () => {
  it('inserts while under the cap and returns the row', () => {
    createKanbanCard({ id: 'ck-cap-1', title: 'Under cap' })
    const row = tryAddKanbanCheckpoint('ck-cap-1', REAL_SHA, REAL_SHA, 'backend', 100)
    expect(row).not.toBeNull()
    expect(row!.n).toBe(1)
  })

  it('refuses (returns null) once the cap is reached, inserting nothing', () => {
    createKanbanCard({ id: 'ck-cap-2', title: 'At cap' })
    tryAddKanbanCheckpoint('ck-cap-2', REAL_SHA, REAL_SHA, 'backend', 1)
    const second = tryAddKanbanCheckpoint('ck-cap-2', REAL_SHA, REAL_SHA, 'backend', 1)
    expect(second).toBeNull()
    expect(getKanbanCheckpoints('ck-cap-2').length).toBe(1)
  })

  it('a burst of calls past the cap never exceeds it (no TOCTOU window)', () => {
    createKanbanCard({ id: 'ck-cap-3', title: 'Burst test' })
    const cap = 5
    let accepted = 0
    for (let i = 0; i < 20; i++) {
      if (tryAddKanbanCheckpoint('ck-cap-3', REAL_SHA, REAL_SHA, 'backend', cap)) accepted++
    }
    expect(accepted).toBe(cap)
    expect(getKanbanCheckpoints('ck-cap-3').length).toBe(cap)
  })

  it('the route enforces the same cap end-to-end (CHECKPOINT_CAP=100, exercised via a low cap substitute is not needed -- this proves the wiring, not the constant)', async () => {
    createKanbanCard({ id: 'ck-cap-route', title: 'Route cap wiring' })
    // Fill to the cap via the db layer directly (faster than 100 HTTP round-trips), then one more
    // request through the real route must 400.
    for (let i = 0; i < 100; i++) tryAddKanbanCheckpoint('ck-cap-route', REAL_SHA, REAL_SHA, 'backend', 100)
    const { ctx, out } = fakeCtx('POST', '/api/kanban/ck-cap-route/checkpoints', JSON.stringify({
      sha: REAL_SHA, head_sha: REAL_SHA, agent: 'backend',
    }))
    expect(await tryHandleKanban(ctx)).toBe(true)
    expect(out.status).toBe(400)
    expect(out.body.error).toMatch(/limit/)
  })

  // F2 regression (Cybersec2 30439): reproduces the measured exploit shape directly against the
  // real route -- many concurrent requests whose bodies all arrive with the SAME delay (a slow
  // body client, any authenticated caller, no special timing needed) must never land more rows
  // than the cap. The old code checked the cap with a plain SELECT BEFORE awaiting the body, so
  // every one of these requests would see the same stale pre-body count; this is why the cap
  // check now runs inside the same statement as the insert, after the body is read.
  it('F2: many concurrent slow-body requests never exceed the cap (reproduces the measured race)', async () => {
    createKanbanCard({ id: 'ck-cap-race', title: 'Concurrent cap test' })
    const almostFull = 98
    for (let i = 0; i < almostFull; i++) tryAddKanbanCheckpoint('ck-cap-race', REAL_SHA, REAL_SHA, 'backend', 100)

    const CONCURRENT_REQUESTS = 20
    const results = await Promise.all(
      Array.from({ length: CONCURRENT_REQUESTS }, () => {
        const { ctx, out } = fakeCtx('POST', '/api/kanban/ck-cap-race/checkpoints', JSON.stringify({
          sha: REAL_SHA, head_sha: REAL_SHA, agent: 'backend',
        }), 10) // all 20 bodies arrive ~simultaneously, 10ms out
        return tryHandleKanban(ctx).then(() => out)
      }),
    )

    const accepted = results.filter((r) => r.status === 201).length
    const refused = results.filter((r) => r.status === 400).length
    expect(accepted).toBe(2) // exactly enough to reach the cap of 100 from 98
    expect(refused).toBe(CONCURRENT_REQUESTS - 2)
    expect(getKanbanCheckpoints('ck-cap-race').length).toBe(100)
  })
})
