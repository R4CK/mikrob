import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { decideContinueFlag, verifyContinueLaunch, decideContinueTimeoutAction, CONTINUE_MIN_CLI, type ContinueDecisionInput } from '../web/channel-continue-policy.js'

// CONTRESUME922 narrowing (approved 2026-09-23 with three conditions). The
// measurement: on Claude Code 2.1.280 a hand-launched --continue session of a
// telegram agent on the fleet-token path brought the plugin up, sent a real
// Telegram message and kept its context. The provider-key agent could not be
// measured because its key is an ephemeral launch-secret (a resume starts
// with an empty key -> 401), so that branch is excluded in CODE.

const ROOT = join(__dirname, '..', '..')
const PROCESS_SRC = readFileSync(join(ROOT, 'src', 'web', 'agent-process.ts'), 'utf-8')

const measured: ContinueDecisionInput = {
  hasPriorSession: true, fresh: false, hasChannel: true, isMainAgent: false, provider: 'telegram',
  usesLaunchSecret: false, fleetTokenLaunch: true, useMcpJsonForChannel: false, installedCli: '2.1.280',
}

describe('decideContinueFlag', () => {
  it('the measured shape resumes: telegram + fleet token + no launch-secret + CLI >= floor', () => {
    expect(decideContinueFlag(measured).useContinue).toBe(true)
    expect(decideContinueFlag({ ...measured, installedCli: '2.1.300' }).useContinue).toBe(true)
  })
  it('condition 1: below the floor, or unmeasured, is fresh', () => {
    expect(decideContinueFlag({ ...measured, installedCli: '2.1.278' })).toMatchObject({ useContinue: false, reason: expect.stringContaining(CONTINUE_MIN_CLI) })
    expect(decideContinueFlag({ ...measured, installedCli: '2.1.193' }).useContinue).toBe(false)
    expect(decideContinueFlag({ ...measured, installedCli: null })).toMatchObject({ useContinue: false, reason: expect.stringContaining('unmeasured') })
  })
  it('condition 2: a launch that reads an ephemeral launch-secret never resumes (mechanism, not a gap)', () => {
    expect(decideContinueFlag({ ...measured, usesLaunchSecret: true })).toMatchObject({ useContinue: false, reason: expect.stringContaining('launch-secret') })
  })
  it('scope: only telegram, only the fleet-token path, not the mcp.json path, never the main agent', () => {
    expect(decideContinueFlag({ ...measured, provider: 'slack' }).useContinue).toBe(false)
    expect(decideContinueFlag({ ...measured, fleetTokenLaunch: false }).useContinue).toBe(false)
    expect(decideContinueFlag({ ...measured, useMcpJsonForChannel: true }).useContinue).toBe(false)
    expect(decideContinueFlag({ ...measured, isMainAgent: true }).useContinue).toBe(false)
  })
  it('unchanged: no prior session / fresh requested -> no; channel-less agents keep --continue regardless of CLI', () => {
    expect(decideContinueFlag({ ...measured, hasPriorSession: false }).useContinue).toBe(false)
    expect(decideContinueFlag({ ...measured, fresh: true }).useContinue).toBe(false)
    expect(decideContinueFlag({ ...measured, hasChannel: false, installedCli: null, usesLaunchSecret: true, fleetTokenLaunch: false }).useContinue).toBe(true)
  })
})

describe('verifyContinueLaunch (condition 3)', () => {
  it('alive on a later poll ends the wait early', async () => {
    let t = 0
    const seq: Array<'alive' | 'down' | 'unknown'> = ['unknown', 'down', 'alive']
    const r = await verifyContinueLaunch({ probe: () => seq.shift() ?? 'alive', windowMs: 90_000, intervalMs: 3_000, now: () => t, sleep: async (ms) => { t += ms } })
    expect(r).toMatchObject({ outcome: 'alive', polls: 3, elapsedMs: 6_000 })
  })
  it('never alive -> timeout at the window, not before', async () => {
    let t = 0
    const r = await verifyContinueLaunch({ probe: () => 'down', windowMs: 90_000, intervalMs: 3_000, now: () => t, sleep: async (ms) => { t += ms } })
    expect(r.outcome).toBe('timeout')
    expect(r.elapsedMs).toBeGreaterThanOrEqual(90_000)
    expect(r.polls).toBe(31)
  })
})

describe('decideContinueTimeoutAction (card 466f21fe F1)', () => {
  it('alive always keeps the session, regardless of generation', () => {
    expect(decideContinueTimeoutAction('alive', false)).toBe('kept')
    expect(decideContinueTimeoutAction('alive', true)).toBe('kept')
  })
  it('timeout with no generation change relaunches fresh -- the normal deaf-resume case', () => {
    expect(decideContinueTimeoutAction('timeout', false)).toBe('relaunch-fresh')
  })
  it('timeout WITH a generation change (a stop or a newer start happened mid-window) skips the fallback -- the F1 fix', () => {
    expect(decideContinueTimeoutAction('timeout', true)).toBe('skip-stopped')
  })
  // MUTATION PIN: without the generationChanged branch, this exact input ('timeout', true) would
  // fall through to 'relaunch-fresh' -- this is the case that flips if that check is ever removed.
  it('MUTATION PIN: self-check -- a changed generation never produces relaunch-fresh', () => {
    expect(decideContinueTimeoutAction('timeout', true)).not.toBe('relaunch-fresh')
  })
})

