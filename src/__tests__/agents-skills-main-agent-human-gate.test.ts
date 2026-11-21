// Card b3b73630 (Cybersec F1, comment 31601 on 7c79badc): skillsRootFor(MAIN_AGENT_ID) is the
// GLOBAL ~/.claude/skills root every agent loads. POST /api/agents/<MAIN_AGENT_ID>/skills had no
// auth-kind check at all -- the shared bearer every fleet agent holds could write there (measured
// 200 + file landed on base e1f43d02c / Gate-SHA 8bb6abcb3). Fix: require the same human
// credential as the dashboard's existing rejectIfNotHumanAuth gate (auth.ts:124) for the
// MAIN_AGENT_ID target only; sub-agent targets keep current behaviour.
//
// Fixture isolation (MikroB report 2026-11-15): an earlier version of this test scaffolded a
// real agent dir (agents/b3b73630-subagent, with .claude/memory/.mcp.json) and wrote into the
// real ~/.claude/skills -- both PROJECT_ROOT/agents (shared with every other fleet-test run) and
// the operator's own global skills catalog. The stray dir tripped 6 guard-wiring tests ("every
// scaffolded agent has the guard") in unrelated suite runs and blocked two lands. Everything the
// route or scaffoldAgentDir touches on disk is redirected into disposable mkdtemp roots below --
// never into PROJECT_ROOT/agents or the real homedir.
import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest'
import { EventEmitter } from 'node:events'
import { existsSync, rmSync, mkdirSync, mkdtempSync, writeFileSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { execFileSync } from 'node:child_process'
import type { RouteContext } from '../web/routes/types.js'

const fakeHome = mkdtempSync(join(tmpdir(), 'b3b73630-fakehome-'))
const fakeAgentsRoot = mkdtempSync(join(tmpdir(), 'b3b73630-fakeagents-'))

vi.mock('node:os', async () => {
  const actual = await vi.importActual<typeof import('node:os')>('node:os')
  return { ...actual, homedir: () => fakeHome }
})
vi.mock('../config.js', async () => {
  const actual = await vi.importActual<typeof import('../config.js')>('../config.js')
  return { ...actual, MAIN_AGENT_ID: 'mikrob' }
})
vi.mock('../logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() },
}))
vi.mock('../agent.js', () => ({
  runAgent: vi.fn(async () => ({ text: '---\nname: probe\ndescription: probe\n---\n# probe\n', error: null })),
}))
vi.mock('../web/agent-config.js', () => ({
  agentDir: (name: string) => join(fakeAgentsRoot, name),
  agentConfigRoot: () => fakeAgentsRoot,
  listAgentNames: () => ['b3b73630-subagent'],
  readAgentCapabilities: () => [],
}))

const { tryHandleAgentsSkills } = await import('../web/routes/agents-skills.js')
const { scaffoldAgentDir } = await import('../web/agent-scaffold.js')
const { agentDir } = await import('../web/agent-config.js')

afterAll(() => {
  rmSync(fakeHome, { recursive: true, force: true })
  rmSync(fakeAgentsRoot, { recursive: true, force: true })
})

const SKILL_NAME = 'b3b73630-probe-skill'
const GLOBAL_SKILLS_DIR = join(fakeHome, '.claude', 'skills')
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

// Card b3b73630 (CYBERSEC NO-GO 31782): the import/delete gate tests below reuse the same
// GLOBAL_SKILLS_DIR / fakeHome fixture as the generate-route tests above.
function buildZip(entryName: string, skillMdContent: string): Buffer {
  const stageDir = mkdtempSync(join(tmpdir(), 'b3b73630-zip-'))
  const zipPath = join(stageDir, 'skill.zip')
  const py = `
import zipfile
with zipfile.ZipFile(${JSON.stringify(zipPath)}, 'w') as z:
    z.writestr(${JSON.stringify(`${entryName}/SKILL.md`)}, ${JSON.stringify(skillMdContent)})
`
  execFileSync('python3', ['-I', '-c', py])
  const data = readFileSync(zipPath)
  rmSync(stageDir, { recursive: true, force: true })
  return data
}

