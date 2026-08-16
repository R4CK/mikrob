// Card 787e5f62: only app.js and style.css got ?v=mtime-size cache-busting in the served
// index.html -- the 40+ modular /app-<slice>.js files this modularisation epic produced were
// wired in as plain, unversioned `<script src="/app-x.js">` tags. A browser could keep an old
// slice cached past a deploy while fetching a fresh app.js, mixing versions that no longer agree
// (Peti's live incident, 2026-08-16: blanket 401s + a TypeError). This is the regression test for
// the fix: every /app-<slice>.js reference in the SERVED (not source) index.html must carry its
// own ?v= token, derived from that file's own mtime+size, and the token must change when -- and
// ONLY when -- that specific file's content changes.
import { describe, it, expect, beforeEach } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { tryHandleStatic } from '../web/routes/static.js'
import type { RouteContext } from '../web/routes/types.js'

let webDir: string

function fakeRes(): {
  res: ServerResponse
  status: () => number | null
  body: () => string
  etag: () => string | undefined
} {
  let status: number | null = null
  let chunks = ''
  let sentEtag: string | undefined
  const res = {
    writeHead(code: number, headers?: Record<string, unknown>) {
      status = code
      const h = headers?.['ETag']
      if (typeof h === 'string') sentEtag = h
      return res
    },
    setHeader() { return res },
    getHeader() { return undefined },
    end(chunk?: string) { if (chunk) chunks += chunk; return res },
    write(chunk?: string) { if (chunk) chunks += chunk; return true },
    on() { return res },
    once() { return res },
    emit() { return false },
  } as unknown as ServerResponse
  return { res, status: () => status, body: () => chunks, etag: () => sentEtag }
}

function ctxFor(path: string, headers: Record<string, string> = {}): {
  ctx: RouteContext
  status: () => number | null
  body: () => string
  etag: () => string | undefined
} {
  const { res, status, body, etag } = fakeRes()
  const req = { headers, method: 'GET', url: path, on() { return req }, once() { return req } } as unknown as IncomingMessage
  return { ctx: { req, res, path, method: 'GET', url: new URL('http://localhost/') } as RouteContext, status, body, etag }
}

/** Mirrors static.ts's own private assetVersion() so the test can predict the expected token
 *  without depending on an internal export. */
function expectedVersion(fileName: string): string {
  const s = statSync(join(webDir, fileName))
  return `${s.mtimeMs.toString(36)}-${s.size.toString(36)}`
}

const MINIMAL_INDEX_HTML = `<!doctype html>
<html>
<head>
<title>x</title>
<meta name="apple-mobile-web-app-title" content="x">
</head>
<body>
<span class="mobile-topbar-title" id="mobileTopbarTitle">x</span>
<div class="sidebar-brand-name" id="sidebarBrandName">x</div>
<link rel="stylesheet" href="/style.css">
<script src="/app-memories.js"></script>
<script src="/app-theme-lang.js"></script>
<script src="/app.js"></script>
</body>
</html>
`

beforeEach(() => {
  webDir = mkdtempSync(join(tmpdir(), 'index-html-cache-busting-'))
  mkdirSync(webDir, { recursive: true })
  writeFileSync(join(webDir, 'index.html'), MINIMAL_INDEX_HTML)
  writeFileSync(join(webDir, 'app.js'), 'console.log("core")\n')
  writeFileSync(join(webDir, 'style.css'), 'body{}\n')
  writeFileSync(join(webDir, 'app-memories.js'), 'console.log("memories v1")\n')
  writeFileSync(join(webDir, 'app-theme-lang.js'), 'console.log("theme v1")\n')
})

describe('index.html cache-busts every /app-<slice>.js reference, not just app.js/style.css (card 787e5f62)', () => {
  it('every slice script tag carries its own ?v= token matching that file\'s mtime+size', async () => {
    const { ctx, status, body } = ctxFor('/')
    expect(await tryHandleStatic(ctx, webDir)).toBe(true)
    expect(status()).toBe(200)
    const html = body()
    expect(html).toContain(`/app-memories.js?v=${expectedVersion('app-memories.js')}`)
    expect(html).toContain(`/app-theme-lang.js?v=${expectedVersion('app-theme-lang.js')}`)
    // app.js/style.css keep working exactly as before -- not a regression.
    expect(html).toContain(`/app.js?v=${expectedVersion('app.js')}`)
    expect(html).toContain(`/style.css?v=${expectedVersion('style.css')}`)
  })

  it('changing ONE slice changes ONLY its own token, not its sibling\'s', async () => {
    const before = ctxFor('/')
    await tryHandleStatic(before.ctx, webDir)
    const htmlBefore = before.body()
    const themeLangTokenBefore = /app-theme-lang\.js\?v=([^"]+)"/.exec(htmlBefore)?.[1]

    writeFileSync(join(webDir, 'app-memories.js'), 'console.log("memories v2 -- changed")\n')

    const after = ctxFor('/')
    await tryHandleStatic(after.ctx, webDir)
    const htmlAfter = after.body()
    expect(htmlAfter).toContain(`/app-memories.js?v=${expectedVersion('app-memories.js')}`)
    expect(htmlAfter).not.toContain(htmlBefore.match(/app-memories\.js\?v=([^"]+)"/)?.[0] ?? '\0unreachable')
    // The untouched sibling's token is unchanged.
    expect(/app-theme-lang\.js\?v=([^"]+)"/.exec(htmlAfter)?.[1]).toBe(themeLangTokenBefore)
  })

  it('the SAME etag round-trips to a real 304 when nothing changed', async () => {
    const first = ctxFor('/')
    await tryHandleStatic(first.ctx, webDir)
    const etag = first.etag()
    expect(etag).toBeTruthy()

    const second = ctxFor('/', { 'if-none-match': etag! })
    await tryHandleStatic(second.ctx, webDir)
    expect(second.status()).toBe(304)
  })

  it('a changed slice invalidates the index ETag, so a client cannot 304 onto a stale reference', async () => {
    const first = ctxFor('/')
    await tryHandleStatic(first.ctx, webDir)
    const staleEtag = first.etag()
    expect(staleEtag).toBeTruthy()

    writeFileSync(join(webDir, 'app-memories.js'), 'console.log("memories v2 -- changed")\n')

    const second = ctxFor('/', { 'if-none-match': staleEtag! })
    await tryHandleStatic(second.ctx, webDir)
    // Before this card, the index ETag only tracked app.js/style.css -- a slice-only change would
    // have kept matching the stale If-None-Match and served a 304, leaving the client's cached
    // index.html (and its now-outdated slice references) in place indefinitely.
    expect(second.status()).toBe(200)
    expect(second.etag()).not.toBe(staleEtag)
  })
})
