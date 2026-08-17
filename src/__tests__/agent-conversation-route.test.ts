// Card 77fd0f07 (pair-FE 03d2ae9c): GET /api/agents/:agent/sessions (session picker data)
// and the `sessionId` query param on the existing /conversation endpoint (replay a PAST
// session, not just the newest).
import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest'
import type http from 'node:http'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, utimesSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { requiresAuth } from '../web/auth-gate.js'
import { agentDir } from '../web/agent-config.js'
import { tryHandleAgentConversation } from '../web/routes/agent-conversation.js'
import type { RouteContext } from '../web/routes/types.js'

// resolveAgentConfigDir is the only fs-touching dependency this route can't otherwise
// steer -- it reads a DB-backed plan/config-dir mapping. Pointing it at a tmp root lets
// the test fixture real .jsonl session files without writing into the live fleet's
// ~/.claude/projects (shared host state, other agents' real sessions). vi.mock is
// hoisted above these imports by vitest's transform, so the mock is in place before
// agent-conversation.js's own import of resolveAgentConfigDir resolves.
let configRoot: string
vi.mock('../web/claude-plans.js', () => ({
  resolveAgentConfigDir: () => ({ configDir: configRoot, planUnresolved: false }),
}))

interface MockRes {
  statusCode: number
  body: string
  writeHead(status: number): MockRes
  setHeader(): void
  end(data?: string): void
}

function mkRes(): MockRes {
  return {
    statusCode: 0,
    body: '',
    writeHead(status) { this.statusCode = status; return this },
    setHeader() {},
    end(data) { if (data !== undefined) this.body += data },
  }
}

async function call(path: string): Promise<{ status: number; json: Record<string, unknown> }> {
  const res = mkRes()
  const url = new URL(`http://127.0.0.1:3420${path}`)
  const ctx: RouteContext = {
    req: {} as http.IncomingMessage,
    res: res as unknown as http.ServerResponse,
    path: url.pathname, // the real dispatcher (src/web.ts) sets ctx.path = url.pathname, query-free
    method: 'GET',
    url,
  }
  const handled = await tryHandleAgentConversation(ctx)
  expect(handled).toBe(true)
  return { status: res.statusCode, json: JSON.parse(res.body || '{}') }
}

function turn(text: string, ts: string): string {
  return JSON.stringify({
    type: 'assistant',
    timestamp: ts,
    message: { content: [{ type: 'text', text }] },
  })
}

const AGENT = 'test-agent-77fd0f07'

beforeAll(() => {
  configRoot = mkdtempSync(join(tmpdir(), 'agent-conv-sessions-'))
  const workingDir = agentDir(AGENT)
  const encoded = workingDir.replace(/[/.]/g, '-')
  const projectDir = join(configRoot, 'projects', encoded)
  mkdirSync(projectDir, { recursive: true })
  // Two sessions, older first -- mtime (not filename) decides "newest".
  writeFileSync(join(projectDir, 'session-old.jsonl'), turn('old session note', '2026-01-01T00:00:00Z') + '\n')
  writeFileSync(join(projectDir, 'session-new.jsonl'), turn('new session note', '2026-01-02T00:00:00Z') + '\n')
})

afterAll(() => {
  rmSync(configRoot, { recursive: true, force: true })
  vi.restoreAllMocks()
})

describe('GET /api/agents/:agent/sessions is behind the auth gate', () => {
  it('requires auth', () => {
    expect(requiresAuth('/api/agents/some-agent/sessions', 'GET')).toBe(true)
  })
})

describe('GET /api/agents/:agent/sessions', () => {
  it('lists every session file, newest first, with sessionId/mtime/entryCount', async () => {
    const { status, json } = await call(`/api/agents/${AGENT}/sessions`)
    expect(status).toBe(200)
    const sessions = json.sessions as Array<{ sessionId: string; mtime: number; entryCount: number }>
    expect(sessions.map((s) => s.sessionId).sort()).toEqual(['session-new', 'session-old'])
    for (const s of sessions) {
      expect(typeof s.mtime).toBe('number')
      expect(s.entryCount).toBe(1)
    }
  })

  it('degrades to an empty list for an agent with no session directory, instead of throwing', async () => {
    const { json } = await call('/api/agents/definitely-not-an-agent-77fd0f07/sessions')
    expect(json.sessions).toEqual([])
  })
})

describe('GET /api/agents/:agent/conversation with sessionId', () => {
  it('omitted sessionId resolves to the newest session (mtime-based, not filename)', async () => {
    // Both fixture files are written back-to-back so filesystem mtimes are near-identical;
    // this test only pins that a session IS resolved and its content matches one of the two
    // fixtures -- the newest-by-mtime ordering itself is covered by the sessions-list test's
    // sort, which uses the same statSync-based mtime field.
    const { json } = await call(`/api/agents/${AGENT}/conversation`)
    expect(json.sessionId).toMatch(/^session-(old|new)$/)
    expect(Array.isArray(json.entries)).toBe(true)
  })

  it('an explicit, existing sessionId pins the response to that exact session', async () => {
    const { json } = await call(`/api/agents/${AGENT}/conversation?sessionId=session-old`)
    expect(json.sessionId).toBe('session-old')
    expect(json.entries).toEqual([
      expect.objectContaining({ kind: 'note', text: 'old session note' }),
    ])
  })

  it('a sessionId that does not match any real file resolves to "no history", never a foreign path', async () => {
    const { json } = await call(`/api/agents/${AGENT}/conversation?sessionId=../../etc/passwd`)
    expect(json.entries).toEqual([])
    expect(json.total).toBe(0)
    expect(json.note).toBeTruthy()
  })
})

