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
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
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

  // Card 3d186397 QA FAIL delta (10812): a traversal senderId must be rejected BEFORE
  // access.json is touched at all -- the first cut of this fix validated the senderId only
  // when writing the marker file, by which point allowFrom/pending/dmPolicy had ALREADY been
  // mutated and persisted, so a rejected request still silently approved the sender. These
  // tests pin the fixed, fail-closed-before-any-effect behaviour: 400, not 500, and access.json
  // byte-for-byte unchanged.
  it('a `../`-shaped senderId is REJECTED (400) BEFORE any access.json mutation', async () => {
    writeAccessWithPending('../../evil-traversal-marker')
    const before = readFileSync(join(stateDir, 'access.json'), 'utf-8')
    const { ctx, out } = fakeCtx({ code: 'abc123' })
    expect(await tryHandleAgents(ctx, webDir)).toBe(true)
    expect(out.status).toBe(400)
    expect(out.body).toEqual({ error: 'Invalid sender identifier' })
    // access.json is untouched: no allowFrom push, no pending deletion, no dmPolicy change.
    expect(readFileSync(join(stateDir, 'access.json'), 'utf-8')).toBe(before)
    // Would land at stateDir/../../evil-traversal-marker == two levels above stateDir.
    expect(existsSync(join(stateDir, '..', '..', 'evil-traversal-marker'))).toBe(false)
    // approved/ is never created either -- the rejection happens before that mkdirSync.
    expect(existsSync(join(stateDir, 'approved'))).toBe(false)
  })

  it('an absolute-path senderId is REJECTED (400), and nothing is written at that path', async () => {
    const absTarget = join(tmpdir(), `pairing-traversal-abs-marker-${Date.now()}`)
    writeAccessWithPending(absTarget)
    const { ctx, out } = fakeCtx({ code: 'abc123' })
    expect(await tryHandleAgents(ctx, webDir)).toBe(true)
    expect(out.status).toBe(400)
    expect(existsSync(absTarget)).toBe(false)
  })

  // MUTATION PIN: with the validate-before-mutate ordering reverted (safeJoin moved back after
  // the access.json write, as the first cut of this fix had it), this traversal case would
  // instead return 500 (not 400) AND leave the rejected senderId in allowFrom -- see the card's
  // QA FAIL (10812) and DECISIONS.md entry for the measured before/after.
  it('MUTATION PIN: a rejected senderId never reaches allowFrom, and the pending code is not consumed', async () => {
    writeAccessWithPending('../outside-marker')
    const { ctx, out } = fakeCtx({ code: 'abc123' })
    await tryHandleAgents(ctx, webDir)
    expect(out.status).toBe(400)
    const access = JSON.parse(readFileSync(join(stateDir, 'access.json'), 'utf-8'))
    expect(access.allowFrom ?? []).not.toContain('../outside-marker')
    // The pending code is NOT consumed either -- a later, corrected plugin response (or a human
    // retry with the same code) can still complete the pairing.
    expect(access.pending).toHaveProperty('abc123')
  })

  // Card 25aaada5 F1 (WhiteHat, MEDIUM): safeJoin is LEXICAL -- it proves the resolved STRING
  // stays inside approvedDir, but says nothing about whether the filesystem entry already AT
  // that path is itself a symlink. 'lnk' is not a traversal shape (safeJoin accepts it), so the
  // route proceeds to the marker write, which used to be a plain writeFileSync and would follow
  // the symlink to wherever it points, outside approved/ entirely. writeFileNoFollowSync (O_
  // NOFOLLOW) refuses instead.
  it('F1: a symlink already sitting at approved/<name> is NOT followed -- external target untouched', async () => {
    const approvedDir = join(stateDir, 'approved')
    mkdirSync(approvedDir, { recursive: true })
    const externalFile = join(tmpdir(), `symlink-escape-target-${Date.now()}.txt`)
    writeFileSync(externalFile, 'ORIG')
    symlinkSync(externalFile, join(approvedDir, 'lnk'))
    writeAccessWithPending('lnk', 'CHAT9')
    const { ctx, out } = fakeCtx({ code: 'abc123' })
    expect(await tryHandleAgents(ctx, webDir)).toBe(true)
    // The write fails (ELOOP via O_NOFOLLOW), caught by the route's outer try/catch -> 500. The
    // point of this test is the file content, not the status code.
    expect(out.status).toBe(500)
    expect(readFileSync(externalFile, 'utf-8')).toBe('ORIG')
  })

  // Card 25aaada5 F3 (LOW, test gap WhiteHat flagged): safeJoin's `target.startsWith(resolvedBase
  // + sep)` check -- WITHOUT the `+ sep`, a sibling directory whose name has approvedDir's name
  // as a raw string PREFIX (e.g. "approved-evil" starts with "approved") would incorrectly pass.
  // No test pinned this before; the mutant (dropping `+ sep`) measured 0/53 red.
  it('F3: a sibling directory sharing approvedDir\'s name as a string prefix is REJECTED (400)', async () => {
    // approvedDir's name is literally "approved" (join(chDir, 'approved')) -- "../approved-evil/f"
    // resolves to a SIBLING of approvedDir whose name starts with "approved" as a raw string,
    // which is exactly the shape the `+ sep` boundary exists to reject.
    writeAccessWithPending('../approved-evil/f')
    const { ctx, out } = fakeCtx({ code: 'abc123' })
    expect(await tryHandleAgents(ctx, webDir)).toBe(true)
    expect(out.status).toBe(400)
    expect(existsSync(join(stateDir, 'approved-evil'))).toBe(false)
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

  // Card 3d186397 QA FAIL delta (10812): this sweep runs with NO human review at all, so a
  // traversal senderId silently becoming a real allowlist entry is worse here than on the
  // human-approval route. The first cut of this fix only guarded the marker write (warn-only,
  // mutation already committed) -- fixed to validate BEFORE any access.json/invites.json effect,
  // skipping the entry entirely (not approved, not consumed) so a later tick can retry it.
  it('a `../`-shaped senderId is skipped entirely -- NOT approved, NOT consumed, NOTHING escapes', () => {
    setup('../../invite-traversal-marker')
    const accessBefore = readFileSync(join(chDir, 'access.json'), 'utf-8')
    const invitesBefore = readFileSync(join(chDir, 'invites.json'), 'utf-8')
    expect(() => runInviteMonitorTick('nonexistent-main-agent-for-test', agentsRoot)).not.toThrow()
    // Would land at chDir/../invite-traversal-marker == one level above chDir (approved/ and
    // telegram/ each cancel one `..` in `join(approvedDir, '../../invite-traversal-marker')`).
    expect(existsSync(join(chDir, '..', 'invite-traversal-marker'))).toBe(false)
    // approved/ is never created -- the rejection happens before that mkdirSync.
    expect(existsSync(join(chDir, 'approved'))).toBe(false)
    // Neither file was written at all: the rejected entry is skipped before any mutation, not
    // approved-then-rolled-back.
    expect(readFileSync(join(chDir, 'access.json'), 'utf-8')).toBe(accessBefore)
    expect(readFileSync(join(chDir, 'invites.json'), 'utf-8')).toBe(invitesBefore)
  })

  it('an absolute-path senderId is skipped the same way, and does not escape', () => {
    const absTarget = join(tmpdir(), `invite-traversal-abs-marker-${Date.now()}`)
    setup(absTarget)
    const accessBefore = readFileSync(join(chDir, 'access.json'), 'utf-8')
    runInviteMonitorTick('nonexistent-main-agent-for-test', agentsRoot)
    expect(existsSync(absTarget)).toBe(false)
    expect(readFileSync(join(chDir, 'access.json'), 'utf-8')).toBe(accessBefore)
  })

  // MUTATION PIN: with the validate-before-mutate ordering reverted (safeJoin only guarding the
  // marker write, as the first cut of this fix had it), a rejected senderId would still end up
  // in allowFrom and its invite token would still be spent -- this is the exact shape QA 10812
  // measured on channel-invites.ts.
  it('MUTATION PIN: a rejected senderId never reaches allowFrom and its invite token is not spent', () => {
    setup('../outside-marker')
    runInviteMonitorTick('nonexistent-main-agent-for-test', agentsRoot)
    const access = JSON.parse(readFileSync(join(chDir, 'access.json'), 'utf-8'))
    expect(access.allowFrom ?? []).not.toContain('../outside-marker')
    expect(access.pending).toHaveProperty('code1')
    const invites = JSON.parse(readFileSync(join(chDir, 'invites.json'), 'utf-8'))
    expect(invites.invites.tok1.used).toBe(false)
  })

  // Card 25aaada5 F1: same symlink-following gap as routes/agents.ts, this time on the
  // UNATTENDED auto-approval sweep -- 'tgt' is not a traversal shape, so the tick proceeds to
  // the marker write, which used to follow a pre-planted symlink to an external file.
  it('F1: a symlink already sitting at approved/<name> is NOT followed -- external target untouched', () => {
    const approvedDir = join(chDir, 'approved')
    mkdirSync(approvedDir, { recursive: true })
    const externalFile = join(tmpdir(), `invite-symlink-escape-target-${Date.now()}.txt`)
    writeFileSync(externalFile, 'ORIG')
    symlinkSync(externalFile, join(approvedDir, 'tgt'))
    setup('tgt')
    expect(() => runInviteMonitorTick('nonexistent-main-agent-for-test', agentsRoot)).not.toThrow()
    expect(readFileSync(externalFile, 'utf-8')).toBe('ORIG')
  })

  // Card 25aaada5 F3: same `+ sep` boundary gap as routes/agents.ts -- a sibling directory
  // sharing approvedDir's name ("approved") as a raw string prefix.
  it('F3: a sibling directory sharing approvedDir\'s name as a string prefix does not escape', () => {
    setup('../approved-evil/f')
    const accessBefore = readFileSync(join(chDir, 'access.json'), 'utf-8')
    expect(() => runInviteMonitorTick('nonexistent-main-agent-for-test', agentsRoot)).not.toThrow()
    expect(existsSync(join(chDir, '..', 'approved-evil'))).toBe(false)
    expect(readFileSync(join(chDir, 'access.json'), 'utf-8')).toBe(accessBefore)
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
