// Card b68ddae8: backend for the Foderacio-oldal "Bejelentkezes Tailscale-lel" button
// (frontend already built + gated GO, card 9bf6a1e0). Wire contract negotiated with
// fron-ted directly on this card (comments 13143, 13179) -- v2, the one actually built:
//
//   POST /api/federation/tailscale/login
//     -> { status: 'connected' | 'needs_login', pollToken: string, loginUrl?: string }
//        pollToken ALWAYS present (both branches); loginUrl only on needs_login.
//        `status` is informational only ("should the UI show a login link"), not a
//        second control-flow branch -- the UI polls regardless.
//
//   GET /api/federation/tailscale/status?pollToken=...
//     -> { status: 'pending' | 'connected' | 'failed', systemId?, baseUrl?, error? }
//        The ONLY place systemId/baseUrl come from, on both branches.
//
// Four commitments made on this card before building (comment 13143, restated 13179),
// per Cybered's NO-GO-derived requirements on the frontend sibling (9bf6a1e0, msg 13169):
//   (a) auth: the existing dashboard-token gate, not the two federation-wire allowlist
//       routes -- MEASURED via isFederationWireEndpoint()'s exact-match list, not assumed.
//   (b) loginUrl is validated server-side (https + login.tailscale.com or *.tailscale.com)
//       BEFORE it ever reaches the wire -- the second layer behind the client validator
//       fron-ted already built and Cybered/QA/Cybersec exhaustively fuzzed.
//   (c) `error` never carries raw stderr -- only a closed errorCode enum.
//   (d) `tailscale serve` (never `--funnel`) -- tailnet-only, logged when enabled, with the
//       manual revoke path (`tailscale serve reset`) documented, not hidden behind a new
//       untested endpoint this card didn't ask for.
//
// A step-up mechanism BEYOND the standard dashboard-token gate (Cybered also asked for
// this) was deliberately NOT added: the frontend was built and already GO'd against a
// bare POST with no extra confirmation header, and every other privileged federation
// write (POST /enabled, /routing-mode, /peers) uses the same bare dashboard-token model.
// Adding one here alone would break the shipped UI without raising the bar anywhere else.
// Left for Cybered's gate call: accept as consistent with existing precedent, or open a
// coordinated FE+BE follow-up that adds real step-up across all of them.
import { randomBytes } from 'node:crypto'
import { spawn } from 'node:child_process'
import { execFileAsync } from '../exec-async.js'
import { logger } from '../../logger.js'
import { WEB_PORT } from '../../config.js'
import { getFederationConfig } from './config.js'

// Resolved per-call, not frozen at module load, so a test can override it via
// process.env.TAILSCALE_BIN without needing module-reset gymnastics.
function tailscaleBin(): string {
  return process.env.TAILSCALE_BIN ?? 'tailscale'
}
const POLL_TOKEN_TTL_MS = 10 * 60 * 1000
const STATUS_TIMEOUT_MS = 5_000
const SERVE_TIMEOUT_MS = 10_000
// How long we wait for `tailscale up` to print the login URL before responding to the
// POST without one (the UI still gets a pollToken and can proceed; contract makes
// loginUrl optional for exactly this reason). The child itself keeps running past this.
const UP_WAIT_FOR_URL_MS = 10_000
// Passed as `tailscale up --timeout=`, bounding how long the CLI itself waits for the
// user to complete the browser auth before giving up (tailscale's own default is
// "block forever", which would leak a child process on an abandoned login).
const UP_BUDGET = '10m'

export type TailscaleLoginErrorCode =
  | 'not_installed'
  | 'status_check_failed'
  | 'up_timeout'
  | 'invalid_login_url'
  | 'serve_failed'
  | 'unknown'

interface PollEntry {
  status: 'pending' | 'connected' | 'failed'
  baseUrl: string | null
  error: TailscaleLoginErrorCode | null
  createdAt: number
}

const pollState = new Map<string, PollEntry>()
let inFlightToken: string | null = null
let inFlightLoginUrl: string | null = null

function newToken(): string {
  return randomBytes(24).toString('base64url')
}

function pruneExpired(now = Date.now()): void {
  for (const [token, entry] of pollState) {
    if (now - entry.createdAt > POLL_TOKEN_TTL_MS) pollState.delete(token)
  }
}

/**
 * Server-side mirror of fron-ted's `fedTailscaleValidLoginUrl` (web/app.js, card 9bf6a1e0) --
 * identical predicate, deliberately: Cybered/QA already fuzzed this exact check against 18
 * bypass classes (userinfo confusion, subdomain-suffix confusion, punycode homograph, port
 * smuggling, trailing dot, protocol-relative). Keep the two in lockstep; do not diverge.
 */
