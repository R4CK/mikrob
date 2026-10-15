// PR2b route wiring: POST/PUT/DELETE /api/claude-plans and GET .../state.
// PR2c adds POST .../rotate, exercised through tryHandleClaudePlans() directly
// (mirrors approvals-notify.test.ts's fake req/res harness). PROJECT_ROOT
// points at a real temp dir so the CRUD round-trips through the actual
// atomic-write path. hardRestartMarveenChannels/restartAgentProcess are
// mocked -- this test must NEVER touch a real tmux session or process.
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { mkdtempSync, rmSync, existsSync, mkdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import type { RouteContext } from '../web/routes/types.js'

const tmpRoot = mkdtempSync(join(tmpdir(), 'marveen-claude-plans-routes-test-'))

vi.mock('../config.js', () => ({ PROJECT_ROOT: tmpRoot, MAIN_AGENT_ID: 'agent-a', DEFAULT_AGENT_MODEL: 'claude-opus-5' }))

let rotationEnabled = '0'
let fleetEnabled = false
let mainIsolated = '0'
vi.mock('../settings-store.js', () => ({
  getEffectiveSettingValue: (key: string) => {
    if (key === 'CLAUDE_ROTATION_ENABLED') return rotationEnabled
    if (key === 'MAIN_AGENT_ISOLATED_CONFIG') return mainIsolated
    if (key === 'CLAUDE_ROTATION_FLEET') return fleetEnabled ? '1' : '0'
    return ''
  },
}))

const hardRestartMarveenChannels = vi.fn((): { ok: boolean; error?: string } => ({ ok: true }))
vi.mock('../web/channel-monitor.js', () => ({ hardRestartMarveenChannels: () => hardRestartMarveenChannels() }))

const restartAgentProcess = vi.fn(
  async (name: string): Promise<{ ok: boolean; pid?: number; error?: string }> => { void name; return { ok: true, pid: 123 } },
)
vi.mock('../web/agent-process.js', () => ({ restartAgentProcess: (name: string) => restartAgentProcess(name) }))

// Fake vault: a plain in-memory Map, never touches the real encrypted store or
// macOS Keychain (see vault-master-key.test.ts for that machinery's own
// tests). This route's job is the PROMOTION lifecycle (raw token in -> vault
// reference out, cleaned up on failure/replacement/delete), not vault.ts
// itself.
const vaultSecrets = new Map<string, string>()
const setSecret = vi.fn((id: string, _label: string, value: string) => { vaultSecrets.set(id, value) })
const deleteSecret = vi.fn((id: string) => vaultSecrets.delete(id))
const getSecret = vi.fn((id: string) => vaultSecrets.get(id) ?? null)
vi.mock('../web/vault.js', () => ({ setSecret, deleteSecret, getSecret }))

// Fleet leg (CLAUDE_ROTATION_FLEET): its logic is tested in
// claude-plan-fleet-rotation.test.ts; here only "does the route start it, and
// only when the opt-in is on".
const runFleetLeg = vi.fn(async (plan: { id: string }) => { void plan; return null })
vi.mock('../web/claude-plan-fleet-wiring.js', () => ({
  runFleetLeg: (p: { id: string }) => runFleetLeg(p),
}))

const { tryHandleClaudePlans } = await import('../web/routes/claude-plans.js')
const { CLAUDE_PLANS_PATH } = await import('../web/claude-plans.js')
const { CLAUDE_PLANS_STATE_PATH } = await import('../web/claude-plans-state.js')

// Card 93ed929a: write/rotate now require a human credential (session or device key) --
// `auth` defaults to a session caller so every PRE-EXISTING test in this file (written before
// that gate existed) keeps exercising the actual CRUD/rotation logic unchanged. The negative
// tests for the gate itself pass `auth` explicitly.
//
// A default parameter substitutes on an explicit `undefined` argument JUST AS MUCH as on an
// omitted one -- `fakeCtx(a, b, c, undefined)` and `fakeCtx(a, b, c)` are indistinguishable to
// JS, both landing on the default. That makes a plain `= {kind:'session'}` default unable to
// express "no auth at all" (the PRODUCTION shape RedHat's N1 finding named -- web.ts hands the
// handler `ctx.auth === undefined` for a request with no principal, not `{}`). `null` is NOT
// substituted by a default parameter (only `undefined` is), so it is used here as the distinct
// "explicitly no auth" marker: omit the argument for the session default, pass `null` for a
// genuine `ctx.auth === undefined`.
function fakeCtx(
  method: string,
  path: string,
  body?: unknown,
  auth: { kind?: string; device?: string } | null = { kind: 'session' },
): { ctx: RouteContext; out: { status: number; body: any } } {
  const resolvedAuth = auth === null ? undefined : auth
  const out: { status: number; body: any } = { status: 0, body: null }
  const res: any = {
    writeHead(status: number) { out.status = status; return res },
    end(chunk?: string) { if (chunk) out.body = JSON.parse(chunk) },
  }
  const url = new URL(`http://localhost:3420${path}`)
  const bodyStr = body === undefined ? '' : JSON.stringify(body)
  const req: any = {
    on(event: string, cb: (chunk?: Buffer) => void) {
      if (event === 'data' && bodyStr) cb(Buffer.from(bodyStr))
      if (event === 'end') cb()
    },
  }
  return { ctx: { req, res, path: url.pathname, method, url, auth: resolvedAuth } as RouteContext, out }
}

function plan(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'pro',
    label: 'Personal PRO',
    configDir: '/opt/claude-pro',
    planType: 'personal',
    channelsAllowed: true,
    ...over,
  }
}

