// GET/POST /api/local-llm/first-draft-enabled (card d57d8a01, Peti Telegram 10951): the master
// kill-switch for every local-first-draft entry point. store/local-first-draft-check.selftest.sh
// pins the shell-side read + the mutation-pinning sweep across all seven real callers; this file
// pins the API surface the dashboard toggle actually calls, including the card's own explicit
// acceptance test that flipping the switch never starts anything on its own.
import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, readFileSync, existsSync } from 'node:fs'
import { Readable } from 'node:stream'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import type http from 'node:http'
import type { RouteContext } from '../web/routes/types.js'

const tmpRoot = mkdtempSync(join(tmpdir(), 'llm-first-draft-switch-'))
const SANDBOX_STORE = join(tmpRoot, 'store')
mkdirSync(SANDBOX_STORE, { recursive: true })

// spawn/execFile are mocked BEFORE the route module is imported, so if the handler ever reached for
// either (starting ollama, running a systemctl command, anything) the test would see the call --
// the card's own acceptance test ("a kapcsolo nem inditja el az ollamat magatol").
const spawnSpy = vi.fn()
const execFileSpy = vi.fn()
vi.mock('node:child_process', async (orig) => {
  const actual = await orig<typeof import('node:child_process')>()
  return { ...actual, spawn: spawnSpy, execFile: execFileSpy }
})

vi.mock('../config.js', async (orig) => {
  const actual = await orig<typeof import('../config.js')>()
  return { ...actual, PROJECT_ROOT: tmpRoot, STORE_DIR: SANDBOX_STORE }
})

const { tryHandleLocalLlm } = await import('../web/routes/local-llm.js')

const FLAG_FILE = join(SANDBOX_STORE, 'local-first-draft.json')
const MIRROR_DIR = join(SANDBOX_STORE, '.gemini-local-subtask-gpu-gate')
const MIRROR_FILE = join(MIRROR_DIR, 'killswitch-mirror.json')

function ctx(
  path: string,
  method: string,
  body?: unknown,
  auth?: RouteContext['auth'],
): { ctx: RouteContext; out: { status: number; body: any } } {
  const out: { status: number; body: any } = { status: 0, body: null }
  const res: any = {
    writeHead(status: number) { out.status = status; return res },
    end(chunk?: string) { if (chunk) out.body = JSON.parse(chunk) },
  }
  const req = Readable.from(body === undefined ? [] : [Buffer.from(JSON.stringify(body))]) as unknown as http.IncomingMessage
  const url = new URL(`http://localhost:3420${path}`)
  return { ctx: { req, res, path: url.pathname, method, url, auth } as RouteContext, out }
}

async function get(): Promise<{ status: number; body: any }> {
  const { ctx: c, out } = ctx('/api/local-llm/first-draft-enabled', 'GET')
  await tryHandleLocalLlm(c)
  return out
}
// Defaults to an owner browser session, since that is the credential the dashboard toggle itself
// uses -- tests exercising the B2 restriction (card d57d8a01, MikroB decision 16743) pass an
// explicit auth to override this.
async function post(body: unknown, auth: RouteContext['auth']): Promise<{ status: number; body: any }> {
  const { ctx: c, out } = ctx('/api/local-llm/first-draft-enabled', 'POST', body, auth)
  await tryHandleLocalLlm(c)
  return out
}

beforeEach(() => {
  rmSync(FLAG_FILE, { force: true })
  rmSync(MIRROR_DIR, { recursive: true, force: true })
  spawnSpy.mockClear()
  execFileSpy.mockClear()
})

afterAll(() => {
  rmSync(tmpRoot, { recursive: true, force: true })
})

describe('GET /api/local-llm/first-draft-enabled', () => {
  it('no file at all -> enabled:true (absence = ON, same default every shell reader uses)', async () => {
    const r = await get()
    expect(r.status).toBe(200)
    expect(r.body).toEqual({ enabled: true, note: '' })
  })

  it('reflects a {"enabled": false} file written by hand/by a previous POST', async () => {
    const { atomicWriteFileSync } = await import('../web/atomic-write.js')
    atomicWriteFileSync(FLAG_FILE, JSON.stringify({ enabled: false, note: 'manual' }))
    const r = await get()
    expect(r.body).toEqual({ enabled: false, note: 'manual' })
  })

  it('an unparseable file fails OPEN -- enabled:true, same direction as every shell reader', async () => {
    const { atomicWriteFileSync } = await import('../web/atomic-write.js')
    atomicWriteFileSync(FLAG_FILE, 'not json at all')
    const r = await get()
    expect(r.body.enabled).toBe(true)
  })
})