export function isValidTailscaleLoginUrl(raw: string): boolean {
  let u: URL
  try {
    u = new URL(raw)
  } catch {
    return false
  }
  return u.protocol === 'https:' && (u.hostname === 'login.tailscale.com' || u.hostname.endsWith('.tailscale.com'))
}

/**
 * Parses `tailscale serve status --json` for the Web handler proxying OUR port. Real shape
 * observed on a live host (`tailscale 1.102.2`):
 *   { "Web": { "<host>:443": { "Handlers": { "/": { "Proxy": "http://127.0.0.1:3420" } } } } }
 */
export function extractServeBaseUrl(json: string, port: number): string | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(json)
  } catch {
    return null
  }
  if (typeof parsed !== 'object' || parsed === null) return null
  const web = (parsed as Record<string, unknown>).Web
  if (typeof web !== 'object' || web === null) return null
  const wantProxy = `http://127.0.0.1:${port}`
  for (const [hostPort, entry] of Object.entries(web as Record<string, unknown>)) {
    if (typeof entry !== 'object' || entry === null) continue
    const handlers = (entry as Record<string, unknown>).Handlers
    if (typeof handlers !== 'object' || handlers === null) continue
    const root = (handlers as Record<string, unknown>)['/']
    if (typeof root !== 'object' || root === null) continue
    if ((root as Record<string, unknown>).Proxy === wantProxy) {
      return `https://${hostPort.replace(/:\d+$/, '')}/`
    }
  }
  return null
}

async function readBackendRunning(): Promise<{ running: boolean } | { error: TailscaleLoginErrorCode }> {
  const r = await execFileAsync(tailscaleBin(), ['status', '--json'], { timeoutMs: STATUS_TIMEOUT_MS })
  if (r.status === null) return { error: r.timedOut ? 'status_check_failed' : 'not_installed' }
  if (r.status !== 0) return { error: 'status_check_failed' }
  try {
    const parsed = JSON.parse(r.stdout) as { BackendState?: unknown }
    return { running: parsed.BackendState === 'Running' }
  } catch {
    return { error: 'status_check_failed' }
  }
}

async function ensureServeEnabled(): Promise<{ baseUrl: string } | { error: TailscaleLoginErrorCode }> {
  const readOnce = () => execFileAsync(tailscaleBin(), ['serve', 'status', '--json'], { timeoutMs: SERVE_TIMEOUT_MS })
  const first = await readOnce()
  if (first.status === 0) {
    const existing = extractServeBaseUrl(first.stdout, WEB_PORT)
    if (existing) return { baseUrl: existing }
  }
  // Not yet configured for our port -- enable it. `serve` ONLY, never `funnel`: tailnet-only,
  // never public (Cybersec requirement, card 9bf6a1e0/b68ddae8).
  const enable = await execFileAsync(tailscaleBin(), ['serve', '--bg', String(WEB_PORT)], { timeoutMs: SERVE_TIMEOUT_MS })
  if (enable.status !== 0) return { error: 'serve_failed' }
  logger.warn(
    { fed: true, tailscaleServe: true, port: WEB_PORT },
    'federation: tailscale serve enabled -- dashboard now reachable on the tailnet (revoke: tailscale serve reset)',
  )
  const after = await readOnce()
  if (after.status !== 0) return { error: 'serve_failed' }
  const baseUrl = extractServeBaseUrl(after.stdout, WEB_PORT)
  return baseUrl ? { baseUrl } : { error: 'serve_failed' }
}

async function finishAfterConnected(token: string): Promise<void> {
  const result = await ensureServeEnabled()
  const entry = pollState.get(token)
  if (!entry) return // expired/pruned while serve was being checked
  if ('error' in result) {
    pollState.set(token, { ...entry, status: 'failed', error: result.error })
  } else {
    pollState.set(token, { ...entry, status: 'connected', baseUrl: result.baseUrl, error: null })
  }
}

/**
 * Streams `tailscale up`'s output for the login URL WITHOUT waiting for the command to
 * finish (it blocks until the user completes browser auth, or --timeout elapses). Resolves
 * once a URL line appears or UP_WAIT_FOR_URL_MS elapses, whichever first; the child keeps
 * running in the background regardless, and its eventual exit updates pollState.
 */
