import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { createServer, type Server } from 'node:http'
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, basename } from 'node:path'
import { createStaticFileServer } from '../webapp/static-server.js'

describe('createStaticFileServer (real HTTP, real filesystem)', () => {
  let dir: string
  let server: Server
  let baseUrl: string

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'static-server-'))
    writeFileSync(join(dir, 'index.html'), '<html>index</html>')
    mkdirSync(join(dir, 'assets'))
    writeFileSync(join(dir, 'assets', 'app.js'), 'console.log(1)')
    writeFileSync(join(dir, 'assets', 'app.css'), 'body{color:red}')
    const handler = createStaticFileServer(dir)
    server = createServer(handler)
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const addr = server.address()
    baseUrl = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`
  })
  afterEach(async () => {
    await new Promise((resolve) => server.close(resolve))
    rmSync(dir, { recursive: true, force: true })
  })

  it('serves index.html for the root path', async () => {
    const res = await fetch(`${baseUrl}/`)
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toContain('text/html')
    expect(await res.text()).toBe('<html>index</html>')
  })

  it('serves a nested asset with the correct MIME type', async () => {
    const res = await fetch(`${baseUrl}/assets/app.js`)
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toContain('application/javascript')
    expect(await res.text()).toBe('console.log(1)')
  })

  it('serves CSS with the correct MIME type', async () => {
    const res = await fetch(`${baseUrl}/assets/app.css`)
    expect(res.headers.get('content-type')).toContain('text/css')
  })

  it('SPA fallback: an unknown client-side route also gets index.html, not a 404', async () => {
    const res = await fetch(`${baseUrl}/hirdetesek/some-listing`)
    expect(res.status).toBe(200)
    expect(await res.text()).toBe('<html>index</html>')
  })

  it('SECURITY: a path-traversal attempt cannot escape the root directory', async () => {
    // A real, live attack shape: request a file OUTSIDE dir via ../ segments. Node's own URL
    // parser normalizes some of these before this handler ever sees req.url, so this is checked
    // at the ACTUAL http layer, not by calling the handler function directly with a pre-crafted
    // string (which would prove the guard exists but not that it survives real request parsing).
    const outsideFile = join(dir, '..', 'outside-secret.txt')
    writeFileSync(outsideFile, 'should never be served')
    try {
      const res = await fetch(`${baseUrl}/../${basename(outsideFile)}`)
      // Either the traversal is rejected (403) or the browser/fetch-level URL normalization
      // already resolved it back to a root-relative path, which then correctly SPA-falls-back
      // to index.html -- both are safe outcomes; the ONLY unsafe outcome is serving the secret
      // file's actual content.
      const body = await res.text()
      expect(body).not.toBe('should never be served')
    } finally {
      rmSync(outsideFile, { force: true })
    }
  })

  it('SECURITY: an encoded path-traversal attempt (%2e%2e) is also rejected', async () => {
    const res = await fetch(`${baseUrl}/assets/%2e%2e/%2e%2e/etc/passwd`)
    const body = await res.text()
    expect(body).not.toContain('root:')
    expect([200, 403, 404]).toContain(res.status)
  })

  it('a 404 when the root directory has no index.html at all (frontend not built)', async () => {
    const emptyDir = mkdtempSync(join(tmpdir(), 'static-server-empty-'))
    const emptyHandler = createStaticFileServer(emptyDir)
    const emptyServer = createServer(emptyHandler)
    await new Promise<void>((resolve) => emptyServer.listen(0, '127.0.0.1', resolve))
    const addr = emptyServer.address()
    const emptyBaseUrl = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`
    try {
      const res = await fetch(`${emptyBaseUrl}/`)
      expect(res.status).toBe(404)
    } finally {
      await new Promise((resolve) => emptyServer.close(resolve))
      rmSync(emptyDir, { recursive: true, force: true })
    }
  })
})
