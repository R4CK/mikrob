// Card 96c00ee5 (split from 965b0b2b + 6b10a6b8's deferred customProvider item, part A only):
// readAgentCustomProvider/writeAgentCustomProvider + the customProvider field on AgentDetail/PUT.
// Pure string storage, same shape as claudePlan -- deliberately NO registry validation and NO
// launch-env wiring here: the registry (listCustomProviders()) and the actual launch path are a
// separate, security-reviewed card (f1800242), because today resolveProviderEnv() picks the
// provider purely from the MODEL STRING shape, and a half-built per-agent provider-selection field
// with no consumer is inert by design, not a gap in this card.
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { EventEmitter } from 'node:events'
import { mkdirSync, rmSync, existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { PROJECT_ROOT } from '../config.js'
import { tryHandleAgents } from '../web/routes/agents.js'
import { agentDir, agentConfigRoot, readAgentCustomProvider, writeAgentCustomProvider } from '../web/agent-config.js'
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

// Card 91188f92 (WhiteHat L1+L2, 96c00ee5; RedHat NO-GO comment 24687 on the first fix).
//
// RedHat's live repro: PUT {claudeMd: MARK, soulMd: MARK, customProvider: BAD} -> 400, but
// claudeMd/soulMd were persisted anyway in 6/6 bad-customProvider cases, because the first fix's
// type/format checks ran in the LAST block of the handler, after every earlier field (including
// claudeMd/soulMd) had already been written. Every 400 case below now sends claudeMd+soulMd
// alongside the bad customProvider and asserts both are UNCHANGED on disk afterward -- the
// original tests only asserted the status code and that customProvider itself stayed null, which
// is exactly why they passed on the partial-write code.
// Two DISTINCT values (baseline, then an attempted overwrite sent alongside the bad
// customProvider) so the assertion can actually detect a write -- writing the SAME value back is
// vacuous: it would read identically whether the handler wrote it again or never touched it.
const CLAUDEMD_BASELINE = 'BASELINE-MARK-CLAUDEMD-91188f92'
const SOULMD_BASELINE = 'BASELINE-MARK-SOULMD-91188f92'
const CLAUDEMD_ATTEMPT = 'ATTEMPTED-OVERWRITE-CLAUDEMD-91188f92'
const SOULMD_ATTEMPT = 'ATTEMPTED-OVERWRITE-SOULMD-91188f92'

function readPersonaFiles(name: string): { claudeMd: string; soulMd: string } {
  return {
    claudeMd: readFileSync(join(agentConfigRoot(name), 'CLAUDE.md'), 'utf-8'),
    soulMd: readFileSync(join(agentDir(name), 'SOUL.md'), 'utf-8'),
  }
}

async function expectRejectedCustomProviderLeavesPersonaUnchanged(customProvider: unknown): Promise<void> {
  await putAgent(AGENT, { claudeMd: CLAUDEMD_BASELINE, soulMd: SOULMD_BASELINE })
  const r = await putAgent(AGENT, { claudeMd: CLAUDEMD_ATTEMPT, soulMd: SOULMD_ATTEMPT, customProvider })
  expect(r.status).toBe(400)
  const persona = readPersonaFiles(AGENT)
  expect(persona.claudeMd).toBe(CLAUDEMD_BASELINE)
  expect(persona.soulMd).toBe(SOULMD_BASELINE)
  const g = await getAgent(AGENT)
  expect(g.body?.customProvider).toBeNull()
}

describe('PUT customProvider: type and format/length guard (card 91188f92)', () => {
  it('L1: a non-string value is rejected with 400, not a 500 after partial writes', async () => {
    await expectRejectedCustomProviderLeavesPersonaUnchanged(123)
  })

  it('L1: an object value is rejected with 400, nothing persisted', async () => {
    await expectRejectedCustomProviderLeavesPersonaUnchanged({})
  })

  it('L1: an array value is rejected with 400, nothing persisted', async () => {
    await expectRejectedCustomProviderLeavesPersonaUnchanged([])
  })

  it('L1: a boolean value is rejected with 400, nothing persisted', async () => {
    await expectRejectedCustomProviderLeavesPersonaUnchanged(true)
  })

  it('L1: an explicit null is still accepted as "clear"', async () => {
    await putAgent(AGENT, { customProvider: 'acme-llm' })
    const r = await putAgent(AGENT, { customProvider: null })
    expect(r.status).toBe(200)
    const g = await getAgent(AGENT)
    expect(g.body?.customProvider).toBeNull()
  })

  it('L2: an oversized string is rejected with 400, nothing persisted', async () => {
    await expectRejectedCustomProviderLeavesPersonaUnchanged('a'.repeat(1024 * 1024))
  })

  it('L2: a value with disallowed characters is rejected with 400, nothing persisted', async () => {
    await expectRejectedCustomProviderLeavesPersonaUnchanged('has spaces/slashes')
  })
})
