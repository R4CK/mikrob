import { createServer, type IncomingMessage, type ServerResponse, type Server } from 'node:http'
import type Database from 'better-sqlite3'
import { recordSighting, recordIngestRun } from './db.js'
import { validateIngestListing } from './ingest-validate.js'

const DEFAULT_MAX_BODY_BYTES = 2 * 1024 * 1024

export interface IngestServerOptions {
  token: string
  db: Database.Database
  now?: () => number
  maxBodyBytes?: number
  onDebugCapture?: (payload: unknown) => void
}

function readJsonBody(req: IncomingMessage, maxBytes: number): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let size = 0
    let tooLarge = false
    const chunks: Buffer[] = []
    req.on('data', (chunk: Buffer) => {
      size += chunk.length
      // Stop BUFFERING once over the limit (bounds memory) but keep draining the socket instead
      // of destroying it -- req and res share one connection, so destroying req here would kill
      // the response too and the caller would see a socket error instead of a clean 400.
      if (size > maxBytes) { tooLarge = true; return }
      chunks.push(chunk)
    })
    req.on('end', () => {
      if (tooLarge) { reject(new Error('payload too large')); return }
      try {
        const text = Buffer.concat(chunks).toString('utf-8')
        resolve(text ? JSON.parse(text) : {})
      } catch {
        reject(new Error('invalid JSON'))
      }
    })
    req.on('error', reject)
  })
}

function send(res: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body)
  res.writeHead(status, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(text) })
  res.end(text)
}

// Constant-time-ish is not the concern here (this is a local, single-user, non-networked secret
// compared once per request, not a login form under brute-force) -- a plain string compare is fine.
function isAuthorized(req: IncomingMessage, token: string): boolean {
  return req.headers.authorization === `Bearer ${token}`
}

// Builds the http.Server but does NOT call .listen() -- see startIngestServer for the bind, which
// deliberately hardcodes 127.0.0.1 (see its own comment for why that must never be a parameter).
export function createIngestServer(opts: IngestServerOptions): Server {
  const now = opts.now ?? Date.now
  const maxBodyBytes = opts.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES

  return createServer((req, res) => {
    void (async () => {
      const url = req.url ?? ''
      const method = req.method ?? 'GET'

      if (method === 'GET' && url === '/api/ingatlan/health') {
        send(res, 200, { ok: true })
        return
      }

      const isIngestPath = url === '/api/ingatlan/ingest'
      const isDebugPath = url === '/api/ingatlan/debug'
      if (!isIngestPath && !isDebugPath) {
        send(res, 404, { error: 'not found' })
        return
      }
      if (method !== 'POST') {
        send(res, 405, { error: 'method not allowed' })
        return
      }
      // Token check applies to BOTH ingest and debug -- the debug capture can carry a chunk of a
      // real (if Peti's own) ingatlan.com page's content, which is not something to accept from an
      // unauthenticated caller even on localhost.
      if (!isAuthorized(req, opts.token)) {
        send(res, 401, { error: 'unauthorized' })
        return
      }

      let body: unknown
      try {
        body = await readJsonBody(req, maxBodyBytes)
      } catch (err) {
        const message = err instanceof Error ? err.message : 'bad request'
        if (isIngestPath) {
          recordIngestRun(
            opts.db,
            { ok: false, newListings: 0, priceChanges: 0, rejectedCount: 0, error: message },
            Math.floor(now() / 1000),
          )
        }
        send(res, 400, { error: message })
        return
      }

      if (isDebugPath) {
        opts.onDebugCapture?.(body)
        send(res, 200, { ok: true })
        return
      }

      // isIngestPath
      const listings = (body as { listings?: unknown[] } | null)?.listings
      const nowEpochSeconds = Math.floor(now() / 1000)
      if (!Array.isArray(listings)) {
        recordIngestRun(
          opts.db,
          { ok: false, newListings: 0, priceChanges: 0, rejectedCount: 0, error: 'body.listings must be an array' },
          nowEpochSeconds,
        )
        send(res, 400, { error: 'body.listings must be an array' })
        return
      }

      const rejected: Array<{ index: number; error: string }> = []
      let accepted = 0
      let newListings = 0
      let priceChanges = 0
      listings.forEach((raw, index) => {
        const result = validateIngestListing(raw)
        if (!result.ok) {
          rejected.push({ index, error: result.error })
          return
        }
        const outcome = recordSighting(opts.db, result.listing, nowEpochSeconds)
        accepted++
        if (outcome.isNewListing) newListings++
        if (outcome.priceChanged) priceChanges++
      })
      // A run that fully processed (even if every single listing was individually rejected) is
      // still "ok" at the run level -- Napló's error state is for the RUN failing, not for a
      // scrape pass that legitimately found nothing new to accept. Per-listing rejects are still
      // visible via rejected_count.
      recordIngestRun(
        opts.db,
        { ok: true, newListings, priceChanges, rejectedCount: rejected.length, error: null },
        nowEpochSeconds,
      )
      send(res, 200, { accepted, rejected, newListings, priceChanges })
    })().catch(() => {
      if (!res.headersSent) send(res, 500, { error: 'internal error' })
    })
  })
}

// The bind address is DELIBERATELY not a parameter/env var. This endpoint receives data extracted
// by a content script running in the context of a third-party page (ingatlan.com) and has no auth
// on /api/ingatlan/health -- binding anywhere but the loopback interface would expose it to the
// LAN. 127.0.0.1 only, always.
export function startIngestServer(server: Server, port: number): Promise<number> {
  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(port, '127.0.0.1', () => {
      const addr = server.address()
      resolve(typeof addr === 'object' && addr ? addr.port : port)
    })
  })
}
