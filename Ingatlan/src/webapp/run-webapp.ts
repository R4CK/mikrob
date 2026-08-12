// Composition root for the local webapp (card 3d04350b/426da6c1). Wires the REAL
// google-auth-library OAuth2Client (which structurally satisfies OAuthClientPort) against the
// pure, fully-tested login/session/API logic built in this directory.
import { OAuth2Client } from 'google-auth-library'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { openDb } from '../db.js'
import { createWebappServer, startWebappServer } from './webapp-server.js'

const HERE = dirname(fileURLToPath(import.meta.url))
const DB_PATH = join(HERE, '..', '..', 'data', 'ingatlan.db')
const PORT = Number(process.env.INGATLAN_WEBAPP_PORT || 8788)

function requireEnv(name: string): string {
  const value = process.env[name]
  if (!value) {
    throw new Error(
      `${name} is not set. Create an OAuth 2.0 Client ID (Web application) in Google Cloud ` +
        `Console, set its redirect URI to http://127.0.0.1:${PORT}/auth/google/callback, and ` +
        `provide INGATLAN_GOOGLE_CLIENT_ID / INGATLAN_GOOGLE_CLIENT_SECRET / ` +
        `INGATLAN_ALLOWED_EMAIL via Ingatlan/.env (gitignored) or the environment.`,
    )
  }
  return value
}

async function main(): Promise<void> {
  const clientId = requireEnv('INGATLAN_GOOGLE_CLIENT_ID')
  const clientSecret = requireEnv('INGATLAN_GOOGLE_CLIENT_SECRET')
  const allowedEmail = requireEnv('INGATLAN_ALLOWED_EMAIL')
  const redirectUri = process.env.INGATLAN_OAUTH_REDIRECT_URI || `http://127.0.0.1:${PORT}/auth/google/callback`

  const oauthClient = new OAuth2Client(clientId, clientSecret, redirectUri)
  const db = openDb(DB_PATH)

  const server = createWebappServer({
    oauthClient,
    clientId,
    allowlist: [allowedEmail],
    db,
  })

  const actualPort = await startWebappServer(server, PORT)
  console.log(`[ingatlan] webapp listening on http://127.0.0.1:${actualPort}`)
  console.log(`[ingatlan] login at http://127.0.0.1:${actualPort}/login`)

  const shutdown = (): void => {
    server.close(() => {
      db.close()
      process.exit(0)
    })
  }
  process.on('SIGINT', shutdown)
  process.on('SIGTERM', shutdown)
}

main().catch((err) => {
  console.error('[ingatlan] fatal:', err instanceof Error ? err.message : err)
  process.exitCode = 1
})
