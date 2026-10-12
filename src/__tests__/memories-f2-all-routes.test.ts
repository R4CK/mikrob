// Card 9655494c F2 -- device-key boundary on every memory route (RedHat NO-GO 17305).
// Real tryHandleMemories, real mintAgentDeviceKey + resolveDeviceKey, in-memory DB.
// 14 cases: 7 security (attacker with own key cannot touch victim's data),
// 5 owner-works (victim key reaches own data), 2 controls (shared-token unchanged).
import { describe, it, expect, vi, beforeAll } from 'vitest'
import { EventEmitter } from 'node:events'
import { initDatabase, saveAgentMemory, saveFailedEpisode, getDb } from '../db.js'
import { tryHandleMemories } from '../web/routes/memories.js'
import { mintAgentDeviceKey, resolveDeviceKey } from '../web/auth-device-keys.js'

vi.mock('../config.js', async () => {
  const actual = await vi.importActual<typeof import('../config.js')>('../config.js')
  return { ...actual, MAIN_AGENT_ID: 'agent-a', ALLOWED_CHAT_ID: 'test-chat', OLLAMA_URL: '' }
})
vi.mock('../logger.js', () => ({ logger: { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() } }))

function call(pathWithQuery: string, method: string, auth: any, body?: unknown) {
  const url = new URL(`http://localhost:3420${pathWithQuery}`)
  let out = ''
  let code = 200
  const res: any = { writeHead: (c: number) => { code = c }, end: (b?: string) => { out = b || '' }, setHeader: () => {} }
  const req: any = new EventEmitter()
  req.headers = {}
  req.destroy = () => {}
  const ctx: any = { req, res, path: url.pathname, method, url, auth }
  const p = tryHandleMemories(ctx)
  if (body !== undefined) setImmediate(() => { req.emit('data', Buffer.from(JSON.stringify(body))); req.emit('end') })
  else setImmediate(() => req.emit('end'))
  return p.then((handled) => ({ handled, code, text: out, json: out ? (() => { try { return JSON.parse(out) } catch { return null } })() : null }))
}

let victimMem = 0
let victimMem2 = 0
let attackerAuth: any
let victimAuth: any
const MARK = 'VICTIM-PRIVATE-MARKER-F2'

beforeAll(() => {
  initDatabase(':memory:')
  victimMem = saveAgentMemory('victim', `${MARK} private hot content`, 'hot', 'secret').id
  victimMem2 = saveAgentMemory('victim', `${MARK} second private row`, 'warm', 'secret2').id
  saveAgentMemory('attacker', 'attacker own row', 'hot', 'own')
  saveFailedEpisode({ agentId: 'victim', task: `${MARK} task`, attempt: 'a', error: 'e', lesson: 'l', keywords: 'k' })
  const ka = mintAgentDeviceKey('attacker'); const pa = resolveDeviceKey(ka.key)!
  attackerAuth = { kind: 'device', device: pa.name, deviceId: pa.id }
  const kv = mintAgentDeviceKey('victim'); const pv = resolveDeviceKey(kv.key)!
  victimAuth = { kind: 'device', device: pv.name, deviceId: pv.id }
})

const row = (id: number) => getDb().prepare('SELECT id, agent_id, content FROM memories WHERE id = ?').get(id) as any

// ── Security: attacker key must NOT reach victim data ──────────────────────────