describe('tryHandleClaudePlans', () => {
  beforeEach(() => {
    if (existsSync(CLAUDE_PLANS_PATH)) rmSync(CLAUDE_PLANS_PATH)
    vaultSecrets.clear()
    setSecret.mockClear()
    deleteSecret.mockClear()
  })

  it('GET returns an empty list when no registry exists', async () => {
    const { ctx, out } = fakeCtx('GET', '/api/claude-plans')
    expect(await tryHandleClaudePlans(ctx)).toBe(true)
    expect(out.body).toEqual([])
  })

  it('POST creates a plan, then GET lists it', async () => {
    const { ctx, out } = fakeCtx('POST', '/api/claude-plans', plan())
    expect(await tryHandleClaudePlans(ctx)).toBe(true)
    expect(out.status).toBe(201)
    expect(out.body).toMatchObject({ id: 'pro', label: 'Personal PRO' })

    const list = fakeCtx('GET', '/api/claude-plans')
    await tryHandleClaudePlans(list.ctx)
    expect(list.out.body.map((p: any) => p.id)).toEqual(['pro'])
  })

  it('POST rejects an invalid plan (400) without writing anything', async () => {
    const { ctx, out } = fakeCtx('POST', '/api/claude-plans', plan({ planType: 'enterprise' }))
    await tryHandleClaudePlans(ctx)
    expect(out.status).toBe(400)
    expect(existsSync(CLAUDE_PLANS_PATH)).toBe(false)
  })

  it('POST rejects a duplicate id (409)', async () => {
    await tryHandleClaudePlans(fakeCtx('POST', '/api/claude-plans', plan()).ctx)
    const dup = fakeCtx('POST', '/api/claude-plans', plan({ label: 'Second' }))
    await tryHandleClaudePlans(dup.ctx)
    expect(dup.out.status).toBe(409)
  })

  it('PUT updates an existing plan; a differing id in the body is ignored', async () => {
    await tryHandleClaudePlans(fakeCtx('POST', '/api/claude-plans', plan()).ctx)

    const { ctx, out } = fakeCtx('PUT', '/api/claude-plans/pro', plan({ id: 'someone-else', label: 'Renamed' }))
    await tryHandleClaudePlans(ctx)
    expect(out.status).toBe(200)
    expect(out.body).toMatchObject({ id: 'pro', label: 'Renamed' })

    const list = fakeCtx('GET', '/api/claude-plans')
    await tryHandleClaudePlans(list.ctx)
    expect(list.out.body).toHaveLength(1)
    expect(list.out.body[0].label).toBe('Renamed')
  })

  it('PUT on an unknown id returns 404', async () => {
    const { ctx, out } = fakeCtx('PUT', '/api/claude-plans/nope', plan())
    await tryHandleClaudePlans(ctx)
    expect(out.status).toBe(404)
  })

  it('PUT with an invalid body returns 400 and leaves the plan untouched', async () => {
    await tryHandleClaudePlans(fakeCtx('POST', '/api/claude-plans', plan()).ctx)
    const { ctx, out } = fakeCtx('PUT', '/api/claude-plans/pro', plan({ channelsAllowed: 'yes' }))
    await tryHandleClaudePlans(ctx)
    expect(out.status).toBe(400)

    const list = fakeCtx('GET', '/api/claude-plans')
    await tryHandleClaudePlans(list.ctx)
    expect(list.out.body[0].channelsAllowed).toBe(true)
  })

  it('DELETE removes a plan', async () => {
    await tryHandleClaudePlans(fakeCtx('POST', '/api/claude-plans', plan()).ctx)
    const { ctx, out } = fakeCtx('DELETE', '/api/claude-plans/pro')
    await tryHandleClaudePlans(ctx)
    expect(out.status).toBe(200)
    expect(out.body).toEqual({ ok: true })

    const list = fakeCtx('GET', '/api/claude-plans')
    await tryHandleClaudePlans(list.ctx)
    expect(list.out.body).toEqual([])
  })

  it('DELETE on an unknown id returns 404', async () => {
    const { ctx, out } = fakeCtx('DELETE', '/api/claude-plans/nope')
    await tryHandleClaudePlans(ctx)
    expect(out.status).toBe(404)
  })

  it('GET .../state reports an empty state when nothing has ever rotated', async () => {
    const { ctx, out } = fakeCtx('GET', '/api/claude-plans/state')
    expect(await tryHandleClaudePlans(ctx)).toBe(true)
    expect(out.body).toEqual({ activePlanByAgent: {}, plans: {} })
  })

  it('GET .../readiness answers { ready, blockers[], details[] } (not shadowed by the :id matcher)', async () => {
    const { ctx, out } = fakeCtx('GET', '/api/claude-plans/readiness')
    expect(await tryHandleClaudePlans(ctx)).toBe(true)
    expect(typeof out.body.ready).toBe('boolean')
    expect(Array.isArray(out.body.blockers)).toBe(true)
    // rotationEnabled defaults to '0' in this file.
    expect(out.body.blockers).toContain('rotation_disabled')
    expect(out.body.details.find((d: any) => d.code === 'rotation_disabled').message).toMatch(/CLAUDE_ROTATION_ENABLED/)
  })

  it('a plan literally named "state" cannot shadow the state route', async () => {
    await tryHandleClaudePlans(fakeCtx('POST', '/api/claude-plans', plan({ id: 'state' })).ctx)
    const { ctx, out } = fakeCtx('GET', '/api/claude-plans/state')
    await tryHandleClaudePlans(ctx)
    expect(out.body).toEqual({ activePlanByAgent: {}, plans: {} })
  })

  // Token-mode (2026-09-12): POST/PUT accept a raw `token` field as a
  // convenience over pre-populating the vault -- see ClaudePlan.tokenSecretId.
  describe('token-mode plans (raw token -> vault promotion)', () => {
    function tokenPlan(over: Record<string, unknown> = {}): Record<string, unknown> {
      return {
        id: 'marketing',
        label: 'Marketing Max 20x',
        token: 'test-fixture-not-a-real-token-marketing',
        planType: 'personal',
        channelsAllowed: true,
        ...over,
      }
    }

    it('POST promotes a raw token to the vault and never returns it', async () => {
      const { ctx, out } = fakeCtx('POST', '/api/claude-plans', tokenPlan())
      await tryHandleClaudePlans(ctx)
      expect(out.status).toBe(201)
      expect(out.body.tokenSecretId).toBe('claude-plan-token-marketing')
      expect(out.body.token).toBeUndefined()
      expect(vaultSecrets.get('claude-plan-token-marketing')).toBe('test-fixture-not-a-real-token-marketing')

      const onDisk = JSON.parse(readFileSync(CLAUDE_PLANS_PATH, 'utf8'))
      expect(onDisk[0].token).toBeUndefined()
      expect(onDisk[0].tokenSecretId).toBe('claude-plan-token-marketing')
    })

    it('POST cleans up the vault secret when the rest of the plan is invalid', async () => {
      const { ctx, out } = fakeCtx('POST', '/api/claude-plans', tokenPlan({ planType: 'enterprise' }))
      await tryHandleClaudePlans(ctx)
      expect(out.status).toBe(400)
      expect(vaultSecrets.has('claude-plan-token-marketing')).toBe(false)
    })

    it('POST cleans up the vault secret on a duplicate id (409)', async () => {
      await tryHandleClaudePlans(fakeCtx('POST', '/api/claude-plans', tokenPlan()).ctx)
      vaultSecrets.clear() // isolate the second call's own write
      const dup = fakeCtx('POST', '/api/claude-plans', tokenPlan({ label: 'Second' }))
      await tryHandleClaudePlans(dup.ctx)
      expect(dup.out.status).toBe(409)
      expect(vaultSecrets.has('claude-plan-token-marketing')).toBe(false)
    })

    it('DELETE removes the associated vault secret too (no orphan)', async () => {
      await tryHandleClaudePlans(fakeCtx('POST', '/api/claude-plans', tokenPlan()).ctx)
      expect(vaultSecrets.has('claude-plan-token-marketing')).toBe(true)

      await tryHandleClaudePlans(fakeCtx('DELETE', '/api/claude-plans/marketing').ctx)
      expect(vaultSecrets.has('claude-plan-token-marketing')).toBe(false)
    })

    it('PUT switching a plan FROM token-mode TO configDir-mode deletes the now-orphaned secret', async () => {
      await tryHandleClaudePlans(fakeCtx('POST', '/api/claude-plans', tokenPlan()).ctx)
      const { ctx, out } = fakeCtx('PUT', '/api/claude-plans/marketing', {
        label: 'Marketing Max 20x', configDir: '/opt/claude-marketing', planType: 'personal', channelsAllowed: true,
      })
      await tryHandleClaudePlans(ctx)
      expect(out.status).toBe(200)
      expect(out.body.configDir).toBe('/opt/claude-marketing')
      expect(vaultSecrets.has('claude-plan-token-marketing')).toBe(false)
    })

    it('rejects a plan with both token and configDir (400), without writing a vault secret', async () => {
      const { ctx, out } = fakeCtx('POST', '/api/claude-plans', tokenPlan({ configDir: '/opt/claude-marketing' }))
      await tryHandleClaudePlans(ctx)
      expect(out.status).toBe(400)
      expect(vaultSecrets.size).toBe(0)
    })

    // PR #1304 review (a): withTokenPromotedToVault used to write the new raw
    // token to the vault BEFORE validatePlan ran. On a PUT that carries an
    // otherwise-invalid body, the write landed on the SAME derived id as the
    // plan's existing (valid) secret, validation then failed, and the
    // failure-path cleanup deleted that same id -- an invalid 400 request
    // destroyed a working credential.
    it('an invalid PUT carrying a raw token leaves the existing secret intact', async () => {
      await tryHandleClaudePlans(fakeCtx('POST', '/api/claude-plans', tokenPlan()).ctx)
      expect(vaultSecrets.get('claude-plan-token-marketing')).toBe('test-fixture-not-a-real-token-marketing')
      setSecret.mockClear()
      deleteSecret.mockClear()

      const { ctx, out } = fakeCtx('PUT', '/api/claude-plans/marketing', tokenPlan({
        token: 'new-token-that-must-never-land', planType: 'enterprise',
      }))
      await tryHandleClaudePlans(ctx)
      expect(out.status).toBe(400)

      // Old secret survives, byte for byte -- neither overwritten nor deleted.
      expect(vaultSecrets.get('claude-plan-token-marketing')).toBe('test-fixture-not-a-real-token-marketing')
      expect(setSecret).not.toHaveBeenCalled()
      expect(deleteSecret).not.toHaveBeenCalled()
    })

    it('a VALID PUT with a new raw token does replace the secret value (contrast with the invalid case above)', async () => {
      await tryHandleClaudePlans(fakeCtx('POST', '/api/claude-plans', tokenPlan()).ctx)
      const { ctx, out } = fakeCtx('PUT', '/api/claude-plans/marketing', tokenPlan({ token: 'rotated-token-value' }))
      await tryHandleClaudePlans(ctx)
      expect(out.status).toBe(200)
      expect(vaultSecrets.get('claude-plan-token-marketing')).toBe('rotated-token-value')
    })

    // Duplicate-token guard (2026-09-26: two of six plans on a real install
    // carried the identical setup-token). Discriminating input: the SAME raw
    // token under a DIFFERENT plan id.
    it('POST rejects a token already stored for a different plan (409), writing nothing and never echoing the token', async () => {
      await tryHandleClaudePlans(fakeCtx('POST', '/api/claude-plans', tokenPlan()).ctx)
      setSecret.mockClear()
      const before = readFileSync(CLAUDE_PLANS_PATH, 'utf8')

      const { ctx, out } = fakeCtx('POST', '/api/claude-plans', tokenPlan({
        id: 'claude7', label: 'Claude 7', token: '  test-fixture-not-a-real-token-marketing  ',
      }))
      await tryHandleClaudePlans(ctx)
      expect(out.status).toBe(409)
      expect(out.body.error).toContain('marketing')
      expect(JSON.stringify(out.body)).not.toContain('test-fixture-not-a-real-token')
      expect(setSecret).not.toHaveBeenCalled()
      expect(vaultSecrets.has('claude-plan-token-claude7')).toBe(false)
      expect(readFileSync(CLAUDE_PLANS_PATH, 'utf8')).toBe(before)
    })

    it('PUT rejects switching a plan to a token another plan already holds (409), existing secret untouched', async () => {
      await tryHandleClaudePlans(fakeCtx('POST', '/api/claude-plans', tokenPlan()).ctx)
      await tryHandleClaudePlans(fakeCtx('POST', '/api/claude-plans', tokenPlan({ id: 'claude7', label: 'Claude 7', token: 'other-fixture-token' })).ctx)
      setSecret.mockClear()
      deleteSecret.mockClear()

      const { ctx, out } = fakeCtx('PUT', '/api/claude-plans/claude7', tokenPlan({ label: 'Claude 7' }))
      await tryHandleClaudePlans(ctx)
      expect(out.status).toBe(409)
      expect(vaultSecrets.get('claude-plan-token-claude7')).toBe('other-fixture-token')
      expect(setSecret).not.toHaveBeenCalled()
      expect(deleteSecret).not.toHaveBeenCalled()
    })

    it('PUT re-sending a plan\'s OWN token is not a duplicate (200)', async () => {
      await tryHandleClaudePlans(fakeCtx('POST', '/api/claude-plans', tokenPlan()).ctx)
      const { ctx, out } = fakeCtx('PUT', '/api/claude-plans/marketing', tokenPlan({ label: 'Renamed' }))
      await tryHandleClaudePlans(ctx)
      expect(out.status).toBe(200)
    })

    // PR #1304 review (b): tokenSecretId must be exactly this plan's own
    // derived id (claude-plan-token-<id>) -- nothing else, even if charset-valid.
    it('rejects a foreign tokenSecretId on POST (not the plan\'s own derived id)', async () => {
      const { ctx, out } = fakeCtx('POST', '/api/claude-plans', {
        id: 'marketing', label: 'Marketing', tokenSecretId: 'MARVEEN-CONNECTORS-PAT',
        planType: 'personal', channelsAllowed: true,
      })
      await tryHandleClaudePlans(ctx)
      expect(out.status).toBe(400)
      expect(vaultSecrets.size).toBe(0)
    })

    it('rejects a foreign tokenSecretId on PUT too, leaving the existing plan/secret untouched', async () => {
      await tryHandleClaudePlans(fakeCtx('POST', '/api/claude-plans', tokenPlan()).ctx)
      const { ctx, out } = fakeCtx('PUT', '/api/claude-plans/marketing', {
        label: 'Marketing', tokenSecretId: 'MARVEEN-CONNECTORS-PAT', planType: 'personal', channelsAllowed: true,
      })
      await tryHandleClaudePlans(ctx)
      expect(out.status).toBe(400)
      expect(vaultSecrets.get('claude-plan-token-marketing')).toBe('test-fixture-not-a-real-token-marketing')
      expect(deleteSecret).not.toHaveBeenCalled()
    })
  })

  // PR #1304 review (b), third required test: "a plan DELETE never removes a
  // non-prefixed secret". With validatePlan now rejecting any foreign
  // tokenSecretId, that state can no longer be reached through the route at
  // all (see the two tests above) -- so this exercises the guard function
  // ITSELF, the thing the DELETE handler actually calls, directly.
  describe('deleteOwnTokenSecret (PR #1304 review (b) defense in depth)', () => {
    it('deletes the plan\'s own derived secret id', async () => {
      const { deleteOwnTokenSecret } = await import('../web/routes/claude-plans.js')
      vaultSecrets.set('claude-plan-token-marketing', 'x')
      deleteOwnTokenSecret('marketing', 'claude-plan-token-marketing')
      expect(deleteSecret).toHaveBeenCalledWith('claude-plan-token-marketing')
      expect(vaultSecrets.has('claude-plan-token-marketing')).toBe(false)
    })

    it('never calls deleteSecret for an id that is not the plan\'s own derived id', async () => {
      const { deleteOwnTokenSecret } = await import('../web/routes/claude-plans.js')
      vaultSecrets.set('MARVEEN-CONNECTORS-PAT', 'live-prod-db-credential')
      deleteOwnTokenSecret('marketing', 'MARVEEN-CONNECTORS-PAT')
      expect(deleteSecret).not.toHaveBeenCalled()
      expect(vaultSecrets.has('MARVEEN-CONNECTORS-PAT')).toBe(true)
    })

    it('no-ops on a null/undefined secretId', async () => {
      const { deleteOwnTokenSecret } = await import('../web/routes/claude-plans.js')
      deleteOwnTokenSecret('marketing', undefined)
      deleteOwnTokenSecret('marketing', null)
      expect(deleteSecret).not.toHaveBeenCalled()
    })
  })
})