describe('POST /api/local-llm/first-draft-enabled', () => {
  it('rejects a missing enabled field (400), does not touch the file', async () => {
    const r = await post({}, { kind: 'session', user: 'peti' })
    expect(r.status).toBe(400)
    expect(existsSync(FLAG_FILE)).toBe(false)
  })

  it('rejects invalid JSON (400)', async () => {
    const out: { status: number; body: any } = { status: 0, body: null }
    const res: any = {
      writeHead(status: number) { out.status = status; return res },
      end(chunk?: string) { if (chunk) out.body = JSON.parse(chunk) },
    }
    const req = Readable.from([Buffer.from('not json at all')]) as unknown as http.IncomingMessage
    const url = new URL('http://localhost:3420/api/local-llm/first-draft-enabled')
    const c = { req, res, path: url.pathname, method: 'POST', url } as RouteContext
    await tryHandleLocalLlm(c)
    expect(out.status).toBe(400)
  })

  it('{enabled:false} persists the switch, with a default note, and GET reflects it', async () => {
    const r = await post({ enabled: false }, { kind: 'session', user: 'peti' })
    expect(r.body.enabled).toBe(false)
    expect(r.body.note).toContain('disabled')
    const stored = JSON.parse(readFileSync(FLAG_FILE, 'utf-8'))
    expect(stored).toEqual({ enabled: false, note: r.body.note })
    expect((await get()).body).toEqual({ enabled: false, note: r.body.note })
  })

  it('{enabled:true, note:"..."} persists the caller-supplied note verbatim (trimmed)', async () => {
    const r = await post({ enabled: true, note: '  Peti approved re-enable  ' }, { kind: 'session', user: 'peti' })
    expect(r.body).toEqual({ enabled: true, note: 'Peti approved re-enable' })
  })

  it('a non-boolean enabled value is rejected (400), not coerced', async () => {
    const r = await post({ enabled: 'false' }, { kind: 'session', user: 'peti' })
    expect(r.status).toBe(400)
    expect(existsSync(FLAG_FILE)).toBe(false)
  })

  it('flipping the switch (either direction) never spawns or execs anything -- it only ever writes JSON', async () => {
    await post({ enabled: false }, { kind: 'session', user: 'peti' })
    await post({ enabled: true }, { kind: 'session', user: 'peti' })
    await get()
    expect(spawnSpy).not.toHaveBeenCalled()
    expect(execFileSpy).not.toHaveBeenCalled()
  })
})

// Card d57d8a01, QA FAIL 16742 secondary finding + MikroB decision 16743 (B2, BLOCKING per Peti's
// own card text): re-enabling must not be reachable with the shared fleet bearer token, or with a
// device key issued to a fleet agent (`agent:<id>`, card 2bfa4c67/9655494c) -- only a human
// credential (owner session, or a device key that is NOT agent-named) may re-enable (WhiteHat2,
// comment 16810, the fleet.ts:119 pattern corrected for the agent-device-key gap it itself has).
describe('POST /api/local-llm/first-draft-enabled -- re-enabling is human-credential-only (B2)', () => {
  it.each([
    ['the shared agent bearer (kind: token)', { kind: 'token' } as RouteContext['auth']],
    ['no auth principal at all', undefined],
    ['a federation peer credential', { kind: 'federation', peer: 'some-peer' } as RouteContext['auth']],
    ['an agent-issued device key', { kind: 'device', device: 'agent:backend', deviceId: 1 } as RouteContext['auth']],
  ])('{enabled:true} is refused (403) with %s, and the file is NOT written', async (_label, auth) => {
    const r = await post({ enabled: true }, auth)
    expect(r.status).toBe(403)
    expect(existsSync(FLAG_FILE)).toBe(false)
  })

  it('{enabled:true} succeeds with an owner browser session', async () => {
    const r = await post({ enabled: true }, { kind: 'session', user: 'peti' })
    expect(r.status).toBe(200)
    expect(r.body).toEqual({ enabled: true, note: r.body.note })
    expect(existsSync(FLAG_FILE)).toBe(true)
  })

  it('{enabled:true} succeeds with a human (non agent-named) device key', async () => {
    const r = await post({ enabled: true }, { kind: 'device', device: 'phone', deviceId: 1 })
    expect(r.status).toBe(200)
    expect(existsSync(FLAG_FILE)).toBe(true)
  })

  it.each([
    ['the shared agent bearer (kind: token)', { kind: 'token' } as RouteContext['auth']],
    ['an agent-issued device key', { kind: 'device', device: 'agent:backend', deviceId: 1 } as RouteContext['auth']],
    ['no auth principal at all', undefined],
  ])('{enabled:false} (the fail-safe direction) still succeeds with %s -- disabling stays open to anyone', async (_label, auth) => {
    const r = await post({ enabled: false }, auth)
    expect(r.body.enabled).toBe(false)
    expect(existsSync(FLAG_FILE)).toBe(true)
  })

  it('refusing a re-enable never spawns or execs anything either', async () => {
    await post({ enabled: true }, { kind: 'token' } as RouteContext['auth'])
    expect(spawnSpy).not.toHaveBeenCalled()
    expect(execFileSpy).not.toHaveBeenCalled()
  })

  it('the default audit note names the caller when enabling', async () => {
    const r = await post({ enabled: true }, { kind: 'session', user: 'peti' })
    expect(r.body.note).toContain('session:peti')
  })
})

