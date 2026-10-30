// Session-auth client for the local freellmapi instance (card 08d1aa90).
// Logs in with the admin credential read from a 0600 file, caches the
// session Bearer token in memory, and re-logs-in once on a 401.
//
// SECURITY:
// - Credential file: 0600 perms, read lazily on first use, never logged
// - Session token: kept in memory only, never logged, never returned to a caller
// - freellmapi is reached on 127.0.0.1 only
import { readFileSync } from 'node:fs'
import { logger } from '../logger.js'

export const FREELLMAPI_BASE_URL = process.env.FREELLMAPI_BASE_URL || 'http://127.0.0.1:3001'
export const FREELLMAPI_ADMIN_CREDENTIAL_FILE =
  process.env.FREELLMAPI_ADMIN_CREDENTIAL_FILE || '/home/neon/.config/freellmapi/admin'

// RedHat NO-GO 25444 F2: FREELLMAPI_BASE_URL was read from the environment with no
// check that it stays loopback -- anything that can redirect it (the service unit,
// or a .env file) could make this client POST the admin credential and every
// submitted key to an arbitrary host. Compute the check once at module load and
// refuse to ever send a request when it fails, before any fetch/login happens.
function isLoopbackUrl(urlString: string): boolean {
  try {
    const { hostname } = new URL(urlString)
    return hostname === '127.0.0.1' || hostname === 'localhost' || hostname === '::1' || hostname === '[::1]'
  } catch {
    return false
  }
}
const FREELLMAPI_BASE_URL_IS_LOOPBACK = isLoopbackUrl(FREELLMAPI_BASE_URL)

export class FreellmapiUnavailableError extends Error {}
export class FreellmapiUpstreamError extends Error {
  constructor(message: string, readonly status: number) {
    super(message)
    this.name = 'FreellmapiUpstreamError'
  }
}

interface Credential { email: string; password: string }

// Parses "email:password" (one line, no trailing/surrounding whitespace kept).
// Never throws a message that echoes the file's content.
function readCredential(filePath: string): Credential {
  let raw: string
  try {
    raw = readFileSync(filePath, 'utf-8')
  } catch {
    throw new FreellmapiUnavailableError(`freellmapi admin credential file is not readable: ${filePath}`)
  }
  const line = raw.trim()
  const sep = line.indexOf(':')
  if (sep <= 0 || sep === line.length - 1) {
    throw new FreellmapiUnavailableError(`freellmapi admin credential file is malformed: ${filePath}`)
  }
  return { email: line.slice(0, sep), password: line.slice(sep + 1) }
}

let cachedToken: string | null = null

// WhiteHat2 GO 25458 L4 / LOW-4 (card 3c9c3a10): freellmapi locks the admin
// account out for 15 minutes after 5 bad logins. A 60s back-off still allowed
// 6 bad logins inside that 15-minute window (measured: 7 requests 60s apart ->
// 6 upstream logins), tripping the lockout. At 240s, at most 4 attempts land
// inside any 900s window (attempts at +0/+240/+480/+720, the 5th at +960 is
// outside it) -- comfortably under the 5-login threshold.
const LOGIN_FAILURE_BACKOFF_MS = 240_000
let loginFailureUntil: number | null = null

async function login(): Promise<string> {
  if (loginFailureUntil !== null && Date.now() < loginFailureUntil) {
    throw new FreellmapiUnavailableError('freellmapi admin login recently failed; backing off before retrying')
  }
  const { email, password } = readCredential(FREELLMAPI_ADMIN_CREDENTIAL_FILE)
  let res: Response
  try {
    res = await fetch(`${FREELLMAPI_BASE_URL}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password }),
      // WhiteHat2 GO 25458 LOW-3 (card 3c9c3a10): a redirect from whatever is
      // listening on the base URL was followed, re-sending the credential to the
      // redirect target. Never follow a redirect here.
      redirect: 'error',
    })
  } catch {
    // Never interpolate the caught error verbatim here: a connection-refused message can
    // include the target URL but never the credential, which never reaches
    // this catch (it is only used to build the request).
    logger.warn({ baseUrl: FREELLMAPI_BASE_URL }, 'freellmapi: login request failed (service unreachable)')
    throw new FreellmapiUnavailableError('freellmapi is not reachable')
  }
  if (!res.ok) {
    loginFailureUntil = Date.now() + LOGIN_FAILURE_BACKOFF_MS
    logger.error({ status: res.status }, 'freellmapi: admin login rejected')
    throw new FreellmapiUpstreamError('freellmapi admin login rejected', res.status)
  }
  loginFailureUntil = null
  const body = (await res.json()) as { token?: string }
  if (!body.token) throw new FreellmapiUpstreamError('freellmapi login response carried no token', 502)
  cachedToken = body.token
  return cachedToken
}

/**
 * Proxy one request to freellmapi with session auth. Logs in lazily on first
 * use and again, once, after a 401 (expired/invalidated session). The
 * response body is returned parsed; callers must not log it verbatim when it
 * could carry key material (upstream already masks on GET/list/add, per
 * routes/keys.ts).
 */
export async function freellmapiRequest(
  method: 'GET' | 'POST' | 'DELETE',
  path: string,
  body?: unknown,
): Promise<{ status: number; data: any }> {
  if (!FREELLMAPI_BASE_URL_IS_LOOPBACK) {
    logger.error({ baseUrl: FREELLMAPI_BASE_URL }, 'freellmapi: refusing a non-loopback base URL, fail-closed')
    throw new FreellmapiUnavailableError('freellmapi base URL must be loopback (127.0.0.1/localhost)')
  }
  const token = cachedToken ?? (await login())
  const doFetch = async (bearer: string) => {
    try {
      return await fetch(`${FREELLMAPI_BASE_URL}${path}`, {
        method,
        headers: {
          Authorization: `Bearer ${bearer}`,
          ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
        },
        body: body !== undefined ? JSON.stringify(body) : undefined,
        // WhiteHat2 GO 25458 LOW-3: same rationale as the login fetch above --
        // a redirect would re-send the submitted key body to whatever the
        // redirect target is.
        redirect: 'error',
      })
    } catch {
      throw new FreellmapiUnavailableError('freellmapi is not reachable')
    }
  }

  let res = await doFetch(token)
  if (res.status === 401) {
    cachedToken = null
    const fresh = await login()
    res = await doFetch(fresh)
  }
  const data = await res.json().catch(() => null)
  return { status: res.status, data }
}
