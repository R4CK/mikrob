// The whole dashboard shipped broken (Peti's own browser-console screenshot, card c4bbea06):
// index.html grew a `<script src="/app-<slice>.js">` tag for every modularised slice, but
// tryHandleStatic's allowlist never grew a matching rule -- every /app-*.js request 404'd, so NONE
// of the 27+ modular slices ever loaded, no matter how correct their JS content was. The vitest
// suite (direct source import) never caught this because it never went through the actual HTTP
// static-file router.
//
// Mirrors static-asset-shape-allowlist.test.ts's own discipline: call tryHandleStatic directly with
// a RAW, unnormalised path (going through the real HTTP server would prove nothing -- web.ts
// normalises first, so a traversal case would 404 with or without a shape check of its own).
import { describe, it, expect, beforeAll } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, readdirSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { tryHandleStatic } from '../web/routes/static.js'
import type { RouteContext } from '../web/routes/types.js'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
let webDir: string

function fakeRes(): { res: ServerResponse; status: () => number | null } {
  let status: number | null = null
  const res = {
    writeHead(code: number) { status = code; return res },
    setHeader() { return res },
    getHeader() { return undefined },
    end() { return res },
    write() { return true },
    on() { return res },
    once() { return res },
    emit() { return false },
  } as unknown as ServerResponse
  return { res, status: () => status }
}

function ctxFor(path: string): { ctx: RouteContext; status: () => number | null } {
  const { res, status } = fakeRes()
  const req = { headers: {}, method: 'GET', url: path, on() { return req }, once() { return req } } as unknown as IncomingMessage
  return { ctx: { req, res, path, method: 'GET', url: new URL('http://localhost/') } as RouteContext, status }
}

beforeAll(() => {
  const sandbox = mkdtempSync(join(tmpdir(), 'app-slice-static-'))
  writeFileSync(join(sandbox, 'secret-outside.js'), 'window.secret = true\n')
  webDir = join(sandbox, 'web')
  mkdirSync(webDir, { recursive: true })
  writeFileSync(join(webDir, 'app.js'), 'console.log("core")\n')
  writeFileSync(join(webDir, 'app-memories.js'), 'console.log("slice")\n')
})

describe('/app-*.js modular slices are served (card c4bbea06)', () => {
  it('POSITIVE: a real slice is served, not 404', async () => {
    const { ctx, status } = ctxFor('/app-memories.js')
    expect(await tryHandleStatic(ctx, webDir)).toBe(true)
    expect(status()).not.toBe(404)
  })

  it('the literal /app.js route is unaffected -- still handled by its own, earlier rule', async () => {
    const { ctx, status } = ctxFor('/app.js')
    expect(await tryHandleStatic(ctx, webDir)).toBe(true)
    expect(status()).not.toBe(404)
  })

  it('NEGATIVE: a slice that does not exist on disk is refused, not silently served', async () => {
    const { ctx, status } = ctxFor('/app-does-not-exist.js')
    expect(await tryHandleStatic(ctx, webDir)).toBe(true)
    expect(status()).toBe(404)
  })

  it('NEGATIVE: raw traversal is refused by the rule itself, not by the caller', async () => {
    for (const p of [
      '/app-../secret-outside.js',
      '/app-..%2fsecret-outside.js',
      '/app-%2e%2e%2fsecret-outside.js',
      '/app-sub/dir.js',
      '/app-.js', // empty name part
    ]) {
      const { ctx, status } = ctxFor(p)
      expect(await tryHandleStatic(ctx, webDir), p).toBe(true)
      expect(status(), p).toBe(404)
    }
  })

  it('NEGATIVE: only .js is served -- an unlisted extension is refused even if the file exists', async () => {
    writeFileSync(join(webDir, 'app-notes.txt'), 'hello')
    const { ctx, status } = ctxFor('/app-notes.txt')
    expect(await tryHandleStatic(ctx, webDir)).toBe(true)
    expect(status()).toBe(404)
  })

  it('every /app-*.js slice that actually ships in web/ is served -- reproduces the real incident against the real files', async () => {
    // This is the assertion that would have caught card c4bbea06 directly: every file matching the
    // shipped naming convention must come back non-404 through the real router, not just through a
    // direct source import of the handler module.
    const unexpectedly404: string[] = []
    for (const name of readdirSync(join(ROOT, 'web'))) {
      if (!/^app-[a-z0-9-]+\.js$/.test(name)) continue
      const { ctx, status } = ctxFor(`/${name}`)
      expect(await tryHandleStatic(ctx, join(ROOT, 'web')), name).toBe(true)
      if (status() === 404) unexpectedly404.push(name)
    }
    expect(unexpectedly404.length, 'at least one real app-*.js slice must exist for this test to mean anything').toBe(0)
    expect(readdirSync(join(ROOT, 'web')).filter((n) => /^app-[a-z0-9-]+\.js$/.test(n)).length).toBeGreaterThan(0)
  })

  it('does NOT admit an html body under the /app- prefix (same posture as /fork- and /avatars/, card 58ee30fd)', async () => {
    writeFileSync(join(webDir, 'app-evil.html'), '<html></html>')
    const { ctx, status } = ctxFor('/app-evil.html')
    expect(await tryHandleStatic(ctx, webDir)).toBe(true)
    expect(status()).toBe(404)
  })
})
