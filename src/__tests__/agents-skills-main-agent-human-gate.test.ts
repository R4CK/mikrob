// Card b3b73630 (Cybersec F1, comment 31601 on 7c79badc): skillsRootFor(MAIN_AGENT_ID) is the
// GLOBAL ~/.claude/skills root every agent loads. POST /api/agents/<MAIN_AGENT_ID>/skills had no
// auth-kind check at all -- the shared bearer every fleet agent holds could write there (measured
// 200 + file landed on base e1f43d02c / Gate-SHA 8bb6abcb3). Fix: require the same human
// credential as the dashboard's existing rejectIfNotHumanAuth gate (auth.ts:124) for the
// MAIN_AGENT_ID target only; sub-agent targets keep current behaviour.
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { EventEmitter } from 'node:events'
import { existsSync, rmSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { tryHandleAgentsSkills } from '../web/routes/agents-skills.js'
import { scaffoldAgentDir } from '../web/agent-scaffold.js'
import { agentDir } from '../web/agent-config.js'
import type { RouteContext } from '../web/routes/types.js'

vi.mock('../config.js', async () => {
  const actual = await vi.importActual<typeof import('../config.js')>('../config.js')
  return { ...actual, MAIN_AGENT_ID: 'mikrob' }
})
vi.mock('../logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() },
}))

const SKILL_NAME = 'b3b73630-probe-skill'
const GLOBAL_SKILLS_DIR = join(homedir(), '.claude', 'skills')
const GLOBAL_SKILL_DIR = join(GLOBAL_SKILLS_DIR, SKILL_NAME)
const SUB_AGENT = 'b3b73630-subagent'

function fakeCtx(agentName: string, auth: RouteContext['auth'], body: unknown): { ctx: RouteContext; out: { status: number; body: any } } {
  const out: { status: number; body: any } = { status: 0, body: null }
  const res: any = {
    writeHead(status: number) { out.status = status; return res },
    end(chunk?: string) { if (chunk) { try { out.body = JSON.parse(chunk) } catch { out.body = chunk } } },
  }
  const req: any = new EventEmitter()
  req.headers = { 'content-type': 'application/json' }
  const path = `/api/agents/${agentName}/skills`
  req.url = path
  const ctx = { req, res, path, method: 'POST', url: new URL(`http://localhost:3420${path}`), auth } as RouteContext
  setImmediate(() => {
    req.emit('data', Buffer.from(JSON.stringify(body)))
    req.emit('end')
  })
  return { ctx, out }
}

beforeEach(() => {
  rmSync(GLOBAL_SKILL_DIR, { recursive: true, force: true })
})

describe('POST /api/agents/<MAIN_AGENT_ID>/skills -- human-only gate (card b3b73630)', () => {
  it.each([
    ['the shared agent bearer (kind: token)', { kind: 'token' } as RouteContext['auth']],
    ['no auth principal at all', undefined],
    ['a federation peer credential', { kind: 'federation', peer: 'some-peer' } as RouteContext['auth']],
    ['an agent device key (agent:backend)', { kind: 'device', device: 'agent:backend', deviceId: 1 } as RouteContext['auth']],
  ])('refused, 403, with %s -- nothing written under ~/.claude/skills', async (_label, auth) => {
    const { ctx, out } = fakeCtx('mikrob', auth, { name: SKILL_NAME, description: 'probe' })
    expect(await tryHandleAgentsSkills(ctx)).toBe(true)
    expect(out.status).toBe(403)
    expect(existsSync(GLOBAL_SKILL_DIR)).toBe(false)
  })

  it('a browser session -> 200, skill written (dashboard generate button keeps working)', async () => {
    const { ctx, out } = fakeCtx('mikrob', { kind: 'session', user: 'peti' }, { name: SKILL_NAME, description: 'probe' })
    expect(await tryHandleAgentsSkills(ctx)).toBe(true)
    expect(out.status).toBe(200)
    expect(existsSync(join(GLOBAL_SKILL_DIR, 'SKILL.md'))).toBe(true)
  })

  it('a non-agent device key (human phone/Bridge pairing) -> 200, skill written', async () => {
    const { ctx, out } = fakeCtx('mikrob', { kind: 'device', device: "Peti's iPhone", deviceId: 2 }, { name: SKILL_NAME, description: 'probe' })
    expect(await tryHandleAgentsSkills(ctx)).toBe(true)
    expect(out.status).toBe(200)
    expect(existsSync(join(GLOBAL_SKILL_DIR, 'SKILL.md'))).toBe(true)
  })

  it('MUTATION PIN: existing skill name -> 409, even for a human session', async () => {
    mkdirSync(GLOBAL_SKILL_DIR, { recursive: true })
    const { ctx, out } = fakeCtx('mikrob', { kind: 'session', user: 'peti' }, { name: SKILL_NAME, description: 'probe' })
    expect(await tryHandleAgentsSkills(ctx)).toBe(true)
    expect(out.status).toBe(409)
  })
})

describe('POST /api/agents/<sub-agent>/skills -- unaffected by the main-agent gate (card b3b73630)', () => {
  beforeEach(() => {
    scaffoldAgentDir(SUB_AGENT)
  })

  it('the shared agent bearer still works for a sub-agent target (unchanged behaviour)', async () => {
    const skillDir = join(agentDir(SUB_AGENT), '.claude', 'skills', SKILL_NAME)
    rmSync(skillDir, { recursive: true, force: true })
    const { ctx, out } = fakeCtx(SUB_AGENT, { kind: 'token' }, { name: SKILL_NAME, description: 'probe' })
    expect(await tryHandleAgentsSkills(ctx)).toBe(true)
    expect(out.status).toBe(200)
    expect(existsSync(join(skillDir, 'SKILL.md'))).toBe(true)
    rmSync(skillDir, { recursive: true, force: true })
  })
})
