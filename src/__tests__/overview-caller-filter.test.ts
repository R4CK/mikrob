// O1 (RedHat 17520 on 9655494c, card ddeb2e17): GET /api/overview handed back the fleet-wide
// activity feed (6 newest memory snippets + 4 newest agent-message bodies) to ANY authenticated
// caller, including a per-agent device key. Once agent keys are actually issued, that lets agent
// A read agent B's private memory content and B's inter-agent message bodies through A's OWN
// key. These pin the fix: a device-scoped agent key only sees its own rows; a dashboard
// token/session caller (the human operator) is unaffected.
import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest'
import { initDatabase, saveAgentMemory, createAgentMessage } from '../db.js'
import { tryHandleOverview } from '../web/routes/overview.js'
import type { RouteContext } from '../web/routes/types.js'

vi.mock('../config.js', async () => {
  const actual = await vi.importActual<typeof import('../config.js')>('../config.js')
  return { ...actual, MAIN_AGENT_ID: 'mikrob', OLLAMA_URL: '' }
})

vi.mock('../logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() },
}))

vi.mock('../web/agent-config.js', () => ({
  listAgentNames: () => [],
  agentDir: (name: string) => `/tmp/nonexistent-${name}`,
  readAgentDisplayName: (name: string) => name,
}))

vi.mock('../web/update-checker.js', () => ({
  getUpdateStatus: () => ({ current: '', latest: '', behind: 0, commits: [], remote: '', lastChecked: 0, repos: [] }),
}))

vi.mock('../web/user-turn-index.js', () => ({
  refreshUserTurnIndex: () => ({ days: {} }),
  turnsOnDay: () => 0,
}))

function makeCtx(pathWithQuery: string, auth?: RouteContext['auth']): { ctx: RouteContext; getBody: () => any } {
  const url = new URL(`http://localhost:3420${pathWithQuery}`)
  let responseBody = ''
  const res = {
    writeHead: () => {},
    end: (body?: Buffer | string) => { responseBody = body ? body.toString() : '' },
    setHeader: () => {},
  }
  return {
    ctx: { req: { headers: {} } as any, res: res as any, path: url.pathname, method: 'GET', url, auth },
    getBody: () => (responseBody ? JSON.parse(responseBody) : null),
  }
}

beforeAll(() => {
  initDatabase(':memory:')
  saveAgentMemory('victim', 'victim private memory content, should not leak cross-agent', 'hot', 'secret')
  saveAgentMemory('attacker', 'attacker own memory content', 'hot', 'own')
  createAgentMessage('victim', 'someone-else', 'a private message body belonging to victim')
  createAgentMessage('attacker', 'someone-else', 'attacker own message body')
})

afterAll(() => { vi.restoreAllMocks() })

describe('GET /api/overview -- caller-boundary on the activity feed (O1, card ddeb2e17)', () => {
  it('an agent device key does NOT see another agent\'s memory/message content in activity', async () => {
    const { ctx, getBody } = makeCtx('/api/overview', { kind: 'device', device: 'agent:attacker' })
    const handled = await tryHandleOverview(ctx)
    expect(handled).toBe(true)
    const body = getBody()
    const activityText = JSON.stringify(body.activity)
    expect(activityText).not.toContain('victim private memory content')
    expect(activityText).not.toContain('a private message body belonging to victim')
  })

  it('the owning agent device key still sees its OWN memory/message content', async () => {
    const { ctx, getBody } = makeCtx('/api/overview', { kind: 'device', device: 'agent:attacker' })
    const handled = await tryHandleOverview(ctx)
    expect(handled).toBe(true)
    const activityText = JSON.stringify(getBody().activity)
    expect(activityText).toContain('attacker own memory content')
    expect(activityText).toContain('attacker own message body')
  })

  // Backward-compat pin: a shared dashboard-token caller (the human operator) keeps today's
  // fleet-wide feed -- this card narrows only the per-agent device-key case.
  it('a shared dashboard-token caller (no device key) is UNCHANGED -- sees the fleet-wide feed', async () => {
    const { ctx, getBody } = makeCtx('/api/overview', { kind: 'token' })
    const handled = await tryHandleOverview(ctx)
    expect(handled).toBe(true)
    const activityText = JSON.stringify(getBody().activity)
    expect(activityText).toContain('victim private memory content')
  })

  it('no auth at all is also UNCHANGED (ungated/legacy call shape) -- still the fleet-wide feed', async () => {
    const { ctx, getBody } = makeCtx('/api/overview')
    const handled = await tryHandleOverview(ctx)
    expect(handled).toBe(true)
    const activityText = JSON.stringify(getBody().activity)
    expect(activityText).toContain('victim private memory content')
  })
})