function startTailscaleUp(token: string): Promise<{ loginUrl: string | null }> {
  return new Promise((resolveEarly) => {
    let settledEarly = false
    let child: ReturnType<typeof spawn>
    try {
      child = spawn(tailscaleBin(), ['up', `--timeout=${UP_BUDGET}`], { stdio: ['ignore', 'pipe', 'pipe'] })
    } catch {
      pollState.set(token, { status: 'failed', baseUrl: null, error: 'not_installed', createdAt: Date.now() })
      resolveEarly({ loginUrl: null })
      return
    }

    let buf = ''
    const urlRe = /(https:\/\/\S+)/
    const settleWithUrl = (rawUrl: string) => {
      settledEarly = true
      clearTimeout(earlyTimer)
      const url = rawUrl.trim()
      if (isValidTailscaleLoginUrl(url)) {
        resolveEarly({ loginUrl: url })
      } else {
        pollState.set(token, { status: 'failed', baseUrl: null, error: 'invalid_login_url', createdAt: Date.now() })
        resolveEarly({ loginUrl: null })
      }
    }
    const tryExtract = (chunk: string) => {
      if (settledEarly) return
      buf += chunk
      const m = urlRe.exec(buf)
      if (m) settleWithUrl(m[1])
    }
    child.stdout?.setEncoding('utf-8')
    child.stderr?.setEncoding('utf-8')
    child.stdout?.on('data', tryExtract)
    child.stderr?.on('data', tryExtract)

    const earlyTimer = setTimeout(() => {
      if (!settledEarly) {
        settledEarly = true
        resolveEarly({ loginUrl: null })
      }
    }, UP_WAIT_FOR_URL_MS)
    earlyTimer.unref?.()

    child.on('error', () => {
      inFlightToken = null
      inFlightLoginUrl = null
      pollState.set(token, { status: 'failed', baseUrl: null, error: 'not_installed', createdAt: Date.now() })
      if (!settledEarly) {
        settledEarly = true
        clearTimeout(earlyTimer)
        resolveEarly({ loginUrl: null })
      }
    })
    child.on('exit', (code) => {
      inFlightToken = null
      inFlightLoginUrl = null
      // No point holding the caller open for the rest of UP_WAIT_FOR_URL_MS once the child
      // has already exited without ever printing a URL -- there is nothing left to wait for.
      if (!settledEarly) {
        settledEarly = true
        clearTimeout(earlyTimer)
        resolveEarly({ loginUrl: null })
      }
      const entry = pollState.get(token)
      if (!entry || entry.status !== 'pending') return // already resolved (e.g. invalid_login_url)
      if (code !== 0) {
        pollState.set(token, { ...entry, status: 'failed', error: 'up_timeout' })
        return
      }
      void finishAfterConnected(token)
    })
  })
}

export interface StartLoginResult {
  status: 'connected' | 'needs_login'
  pollToken: string
  loginUrl?: string
}

export async function startTailscaleLogin(): Promise<StartLoginResult | { error: TailscaleLoginErrorCode }> {
  pruneExpired()

  // Single-flight: a concurrent POST while a login is already running attaches to the SAME
  // attempt instead of spawning a second `tailscale up`/`serve --bg`. The lock is claimed
  // HERE, synchronously, before the first `await` below -- claiming it only after checking
  // `tailscale status` would leave a race window (two concurrent calls both pass the "is
  // anything in flight" check before either sets the lock) exactly as wide as that await.
  if (inFlightToken && pollState.has(inFlightToken)) {
    return {
      status: 'needs_login',
      pollToken: inFlightToken,
      ...(inFlightLoginUrl ? { loginUrl: inFlightLoginUrl } : {}),
    }
  }
  const token = newToken()
  inFlightToken = token
  pollState.set(token, { status: 'pending', baseUrl: null, error: null, createdAt: Date.now() })

  const backend = await readBackendRunning()
  if ('error' in backend) {
    if (inFlightToken === token) inFlightToken = null
    pollState.delete(token)
    return backend
  }

  if (backend.running) {
    inFlightToken = null // no `tailscale up` in flight for this branch -- nothing left to guard
    void finishAfterConnected(token)
    return { status: 'connected', pollToken: token }
  }

  const { loginUrl } = await startTailscaleUp(token)
  inFlightLoginUrl = loginUrl
  return { status: 'needs_login', pollToken: token, ...(loginUrl ? { loginUrl } : {}) }
}

export interface LoginStatusResult {
  status: 'pending' | 'connected' | 'failed'
  systemId?: string
  baseUrl?: string
  error?: TailscaleLoginErrorCode
}

export function getTailscaleLoginStatus(pollToken: string): LoginStatusResult {
  pruneExpired()
  const entry = pollState.get(pollToken)
  if (!entry) return { status: 'failed', error: 'unknown' }
  if (entry.status === 'connected') {
    return { status: 'connected', systemId: getFederationConfig().systemId, baseUrl: entry.baseUrl ?? undefined }
  }
  if (entry.status === 'failed') {
    return { status: 'failed', error: entry.error ?? 'unknown' }
  }
  return { status: 'pending' }
}

/** Test-only: reset module state between test cases (the maps/locks are process-lifetime). */
export function _resetTailscaleLoginStateForTests(): void {
  pollState.clear()
  inFlightToken = null
  inFlightLoginUrl = null
}
