// Card bac41395 (Cybered finding 9bf6a1e0/13169): the dashboard had no CSP at all -- neither a
// meta tag nor a server header. Two things to pin: the directive string itself stays strict where
// it matters (script-src has NO 'unsafe-inline'/'unsafe-eval'), and the header is actually wired
// into every response, not just defined and forgotten.
import { describe, it, expect } from 'vitest'
import { readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { CONTENT_SECURITY_POLICY } from '../web/csp.js'

const ROOT = join(import.meta.dirname, '..', '..')

describe('CONTENT_SECURITY_POLICY', () => {
  it('is a single semicolon-joined directive string with no trailing semicolon', () => {
    expect(CONTENT_SECURITY_POLICY).not.toMatch(/;\s*$/)
    expect(CONTENT_SECURITY_POLICY.split('; ').length).toBeGreaterThan(5)
  })

  it('script-src has no unsafe-inline/unsafe-eval -- the directive that actually stops XSS', () => {
    const scriptSrc = CONTENT_SECURITY_POLICY.split('; ').find((d) => d.startsWith('script-src'))
    expect(scriptSrc).toBeDefined()
    expect(scriptSrc).not.toContain('unsafe-inline')
    expect(scriptSrc).not.toContain('unsafe-eval')
    expect(scriptSrc).not.toContain("'none'") // must allow at least self
  })

  it('allows the jsDelivr CDN the dashboard actually loads xterm/qrcode-generator from', () => {
    const scriptSrc = CONTENT_SECURITY_POLICY.split('; ').find((d) => d.startsWith('script-src'))
    const styleSrc = CONTENT_SECURITY_POLICY.split('; ').find((d) => d.startsWith('style-src'))
    expect(scriptSrc).toContain('https://cdn.jsdelivr.net')
    expect(styleSrc).toContain('https://cdn.jsdelivr.net')
  })

  it('blocks framing (frame-ancestors none) -- nothing in web/ uses an iframe', () => {
    expect(CONTENT_SECURITY_POLICY).toContain("frame-ancestors 'none'")
  })

  it('restricts object-src (no Flash/plugin-era embed vector)', () => {
    expect(CONTENT_SECURITY_POLICY).toContain("object-src 'none'")
  })

  // Structural check, not a live-server request: startWebServer() does heavy side-effecting boot
  // work (token creation, hook registration) that does not belong in this unit test. This asserts
  // the wiring exists in source instead -- the header is set unconditionally, before any route
  // can write its own response, so no path through the server skips it.
  it('src/web.ts sets the header on every response, before the CORS/route logic runs', () => {
    const src = readFileSync(join(ROOT, 'src', 'web.ts'), 'utf-8')
    const handlerStart = src.indexOf('const server = http.createServer(async (req, res) => {')
    expect(handlerStart).toBeGreaterThanOrEqual(0)
    const corsStart = src.indexOf("res.setHeader('Access-Control-Allow-Origin'", handlerStart)
    const cspCall = src.indexOf("res.setHeader('Content-Security-Policy'", handlerStart)
    expect(cspCall, 'Content-Security-Policy setHeader call not found in the request handler').toBeGreaterThanOrEqual(0)
    expect(cspCall, 'CSP header must be set before the CORS block, not after').toBeLessThan(corsStart)
  })

  it('the extracted service-worker-unregister script exists and is no longer inline in index.html', () => {
    // Card bac41395: the inline <script> in index.html was moved to an external file specifically
    // so script-src needs no CSP hash (a hash for inline content goes stale silently on edit).
    expect(existsSync(join(ROOT, 'web', 'sw-unregister.js'))).toBe(true)
    const html = readFileSync(join(ROOT, 'web', 'index.html'), 'utf-8')
    expect(html).toContain('<script src="/sw-unregister.js"></script>')
    expect(html).not.toMatch(/<script>\s*\/\/ Service worker intentionally DISABLED/)
  })
})
