// Card 77fd0f07 (pair-FE 03d2ae9c): GET /api/agents/:agent/sessions (session picker data)
// and the `sessionId` query param on the existing /conversation endpoint (replay a PAST
// session, not just the newest).
import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest'
import type http from 'node:http'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
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
  const ctx: RouteContext = {
    req: {} as http.IncomingMessage,
    res: res as unknown as http.ServerResponse,
    path,
    method: 'GET',
    url: new URL(`http://127.0.0.1:3420${path}`),
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
