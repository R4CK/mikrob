import { createServer, type IncomingMessage, type ServerResponse, type Server } from 'node:http'
import type Database from 'better-sqlite3'
import { buildAuthUrl, exchangeCodeForProfile, OAuthExchangeError, type OAuthClientPort } from './oauth-flow.js'
import { isAllowedEmail } from './allowlist.js'
import { SessionStore } from './session-store.js'
import { StateStore } from './state-store.js'
import { parseCookies, serializeCookie, clearCookie } from './cookie.js'
import { handleApiRoute } from './api-routes.js'

const SESSION_COOKIE = 'ingatlan_session'
const DEFAULT_SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000 // 30 days -- a single-user local app

export interface WebappServerOptions {
  oauthClient: OAuthClientPort
  clientId: string
  allowlist: readonly string[]
  db: Database.Database
  sessionTtlMs?: number
  now?: () => number
  // Serves the SPA for any GET that reaches here already authenticated and unmatched by the API
  // routes below -- deliberately an injected hook, not a built-in static-file server: the
  // frontend (card 65e96a20) does not exist yet, and a real static-file server (path traversal,
  // content-type detection, caching headers) is its own scope, not this card's. Omit it and an
  // authenticated page request gets a plain 200 placeholder instead of 404 -- there is nothing
  // to 404 FROM, this app has no other page routes.
  serveDashboard?: (req: IncomingMessage, res: ServerResponse) => void
}

function send(res: ServerResponse, status: number, body: unknown, extraHeaders: Record<string, string> = {}): void {
  const text = JSON.stringify(body)
  res.writeHead(status, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(text), ...extraHeaders })
  res.end(text)
}

function redirect(res: ServerResponse, location: string, extraHeaders: Record<string, string> = {}): void {
  res.writeHead(302, { Location: location, ...extraHeaders })
  res.end()
}

export function createWebappServer(opts: WebappServerOptions): Server {
  const now = opts.now ?? Date.now
  const sessions = new SessionStore(opts.sessionTtlMs ?? DEFAULT_SESSION_TTL_MS, now)
  const states = new StateStore(10 * 60 * 1000, now)

  return createServer((req, res) => {
    void (async () => {
      const url = new URL(req.url ?? '/', 'http://localhost')
      const { pathname } = url
      const method = req.method ?? 'GET'
      const cookies = parseCookies(req.headers.cookie)
      const session = cookies[SESSION_COOKIE] ? sessions.get(cookies[SESSION_COOKIE]) : null

      if (method === 'GET' && pathname === '/login') {
        const state = states.issue()
        redirect(res, buildAuthUrl(opts.oauthClient, state))
        return
      }

      if (method === 'GET' && pathname === '/auth/google/callback') {
        const code = url.searchParams.get('code')
        const state = url.searchParams.get('state')
        if (!code || !state || !states.consume(state)) {
          send(res, 400, { error: 'invalid or expired login attempt -- please try logging in again' })
          return
        }
        try {
          const profile = await exchangeCodeForProfile(opts.oauthClient, code, opts.clientId)
          if (!profile.emailVerified || !isAllowedEmail(profile.email, opts.allowlist)) {
            send(res, 403, { error: 'this Google account is not authorized for this app' })
            return
          }
          const sessionId = sessions.create(profile.email)
          redirect(res, '/dashboard', {
            'Set-Cookie': serializeCookie(SESSION_COOKIE, sessionId, {
              maxAgeSeconds: (opts.sessionTtlMs ?? DEFAULT_SESSION_TTL_MS) / 1000,
            }),
          })
        } catch (err) {
          if (err instanceof OAuthExchangeError) {
            send(res, 400, { error: 'login failed -- please try again' })
            return
          }
          throw err
        }
        return
      }

      if (method === 'GET' && pathname === '/logout') {
        if (cookies[SESSION_COOKIE]) sessions.destroy(cookies[SESSION_COOKIE])
        redirect(res, '/login', { 'Set-Cookie': clearCookie(SESSION_COOKIE) })
        return
      }

      // Everything past this point requires a valid session -- both the API and the dashboard
      // page itself. An API path gets a JSON 401 (the SPA can react to it); anything else is
      // sent to /login, since a browser navigating here IS the login entry point.
      if (!session) {
        if (pathname.startsWith('/api/')) send(res, 401, { error: 'not authenticated' })
        else redirect(res, '/login')
        return
      }

      const apiResult = handleApiRoute(opts.db, method, pathname)
      if (apiResult) {
        send(res, apiResult.status, apiResult.body)
        return
      }

      if (method === 'GET' && opts.serveDashboard) {
        opts.serveDashboard(req, res)
        return
      }

      if (method === 'GET') {
        send(res, 200, { ok: true, note: 'authenticated -- dashboard frontend not wired yet (card 65e96a20)' })
        return
      }

      send(res, 404, { error: 'not found' })
    })().catch(() => {
      if (!res.headersSent) send(res, 500, { error: 'internal error' })
    })
  })
}

export function startWebappServer(server: Server, port: number): Promise<number> {
  return new Promise((resolve, reject) => {
    server.once('error', reject)
    // Same invariant as the ingest server: loopback-only, not configurable. This one carries a
    // real user session after Google login, which makes binding beyond 127.0.0.1 strictly worse
    // than the ingest server's already-strict stance.
    server.listen(port, '127.0.0.1', () => {
      const addr = server.address()
      resolve(typeof addr === 'object' && addr ? addr.port : port)
    })
  })
}