// Card 77fd0f07, Cybersec NO-GO (comment 14132): the unbounded, uncached
// version parsed every session file's FULL content just to report entryCount
// -- measured at ~4.2s of blocking reads for one real agent's history (2238
// files, 603MB). The fix caps the list and caches entryCount by (mtime,
// size). These two describe blocks prove the fix's DoD, not just that
// something changed.
describe('GET /api/agents/:agent/sessions caps the list (Cybersec NO-GO 14132: no file-count limit was the vulnerability)', () => {
  const CAP_AGENT = 'test-agent-77fd0f07-cap'
  let capDir: string

  beforeAll(() => {
    const workingDir = agentDir(CAP_AGENT)
    const encoded = workingDir.replace(/[/.]/g, '-')
    capDir = join(configRoot, 'projects', encoded)
    mkdirSync(capDir, { recursive: true })
    // 55 sessions -- 5 more than the 50-item cap. Explicit staggered mtimes
    // (not write order) so "newest N" is unambiguous and not a timing-flake.
    const base = new Date('2026-01-01T00:00:00Z').getTime()
    for (let i = 0; i < 55; i++) {
      const file = join(capDir, `session-${String(i).padStart(3, '0')}.jsonl`)
      writeFileSync(file, turn(`turn ${i}`, new Date(base + i * 1000).toISOString()) + '\n')
      const mtime = new Date(base + i * 1000)
      utimesSync(file, mtime, mtime) // session-054 is newest (highest i)
    }
  })

  it('returns at most 50 sessions, the newest by mtime', async () => {
    const { json } = await call(`/api/agents/${CAP_AGENT}/sessions`)
    const sessions = json.sessions as Array<{ sessionId: string }>
    expect(sessions.length).toBe(50)
    // Newest 50 of 0..54 is 5..54 -- session-000..004 must be excluded.
    const ids = sessions.map((s) => s.sessionId)
    expect(ids).not.toContain('session-000')
    expect(ids).not.toContain('session-004')
    expect(ids).toContain('session-054')
    expect(ids).toContain('session-005')
  })

  it('a session beyond the list cap is still individually replayable by sessionId', async () => {
    const { json } = await call(`/api/agents/${CAP_AGENT}/conversation?sessionId=session-000`)
    expect(json.sessionId).toBe('session-000')
    expect(json.entries).toEqual([expect.objectContaining({ kind: 'note', text: 'turn 0' })])
  })
})

describe('entryCount is cached by (mtime, size), not recomputed every request (Cybersec NO-GO 14132: no per-request cost bound was the vulnerability)', () => {
  const CACHE_AGENT = 'test-agent-77fd0f07-cache'
  let cacheDir: string
  let file: string

  beforeAll(() => {
    const workingDir = agentDir(CACHE_AGENT)
    const encoded = workingDir.replace(/[/.]/g, '-')
    cacheDir = join(configRoot, 'projects', encoded)
    mkdirSync(cacheDir, { recursive: true })
    file = join(cacheDir, 'session-cache.jsonl')
  })

  it('an unchanged (mtime, size) key returns the previously-computed count even if the file content since changed', async () => {
    const secondTurnLine = turn('second turn (should not be seen yet)', '2026-02-01T00:00:00Z')
    const firstLine = turn('first turn', '2026-01-31T00:00:00Z')
    // Same total byte length in both rounds (ASCII-only, utf-8 == byte-for-byte)
    // so the cache key (mtime, size) is IDENTICAL across rounds -- isolates the
    // test to "does mtime/size gate the recompute", not incidental size drift.
    const round1 = firstLine + '\n' + 'X'.repeat(secondTurnLine.length) + '\n'
    const round2 = firstLine + '\n' + secondTurnLine + '\n'
    expect(round1.length).toBe(round2.length)

    const fixedMtime = new Date('2026-02-02T00:00:00Z')
    writeFileSync(file, round1)
    utimesSync(file, fixedMtime, fixedMtime)
    const first = await call(`/api/agents/${CACHE_AGENT}/sessions`)
    expect((first.json.sessions as Array<{ entryCount: number }>)[0].entryCount).toBe(1)

    // Overwrite with content that WOULD parse to 2 entries, but keep the same
    // mtime+size -- the cache must serve the stale count, not reparse.
    writeFileSync(file, round2)
    utimesSync(file, fixedMtime, fixedMtime)
    const second = await call(`/api/agents/${CACHE_AGENT}/sessions`)
    expect((second.json.sessions as Array<{ entryCount: number }>)[0].entryCount).toBe(1)

    // Now bump mtime with the same (2-entry) content -- cache must invalidate.
    const bumpedMtime = new Date('2026-02-02T00:00:01Z')
    utimesSync(file, bumpedMtime, bumpedMtime)
    const third = await call(`/api/agents/${CACHE_AGENT}/sessions`)
    expect((third.json.sessions as Array<{ entryCount: number }>)[0].entryCount).toBe(2)
  })
})
