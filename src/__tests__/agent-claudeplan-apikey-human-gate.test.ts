// Card 6eca461e (RedHat N2 on the 93ed929a re-gate): PUT /api/agents/:name's claudePlan and
// apiKey fields had NO principal gate at all -- the shared fleet dashboard bearer every agent
// holds could redirect which Claude plan/credential an agent launches with. Same human-only
// posture (and the same rejectIfNotHumanAuth helper, now in auth.ts) as the claude-plans route
// itself (card 93ed929a, see claude-plans-routes.test.ts for that route's own gate tests).
//
// Every other PUT field (claudeMd, model, customProvider, ...) is OUT OF SCOPE here -- see
// agent-custom-provider-field.test.ts, which still exercises customProvider with no auth at all
// and must keep passing unchanged.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { EventEmitter } from 'node:events'
import { mkdirSync, rmSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { PROJECT_ROOT } from '../config.js'
import { tryHandleAgents } from '../web/routes/agents.js'
import { agentDir, readAgentClaudePlan } from '../web/agent-config.js'
import { scaffoldAgentDir } from '../web/agent-scaffold.js'
import type { RouteContext } from '../web/routes/types.js'

const AGENT = 'gatetest-6eca461e'

const vaultSecrets = new Map<string, string>()
vi.mock('../web/vault.js', () => ({
  getSecret: (id: string) => vaultSecrets.get(id) ?? null,
  setSecret: (id: string, _label: string, value: string) => { vaultSecrets.set(id, value) },
  deleteSecret: (id: string) => vaultSecrets.delete(id),
  listSecrets: () => [...vaultSecrets.entries()].map(([id, value]) => ({ id, label: id, value })),
}))

beforeEach(() => {
  if (!existsSync(agentDir(AGENT))) { mkdirSync(agentDir(AGENT), { recursive: true }); scaffoldAgentDir(AGENT) }
  vaultSecrets.clear()
})

afterEach(() => {
  rmSync(agentDir(AGENT), { recursive: true, force: true })
})

async function putAgent(
  body: Record<string, unknown>,
  auth?: { kind: 'token' | 'session' | 'federation' | 'device'; device?: string },
): Promise<{ status: number; body: any }> {
  const req = new EventEmitter() as unknown as RouteContext['req']
  ;(req as unknown as { headers: Record<string, string> }).headers = {}
  const out: { status: number; body: any } = { status: 0, body: null }
  const res = {
    writeHead(status: number) { out.status = status; return res },
    end(chunk?: string) { if (chunk) out.body = JSON.parse(chunk) },
    setHeader() {},
  }
  const url = new URL(`http://localhost:3420/api/agents/${encodeURIComponent(AGENT)}`)
  process.nextTick(() => {
    ;(req as unknown as EventEmitter).emit('data', Buffer.from(JSON.stringify(body)))
    ;(req as unknown as EventEmitter).emit('end')
  })
  const handled = await tryHandleAgents(
    { req, res, path: url.pathname, method: 'PUT', url, auth } as unknown as RouteContext,
    join(PROJECT_ROOT, 'web'),
  )
  expect(handled).toBe(true)
  return { status: out.status || 200, body: out.body }
}

describe('PUT /api/agents/:name -- claudePlan requires a human credential (card 6eca461e)', () => {
  it.each([
    ['the shared agent bearer (kind: token)', { kind: 'token' } as const],
    ['no auth principal at all', undefined],
    ['an agent-issued device key (agent:qa)', { kind: 'device', device: 'agent:qa' } as const],
  ])('rejected (403) for %s, nothing written', async (_label, auth) => {
    const r = await putAgent({ claudePlan: '' }, auth)
    expect(r.status).toBe(403)
    expect(r.body?.error).toContain('browser session or a device key')
  })

  it('succeeds for a real session', async () => {
    const r = await putAgent({ claudePlan: '' }, { kind: 'session' })
    expect(r.status).toBe(200)
  })

  it('succeeds for a non-agent device key (phone pairing)', async () => {
    const r = await putAgent({ claudePlan: '' }, { kind: 'device', device: 'phone' })
    expect(r.status).toBe(200)
  })

  // MUTATION PIN: with rejectIfNotHumanAuth removed from this block, the shared-token request
  // would instead succeed (200) and actually clear/write the stored claudePlan.
  it('MUTATION PIN: the rejection is specifically the auth gate, not an unrelated 400', async () => {
    const r = await putAgent({ claudePlan: '' }, { kind: 'token' })
    expect(r.status).toBe(403)
    expect(readAgentClaudePlan(AGENT)).toBeNull()
  })
})

describe('PUT /api/agents/:name -- apiKey requires a human credential (card 6eca461e)', () => {
  it.each([
    ['the shared agent bearer (kind: token)', { kind: 'token' } as const],
    ['no auth principal at all', undefined],
    ['an agent-issued device key (agent:qa)', { kind: 'device', device: 'agent:qa' } as const],
  ])('rejected (403) for %s, no secret written', async (_label, auth) => {
    const r = await putAgent({ authMode: 'api', apiKey: 'sk-should-not-land' }, auth)
    expect(r.status).toBe(403)
    expect(vaultSecrets.has(`agent-${AGENT}-api-key`)).toBe(false)
  })

  it('succeeds for a real session and the key is stored', async () => {
    const r = await putAgent({ authMode: 'api', apiKey: 'sk-legit' }, { kind: 'session' })
    expect(r.status).toBe(200)
    expect(vaultSecrets.get(`agent-${AGENT}-api-key`)).toBe('sk-legit')
  })

  // MUTATION PIN: with rejectIfNotHumanAuth removed from this block, the shared-token request
  // would instead succeed (200) and actually store the forged key in the vault.
  it('MUTATION PIN: the rejection is specifically the auth gate, not an unrelated failure', async () => {
    const r = await putAgent({ authMode: 'api', apiKey: 'sk-should-not-land' }, { kind: 'token' })
    expect(r.status).toBe(403)
    expect(r.body?.error).toContain('browser session or a device key')
    expect(vaultSecrets.size).toBe(0)
  })
})
