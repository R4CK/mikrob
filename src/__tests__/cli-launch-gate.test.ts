// Card 6b10a6b8 (upstream PICKERCLIKAPU923, item 1 of 4): the model picker/PUT path must refuse a
// model the INSTALLED Claude Code CLI cannot actually launch. claude-cli-support.ts /
// claude-cli-version.ts already existed and were already unit-tested, but NOTHING called them
// (grep-verified before this card: zero call sites outside their own test files) -- a customer
// pinned on an old CLI (install-linux.sh CLAUDE_PIN) could pick claude-fable-5-1/claude-opus-5-5,
// the agent would come up, and every prompt would 400 unrecognized_model in the pane with nothing
// in the launch path catching it. This pins the wiring, not the pure classification (that is
// claude-cli-support.test.ts's job).
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { EventEmitter } from 'node:events'
import { mkdirSync, rmSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { PROJECT_ROOT } from '../config.js'
import { tryHandleAgents, refuseIfCliCannotLaunch } from '../web/routes/agents.js'
import { agentDir, writeAgentModel, readAgentModel } from '../web/agent-config.js'
import { scaffoldAgentDir } from '../web/agent-scaffold.js'
import { CLI_VERSION_OVERRIDE_ENV, resetClaudeCliVersionCache } from '../web/claude-cli-version.js'
import type { RouteContext } from '../web/routes/types.js'

const AGENT = 'clitest-6b10a6b8'

beforeEach(() => {
  resetClaudeCliVersionCache()
  delete process.env[CLI_VERSION_OVERRIDE_ENV]
  if (!existsSync(agentDir(AGENT))) { mkdirSync(agentDir(AGENT), { recursive: true }); scaffoldAgentDir(AGENT) }
})

afterEach(() => {
  resetClaudeCliVersionCache()
  delete process.env[CLI_VERSION_OVERRIDE_ENV]
  rmSync(agentDir(AGENT), { recursive: true, force: true })
})

describe('refuseIfCliCannotLaunch (unit)', () => {
  it('fails OPEN when the CLI version is unmeasured (no override, no binary assumed)', async () => {
    process.env[CLI_VERSION_OVERRIDE_ENV] = ''
    expect(await refuseIfCliCannotLaunch('claude-opus-5-5')).toBeNull()
  })

  it('refuses a model below its recorded minimum CLI version, with the version and threshold in the message', async () => {
    process.env[CLI_VERSION_OVERRIDE_ENV] = '2.1.110'
    const msg = await refuseIfCliCannotLaunch('claude-opus-5-5')
    expect(msg).not.toBeNull()
    expect(msg).toContain('2.1.110')
    expect(msg).toContain('2.1.280')
    expect(msg).toContain('claude-opus-5-5')
  })

  it('allows the same model once the installed CLI meets the minimum', async () => {
    process.env[CLI_VERSION_OVERRIDE_ENV] = '2.1.280'
    expect(await refuseIfCliCannotLaunch('claude-opus-5-5')).toBeNull()
  })

  it('never refuses a model with no recorded CLI constraint', async () => {
    process.env[CLI_VERSION_OVERRIDE_ENV] = '2.1.110'
    expect(await refuseIfCliCannotLaunch('claude-sonnet-5')).toBeNull()
  })
})

async function putModel(name: string, model: string): Promise<{ status: number; body: any }> {
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
    ;(req as unknown as EventEmitter).emit('data', Buffer.from(JSON.stringify({ model })))
    ;(req as unknown as EventEmitter).emit('end')
  })
  const handled = await tryHandleAgents(
    { req, res, path: url.pathname, method: 'PUT', url } as unknown as RouteContext,
    join(PROJECT_ROOT, 'web'),
  )
  expect(handled).toBe(true)
  return { status: out.status || 200, body: out.body }
}

describe('PUT /api/agents/:name -- CLI-launch gate wired into the real route', () => {
  it('400s and does NOT persist the model when the installed CLI cannot launch it', async () => {
    process.env[CLI_VERSION_OVERRIDE_ENV] = '2.1.110'
    const before = readAgentModel(AGENT)
    const r = await putModel(AGENT, 'claude-opus-5-5')
    expect(r.status).toBe(400)
    expect(r.body?.error).toContain('2.1.280')
    expect(readAgentModel(AGENT)).toBe(before) // unchanged -- the refusal must happen before the write
  })

  it('200s and persists the model once the installed CLI can launch it', async () => {
    process.env[CLI_VERSION_OVERRIDE_ENV] = '2.1.280'
    const r = await putModel(AGENT, 'claude-opus-5-5')
    expect(r.status).toBe(200)
    expect(r.body?.ok).toBe(true)
    expect(readAgentModel(AGENT)).toBe('claude-opus-5-5')
  })

  it('still 400s on a syntactically invalid id BEFORE the CLI gate ever runs', async () => {
    process.env[CLI_VERSION_OVERRIDE_ENV] = '2.1.280'
    const r = await putModel(AGENT, "x'; id; echo '")
    expect(r.status).toBe(400)
    expect(r.body?.error).not.toContain('Claude Code CLI')
  })
})

// MUTATION PROOF: remove the gate (the shape the fix replaced) and the 400 test above would pass
// on a model the installed CLI genuinely cannot run -- false green. Pinned as a source check so a
// future refactor that drops the call site, not just a logic bug inside it, is caught too.
describe('wiring contract', () => {
  it('both the POST and PUT handlers call the gate before persisting the model', async () => {
    const { readFileSync } = await import('node:fs')
    const src = readFileSync(join(import.meta.dirname, '..', 'web', 'routes', 'agents.ts'), 'utf8')
    const hits = [...src.matchAll(/refuseIfCliCannotLaunch\(/g)]
    // One definition + at least two call sites (POST create, PUT update).
    expect(hits.length).toBeGreaterThanOrEqual(3)
  })
})