// Card 784a9325 (RedHat CYBERED GO 19644 on a020247b, K1+K2): the jailed agy engine reads ONLY the
// mirror file (FIRST_DRAFT_MIRROR_FILE), never the real switch file directly -- bwrap pins the
// inode at jail-start, so a host-side atomicWriteFileSync rename is invisible to an already-running
// jail unless it is the mirror's own directory that gets the rename. Before this card, the mirror
// write had ZERO test coverage: the existing tests above all read the MAIN switch file only, so a
// regression that stopped writing the mirror, or wrote the wrong value into it, was invisible here.
describe('POST /api/local-llm/first-draft-enabled -- jailed-agy mirror file (card 784a9325)', () => {
  it('{enabled:false} writes {enabled:false} into the mirror file alongside the main switch', async () => {
    const r = await post({ enabled: false }, { kind: 'session', user: 'peti' })
    expect(r.status).toBe(200)
    expect(JSON.parse(readFileSync(MIRROR_FILE, 'utf-8'))).toEqual({ enabled: false })
  })

  it('{enabled:true} writes {enabled:true} into the mirror file alongside the main switch', async () => {
    const r = await post({ enabled: true }, { kind: 'session', user: 'peti' })
    expect(r.status).toBe(200)
    expect(JSON.parse(readFileSync(MIRROR_FILE, 'utf-8'))).toEqual({ enabled: true })
  })

  // K1: a mirror-write failure on the OFF transition must not come back as 200 -- the main switch
  // is genuinely off, but the jail only ever sees the mirror, and a 200 here would claim the kill
  // switch took effect when the jail-visible copy may still read stale/ON. Forcing the failure by
  // pre-creating a FILE where the route wants a directory (mkdirSync(..., {recursive:true}) then
  // throws ENOTDIR) needs no fs mocking and exercises the real code path end to end.
  it('{enabled:false}: a mirror-write failure is surfaced, not swallowed (fail-closed, no 200)', async () => {
    rmSync(MIRROR_DIR, { recursive: true, force: true })
    const { writeFileSync } = await import('node:fs')
    writeFileSync(MIRROR_DIR, 'not a directory')
    const r = await post({ enabled: false }, { kind: 'session', user: 'peti' })
    expect(r.status).not.toBe(200)
    expect(r.status).toBe(502)
    expect(r.body.error).toBe('mirror_write_failed')
    // The main switch write already landed -- this is a mirror-only failure, not a full rollback.
    expect(JSON.parse(readFileSync(FLAG_FILE, 'utf-8')).enabled).toBe(false)
  })

  // The reverse direction is the safe one (jail stays OFF/degraded, never silently ON), so it keeps
  // the old best-effort 200 -- this pins that the two directions are NOT treated symmetrically.
  it('{enabled:true}: a mirror-write failure still returns 200 (safe direction, logged not surfaced)', async () => {
    rmSync(MIRROR_DIR, { recursive: true, force: true })
    const { writeFileSync } = await import('node:fs')
    writeFileSync(MIRROR_DIR, 'not a directory')
    const r = await post({ enabled: true }, { kind: 'session', user: 'peti' })
    expect(r.status).toBe(200)
    expect(r.body.enabled).toBe(true)
  })
})