describe('the launch path is wired to the policy', () => {
  it('startAgentProcess decides with decideContinueFlag from the measured inputs and no longer hardcodes !hasChannel', () => {
    expect(PROCESS_SRC).not.toContain("(hasPriorSession && !opts.fresh && !hasChannel) ? '--continue ' : ''")
    expect(PROCESS_SRC).toContain('const usesLaunchSecret = providerEnv !== \'\' || apiKeyEnv !== \'\'')
    expect(PROCESS_SRC).toContain('fleetTokenLaunch: oauthTokenEnv !== \'\'')
    expect(PROCESS_SRC).toContain('installedCli = hasChannel ? (await measureClaudeCliVersion()).version : null')
    expect(PROCESS_SRC).toContain("const continueFlag = continueDecision.useContinue ? '--continue ' : ''")
  })
  it('a resumed channel launch is verified with the plugin-liveness probe and falls back to a FRESH start', () => {
    const at = PROCESS_SRC.indexOf('if (continueFlag && hasChannel && name !== MAIN_AGENT_ID) {')
    expect(at).toBeGreaterThan(-1)
    const block = PROCESS_SRC.slice(at, at + 2500)
    expect(block).toContain('verifyContinueLaunch({')
    expect(block).toContain('probeChannelPluginLiveness(pid, agentProvider, name)')
    expect(block).toContain("['kill-session', '-t', session]")
    expect(block).toContain('startAgentProcess(name, { fresh: true })')
  })
  it('the timeout fallback is routed through decideContinueTimeoutAction, not a bare if(v.outcome==="alive") (card 466f21fe F1)', () => {
    const at = PROCESS_SRC.indexOf('if (continueFlag && hasChannel && name !== MAIN_AGENT_ID) {')
    const block = PROCESS_SRC.slice(at, at + 2500)
    expect(block).toContain('decideContinueTimeoutAction(v.outcome, generationChanged)')
    expect(block).toContain("action === 'kept'")
    expect(block).toContain("action === 'skip-stopped'")
  })
  it('every launch bumps its own agentLaunchGeneration entry BEFORE the verify window opens', () => {
    const newSessionAt = PROCESS_SRC.indexOf("runTmux(startTarget, ['new-session', '-d', '-s', session, buildLaunchCmd(dir)]")
    const continueAt = PROCESS_SRC.indexOf('if (continueFlag && hasChannel && name !== MAIN_AGENT_ID) {')
    const between = PROCESS_SRC.slice(newSessionAt, continueAt)
    expect(newSessionAt).toBeGreaterThan(-1)
    expect(continueAt).toBeGreaterThan(newSessionAt)
    expect(between).toContain('const myLaunchGeneration = Symbol()')
    expect(between).toContain('agentLaunchGeneration.set(name, myLaunchGeneration)')
  })
  it('stopAgentProcessUnlocked bumps the generation too, before killing the session (card 466f21fe F1)', () => {
    const stopAt = PROCESS_SRC.indexOf('async function stopAgentProcessUnlocked(name: string)')
    expect(stopAt).toBeGreaterThan(-1)
    const killAt = PROCESS_SRC.indexOf("kill-session", stopAt)
    const bumpAt = PROCESS_SRC.indexOf('agentLaunchGeneration.set(name, Symbol())', stopAt)
    expect(bumpAt).toBeGreaterThan(stopAt)
    expect(bumpAt).toBeLessThan(killAt)
  })
})

describe('card 466f21fe F2 (design note): a restart triggered for a SECURITY reason must force fresh', () => {
  // F2 named no current code defect ("Nem hibát, hanem munkamódszer-változást jelzek") -- the
  // fresh switch already existed. This locks in the one such call site that exists today
  // (context-guard-runner.ts's saturated-context restart, DANICTXHUROK906) so a future edit
  // dropping `fresh: true` there is caught, rather than leaving the principle as prose only.
  const GUARD_SRC = readFileSync(join(ROOT, 'src', 'web', 'context-guard-runner.ts'), 'utf-8')
  it('the context-guard restart of a sub-agent forces fresh: true', () => {
    expect(GUARD_SRC).toContain('const res = await restartAgentProcess(name, { fresh: true })')
  })
  it('MUTATION PIN: self-check -- a non-fresh call would not match the pinned text', () => {
    expect(GUARD_SRC).not.toContain('const res = await restartAgentProcess(name, { fresh: false })')
    expect(GUARD_SRC).not.toContain('const res = await restartAgentProcess(name)')
  })
})