function fakeImportCtx(agentName: string, auth: RouteContext['auth'], zipData: Buffer): { ctx: RouteContext; out: { status: number; body: any } } {
  const out: { status: number; body: any } = { status: 0, body: null }
  const res: any = {
    writeHead(status: number) { out.status = status; return res },
    end(chunk?: string) { if (chunk) { try { out.body = JSON.parse(chunk) } catch { out.body = chunk } } },
  }
  const boundary = 'b3b73630boundary'
  const head = Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="skill.zip"\r\nContent-Type: application/zip\r\n\r\n`, 'binary')
  const tail = Buffer.from(`\r\n--${boundary}--\r\n`, 'binary')
  const body = Buffer.concat([head, zipData, tail])
  const req: any = new EventEmitter()
  req.headers = { 'content-type': `multipart/form-data; boundary=${boundary}` }
  const path = `/api/agents/${agentName}/skills/import`
  req.url = path
  const ctx = { req, res, path, method: 'POST', url: new URL(`http://localhost:3420${path}`), auth } as RouteContext
  setImmediate(() => {
    req.emit('data', body)
    req.emit('end')
  })
  return { ctx, out }
}

function fakeDeleteCtx(agentName: string, skillName: string, auth: RouteContext['auth']): { ctx: RouteContext; out: { status: number; body: any } } {
  const out: { status: number; body: any } = { status: 0, body: null }
  const res: any = {
    writeHead(status: number) { out.status = status; return res },
    end(chunk?: string) { if (chunk) { try { out.body = JSON.parse(chunk) } catch { out.body = chunk } } },
  }
  const req: any = new EventEmitter()
  req.headers = {}
  const path = `/api/agents/${agentName}/skills/${skillName}`
  req.url = path
  const ctx = { req, res, path, method: 'DELETE', url: new URL(`http://localhost:3420${path}`), auth } as RouteContext
  setImmediate(() => {
    req.emit('data', Buffer.alloc(0))
    req.emit('end')
  })
  return { ctx, out }
}

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

describe('POST /api/agents/<MAIN_AGENT_ID>/skills/import -- human-only gate (card b3b73630, CYBERSEC NO-GO 31782)', () => {
  const IMPORT_SKILL_NAME = 'b3b73630-import-skill'
  const IMPORT_SKILL_DIR = join(GLOBAL_SKILLS_DIR, IMPORT_SKILL_NAME)

  beforeEach(() => {
    rmSync(IMPORT_SKILL_DIR, { recursive: true, force: true })
  })

  it.each([
    ['the shared agent bearer (kind: token)', { kind: 'token' } as RouteContext['auth']],
    ['no auth principal at all', undefined],
    ['a federation peer credential', { kind: 'federation', peer: 'some-peer' } as RouteContext['auth']],
    ['an agent device key (agent:backend)', { kind: 'device', device: 'agent:backend', deviceId: 1 } as RouteContext['auth']],
  ])('refused, 403, with %s -- nothing extracted under ~/.claude/skills', async (_label, auth) => {
    const zip = buildZip(IMPORT_SKILL_NAME, '---\nname: probe\ndescription: probe\n---\n# probe\n')
    const { ctx, out } = fakeImportCtx('mikrob', auth, zip)
    expect(await tryHandleAgentsSkills(ctx)).toBe(true)
    expect(out.status).toBe(403)
    expect(existsSync(IMPORT_SKILL_DIR)).toBe(false)
  })

  it('a browser session -> 200, skill extracted', async () => {
    const zip = buildZip(IMPORT_SKILL_NAME, '---\nname: probe\ndescription: probe\n---\n# probe\n')
    const { ctx, out } = fakeImportCtx('mikrob', { kind: 'session', user: 'peti' }, zip)
    expect(await tryHandleAgentsSkills(ctx)).toBe(true)
    expect(out.status).toBe(200)
    expect(existsSync(join(IMPORT_SKILL_DIR, 'SKILL.md'))).toBe(true)
  })

  it('a non-agent device key (human phone/Bridge pairing) -> 200, skill extracted', async () => {
    const zip = buildZip(IMPORT_SKILL_NAME, '---\nname: probe\ndescription: probe\n---\n# probe\n')
    const { ctx, out } = fakeImportCtx('mikrob', { kind: 'device', device: "Peti's iPhone", deviceId: 2 }, zip)
    expect(await tryHandleAgentsSkills(ctx)).toBe(true)
    expect(out.status).toBe(200)
    expect(existsSync(join(IMPORT_SKILL_DIR, 'SKILL.md'))).toBe(true)
  })
})

