import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import type { Server } from 'node:http'
import Database from 'better-sqlite3'
import { openDb } from '../db.js'
import { createIngestServer, startIngestServer } from '../ingest-server.js'

const TOKEN = 'test-token-123'

const validListing = (overrides: Record<string, unknown> = {}) => ({
  id: 'l1',
  url: 'https://ingatlan.com/lakas/l1',
  tipus: 'lakas',
  allapot: null,
  epitesiEv: null,
  cim: null,
  alapteruletM2: null,
  ar: 1000,
  nm2Ar: 100,
  ...overrides,
})

describe('ingest server (real HTTP, real DB)', () => {
  let db: Database.Database
  let server: Server
  let baseUrl: string
  let debugCaptures: unknown[]

  beforeEach(async () => {
    db = openDb(':memory:')
    debugCaptures = []
    server = createIngestServer({ token: TOKEN, db, now: () => 1000, onDebugCapture: (p) => debugCaptures.push(p) })
    const port = await startIngestServer(server, 0)
    baseUrl = `http://127.0.0.1:${port}`
  })
  afterEach(async () => {
    db.close()
    await new Promise((resolve) => server.close(resolve))
  })

  it('GET /api/ingatlan/health requires no auth and returns ok', async () => {
    const res = await fetch(`${baseUrl}/api/ingatlan/health`)
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: true })
  })

  it('POST /api/ingatlan/ingest without an Authorization header is 401', async () => {
    const res = await fetch(`${baseUrl}/api/ingatlan/ingest`, {
      method: 'POST',
      body: JSON.stringify({ listings: [] }),
    })
    expect(res.status).toBe(401)
  })

  it('POST with the WRONG token is 401', async () => {
    const res = await fetch(`${baseUrl}/api/ingatlan/ingest`, {
      method: 'POST',
      headers: { Authorization: 'Bearer wrong-token' },
      body: JSON.stringify({ listings: [] }),
    })
    expect(res.status).toBe(401)
  })

  it('POST with the correct token and a valid listing is accepted and actually lands in the DB', async () => {
    const res = await fetch(`${baseUrl}/api/ingatlan/ingest`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${TOKEN}` },
      body: JSON.stringify({ listings: [validListing()] }),
    })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ accepted: 1, rejected: [], newListings: 1, priceChanges: 0 })
    expect(db.prepare('SELECT * FROM listings WHERE id = ?').get('l1')).toBeTruthy()
  })

  it('a successful ingest also writes an ok=1 row to ingest_log (Napló source, card 1f51f050)', async () => {
    await fetch(`${baseUrl}/api/ingatlan/ingest`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${TOKEN}` },
      body: JSON.stringify({ listings: [validListing()] }),
    })
    const rows = db.prepare('SELECT * FROM ingest_log').all() as Array<{ ok: number; new_listings: number; error: string | null }>
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ ok: 1, new_listings: 1, error: null })
  })

  it('a MIX of valid and invalid listings partially accepts, reporting the invalid index+reason', async () => {
    const res = await fetch(`${baseUrl}/api/ingatlan/ingest`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${TOKEN}` },
      body: JSON.stringify({
        listings: [validListing({ id: 'ok1' }), { id: 'bad', url: 'not-a-url' }, validListing({ id: 'ok2' })],
      }),
    })
    const json = await res.json()
    expect(res.status).toBe(200)
    expect(json.accepted).toBe(2)
    expect(json.rejected).toEqual([{ index: 1, error: 'url is not a valid URL' }])
    expect(db.prepare('SELECT COUNT(*) c FROM listings').get()).toEqual({ c: 2 })
  })

  it('malformed JSON body is 400, not a crash', async () => {
    const res = await fetch(`${baseUrl}/api/ingatlan/ingest`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${TOKEN}` },
      body: '{not json',
    })
    expect(res.status).toBe(400)
  })

  it('malformed JSON body also writes a FAILED run to ingest_log -- Napló must be able to show it', async () => {
    await fetch(`${baseUrl}/api/ingatlan/ingest`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${TOKEN}` },
      body: '{not json',
    })
    const rows = db.prepare('SELECT * FROM ingest_log').all() as Array<{ ok: number; error: string | null }>
    expect(rows).toHaveLength(1)
    expect(rows[0].ok).toBe(0)
    expect(rows[0].error).toBeTruthy()
  })

  it('body.listings not an array is 400', async () => {
    const res = await fetch(`${baseUrl}/api/ingatlan/ingest`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${TOKEN}` },
      body: JSON.stringify({ listings: 'nope' }),
    })
    expect(res.status).toBe(400)
  })

  it('body.listings not an array also writes a FAILED run to ingest_log', async () => {
    await fetch(`${baseUrl}/api/ingatlan/ingest`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${TOKEN}` },
      body: JSON.stringify({ listings: 'nope' }),
    })
    const rows = db.prepare('SELECT * FROM ingest_log').all() as Array<{ ok: number; error: string | null }>
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ ok: 0, error: 'body.listings must be an array' })
  })

  it('GET on the ingest path (wrong method) is 405', async () => {
    const res = await fetch(`${baseUrl}/api/ingatlan/ingest`, {
      headers: { Authorization: `Bearer ${TOKEN}` },
    })
    expect(res.status).toBe(405)
  })

  it('an unknown path is 404', async () => {
    const res = await fetch(`${baseUrl}/api/ingatlan/nope`)
    expect(res.status).toBe(404)
  })

  it('POST /api/ingatlan/debug requires auth too and invokes onDebugCapture with the payload', async () => {
    const unauthed = await fetch(`${baseUrl}/api/ingatlan/debug`, {
      method: 'POST',
      body: JSON.stringify({ page: 'x' }),
    })
    expect(unauthed.status).toBe(401)

    const res = await fetch(`${baseUrl}/api/ingatlan/debug`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${TOKEN}` },
      body: JSON.stringify({ pageUrl: 'https://ingatlan.com/x', note: 'found nothing' }),
    })
    expect(res.status).toBe(200)
    expect(debugCaptures).toEqual([{ pageUrl: 'https://ingatlan.com/x', note: 'found nothing' }])
    // /debug is a diagnostic capture, not a scrape run -- it must not pollute Napló.
    expect(db.prepare('SELECT COUNT(*) c FROM ingest_log').get()).toEqual({ c: 0 })
  })

  it('a payload larger than the configured limit is rejected, not accepted or crashed on', async () => {
    db.close()
    db = openDb(':memory:')
    await new Promise((resolve) => server.close(resolve))
    server = createIngestServer({ token: TOKEN, db, maxBodyBytes: 10 })
    const port = await startIngestServer(server, 0)
    baseUrl = `http://127.0.0.1:${port}`

    const res = await fetch(`${baseUrl}/api/ingatlan/ingest`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${TOKEN}` },
      body: JSON.stringify({ listings: [validListing()] }),
    })
    expect(res.status).toBe(400)
  })

  it('binds to 127.0.0.1, not 0.0.0.0 -- the address is loopback-only', async () => {
    const addr = server.address()
    expect(typeof addr === 'object' && addr?.address).toBe('127.0.0.1')
  })
})