describe('POST /api/claude-plans/rotate (PR2c)', () => {
  const agentsDir = join(tmpRoot, 'agents')

  beforeEach(() => {
    if (existsSync(CLAUDE_PLANS_PATH)) rmSync(CLAUDE_PLANS_PATH)
    if (existsSync(CLAUDE_PLANS_STATE_PATH)) rmSync(CLAUDE_PLANS_STATE_PATH)
    if (existsSync(agentsDir)) rmSync(agentsDir, { recursive: true, force: true })
    rotationEnabled = '1'
    mainIsolated = '1'
    hardRestartMarveenChannels.mockClear().mockReturnValue({ ok: true })
    restartAgentProcess.mockClear().mockResolvedValue({ ok: true, pid: 123 })
    fleetEnabled = false
    runFleetLeg.mockClear()
  })

  async function seedTwoPlans() {
    await tryHandleClaudePlans(fakeCtx('POST', '/api/claude-plans', plan({ id: 'pro', label: 'Personal PRO' })).ctx)
    await tryHandleClaudePlans(fakeCtx('POST', '/api/claude-plans', plan({ id: 'team', label: 'Team Seat' })).ctx)
  }

  it('rejects with 400 when targetPlanId is missing', async () => {
    const { ctx, out } = fakeCtx('POST', '/api/claude-plans/rotate', {})
    await tryHandleClaudePlans(ctx)
    expect(out.status).toBe(400)
  })

  it('rejects with 400 for an unknown targetPlanId', async () => {
    await seedTwoPlans()
    const { ctx, out } = fakeCtx('POST', '/api/claude-plans/rotate', { targetPlanId: 'nope' })
    await tryHandleClaudePlans(ctx)
    expect(out.status).toBe(400)
    expect(hardRestartMarveenChannels).not.toHaveBeenCalled()
  })

  it('rejects with 400 when the target plan does not allow channels', async () => {
    await tryHandleClaudePlans(fakeCtx('POST', '/api/claude-plans', plan({ id: 'pro' })).ctx)
    await tryHandleClaudePlans(fakeCtx('POST', '/api/claude-plans', plan({ id: 'team', label: 'Team', channelsAllowed: false })).ctx)
    const { ctx, out } = fakeCtx('POST', '/api/claude-plans/rotate', { targetPlanId: 'team' })
    await tryHandleClaudePlans(ctx)
    expect(out.status).toBe(400)
  })

  it('rejects with 409 when CLAUDE_ROTATION_ENABLED is off', async () => {
    await seedTwoPlans()
    rotationEnabled = '0'
    const { ctx, out } = fakeCtx('POST', '/api/claude-plans/rotate', { targetPlanId: 'team' })
    await tryHandleClaudePlans(ctx)
    expect(out.status).toBe(409)
    expect(hardRestartMarveenChannels).not.toHaveBeenCalled()
  })

  it('rejects with 409 for the main agent when MAIN_AGENT_ISOLATED_CONFIG is off', async () => {
    await seedTwoPlans()
    mainIsolated = '0'
    const { ctx, out } = fakeCtx('POST', '/api/claude-plans/rotate', { targetPlanId: 'team' })
    await tryHandleClaudePlans(ctx)
    expect(out.status).toBe(409)
    expect(hardRestartMarveenChannels).not.toHaveBeenCalled()
  })

  it('rejects with 409 for the main agent with fewer than 2 registered plans', async () => {
    await tryHandleClaudePlans(fakeCtx('POST', '/api/claude-plans', plan({ id: 'pro' })).ctx)
    const { ctx, out } = fakeCtx('POST', '/api/claude-plans/rotate', { targetPlanId: 'pro' })
    await tryHandleClaudePlans(ctx)
    expect(out.status).toBe(409)
  })

  it('happy path (main agent, default agentId): writes state THEN restarts, in that order', async () => {
    await seedTwoPlans()
    const order: string[] = []
    hardRestartMarveenChannels.mockImplementation(() => { order.push('restart'); return { ok: true } })
    const { ctx, out } = fakeCtx('POST', '/api/claude-plans/rotate', { targetPlanId: 'team' })
    await tryHandleClaudePlans(ctx)
    expect(out.status).toBe(200)
    expect(out.body).toEqual({ ok: true, agentId: 'agent-a', activePlanId: 'team', fleet: 'off' })
    expect(hardRestartMarveenChannels).toHaveBeenCalledTimes(1)
    // CLAUDE_ROTATION_FLEET off (default): the fleet is not touched at all.
    expect(runFleetLeg).not.toHaveBeenCalled()

    const state = fakeCtx('GET', '/api/claude-plans/state')
    await tryHandleClaudePlans(state.ctx)
    expect(state.out.body.activePlanByAgent).toEqual({ 'agent-a': 'team' })
  })

  it('CLAUDE_ROTATION_FLEET on: a main-agent rotation starts the fleet leg for the target plan', async () => {
    await seedTwoPlans()
    fleetEnabled = true
    const { ctx, out } = fakeCtx('POST', '/api/claude-plans/rotate', { targetPlanId: 'team' })
    await tryHandleClaudePlans(ctx)
    expect(out.status).toBe(200)
    expect(out.body.fleet).toBe('started')
    await vi.waitFor(() => expect(runFleetLeg).toHaveBeenCalledTimes(1))
    expect(runFleetLeg.mock.calls[0][0].id).toBe('team')
  })

  it('CLAUDE_ROTATION_FLEET on: no fleet leg when the main restart itself failed', async () => {
    await seedTwoPlans()
    fleetEnabled = true
    hardRestartMarveenChannels.mockReturnValue({ ok: false, error: 'boom' })
    const { ctx, out } = fakeCtx('POST', '/api/claude-plans/rotate', { targetPlanId: 'team' })
    await tryHandleClaudePlans(ctx)
    expect(out.status).toBe(500)
    await new Promise((r) => setTimeout(r, 20))
    expect(runFleetLeg).not.toHaveBeenCalled()
  })

  it('this is also how a first-ever assignment happens -- no separate bootstrap path', async () => {
    // No prior activePlanByAgent entry for agent-a: applyRotation just adds one.
    await seedTwoPlans()
    const { ctx } = fakeCtx('POST', '/api/claude-plans/rotate', { targetPlanId: 'pro' })
    await tryHandleClaudePlans(ctx)
    const state = fakeCtx('GET', '/api/claude-plans/state')
    await tryHandleClaudePlans(state.ctx)
    expect(state.out.body.activePlanByAgent['agent-a']).toBe('pro')
  })

  it('returns 500 and does not report ok when the main-agent restart fails', async () => {
    await seedTwoPlans()
    hardRestartMarveenChannels.mockReturnValue({ ok: false, error: 'launchctl boom' })
    const { ctx, out } = fakeCtx('POST', '/api/claude-plans/rotate', { targetPlanId: 'team' })
    await tryHandleClaudePlans(ctx)
    expect(out.status).toBe(500)
    expect(out.body.error).toContain('launchctl boom')
  })

  it('sub-agent path: 404 when the agent does not exist', async () => {
    await seedTwoPlans()
    const { ctx, out } = fakeCtx('POST', '/api/claude-plans/rotate', { agentId: 'devy', targetPlanId: 'team' })
    await tryHandleClaudePlans(ctx)
    expect(out.status).toBe(404)
    expect(restartAgentProcess).not.toHaveBeenCalled()
  })

  it('sub-agent path: writes claudePlan + restarts via restartAgentProcess, not the main-agent path', async () => {
    await seedTwoPlans()
    mkdirSync(join(agentsDir, 'devy'), { recursive: true })
    const { ctx, out } = fakeCtx('POST', '/api/claude-plans/rotate', { agentId: 'devy', targetPlanId: 'team' })
    await tryHandleClaudePlans(ctx)
    expect(out.status).toBe(200)
    expect(out.body).toEqual({ ok: true, agentId: 'devy', activePlanId: 'team' })
    expect(restartAgentProcess).toHaveBeenCalledWith('devy')
    expect(hardRestartMarveenChannels).not.toHaveBeenCalled()

    const state = fakeCtx('GET', '/api/claude-plans/state')
    await tryHandleClaudePlans(state.ctx)
    expect(state.out.body.activePlanByAgent.devy).toBe('team')
  })

  it('sub-agent path is NOT gated on MAIN_AGENT_ISOLATED_CONFIG or the 2-plan minimum', async () => {
    // Only design 6.2's main-agent precondition mentions isolation; a
    // sub-agent's claudePlan field is a normal per-agent setting already,
    // unrelated to the main agent's auth mode.
    await tryHandleClaudePlans(fakeCtx('POST', '/api/claude-plans', plan({ id: 'pro' })).ctx)
    mainIsolated = '0'
    mkdirSync(join(agentsDir, 'devy'), { recursive: true })
    const { ctx, out } = fakeCtx('POST', '/api/claude-plans/rotate', { agentId: 'devy', targetPlanId: 'pro' })
    await tryHandleClaudePlans(ctx)
    expect(out.status).toBe(200)
  })
})

