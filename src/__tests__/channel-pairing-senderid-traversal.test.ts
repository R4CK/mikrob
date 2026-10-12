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
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
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

// Card 25aaada5 delta, RedHat NO-GO (17101) B1': a one-shot hook fired from inside realpathSync
// itself, so a test can simulate "the directory is swapped for a symlink in the exact instant
// AFTER the fd-pinned open already resolved it but the realpath confirmation call runs" --
// vi.spyOn can't intercept a live ESM named export directly (Node's module namespace isn't
// configurable), so the override goes through vi.mock instead. Every other fs function keeps its
// real implementation; only realpathSync gains this optional one-shot side effect.
let realpathSyncHook: (() => void) | null = null
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>()
  return {
    ...actual,
    realpathSync: Object.assign(
      (...args: Parameters<typeof actual.realpathSync>) => {
        const result = (actual.realpathSync as (...a: typeof args) => ReturnType<typeof actual.realpathSync>)(...args)
        if (realpathSyncHook) {
          const hook = realpathSyncHook
          realpathSyncHook = null
          hook()
        }
        return result
      },
      actual.realpathSync,
    ),
  }
})

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

  // Card 25aaada5 delta, RedHat NO-GO (16934) B1: O_NOFOLLOW only protects the LAST path
  // component. If approvedDir ITSELF is a symlink to an external directory, the senderId
  // ('victim', not a traversal shape) passes safeJoin fine, and the write landed in the
  // EXTERNAL directory -- unprotected by the F1 fix. Measured by RedHat as XA.
  it('B1 (XA): approvedDir ITSELF being a symlink does not let the write escape', async () => {
    const externalDir = mkdtempSync(join(tmpdir(), 'approved-dir-escape-'))
    // approvedDir does not exist yet -- plant it as a symlink BEFORE the route's own
    // mkdirSync(approvedDir, {recursive:true}), which no-ops on an existing symlinked dir.
    symlinkSync(externalDir, join(stateDir, 'approved'))
    writeAccessWithPending('victim', 'CHAT-X')
    const { ctx, out } = fakeCtx({ code: 'abc123' })
    expect(await tryHandleAgents(ctx, webDir)).toBe(true)
    expect(out.status).toBe(500)
    expect(existsSync(join(externalDir, 'victim'))).toBe(false)
  })

  // XB: an intermediate component (not the directory the caller passed, but one safeJoin
  // walks through for a slash-containing senderId) is a symlink. B2 already rejects any
  // senderId containing '/' outright, so this is really pinning that B2 runs -- kept as its
  // own case because it is the shape RedHat measured, distinct from XA.
  it('B1/B2 (XB): a slash-containing senderId ("sub/id") is rejected before any symlink is even consulted', async () => {
    const approvedDir = join(stateDir, 'approved')
    mkdirSync(approvedDir, { recursive: true })
    const externalDir = mkdtempSync(join(tmpdir(), 'approved-sub-escape-'))
    symlinkSync(externalDir, join(approvedDir, 'sub'))
    writeAccessWithPending('sub/id', 'CHAT-X')
    const { ctx, out } = fakeCtx({ code: 'abc123' })
    expect(await tryHandleAgents(ctx, webDir)).toBe(true)
    expect(out.status).toBe(400)
    expect(existsSync(join(externalDir, 'id'))).toBe(false)
  })

  // B2: shapes that resolve INSIDE approvedDir (so safeJoin alone accepts them) but are not
  // usable filenames -- each used to fail at some OTHER layer, always AFTER the allowFrom
  // mutation. it.each covers every shape RedHat named plus the positive control.
  it.each([
    ['empty string', ''],
    ['"."', '.'],
    ['".."', '..'],
    ['"x/.." (resolves to approvedDir itself)', 'x/..'],
    ['an embedded NUL byte', 'bad\0id'],
    ['a 300-character id', 'x'.repeat(300)],
  ] as const)('B2: %s is rejected (400) BEFORE any access.json mutation', async (_label, senderId) => {
    writeAccessWithPending(senderId)
    const before = readFileSync(join(stateDir, 'access.json'), 'utf-8')
    const { ctx, out } = fakeCtx({ code: 'abc123' })
    expect(await tryHandleAgents(ctx, webDir)).toBe(true)
    expect(out.status).toBe(400)
    expect(readFileSync(join(stateDir, 'access.json'), 'utf-8')).toBe(before)
  })

  it('B2 positive control: a plain numeric senderId still succeeds', async () => {
    writeAccessWithPending('12345')
    const { ctx, out } = fakeCtx({ code: 'abc123' })
    await tryHandleAgents(ctx, webDir)
    expect(out.status).toBe(200)
  })

  // Card 25aaada5 delta, RedHat NO-GO (17101) B1': the previous fix (realpathSync(dirname) THEN
  // openSync(path) by path) was two separate syscalls with a window between them -- RedHat
  // measured ~7% of 120000 racing calls landing outside the sandbox when approvedDir was swapped
  // for a symlink in that window. The fix opens the PARENT DIRECTORY once (O_NOFOLLOW) and does
  // every subsequent check/write through THAT fd (/proc/self/fd/<fd>/...), so a later swap of the
  // path 'approved' cannot redirect the already-open fd. This test simulates the race
  // deterministically: the realpathSync call (which runs strictly AFTER the directory fd was
  // already opened) swaps the real path out from under it before returning.
  it("B1': swapping approvedDir for an external symlink right after it was opened by fd does not escape (RedHat 17101 TOCTOU)", async () => {
    const approvedDir = join(stateDir, 'approved')
    mkdirSync(approvedDir, { recursive: true })
    const externalDir = mkdtempSync(join(tmpdir(), 'approved-toctou-'))
    const movedAsideDir = `${approvedDir}.orig-during-race`
    // The dirFd was already opened (by the caller, inside writeFileNoFollowSync) against the
    // REAL approvedDir before this hook fires on the realpathSync confirmation call. Swap the
    // path out from under it now, simulating the attacker's race window.
    realpathSyncHook = () => {
      renameSync(approvedDir, movedAsideDir)
      symlinkSync(externalDir, approvedDir)
    }
    writeAccessWithPending('victim', 'CHAT-RACE')
    const { ctx, out } = fakeCtx({ code: 'abc123' })
    expect(await tryHandleAgents(ctx, webDir)).toBe(true)
    // The write must land in the ORIGINAL directory (now renamed aside, but still the same
    // fd/inode the dirFd pinned) -- never in externalDir, which the path 'approved' now points
    // to after the swap.
    expect(out.status).toBe(200)
    expect(existsSync(join(externalDir, 'victim'))).toBe(false)
    expect(readFileSync(join(movedAsideDir, 'victim'), 'utf-8')).toBe('CHAT-RACE')
  })

  // Card 25aaada5 delta, RedHat NO-GO (17101) N1: the marker write must happen BEFORE the
  // allowFrom/pending/dmPolicy mutation -- the previous ordering wrote the marker last, so a
  // symlink at the final path component threw only AFTER the sender had already been
  // half-approved (allowFrom pushed and persisted, pending consumed).
  it('N1: a symlink at the marker path is rejected BEFORE access.json is mutated at all (half-approval closed)', async () => {
    const approvedDir = join(stateDir, 'approved')
    mkdirSync(approvedDir, { recursive: true })
    const externalFile = join(tmpdir(), `n1-escape-target-${Date.now()}.txt`)
    writeFileSync(externalFile, 'ORIG')
    symlinkSync(externalFile, join(approvedDir, 'lnk'))
    writeAccessWithPending('lnk', 'CHAT9')
    const before = readFileSync(join(stateDir, 'access.json'), 'utf-8')
    const { ctx, out } = fakeCtx({ code: 'abc123' })
    expect(await tryHandleAgents(ctx, webDir)).toBe(true)
    expect(out.status).toBe(500)
    expect(readFileSync(join(stateDir, 'access.json'), 'utf-8')).toBe(before)
    const access = JSON.parse(before)
    expect(access.allowFrom ?? []).not.toContain('lnk')
    expect(access.pending).toHaveProperty('abc123')
  })

  // Card 25aaada5 delta, RedHat NO-GO (17101) N4/M6 test gap: removing ONLY the backslash check
  // from isPlausibleChannelSenderId left the repo's tests 100% green (no test used a
  // backslash-only senderId; the existing tests only covered '/'). Pins the backslash case.
  it('M6: a backslash-containing senderId ("a\\\\b") is rejected (400) BEFORE any access.json mutation', async () => {
    writeAccessWithPending('a\\b')
    const before = readFileSync(join(stateDir, 'access.json'), 'utf-8')
    const { ctx, out } = fakeCtx({ code: 'abc123' })
    expect(await tryHandleAgents(ctx, webDir)).toBe(true)
    expect(out.status).toBe(400)
    expect(readFileSync(join(stateDir, 'access.json'), 'utf-8')).toBe(before)
  })

  // Card 25aaada5 delta, RedHat NO-GO (17101) N2: the length cap was 200 UTF-16 code units, not
  // the filesystem's real 255-BYTE limit -- a multi-byte-character id could be under 200 code
  // units yet over 255 bytes, passing this check and failing deeper (ENAMETOOLONG) after the
  // allowFrom mutation.
  it('N2: an id that is under 200 UTF-16 units but over 255 UTF-8 bytes is rejected (400) BEFORE mutation', async () => {
    const senderId = 'é'.repeat(130) // 130 code units, 260 bytes (each is 2 bytes in UTF-8)
    expect(senderId.length).toBeLessThan(200)
    expect(Buffer.byteLength(senderId, 'utf8')).toBeGreaterThan(255)
    writeAccessWithPending(senderId)
    const before = readFileSync(join(stateDir, 'access.json'), 'utf-8')
    const { ctx, out } = fakeCtx({ code: 'abc123' })
    expect(await tryHandleAgents(ctx, webDir)).toBe(true)
    expect(out.status).toBe(400)
    expect(readFileSync(join(stateDir, 'access.json'), 'utf-8')).toBe(before)
  })

  // Card 25aaada5 delta, RedHat NO-GO (17101) N2: a non-NUL control character (tab) must also be
  // rejected -- the previous denylist only checked for NUL specifically.
  it('N2: a control character (tab) in the senderId is rejected (400) BEFORE mutation', async () => {
    writeAccessWithPending('victim\twith-tab')
    const before = readFileSync(join(stateDir, 'access.json'), 'utf-8')
    const { ctx, out } = fakeCtx({ code: 'abc123' })
    expect(await tryHandleAgents(ctx, webDir)).toBe(true)
    expect(out.status).toBe(400)
    expect(readFileSync(join(stateDir, 'access.json'), 'utf-8')).toBe(before)
  })

  // Card 25aaada5 delta, RedHat NO-GO (17101) N4/M12 test gap: removing ONLY the `typeof`
  // check from isPlausibleChannelSenderId left the repo's tests 100% green -- no test exercised
  // the real route with a non-string pending.senderId (a shape that is impossible to construct
  // through the typed `writeAccessWithPending` helper, so this writes access.json's raw JSON
  // directly, the same way a malformed/compromised plugin response could).
  it.each([
    ['a number', 12345],
    ['null', null],
    ['an object', { x: 1 }],
    ['an array', ['a', 'b']],
  ] as const)('M12: a non-string senderId (%s) is rejected (400) BEFORE any access.json mutation', async (_label, senderId) => {
    writeFileSync(
      join(stateDir, 'access.json'),
      JSON.stringify({ pending: { abc123: { senderId, chatId: '555', createdAt: Date.now(), expiresAt: Date.now() + 60000 } } }),
    )
    const before = readFileSync(join(stateDir, 'access.json'), 'utf-8')
    const { ctx, out } = fakeCtx({ code: 'abc123' })
    expect(await tryHandleAgents(ctx, webDir)).toBe(true)
    expect(out.status).toBe(400)
    expect(readFileSync(join(stateDir, 'access.json'), 'utf-8')).toBe(before)
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

  // Card 25aaada5 delta, RedHat NO-GO (16934) B1 (XD): the unattended sweep's symlinked
  // approvedDir case -- more severe than routes/agents.ts's XA because there is no human in
  // the loop seeing the 500. approvedDir must not exist yet (same ordering as the agents.ts
  // XA test) so the symlink can be planted before the tick's own mkdirSync.
  it('B1 (XD): approvedDir ITSELF being a symlink does not let the unattended sweep escape', () => {
    const externalDir = mkdtempSync(join(tmpdir(), 'invite-approved-dir-escape-'))
    symlinkSync(externalDir, join(chDir, 'approved'))
    setup('victim')
    expect(() => runInviteMonitorTick('nonexistent-main-agent-for-test', agentsRoot)).not.toThrow()
    expect(existsSync(join(externalDir, 'victim'))).toBe(false)
  })

  // B2: same shape denylist as routes/agents.ts, on the unattended sweep -- each shape must be
  // skipped (not approved, not consumed) rather than silently half-approved.
  it.each([
    ['empty string', ''],
    ['"."', '.'],
    ['".."', '..'],
    ['"x/.." (resolves to approvedDir itself)', 'x/..'],
    ['an embedded NUL byte', 'bad\0id'],
    ['a 300-character id', 'x'.repeat(300)],
    ['a slash-containing id ("sub/id")', 'sub/id'],
  ] as const)('B2: %s is skipped, allowFrom/invites untouched', (_label, senderId) => {
    setup(senderId)
    const accessBefore = readFileSync(join(chDir, 'access.json'), 'utf-8')
    const invitesBefore = readFileSync(join(chDir, 'invites.json'), 'utf-8')
    expect(() => runInviteMonitorTick('nonexistent-main-agent-for-test', agentsRoot)).not.toThrow()
    expect(readFileSync(join(chDir, 'access.json'), 'utf-8')).toBe(accessBefore)
    expect(readFileSync(join(chDir, 'invites.json'), 'utf-8')).toBe(invitesBefore)
  })

  it('B2 positive control: a plain numeric senderId still gets approved', () => {
    setup('12345')
    runInviteMonitorTick('nonexistent-main-agent-for-test', agentsRoot)
    expect(existsSync(join(chDir, 'approved', '12345'))).toBe(true)
  })

  // Card 25aaada5 delta, RedHat NO-GO (17101) B1': same fd-pinned-open TOCTOU closure as
  // routes/agents.ts, exercised on the unattended sweep -- more severe here since there is no
  // human seeing a failed response.
  it("B1': swapping approvedDir for an external symlink right after it was opened by fd does not escape (RedHat 17101 TOCTOU)", () => {
    const approvedDir = join(chDir, 'approved')
    mkdirSync(approvedDir, { recursive: true })
    const externalDir = mkdtempSync(join(tmpdir(), 'invite-approved-toctou-'))
    const movedAsideDir = `${approvedDir}.orig-during-race`
    realpathSyncHook = () => {
      renameSync(approvedDir, movedAsideDir)
      symlinkSync(externalDir, approvedDir)
    }
    setup('victim')
    expect(() => runInviteMonitorTick('nonexistent-main-agent-for-test', agentsRoot)).not.toThrow()
    expect(existsSync(join(externalDir, 'victim'))).toBe(false)
    expect(existsSync(join(movedAsideDir, 'victim'))).toBe(true)
  })

  // Card 25aaada5 delta, RedHat NO-GO (17101) N1: on the unattended sweep, a marker-write failure
  // (symlink at the final path component) must skip the entry entirely -- not leave it
  // half-approved (allowFrom populated, invite spent, marker missing).
  it('N1: a symlink at the marker path is skipped entirely -- allowFrom/invites untouched (half-approval closed)', () => {
    const approvedDir = join(chDir, 'approved')
    mkdirSync(approvedDir, { recursive: true })
    const externalFile = join(tmpdir(), `invite-n1-escape-target-${Date.now()}.txt`)
    writeFileSync(externalFile, 'ORIG')
    symlinkSync(externalFile, join(approvedDir, 'tgt'))
    setup('tgt')
    const accessBefore = readFileSync(join(chDir, 'access.json'), 'utf-8')
    const invitesBefore = readFileSync(join(chDir, 'invites.json'), 'utf-8')
    expect(() => runInviteMonitorTick('nonexistent-main-agent-for-test', agentsRoot)).not.toThrow()
    expect(readFileSync(join(chDir, 'access.json'), 'utf-8')).toBe(accessBefore)
    expect(readFileSync(join(chDir, 'invites.json'), 'utf-8')).toBe(invitesBefore)
    expect(readFileSync(externalFile, 'utf-8')).toBe('ORIG')
  })

  // Card 25aaada5 delta, RedHat NO-GO (17101) N4/M6 test gap: same backslash-only shape as
  // routes/agents.ts, on the sweep.
  it('M6: a backslash-containing senderId ("a\\\\b") is skipped, allowFrom/invites untouched', () => {
    setup('a\\b')
    const accessBefore = readFileSync(join(chDir, 'access.json'), 'utf-8')
    const invitesBefore = readFileSync(join(chDir, 'invites.json'), 'utf-8')
    expect(() => runInviteMonitorTick('nonexistent-main-agent-for-test', agentsRoot)).not.toThrow()
    expect(readFileSync(join(chDir, 'access.json'), 'utf-8')).toBe(accessBefore)
    expect(readFileSync(join(chDir, 'invites.json'), 'utf-8')).toBe(invitesBefore)
  })

  // Card 25aaada5 delta, RedHat NO-GO (17101) N2: same byte-length-over-char-length gap, on the
  // sweep.
  it('N2: an id that is under 200 UTF-16 units but over 255 UTF-8 bytes is skipped, allowFrom/invites untouched', () => {
    const senderId = 'é'.repeat(130)
    setup(senderId)
    const accessBefore = readFileSync(join(chDir, 'access.json'), 'utf-8')
    const invitesBefore = readFileSync(join(chDir, 'invites.json'), 'utf-8')
    expect(() => runInviteMonitorTick('nonexistent-main-agent-for-test', agentsRoot)).not.toThrow()
    expect(readFileSync(join(chDir, 'access.json'), 'utf-8')).toBe(accessBefore)
    expect(readFileSync(join(chDir, 'invites.json'), 'utf-8')).toBe(invitesBefore)
  })

  // Card 25aaada5 delta, RedHat NO-GO (17101) N2: a tab is a VALID filename character on Linux
  // (unlike an overlong name, nothing downstream throws), so this is the case that actually pins
  // the control-character check itself on the sweep -- not just overlapping N1 ordering defense.
  it('N2: a control character (tab) in the senderId is skipped, allowFrom/invites untouched', () => {
    setup('victim\twith-tab')
    const accessBefore = readFileSync(join(chDir, 'access.json'), 'utf-8')
    const invitesBefore = readFileSync(join(chDir, 'invites.json'), 'utf-8')
    expect(() => runInviteMonitorTick('nonexistent-main-agent-for-test', agentsRoot)).not.toThrow()
    expect(readFileSync(join(chDir, 'access.json'), 'utf-8')).toBe(accessBefore)
    expect(readFileSync(join(chDir, 'invites.json'), 'utf-8')).toBe(invitesBefore)
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
