/**
 * 0ad35f99 (WhiteHat GO b5e1d7df, Gate-SHA 0096cd69): memory-write-trace.test.ts
 * only calls updateMemory() directly with an `updated_by` argument -- it never
 * proves the PUT/PATCH route actually forwards the body's `updated_by` field
 * into that call. A route that silently dropped the field would leave that
 * test green. This test exercises the route itself.
 */
import { describe, it, expect, vi, beforeAll } from 'vitest'
import { Readable } from 'stream'
import { initDatabase, saveAgentMemory, getDb } from '../db.js'
import { tryHandleMemories } from '../web/routes/memories.js'
import type { RouteContext } from '../web/routes/types.js'

vi.mock('../config.js', async () => {
  const actual = await vi.importActual<typeof import('../config.js')>('../config.js')
  return { ...actual, MAIN_AGENT_ID: 'agent-a', ALLOWED_CHAT_ID: 'test-chat', OLLAMA_URL: '' }
})
vi.mock('../logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() },
}))

async function call(path: string, method: string, body?: unknown): Promise<{ status: number; body: any }> {
  const url = new URL(`http://localhost:3420${path}`)
  let responseBody = ''
  let statusCode = 200
  const res = {
    writeHead: (code: number) => { statusCode = code },
    setHeader: () => {},
    end: (b?: string) => { responseBody = b || '' },
  }
  const req = Readable.from(body === undefined ? [] : [Buffer.from(JSON.stringify(body))]) as any
  const ctx: RouteContext = { req, res: res as any, path, method, url }
  await tryHandleMemories(ctx)
  return { status: statusCode, body: responseBody ? JSON.parse(responseBody) : null }
}

function updatedByOf(id: number): string | null {
  return (getDb().prepare('SELECT updated_by FROM memories WHERE id = ?').get(id) as { updated_by: string | null }).updated_by
}

beforeAll(() => {
  initDatabase(':memory:')
})

describe('PUT/PATCH /api/memories/:id forwards updated_by to the write-trace', () => {
  it('PUT with updated_by stamps the row', async () => {
    const { id } = saveAgentMemory('agent-a', 'original', 'shared', 'k')
    const r = await call(`/api/memories/${id}`, 'PUT', { content: 'edited via PUT', updated_by: 'qa2' })
    expect(r.status).toBe(200)
    expect(updatedByOf(id)).toBe('qa2')
  })

  it('PATCH with updated_by stamps the row', async () => {
    const { id } = saveAgentMemory('agent-a', 'original', 'shared', 'k')
    const r = await call(`/api/memories/${id}`, 'PATCH', { content: 'edited via PATCH', updated_by: 'cybersec' })
    expect(r.status).toBe(200)
    expect(updatedByOf(id)).toBe('cybersec')
  })

  it('a prepend-only PATCH still forwards updated_by', async () => {
    const { id } = saveAgentMemory('agent-a', 'original', 'shared', 'k')
    const r = await call(`/api/memories/${id}`, 'PATCH', { prepend: '[note]', updated_by: 'fron-ted' })
    expect(r.status).toBe(200)
    expect(updatedByOf(id)).toBe('fron-ted')
  })

  it('omitting updated_by leaves the row unattributed (explicit NULL, not a leftover)', async () => {
    const { id } = saveAgentMemory('agent-a', 'original', 'shared', 'k')
    await call(`/api/memories/${id}`, 'PUT', { content: 'first edit', updated_by: 'mira' })
    const r = await call(`/api/memories/${id}`, 'PUT', { content: 'second edit' })
    expect(r.status).toBe(200)
    expect(updatedByOf(id)).toBeNull()
  })
})
