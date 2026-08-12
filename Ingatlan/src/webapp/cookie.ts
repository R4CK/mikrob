// Minimal cookie parse/serialize -- this app has exactly ONE cookie (the session id), so a full
// cookie-parsing dependency is not warranted here (simplicity first).
export function parseCookies(header: string | undefined | null): Record<string, string> {
  const cookies: Record<string, string> = {}
  if (!header) return cookies
  for (const part of header.split(';')) {
    const eq = part.indexOf('=')
    if (eq === -1) continue
    const key = part.slice(0, eq).trim()
    const value = part.slice(eq + 1).trim()
    if (key) cookies[key] = decodeURIComponent(value)
  }
  return cookies
}

export interface CookieOptions {
  maxAgeSeconds?: number
  sameSite?: 'Strict' | 'Lax' | 'None'
}

// No `Secure` attribute: this app is plain-HTTP localhost-only by design (card 3d04350b --
// "Nincs kulso publikus felulet, csak localhost"), and a Secure cookie is never sent back to the
// server over plain HTTP, which would silently break login. HttpOnly is always set (the session
// id must never be readable from page JS -- there is no legitimate reason for the SPA to read
// it, only to have it sent automatically on each request).
export function serializeCookie(name: string, value: string, opts: CookieOptions = {}): string {
  const parts = [`${name}=${encodeURIComponent(value)}`, 'Path=/', 'HttpOnly', `SameSite=${opts.sameSite ?? 'Lax'}`]
  if (opts.maxAgeSeconds !== undefined) parts.push(`Max-Age=${Math.floor(opts.maxAgeSeconds)}`)
  return parts.join('; ')
}

// A Max-Age=0 cookie with the same name/path/attributes clears it in every browser.
export function clearCookie(name: string): string {
  return `${name}=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax`
}
