// /subagent-state.json is unauthenticated (app-auth-bootstrap.js polls it with no token), and its
// source file (store/active-subagents.json) is written by a prompt, not a schema-checked writer
// (Cybersec INFO on c375238d, card 613a8142). Before the fix, the route passed the file's raw bytes
// straight through -- whatever the file contained, the response was a byte-exact copy. This proves
// the route now re-serialises a validated, agent-id-shaped array instead.
import { describe, it, expect, beforeEach } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { tryHandleStatic } from '../web/routes/static.js'
import type { RouteContext } from '../web/routes/types.js'

let sandbox: string
let webDir: string
let storeDir: string

function fakeRes(): { res: ServerResponse; status: () => number | null; body: () => string } {
  let status: number | null = null
  let chunks = ''
  const res = {
    writeHead(code: number) { status = code; return res },
    setHeader() { return res },
    getHeader() { return undefined },
    end(chunk?: unknown) { if (typeof chunk === 'string') chunks += chunk; return res },
    write(chunk?: unknown) { if (typeof chunk === 'string') chunks += chunk; return true },
    on() { return res },
    once() { return res },
    emit() { return false },
  } as unknown as ServerResponse
  return { res, status: () => status, body: () => chunks }
}

function ctxFor(path: string): { ctx: RouteContext; status: () => number | null; body: () => string } {
  const { res, status, body } = fakeRes()
  const req = { headers: {}, method: 'GET', url: path, on() { return req }, once() { return req } } as unknown as IncomingMessage
  return { ctx: { req, res, path, method: 'GET', url: new URL('http://localhost/') } as RouteContext, status, body }
}

beforeEach(() => {
  sandbox = mkdtempSync(join(tmpdir(), 'subagent-state-route-'))
  webDir = join(sandbox, 'web')
  storeDir = join(sandbox, 'store')
  mkdirSync(webDir, { recursive: true })
  mkdirSync(storeDir, { recursive: true })
})

describe('/subagent-state.json re-serialises a validated array (card 613a8142)', () => {
  it('POSITIVE: real agent-id-shaped entries pass through unchanged', async () => {
    writeFileSync(join(storeDir, 'active-subagents.json'), JSON.stringify(['mikrob', 'backend-2']))
    const { ctx, status, body } = ctxFor('/subagent-state.json')
    expect(await tryHandleStatic(ctx, webDir)).toBe(true)
    expect(status()).toBe(200)
    expect(JSON.parse(body())).toEqual(['mikrob', 'backend-2'])
  })

  it('a non-agent-id-shaped entry (whitespace/separators) is dropped, not served', async () => {
    writeFileSync(join(storeDir, 'active-subagents.json'), JSON.stringify(['mikrob', '../../etc/passwd', 'a b']))
    const { ctx, status, body } = ctxFor('/subagent-state.json')
    expect(await tryHandleStatic(ctx, webDir)).toBe(true)
    expect(status()).toBe(200)
    expect(JSON.parse(body())).toEqual(['mikrob'])
  })

  it('a non-array JSON value (e.g. an object) is refused -> empty array, not the raw object', async () => {
    writeFileSync(join(storeDir, 'active-subagents.json'), JSON.stringify({ leaked: 'something' }))
    const { ctx, status, body } = ctxFor('/subagent-state.json')
    expect(await tryHandleStatic(ctx, webDir)).toBe(true)
    expect(status()).toBe(200)
    expect(JSON.parse(body())).toEqual([])
  })

  it('broken JSON in the file is refused -> empty array, not a crash or the raw bytes', async () => {
    writeFileSync(join(storeDir, 'active-subagents.json'), '{not valid json')
    const { ctx, status, body } = ctxFor('/subagent-state.json')
    expect(await tryHandleStatic(ctx, webDir)).toBe(true)
    expect(status()).toBe(200)
    expect(JSON.parse(body())).toEqual([])
  })

  it('no file on disk -> empty array (unchanged default)', async () => {
    rmSync(join(storeDir, 'active-subagents.json'), { force: true })
    const { ctx, status, body } = ctxFor('/subagent-state.json')
    expect(await tryHandleStatic(ctx, webDir)).toBe(true)
    expect(status()).toBe(200)
    expect(JSON.parse(body())).toEqual([])
  })
})