// Card 93ed929a (WhiteHat F1 on 517fdcc5, comment 16354): the plan-write routes (POST/PUT/DELETE
// /api/claude-plans) and the rotation trigger (POST .../rotate) had NO principal gate at all --
// the shared fleet dashboard bearer every agent holds could create/edit/delete plans (including
// vault-secret writes) and trigger a real credential rotation + agent restart. Same human-only
// posture as POST /api/connectors's project-scope stdio add (card 67e73b48). GET /api/claude-plans,
// GET .../state and POST .../:id/probe are UNCHANGED (read-only / already rate-limited, not the
// card's concern).
describe('tryHandleClaudePlans -- write/rotate require a human credential (card 93ed929a)', () => {
  beforeEach(() => {
    if (existsSync(CLAUDE_PLANS_PATH)) rmSync(CLAUDE_PLANS_PATH)
    if (existsSync(CLAUDE_PLANS_STATE_PATH)) rmSync(CLAUDE_PLANS_STATE_PATH)
    vaultSecrets.clear()
  })

  it.each([
    ['the shared agent bearer (kind: token)', { kind: 'token' }],
    // {} rather than `undefined`: fakeCtx's default parameter would silently substitute its
    // own session-auth default for an `undefined` argument (JS default-parameter semantics
    // apply on an explicit `undefined`, not just a missing one) -- {} genuinely carries no
    // `kind`, which is what "no auth principal at all" means.
    ['no auth principal at all', {}],
    ['a federation peer credential', { kind: 'federation' }],
  ] as const)('POST /api/claude-plans is rejected (403) for %s, nothing written', async (_label, auth) => {
    const { ctx, out } = fakeCtx('POST', '/api/claude-plans', plan(), auth)
    expect(await tryHandleClaudePlans(ctx)).toBe(true)
    expect(out.status).toBe(403)
    expect(existsSync(CLAUDE_PLANS_PATH)).toBe(false)
  })

  it('POST /api/claude-plans succeeds for a device key (kind: device)', async () => {
    const { ctx, out } = fakeCtx('POST', '/api/claude-plans', plan(), { kind: 'device' })
    await tryHandleClaudePlans(ctx)
    expect(out.status).toBe(201)
  })

  it('PUT /api/claude-plans/:id is rejected (403) for the shared agent bearer, nothing changed', async () => {
    await tryHandleClaudePlans(fakeCtx('POST', '/api/claude-plans', plan()).ctx)
    const before = readFileSync(CLAUDE_PLANS_PATH, 'utf8')
    const { ctx, out } = fakeCtx('PUT', '/api/claude-plans/pro', plan({ label: 'Renamed' }), { kind: 'token' })
    await tryHandleClaudePlans(ctx)
    expect(out.status).toBe(403)
    expect(readFileSync(CLAUDE_PLANS_PATH, 'utf8')).toBe(before)
  })

  it('DELETE /api/claude-plans/:id is rejected (403) for the shared agent bearer, plan survives', async () => {
    await tryHandleClaudePlans(fakeCtx('POST', '/api/claude-plans', plan()).ctx)
    const { ctx, out } = fakeCtx('DELETE', '/api/claude-plans/pro', undefined, { kind: 'token' })
    await tryHandleClaudePlans(ctx)
    expect(out.status).toBe(403)
    const list = fakeCtx('GET', '/api/claude-plans')
    await tryHandleClaudePlans(list.ctx)
    expect(list.out.body.map((p: any) => p.id)).toEqual(['pro'])
  })

  it('POST /api/claude-plans/rotate is rejected (403) for the shared agent bearer, no restart, no state change', async () => {
    await tryHandleClaudePlans(fakeCtx('POST', '/api/claude-plans', plan({ id: 'pro' })).ctx)
    await tryHandleClaudePlans(fakeCtx('POST', '/api/claude-plans', plan({ id: 'team', label: 'Team Seat' })).ctx)
    rotationEnabled = '1'
    mainIsolated = '1'
    const { ctx, out } = fakeCtx('POST', '/api/claude-plans/rotate', { targetPlanId: 'team' }, { kind: 'token' })
    await tryHandleClaudePlans(ctx)
    expect(out.status).toBe(403)
    expect(hardRestartMarveenChannels).not.toHaveBeenCalled()
    const state = fakeCtx('GET', '/api/claude-plans/state')
    await tryHandleClaudePlans(state.ctx)
    expect(state.out.body.activePlanByAgent).toEqual({})
  })

  // MUTATION PIN: with rejectIfNotHumanAuth removed from the rotate handler, this same request
  // (shared bearer, rotation enabled) would instead succeed and restart the main agent -- this
  // assertion distinguishes "the gate rejected it" from "it failed for an unrelated reason".
  it('MUTATION PIN: the rotate rejection is specifically the auth gate, not a missing-plan 400/404', async () => {
    await tryHandleClaudePlans(fakeCtx('POST', '/api/claude-plans', plan({ id: 'pro' })).ctx)
    await tryHandleClaudePlans(fakeCtx('POST', '/api/claude-plans', plan({ id: 'team', label: 'Team Seat' })).ctx)
    rotationEnabled = '1'
    mainIsolated = '1'
    const { ctx, out } = fakeCtx('POST', '/api/claude-plans/rotate', { targetPlanId: 'team' }, { kind: 'token' })
    await tryHandleClaudePlans(ctx)
    expect(out.status).toBe(403)
    expect(out.body.error).toContain('browser session or a device key')
  })

  // N1 (RedHat 16876): the fail-open check for "no principal at all" must pin the ACTUAL
  // production shape -- ctx.auth === undefined -- not the earlier `{}` stand-in, which an M6
  // mutant (the gate accepting a falsy ctx.auth) passed vacuously because `{}.kind` and
  // `undefined`'s own `?.kind` both read as undefined through optional chaining, but a mutant
  // checking `!ctx.auth` specifically only sees the REAL undefined case.
  it('N1: a request with no auth object at all (ctx.auth === undefined) is rejected (403)', async () => {
    const { ctx, out } = fakeCtx('POST', '/api/claude-plans', plan(), null)
    expect(await tryHandleClaudePlans(ctx)).toBe(true)
    expect(out.status).toBe(403)
    expect(existsSync(CLAUDE_PLANS_PATH)).toBe(false)
  })

  // B1 (RedHat NO-GO 16876, HIGH if rotation is ever enabled): `kind === 'device'` alone is NOT
  // a human credential. Card 9655494c issues agent:<id> device keys to fleet agents (including
  // the gate agents the 2bfa4c67 verdict path is built on) -- every one of those resolves to
  // exactly this `{kind:'device', device:'agent:<id>'}` shape, which the first cut of this gate
  // let straight through. Measured by RedHat: an 'agent:qa' device key passed POST/PUT/DELETE
  // and /rotate. Only a non-agent device key (phone/Bridge pairing) is actually human.
  it.each([
    ['POST', '/api/claude-plans', plan()],
    ['PUT', '/api/claude-plans/pro', plan({ label: 'Renamed' })],
    ['DELETE', '/api/claude-plans/pro', undefined],
    ['POST', '/api/claude-plans/rotate', { targetPlanId: 'team' }],
  ] as const)('B1: an agent-issued device key (agent:qa) is rejected (403) on %s %s', async (method, path, body) => {
    await tryHandleClaudePlans(fakeCtx('POST', '/api/claude-plans', plan({ id: 'pro' })).ctx)
    await tryHandleClaudePlans(fakeCtx('POST', '/api/claude-plans', plan({ id: 'team', label: 'Team Seat' })).ctx)
    rotationEnabled = '1'
    mainIsolated = '1'
    const { ctx, out } = fakeCtx(method, path, body, { kind: 'device', device: 'agent:qa' })
    await tryHandleClaudePlans(ctx)
    expect(out.status).toBe(403)
    expect(hardRestartMarveenChannels).not.toHaveBeenCalled()
  })

  // Positive control for B1: a non-agent device key (the Bridge/phone pairing shape) is still
  // treated as human -- the fix must not collapse the whole device branch to session-only.
  it('B1 positive control: a non-agent device key (phone pairing) still succeeds', async () => {
    const { ctx, out } = fakeCtx('POST', '/api/claude-plans', plan(), { kind: 'device', device: 'phone' })
    await tryHandleClaudePlans(ctx)
    expect(out.status).toBe(201)
  })

  // MUTATION PIN: with the agentKeyToAgentId exclusion removed (device alone treated as
  // human again), this exact agent:qa request would instead succeed (201) and, on the rotate
  // route with rotation enabled, actually restart the main agent.
  it('MUTATION PIN: B1 -- the agent-device rejection is specifically the agentKeyToAgentId check', async () => {
    const { ctx, out } = fakeCtx('POST', '/api/claude-plans', plan(), { kind: 'device', device: 'agent:qa' })
    await tryHandleClaudePlans(ctx)
    expect(out.status).toBe(403)
    expect(out.body.error).toContain('browser session or a device key')
    expect(existsSync(CLAUDE_PLANS_PATH)).toBe(false)
  })
})
