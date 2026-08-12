// Composition root for the local ingest server (card 3f6bcc41). Peti runs this, then loads the
// browser extension and pastes the printed token into its options page ONCE.
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { mkdirSync, writeFileSync } from 'node:fs'
import { openDb } from './db.js'
import { ensureIngestToken } from './ingest-token.js'
import { createIngestServer, startIngestServer } from './ingest-server.js'

const HERE = dirname(fileURLToPath(import.meta.url))
const DATA_DIR = join(HERE, '..', 'data')
const DB_PATH = join(DATA_DIR, 'ingatlan.db')
const TOKEN_PATH = join(DATA_DIR, '.ingest-token')
const DEBUG_DIR = join(DATA_DIR, 'debug-captures')
const PORT = Number(process.env.INGATLAN_INGEST_PORT || 8787)

// The content script cannot know the real page structure in advance (Cloudflare blocks any
// pre-fetch we could inspect it with -- see README "Blokkolt"). When it finds nothing, it POSTs a
// diagnostic snapshot here instead of silently doing nothing, so the extraction logic can be
// fixed in one iteration against a REAL capture rather than guessed again.
function saveDebugCapture(payload: unknown): void {
  mkdirSync(DEBUG_DIR, { recursive: true })
  const path = join(DEBUG_DIR, `${Date.now()}.json`)
  writeFileSync(path, JSON.stringify(payload, null, 2))
  console.log(`[ingatlan] debug capture saved: ${path}`)
}

function main(): void {
  const db = openDb(DB_PATH)
  const token = ensureIngestToken(TOKEN_PATH)
  const server = createIngestServer({ token, db, onDebugCapture: saveDebugCapture })

  startIngestServer(server, PORT)
    .then((actualPort) => {
      console.log(`[ingatlan] ingest server listening on http://127.0.0.1:${actualPort}`)
      console.log(`[ingatlan] extension token (paste into the extension's options page): ${token}`)
    })
    .catch((err) => {
      console.error('[ingatlan] failed to start:', err instanceof Error ? err.message : err)
      process.exitCode = 1
    })

  const shutdown = (): void => {
    server.close(() => {
      db.close()
      process.exit(0)
    })
  }
  process.on('SIGINT', shutdown)
  process.on('SIGTERM', shutdown)
}

main()
