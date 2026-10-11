// Card 3d186397 (security audit, Cybersec out-of-scope note on 7503bb31 comment 5384):
// senderId traversal sanitization for the two writeFileSync(approvedDir, senderId) call sites.
//
// Both sites write a pairing-approval marker file whose NAME is `entry.senderId` /
// `pEntry.senderId` -- a value this server never writes itself. It comes from access.json's
// `pending` map, which is populated exclusively by the EXTERNAL channel plugin binary (telegram@
// claude-plugins-official and friends) when an unrecognized sender writes to the bot. Grep across
// src/ confirms `pending[...]` is only ever READ in our TypeScript, never WRITTEN -- so the shape
// of senderId is whatever the plugin's own parsing of the inbound channel message produces, not
// something this codebase controls or has validated.
//
// Repro attempted: a `../`-shaped or absolute senderId, reaching this server via a crafted/buggy
// plugin response (or a compromised plugin process) BEFORE the fix, would make writeFileSync()
// write (or overwrite) an arbitrary file outside the channel's `approved/` directory, with content
// controlled by `chatId` (routes/agents.ts) or empty (channel-invites.ts) -- a path-traversal
// write, not merely a read. The fix: both sites now resolve the target through `safeJoin()`
// (src/web/sanitize.ts), which resolves-then-checks the prefix and throws `Path traversal
// rejected: ...` for any `../`-shaped or absolute segment, instead of writing outside the intended
// directory.
//
// Two layers, same as invite-token-not-logged.test.ts's structure: a behavioural test per call
// site (drives the real route / real monitor tick against a temp directory), and a source-level
// pin so neither site can silently regress back to a bare `join(...)` for a plugin-sourced
// senderId.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { EventEmitter } from 'node:events'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { tryHandleAgents } from '../web/routes/agents.js'
import type { RouteContext } from '../web/routes/types.js'
import { runInviteMonitorTick } from '../web/channel-invites.js'
import { MAIN_AGENT_ID } from '../config.js'