describe('F2 security: attacker device-key cannot access victim data', () => {
  it('GET failed-episodes ?agent=victim is scoped to attacker', async () => {
    const r = await call('/api/memories/failed-episodes?agent=victim', 'GET', attackerAuth)
    expect(JSON.stringify(r.json)).not.toContain(MARK)
  })

  it('GET recall-audit ?agent=victim is scoped to attacker', async () => {
    const r = await call('/api/memories/recall-audit?agent=victim', 'GET', attackerAuth)
    expect(JSON.stringify(r.json)).not.toContain(MARK)
    expect(JSON.stringify(r.json)).not.toContain('"agentId":"victim"')
  })

  it('GET stats does not expose victim in byAgent', async () => {
    const r = await call('/api/memories/stats', 'GET', attackerAuth)
    expect(Object.keys(r.json?.byAgent ?? {})).not.toContain('victim')
  })

  it('PUT /:id cannot overwrite victim row', async () => {
    await call(`/api/memories/${victimMem}`, 'PUT', attackerAuth, { content: 'OVERWRITTEN-BY-ATTACKER' })
    expect(row(victimMem)?.content).toContain(MARK)
  })

  it('PUT /:id cannot reassign victim row ownership', async () => {
    await call(`/api/memories/${victimMem2}`, 'PUT', attackerAuth, { content: `${MARK} second private row`, agent_id: 'attacker' })
    expect(row(victimMem2)?.agent_id).toBe('victim')
  })

  it('DELETE /:id cannot delete victim row', async () => {
    await call(`/api/memories/${victimMem}`, 'DELETE', attackerAuth)
    expect(row(victimMem)).toBeDefined()
  })

  it('POST failed-episode with body agent_id=victim is stored under attacker', async () => {
    await call('/api/memories/failed-episode', 'POST', attackerAuth, { agent_id: 'victim', task: 'forged-fe-task', attempt: 'a', error: 'e', lesson: 'l' })
    const owner = getDb().prepare("SELECT agent_id FROM memories WHERE content LIKE '%forged-fe-task%'").get() as any
    expect(owner?.agent_id).toBe('attacker')
  })

  it('POST import with body agent_id=victim is stored under attacker', async () => {
    await call('/api/memories/import', 'POST', attackerAuth, { agent_id: 'victim', chunks: ['forged-import-chunk'] })
    const owner = getDb().prepare("SELECT agent_id FROM memories WHERE content LIKE '%forged-import-chunk%'").get() as any
    expect(owner?.agent_id).toBe('attacker')
  })
})

// ── Owner: victim key reaches victim's own data ────────────────────────────────

describe('F2 owner: victim device-key can read and write own data', () => {
  it('GET failed-episodes returns victim own episodes', async () => {
    const r = await call('/api/memories/failed-episodes?agent=ignored', 'GET', victimAuth)
    expect(JSON.stringify(r.json)).toContain(MARK)
  })

  it('GET recall-audit returns victim own audit', async () => {
    const r = await call('/api/memories/recall-audit', 'GET', victimAuth)
    // Just verifying it does not error (auditMemoryRecall may return empty if no recalls yet)
    expect(r.code).toBe(200)
  })

  it('GET stats returns only victim own counts', async () => {
    const r = await call('/api/memories/stats', 'GET', victimAuth)
    expect(Object.keys(r.json?.byAgent ?? {})).toContain('victim')
    expect(Object.keys(r.json?.byAgent ?? {})).not.toContain('attacker')
  })

  it('PUT /:id victim can update own row', async () => {
    const r = await call(`/api/memories/${victimMem}`, 'PUT', victimAuth, { content: `${MARK} updated by owner` })
    expect(r.code).toBe(200)
    expect(row(victimMem)?.content).toContain('updated by owner')
  })

  it('DELETE /:id victim can delete own row', async () => {
    const extra = saveAgentMemory('victim', `${MARK} to-delete`, 'cold', '').id
    const r = await call(`/api/memories/${extra}`, 'DELETE', victimAuth)
    expect(r.code).toBe(200)
    expect(row(extra)).toBeUndefined()
  })
})

// ── Controls: shared-token (no device) behaviour unchanged ────────────────────

describe('F2 controls: legacy shared token unchanged', () => {
  it('shared token can list victim rows', async () => {
    const r = await call('/api/memories?agent=victim', 'GET', undefined)
    expect(JSON.stringify(r.json)).toContain(MARK)
  })

  it('shared token gets global stats', async () => {
    const r = await call('/api/memories/stats', 'GET', undefined)
    // global stats include multiple agents
    expect(typeof r.json?.total).toBe('number')
    expect(r.json?.total).toBeGreaterThan(0)
  })
})
