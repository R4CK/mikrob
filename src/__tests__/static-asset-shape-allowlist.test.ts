// /avatars/ and /icons/ must validate the SHAPE of their path parameter themselves (card 6ed41c9d).
//
// Cybersec's finding on the 241532d8 gate: these two rules string-replaced the prefix and joined the
// rest onto webDir with no shape check, so their traversal protection came entirely from src/web.ts
// parsing the request with `new URL(...)` -- which resolves `..` and decodes `%2e` before a handler
// sees anything. Not exploitable today (measured: `/avatars/../../package.json` 404s over HTTP), but
// accidental: these routes are unauthenticated, and an innocuous refactor of web.ts would have made
// them traversable while /fork- and /lang/ stayed safe on their own validation.
//
// THESE TESTS CALL THE HANDLER DIRECTLY WITH A RAW, UNNORMALISED PATH. Going through the HTTP server
// would prove nothing: web.ts normalises first, so the traversal cases would 404 with or without the
// fix and the suite would be green on the unfixed code. That is the difference between testing the
// rule and testing the caller.
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

/** Minimal response double: records the status and whether a body was written. */
function fakeRes(): { res: ServerResponse; status: () => number | null; served: () => boolean } {
  let status: number | null = null
  let served = false
  const res = {
    writeHead(code: number) { status = code; return res },
    setHeader() { return res },
    getHeader() { return undefined },
    end(chunk?: unknown) { if (chunk !== undefined) served = true; return res },
    write() { served = true; return true },
    on() { return res },
    once() { return res },
    emit() { return false },
  } as unknown as ServerResponse
  return { res, status: () => status, served: () => served }
}

function ctxFor(path: string): { ctx: RouteContext; status: () => number | null } {
  const { res, status } = fakeRes()
  const req = { headers: {}, method: 'GET', url: path, on() { return req }, once() { return req } } as unknown as IncomingMessage
  // `url` is what web.ts WOULD have produced; the handler under test reads `path`, and the whole
  // point here is to hand it a path the URL parser would never have produced.
  return { ctx: { req, res, path, method: 'GET', url: new URL('http://localhost/') } as RouteContext, status }
}

beforeAll(() => {
  // A webDir of our own, with one legitimate asset per directory plus a file OUTSIDE it -- the thing
  // a traversal would reach. Using a temp tree rather than the repo's own web/ keeps the negative
  // cases honest: the target exists, so a 404 means the guard refused, not that the file was absent.
  const sandbox = mkdtempSync(join(tmpdir(), 'static-shape-'))
  writeFileSync(join(sandbox, 'secret-outside.json'), '{"reachable":false}\n')
  webDir = join(sandbox, 'web')
  mkdirSync(join(webDir, 'avatars'), { recursive: true })
  mkdirSync(join(webDir, 'icons'), { recursive: true })
  writeFileSync(join(webDir, 'avatars', '01_robot.png'), 'png-bytes')
  writeFileSync(join(webDir, 'avatars', 'gallery.html'), '<html></html>')
  writeFileSync(join(webDir, 'icons', 'icon-192.png'), 'png-bytes')
})

describe('/avatars/ and /icons/ validate their own path parameter (card 6ed41c9d)', () => {
  it('POSITIVE: a real asset is still served -- both routes', async () => {
    for (const p of ['/avatars/01_robot.png', '/icons/icon-192.png']) {
      const { ctx, status } = ctxFor(p)
      expect(await tryHandleStatic(ctx, webDir), p).toBe(true)
      expect(status(), p).not.toBe(404)
    }
  })

  it('NEGATIVE: html is NOT served, even from a name that is otherwise well-formed (card 58ee30fd)', async () => {
    // Cybersec's follow-up: these are unauth paths, and an HTML body from the dashboard's own origin
    // is a script surface the moment anything writes into web/avatars. Nothing does today (the avatar
    // upload writes into agents/<name>/), which is exactly why the narrowing is cheap now.
    const { ctx, status } = ctxFor('/avatars/gallery.html')
    expect(await tryHandleStatic(ctx, webDir)).toBe(true)
    expect(status()).toBe(404)
  })

  it('NEGATIVE: a raw traversal is refused by the rule itself, not by the caller', async () => {
    for (const p of [
      '/avatars/../../secret-outside.json',
      '/icons/../../secret-outside.json',
      '/avatars/../avatars/01_robot.png', // resolves back inside, still not a NAME
      '/icons/sub/dir/icon-192.png',
      '/avatars/..%2f..%2fsecret-outside.json', // percent-encoded, undecoded by any caller
      '/avatars/%2e%2e%2fsecret-outside.json',
      '/avatars/..\\..\\secret-outside.json',
      '/avatars/.',
      '/avatars/..',
    ]) {
      const { ctx, status } = ctxFor(p)
      expect(await tryHandleStatic(ctx, webDir), p).toBe(true) // the route still OWNS the path
      expect(status(), p).toBe(404) // ...and answers 404
    }
  })

  it('NEGATIVE: an unlisted extension is refused even when the file exists', async () => {
    writeFileSync(join(webDir, 'avatars', 'notes.txt'), 'hello')
    const { ctx, status } = ctxFor('/avatars/notes.txt')
    expect(await tryHandleStatic(ctx, webDir)).toBe(true)
    expect(status()).toBe(404)
  })

  // Deliberately excluded from serving, listed BY NAME so the exception is reviewable instead of
  // being absorbed into a looser rule. Anything else that stops serving fails the test below.
  const KNOWN_UNSERVED = new Set(['avatars/gallery.html'])

  it('the allowlist admits every asset that ships -- except the ones we deliberately dropped', async () => {
    // The main regression risk named by card 6ed41c9d, asserted against the REAL directories: a name
    // that ships and does not match would be a live 404. Card 58ee30fd then removed html on purpose,
    // so the assertion has to distinguish "we meant that" from "we broke something".
    const unexpectedly404: string[] = []
    const servedButListed: string[] = []
    for (const dir of ['avatars', 'icons']) {
      const real = join(ROOT, 'web', dir)
      if (!existsSync(real)) continue
      for (const name of readdirSync(real)) {
        const { ctx, status } = ctxFor(`/${dir}/${name}`)
        expect(await tryHandleStatic(ctx, join(ROOT, 'web')), `${dir}/${name}`).toBe(true)
        const is404 = status() === 404
        const listed = KNOWN_UNSERVED.has(`${dir}/${name}`)
        if (is404 && !listed) unexpectedly404.push(`${dir}/${name}`)
        if (!is404 && listed) servedButListed.push(`${dir}/${name}`)
      }
    }
    expect(unexpectedly404, 'these ship but no longer serve').toEqual([])
    // The other direction matters too: a stale entry here would quietly excuse a file that is fine.
    expect(servedButListed, 'these serve but are listed as deliberately dropped').toEqual([])
  })
})
