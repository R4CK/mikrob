// Card 96c00ee5 (split from 965b0b2b + 6b10a6b8's deferred customProvider item, part A only):
// readAgentCustomProvider/writeAgentCustomProvider + the customProvider field on AgentDetail/PUT.
// Pure string storage, same shape as claudePlan -- deliberately NO registry validation and NO
// launch-env wiring here: the registry (listCustomProviders()) and the actual launch path are a
// separate, security-reviewed card (f1800242), because today resolveProviderEnv() picks the
// provider purely from the MODEL STRING shape, and a half-built per-agent provider-selection field
// with no consumer is inert by design, not a gap in this card.
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { EventEmitter } from 'node:events'
import { mkdirSync, rmSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { PROJECT_ROOT } from '../config.js'
import { tryHandleAgents } from '../web/routes/agents.js'
import { agentDir, readAgentCustomProvider, writeAgentCustomProvider } from '../web/agent-config.js'
import { scaffoldAgentDir } from '../web/agent-scaffold.js'
import { checkAgentPutFields, AGENT_PUT_WRITABLE_FIELDS } from '../web/agent-put-fields.js'
import type { RouteContext } from '../web/routes/types.js'

const AGENT = 'custprovtest-96c00ee5'

beforeEach(() => {
  if (!existsSync(agentDir(AGENT))) { mkdirSync(agentDir(AGENT), { recursive: true }); scaffoldAgentDir(AGENT) }
})

afterEach(() => {
  rmSync(agentDir(AGENT), { recursive: true, force: true })
})

describe('readAgentCustomProvider / writeAgentCustomProvider (unit)', () => {
  it('defaults to null when never set', () => {
    expect(readAgentCustomProvider(AGENT)).toBeNull()
  })

  it('round-trips a set value', () => {
    writeAgentCustomProvider(AGENT, 'my-byo-endpoint')
    expect(readAgentCustomProvider(AGENT)).toBe('my-byo-endpoint')
  })

  it('trims whitespace on write and read', () => {
    writeAgentCustomProvider(AGENT, '  spaced-id  ')
    expect(readAgentCustomProvider(AGENT)).toBe('spaced-id')
  })

  it('clearing with an empty/whitespace string removes the key (back to null)', () => {
    writeAgentCustomProvider(AGENT, 'something')
    writeAgentCustomProvider(AGENT, '   ')
    expect(readAgentCustomProvider(AGENT)).toBeNull()
  })
})

describe('checkAgentPutFields accepts customProvider', () => {
  it('customProvider is in the writable-fields allowlist', () => {
    expect(AGENT_PUT_WRITABLE_FIELDS).toContain('customProvider')
  })

  it('a PUT body with only customProvider is accepted', () => {
    expect(checkAgentPutFields(AGENT, { customProvider: 'anything' }).ok).toBe(true)
  })
})

async function putAgent(name: string, body: Record<string, unknown>): Promise<{ status: number; body: any }> {
  const req = new EventEmitter() as unknown as RouteContext['req']
  ;(req as unknown as { headers: Record<string, string> }).headers = {}
  const out: { status: number; body: any } = { status: 0, body: null }
  const res = {
    writeHead(status: number) { out.status = status; return res },
    end(chunk?: string) { if (chunk) out.body = JSON.parse(chunk) },
    setHeader() {},
  }
  const url = new URL(`http://localhost:3420/api/agents/${encodeURIComponent(name)}`)
  process.nextTick(() => {
    ;(req as unknown as EventEmitter).emit('data', Buffer.from(JSON.stringify(body)))
    ;(req as unknown as EventEmitter).emit('end')
  })
  const handled = await tryHandleAgents(
    { req, res, path: url.pathname, method: 'PUT', url } as unknown as RouteContext,
    join(PROJECT_ROOT, 'web'),
  )
  expect(handled).toBe(true)
  return { status: out.status || 200, body: out.body }
}

async function getAgent(name: string): Promise<{ status: number; body: any }> {
  const req = new EventEmitter() as unknown as RouteContext['req']
  ;(req as unknown as { headers: Record<string, string> }).headers = {}
  const out: { status: number; body: any } = { status: 0, body: null }
  const res = {
    writeHead(status: number) { out.status = status; return res },
    end(chunk?: string) { if (chunk) out.body = JSON.parse(chunk) },
    setHeader() {},
  }
  const url = new URL(`http://localhost:3420/api/agents/${encodeURIComponent(name)}`)
  const handled = await tryHandleAgents(
    { req, res, path: url.pathname, method: 'GET', url } as unknown as RouteContext,
    join(PROJECT_ROOT, 'web'),
  )
  expect(handled).toBe(true)
  return { status: out.status || 200, body: out.body }
}

describe('PUT/GET /api/agents/:name -- customProvider wired into the real route', () => {
  it('200s and persists the field, visible on the next GET', async () => {
    const r = await putAgent(AGENT, { customProvider: 'acme-llm' })
    expect(r.status).toBe(200)
    expect(r.body?.ok).toBe(true)
    const g = await getAgent(AGENT)
    expect(g.body?.customProvider).toBe('acme-llm')
  })

  it('an empty string clears it back to null', async () => {
    await putAgent(AGENT, { customProvider: 'acme-llm' })
    await putAgent(AGENT, { customProvider: '' })
    const g = await getAgent(AGENT)
    expect(g.body?.customProvider).toBeNull()
  })

  it('GET defaults to null when never set', async () => {
    const g = await getAgent(AGENT)
    expect(g.body?.customProvider).toBeNull()
  })
})