vi.mock('../logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}))

const SRC = join(dirname(fileURLToPath(import.meta.url)), '..')

// ---------------------------------------------------------------------------
// Site 1: POST /api/agents/:name/channels/telegram/approve (routes/agents.ts)
// ---------------------------------------------------------------------------

function fakeCtx(body: unknown): { ctx: RouteContext; out: { status: number; body: any } } {
  const out: { status: number; body: any } = { status: 0, body: null }
  const res: any = {
    writeHead(status: number) { out.status = status; return res },
    end(chunk?: string) { if (chunk) { try { out.body = JSON.parse(chunk) } catch { out.body = chunk } } },
  }
  const req: any = new EventEmitter()
  req.headers = {}
  const url = new URL(`http://localhost:3420/api/agents/${MAIN_AGENT_ID}/channels/telegram/approve`)
  req.url = url.pathname
  const ctx = { req, res, path: url.pathname, method: 'POST', url, auth: { kind: 'token' } } as RouteContext
  const payload = JSON.stringify(body)
  process.nextTick(() => {
    req.emit('data', Buffer.from(payload))
    req.emit('end')
  })
  return { ctx, out }
}

describe('POST /api/agents/:name/channels/telegram/approve -- senderId traversal (card 3d186397)', () => {
  let stateDir: string
  let webDir: string
  let prevStateDirEnv: string | undefined

  beforeEach(() => {
    stateDir = mkdtempSync(join(tmpdir(), 'pairing-traversal-state-'))
    webDir = mkdtempSync(join(tmpdir(), 'pairing-traversal-web-'))
    prevStateDirEnv = process.env.TELEGRAM_STATE_DIR
    process.env.TELEGRAM_STATE_DIR = stateDir
  })

  afterEach(() => {
    if (prevStateDirEnv === undefined) delete process.env.TELEGRAM_STATE_DIR
    else process.env.TELEGRAM_STATE_DIR = prevStateDirEnv
    rmSync(stateDir, { recursive: true, force: true })
    rmSync(webDir, { recursive: true, force: true })
  })

  function writeAccessWithPending(senderId: string, chatId = '555'): void {
    writeFileSync(
      join(stateDir, 'access.json'),
      JSON.stringify({ pending: { 'abc123': { senderId, chatId, createdAt: Date.now(), expiresAt: Date.now() + 60000 } } }),
    )
  }

  it('a normal senderId is approved and the marker lands inside approved/ (positive control)', async () => {
    writeAccessWithPending('555666777')
    const { ctx, out } = fakeCtx({ code: 'abc123' })
    expect(await tryHandleAgents(ctx, webDir)).toBe(true)
    expect(out.status).toBe(200)
    expect(out.body).toEqual({ ok: true, senderId: '555666777' })
    expect(readFileSync(join(stateDir, 'approved', '555666777'), 'utf-8')).toBe('555')
  })

  it('a `../`-shaped senderId is REJECTED (500), and nothing is written outside approved/', async () => {
    writeAccessWithPending('../../evil-traversal-marker')
    const { ctx, out } = fakeCtx({ code: 'abc123' })
    expect(await tryHandleAgents(ctx, webDir)).toBe(true)
    expect(out.status).toBe(500)
    expect(out.body).toEqual({ error: 'Failed to approve pairing' })
    // Would land at stateDir/../../evil-traversal-marker == two levels above stateDir.
    expect(existsSync(join(stateDir, '..', '..', 'evil-traversal-marker'))).toBe(false)
    // approved/ itself is created (mkdirSync runs before the safeJoin throw) but stays empty --
    // the rejected write never lands inside it either.
    expect(readdirSync(join(stateDir, 'approved'))).toEqual([])
  })

  it('an absolute-path senderId is REJECTED (500), and nothing is written at that path', async () => {
    const absTarget = join(tmpdir(), `pairing-traversal-abs-marker-${Date.now()}`)
    writeAccessWithPending(absTarget)
    const { ctx, out } = fakeCtx({ code: 'abc123' })
    expect(await tryHandleAgents(ctx, webDir)).toBe(true)
    expect(out.status).toBe(500)
    expect(existsSync(absTarget)).toBe(false)
  })

  // MUTATION PIN: with the fix reverted to a bare `join(approvedDir, entry.senderId)`, the
  // traversal case above would instead return {ok:true} (status defaults to 0/200-ish success
  // path) and actually create the file two levels above stateDir -- see the manual mutation check
  // in the card's DECISIONS.md entry. This assertion distinguishes "rejected" from "silently
  // wrote somewhere unexpected but also somehow errored for another reason".
  it('MUTATION PIN: the traversal rejection is specifically the safeJoin throw, not an unrelated error', async () => {
    writeAccessWithPending('../outside-marker')
    const { ctx } = fakeCtx({ code: 'abc123' })
    await tryHandleAgents(ctx, webDir)
    // access.json mutation (allowFrom/pending/dmPolicy) happens BEFORE the safeJoin call in the
    // same try block, so it still committed -- only the marker write failed. This confirms we are
    // inside that specific try/catch, at the writeFileSync(safeJoin(...)) line, not erroring earlier.
    const access = JSON.parse(readFileSync(join(stateDir, 'access.json'), 'utf-8'))
    expect(access.allowFrom).toContain('../outside-marker')
    expect(access.pending).toEqual({})
  })
})

// ---------------------------------------------------------------------------
// Site 2: runInviteMonitorTick (channel-invites.ts)
// ---------------------------------------------------------------------------

describe('runInviteMonitorTick -- senderId traversal on auto-approve (card 3d186397)', () => {
  let agentsRoot: string
  let chDir: string

  beforeEach(() => {
    agentsRoot = mkdtempSync(join(tmpdir(), 'invite-traversal-agents-'))
    mkdirSync(join(agentsRoot, 'someagent'))
    chDir = join(agentsRoot, 'someagent', '.claude', 'channels', 'telegram')
    mkdirSync(chDir, { recursive: true })
  })

  afterEach(() => {
    rmSync(agentsRoot, { recursive: true, force: true })
  })

  function setup(senderId: string): void {
    const now = Date.now()
    writeFileSync(
      join(chDir, 'access.json'),
      JSON.stringify({ dmPolicy: 'pairing', pending: { code1: { senderId, chatId: '1', createdAt: now - 1000, expiresAt: now + 60000 } } }),
    )
    writeFileSync(
      join(chDir, 'invites.json'),
      JSON.stringify({ invites: { tok1: { createdAt: now - 2000, expiresAt: now + 60000, used: false } } }),
    )
  }

  it('a normal senderId gets a marker file inside approved/ (positive control)', () => {
    setup('111222333')
    // "nonexistent-main" has no main-agent access.json under stateDir, so only the sub-agent in
    // agentsRoot is processed -- this isolates the test from the real install's channel state.
    runInviteMonitorTick('nonexistent-main-agent-for-test', agentsRoot)
    expect(existsSync(join(chDir, 'approved', '111222333'))).toBe(true)
  })

  it('a `../`-shaped senderId does not escape approved/ -- auto-approve still completes otherwise', () => {
    setup('../../invite-traversal-marker')
    expect(() => runInviteMonitorTick('nonexistent-main-agent-for-test', agentsRoot)).not.toThrow()
    // The write is caught internally (logger.warn). With the fix, nothing lands anywhere outside
    // approved/. `join(approvedDir, '../../invite-traversal-marker')` textually normalizes to one
    // level ABOVE chDir (approved/ and telegram/ each cancel one `..`) -- that is the exact path a
    // reverted bare-join would have written to, so check it directly rather than only "not inside
    // approved/" (which a different escape depth could satisfy vacuously).
    expect(existsSync(join(chDir, '..', 'invite-traversal-marker'))).toBe(false)
    // approved/ itself is created (mkdirSync runs before the safeJoin throw) but stays empty.
    expect(readdirSync(join(chDir, 'approved'))).toEqual([])
    // The rest of the approval (allowFrom, pending removal, token spend) still happened -- the
    // monitor's own try/catch around just the marker write means a hostile senderId cannot stall
    // the whole tick, which matters because `pending` is driven by the same untrusted plugin.
    const access = JSON.parse(readFileSync(join(chDir, 'access.json'), 'utf-8'))
    expect(access.allowFrom).toContain('../../invite-traversal-marker')
    expect(access.pending).toEqual({})
  })

  it('an absolute-path senderId does not escape approved/', () => {
    const absTarget = join(tmpdir(), `invite-traversal-abs-marker-${Date.now()}`)
    setup(absTarget)
    runInviteMonitorTick('nonexistent-main-agent-for-test', agentsRoot)
    expect(existsSync(absTarget)).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// Source-level pin: a plugin-sourced senderId written as a path segment must
// go through safeJoin, not a bare join -- defense in depth against a future
// edit silently reverting one of the two sites (or adding a third).
// ---------------------------------------------------------------------------

/** Every .ts under src/, minus tests. */
function sourceFiles(dir: string): string[] {
  const out: string[] = []
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) {
      if (entry === '__tests__' || entry === 'node_modules') continue
      out.push(...sourceFiles(full))
    } else if (entry.endsWith('.ts')) {
      out.push(full)
    }
  }
  return out
}

// Matches `writeFileSync(join(<anything>, <x>.senderId), ...)` -- a bare join (not safeJoin)
// taking a `.senderId` property as its last path segment. Deliberately narrow to this one shape
// (the class this card found), not a general "all writeFileSync must use safeJoin" rule, which
// would flag unrelated, already-safe call sites across the codebase.
const BARE_JOIN_WITH_SENDERID_RX = /writeFileSync\(\s*join\([^()]*\.senderId\s*\)/

describe('no writeFileSync(join(..., *.senderId)) site bypasses safeJoin (card 3d186397)', () => {
  const files = sourceFiles(SRC)

  it('scans a plausible number of source files (a broken walk would pass vacuously)', () => {
    expect(files.length).toBeGreaterThan(100)
  })

  it('finds no bare-join senderId write', () => {
    const offenders = files
      .filter((f) => BARE_JOIN_WITH_SENDERID_RX.test(readFileSync(f, 'utf-8')))
      .map((f) => relative(SRC, f))
    expect(
      offenders,
      `these files write a plugin-sourced senderId through a bare join(), not safeJoin():\n${offenders.join('\n')}\n` +
        `senderId comes from the external channel plugin's own pending-entry data (never validated by ` +
        `this codebase) -- use safeJoin(approvedDir, senderId) instead (see web/sanitize.ts).`,
    ).toEqual([])
  })

  it('the rule is not vacuous: it flags the shape that would have shipped', () => {
    const wouldHaveShipped = `writeFileSync(join(approvedDir, entry.senderId), String(entry.chatId ?? ''))`
    expect(BARE_JOIN_WITH_SENDERID_RX.test(wouldHaveShipped)).toBe(true)
  })

  it('the rule does NOT flag the actual, fixed safeJoin call', () => {
    const shipped = `writeFileSync(safeJoin(approvedDir, entry.senderId), String(entry.chatId ?? ''))`
    expect(BARE_JOIN_WITH_SENDERID_RX.test(shipped)).toBe(false)
  })
})