describe('DELETE /api/agents/<MAIN_AGENT_ID>/skills/<name> -- human-only gate (card b3b73630, CYBERSEC NO-GO 31782)', () => {
  const DELETE_SKILL_NAME = 'b3b73630-delete-skill'
  const DELETE_SKILL_DIR = join(GLOBAL_SKILLS_DIR, DELETE_SKILL_NAME)

  beforeEach(() => {
    rmSync(DELETE_SKILL_DIR, { recursive: true, force: true })
    mkdirSync(DELETE_SKILL_DIR, { recursive: true })
    writeFileSync(join(DELETE_SKILL_DIR, 'SKILL.md'), '# probe\n')
  })

  it.each([
    ['the shared agent bearer (kind: token)', { kind: 'token' } as RouteContext['auth']],
    ['no auth principal at all', undefined],
    ['a federation peer credential', { kind: 'federation', peer: 'some-peer' } as RouteContext['auth']],
    ['an agent device key (agent:backend)', { kind: 'device', device: 'agent:backend', deviceId: 1 } as RouteContext['auth']],
  ])('refused, 403, with %s -- the skill is not removed', async (_label, auth) => {
    const { ctx, out } = fakeDeleteCtx('mikrob', DELETE_SKILL_NAME, auth)
    expect(await tryHandleAgentsSkills(ctx)).toBe(true)
    expect(out.status).toBe(403)
    expect(existsSync(DELETE_SKILL_DIR)).toBe(true)
  })

  it('a browser session -> 200, skill removed', async () => {
    const { ctx, out } = fakeDeleteCtx('mikrob', DELETE_SKILL_NAME, { kind: 'session', user: 'peti' })
    expect(await tryHandleAgentsSkills(ctx)).toBe(true)
    expect(out.status).toBe(200)
    expect(existsSync(DELETE_SKILL_DIR)).toBe(false)
  })

  it('a non-agent device key (human phone/Bridge pairing) -> 200, skill removed', async () => {
    const { ctx, out } = fakeDeleteCtx('mikrob', DELETE_SKILL_NAME, { kind: 'device', device: "Peti's iPhone", deviceId: 2 })
    expect(await tryHandleAgentsSkills(ctx)).toBe(true)
    expect(out.status).toBe(200)
    expect(existsSync(DELETE_SKILL_DIR)).toBe(false)
  })
})

describe('POST /api/agents/<sub-agent>/skills -- unaffected by the main-agent gate (card b3b73630)', () => {
  beforeEach(() => {
    scaffoldAgentDir(SUB_AGENT)
  })

  afterAll(() => {
    rmSync(agentDir(SUB_AGENT), { recursive: true, force: true })
  })

  it('the shared agent bearer still works for a sub-agent target (unchanged behaviour)', async () => {
    const skillDir = join(agentDir(SUB_AGENT), '.claude', 'skills', SKILL_NAME)
    rmSync(skillDir, { recursive: true, force: true })
    const { ctx, out } = fakeCtx(SUB_AGENT, { kind: 'token' }, { name: SKILL_NAME, description: 'probe' })
    expect(await tryHandleAgentsSkills(ctx)).toBe(true)
    expect(out.status).toBe(200)
    expect(existsSync(join(skillDir, 'SKILL.md'))).toBe(true)
  })
})
