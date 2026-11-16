import { describe, it, expect, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { decideContinueFlag, verifyContinueLaunch, decideContinueTimeoutAction, hasLaunchGenerationChanged, resolveContinueTimeoutAction, CONTINUE_MIN_CLI, type ContinueDecisionInput } from '../web/channel-continue-policy.js'

// Card 2b2fbabc F2: stopAgentProcess's not-running early return is exercised for real (not
// mocked at the agent-process.js module boundary -- that boundary IS the module under test
// here). Only the real tmux child-process call underneath it is stubbed, exactly like
// reauth-healer.test.ts stubs node:child_process for the same reason: a real tmux invocation
// against a name that never had a session always fails anyway ("no server running"), so making
// that failure explicit and synchronous is a stub of the OUTCOME, not a fake of the logic.
vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>()
  return { ...actual, execFileSync: () => { throw new Error('mocked: no tmux server') } }
})

// CONTRESUME922 narrowing (approved 2026-09-23 with three conditions). The
// measurement: on Claude Code 2.1.280 a hand-launched --continue session of a
// telegram agent on the fleet-token path brought the plugin up, sent a real
// Telegram message and kept its context. The provider-key agent could not be
// measured because its key is an ephemeral launch-secret (a resume starts
// with an empty key -> 401), so that branch is excluded in CODE.

const ROOT = join(__dirname, '..', '..')
const PROCESS_SRC = readFileSync(join(ROOT, 'src', 'web', 'agent-process.ts'), 'utf-8')

const { isAgentRunning, stopAgentProcess, __getAgentLaunchGenerationForTest, bumpAgentLaunchGeneration, applyContinueVerifyOutcome } = await import('../web/agent-process.js')

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

describe('hasLaunchGenerationChanged (card eb26a3e4: the comparison direction itself, not just decideContinueTimeoutAction)', () => {
  it('the same symbol (nothing changed since launch) is NOT a change', () => {
    const g = Symbol()
    expect(hasLaunchGenerationChanged(g, g)).toBe(false)
  })
  it('a different symbol (a stop or a newer start happened) IS a change', () => {
    expect(hasLaunchGenerationChanged(Symbol(), Symbol())).toBe(true)
  })
  it('an undefined current generation (never set, or cleared) IS a change from any captured symbol', () => {
    expect(hasLaunchGenerationChanged(undefined, Symbol())).toBe(true)
  })
  // MUTATION PIN: flipping the `!==` to `===` inside hasLaunchGenerationChanged would invert
  // every one of the 3 cases above -- this test only exists to say explicitly what that mutant
  // does, so a future reviewer sees the exact failure shape, not just 3 red cases with no story.
  it('MUTATION PIN: a flipped (===) comparison would report "unchanged" as changed and vice versa', () => {
    const g = Symbol()
    const inverted = (current: symbol | undefined, captured: symbol) => current === captured
    expect(inverted(g, g)).not.toBe(hasLaunchGenerationChanged(g, g))
    expect(inverted(Symbol(), Symbol())).not.toBe(hasLaunchGenerationChanged(Symbol(), Symbol()))
  })
})

describe('resolveContinueTimeoutAction (card 2b2fbabc: the glued call-site function, behaviourally)', () => {
  it('composes exactly like the two pinned primitives: same generation -> relaunch-fresh on timeout', () => {
    const g = Symbol()
    expect(resolveContinueTimeoutAction('timeout', g, g)).toBe('relaunch-fresh')
  })
  it('changed generation on timeout -> skip-stopped (the F1 fix, through the composed function)', () => {
    expect(resolveContinueTimeoutAction('timeout', Symbol(), Symbol())).toBe('skip-stopped')
  })
  it('undefined current generation (never set, or cleared) counts as changed -> skip-stopped', () => {
    expect(resolveContinueTimeoutAction('timeout', undefined, Symbol())).toBe('skip-stopped')
  })
  it('alive always keeps the session regardless of generation', () => {
    const g = Symbol()
    expect(resolveContinueTimeoutAction('alive', g, g)).toBe('kept')
    expect(resolveContinueTimeoutAction('alive', Symbol(), Symbol())).toBe('kept')
  })
  // MUTATION PIN (card 2b2fbabc F1): the two tests above ('same generation -> relaunch-fresh' and
  // 'changed generation -> skip-stopped') ARE the mutant catch -- this is the exact finding: a `!`
  // negating the comparison this function feeds into would flip BOTH their expected results. Unlike
  // the old source-text `toContain('hasLaunchGenerationChanged(...)')` check (which matches the
  // substring whether or not it is negated), these assertions execute the real composition, so a
  // negation here turns a passing test red instead of surviving unnoticed.
  it('MUTATION PIN: self-check -- the same two cases disagree, which is what a negated comparison could not produce', () => {
    const g = Symbol()
    expect(resolveContinueTimeoutAction('timeout', g, g)).not.toBe(resolveContinueTimeoutAction('timeout', Symbol(), Symbol()))
  })
})

describe('applyContinueVerifyOutcome (card 2b2fbabc MEDIUM-1 / card 56344ff4): the post-resolve tail, behaviourally', () => {
  const polls = 5
  const elapsedMs = 15_000

  it("'kept': no kill, no relaunch", async () => {
    const name = `__m1-kept-${Date.now()}-${Math.random().toString(36).slice(2)}`
    const capturedAtLaunch = Symbol()
    bumpAgentLaunchGeneration(name) // current != capturedAtLaunch on purpose: 'alive' must win regardless
    const killSession = vi.fn()
    const startAgentProcess = vi.fn()
    const action = await applyContinueVerifyOutcome(name, 'sess', { outcome: 'alive', polls, elapsedMs }, capturedAtLaunch, { killSession, startAgentProcess })
    expect(action).toBe('kept')
    expect(killSession).not.toHaveBeenCalled()
    expect(startAgentProcess).not.toHaveBeenCalled()
  })

  // Y11 (Cybersec GO 32483, MEDIUM-1): the old inline `if (action === 'skip-stopped') { ...; return }`
  // was pinned only by a source-text check on the condition, which cannot tell a branch WITH its
  // `return` from one without it -- a mutant removing the `return` fell through to kill+relaunch
  // and stayed 87/87 green. This test drives the real branch and asserts on the SIDE EFFECT
  // (nothing killed, nothing relaunched), not on source text: a `return`-less mutant makes it RED.
  it("Y11 MUTATION PIN: 'skip-stopped' (a stop/newer-start happened mid-window) -- no kill, no relaunch", async () => {
    const name = `__m1-skip-${Date.now()}-${Math.random().toString(36).slice(2)}`
    const capturedAtLaunch = Symbol()
    bumpAgentLaunchGeneration(name) // current generation now differs from capturedAtLaunch -> skip-stopped
    const killSession = vi.fn()
    const startAgentProcess = vi.fn()
    const action = await applyContinueVerifyOutcome(name, 'sess', { outcome: 'timeout', polls, elapsedMs }, capturedAtLaunch, { killSession, startAgentProcess })
    expect(action).toBe('skip-stopped')
    expect(killSession).not.toHaveBeenCalled()
    expect(startAgentProcess).not.toHaveBeenCalled()
  })

  it("'relaunch-fresh': unchanged generation on timeout -- kills the session then relaunches fresh", async () => {
    const name = `__m1-fresh-${Date.now()}-${Math.random().toString(36).slice(2)}`
    // Mirrors the real launch call site: it bumps the map to a fresh symbol and captures that
    // SAME symbol as capturedAtLaunch, right before opening the verify window.
    bumpAgentLaunchGeneration(name)
    const capturedAtLaunch = __getAgentLaunchGenerationForTest(name)!
    const killSession = vi.fn()
    const startAgentProcess = vi.fn(async () => ({ ok: true, pid: 1 }))
    const action = await applyContinueVerifyOutcome(name, 'sess', { outcome: 'timeout', polls, elapsedMs }, capturedAtLaunch, { killSession, startAgentProcess })
    expect(action).toBe('relaunch-fresh')
    expect(killSession).toHaveBeenCalledWith(name, 'sess')
    expect(startAgentProcess).toHaveBeenCalledWith(name, { fresh: true })
  })

  // Y2 (Cybersec GO 32483, MEDIUM-1): the old call site could pass the CAPTURED generation as the
  // "current" one too, which makes every timeout read as unchanged and re-opens the original F1
  // bug (a just-stopped agent gets wrongly relaunched fresh). Removed structurally, not just
  // tested: applyContinueVerifyOutcome takes only ONE generation symbol (capturedAtLaunch) and
  // looks up "current" itself from the module's own map -- there is no second symbol parameter a
  // call site could mix up with it any more. This test still pins the real map-lookup wiring: the
  // same capturedAtLaunch symbol produces opposite actions depending on what is CURRENTLY in the
  // map for that name, which only holds if the lookup is genuinely live, not a stale copy.
  it('Y2 MUTATION PIN: same capturedAtLaunch symbol -> relaunch-fresh if nothing changed since, skip-stopped if the map moved on', async () => {
    const name = `__m1-y2-${Date.now()}-${Math.random().toString(36).slice(2)}`
    const capturedAtLaunch = Symbol()
    const killSessionA = vi.fn()
    const startA = vi.fn(async () => ({ ok: true, pid: 1 }))
    // agentLaunchGeneration has nothing for `name` yet -> undefined != capturedAtLaunch -> changed.
    const a = await applyContinueVerifyOutcome(name, 'sess', { outcome: 'timeout', polls, elapsedMs }, capturedAtLaunch, { killSession: killSessionA, startAgentProcess: startA })
    expect(a).toBe('skip-stopped')
    expect(startA).not.toHaveBeenCalled()

    const killSessionB = vi.fn()
    const startB = vi.fn(async () => ({ ok: true, pid: 1 }))
    // Now set the map to the SAME symbol as capturedAtLaunch -> unchanged -> relaunch-fresh.
    bumpAgentLaunchGeneration(name)
    const matching = __getAgentLaunchGenerationForTest(name)!
    const b = await applyContinueVerifyOutcome(name, 'sess', { outcome: 'timeout', polls, elapsedMs }, matching, { killSession: killSessionB, startAgentProcess: startB })
    expect(b).toBe('relaunch-fresh')
    expect(startB).toHaveBeenCalledWith(name, { fresh: true })
  })
})

describe('card 2b2fbabc F2: a stop on an already-not-running agent still bumps the generation', () => {
  it('never-started agent: isAgentRunning is false (sanity, no real tmux session exists)', () => {
    expect(isAgentRunning(`__f2-sanity-${Date.now()}`)).toBe(false)
  })
  it('stopAgentProcess on a session that was never started still invalidates a pending --continue callback', async () => {
    const name = `__f2-test-${Date.now()}-${Math.random().toString(36).slice(2)}`
    const before = __getAgentLaunchGenerationForTest(name)
    expect(before).toBeUndefined()
    const r = await stopAgentProcess(name)
    expect(r).toEqual({ ok: false, error: 'Agent is not running' })
    const after = __getAgentLaunchGenerationForTest(name)
    // RED before the fix: the old early return sat BEFORE the bump, so `after` stayed undefined,
    // byte-identical to `before` -- a pending --continue callback captured earlier would still see
    // its own generation as unchanged and wrongly relaunch-fresh, undoing this explicit stop.
    expect(after).toBeDefined()
    expect(after).not.toBe(before)
  })
})

describe('the launch path is wired to the policy', () => {
  it('startAgentProcess decides with decideContinueFlag from the measured inputs and no longer hardcodes !hasChannel', () => {
    expect(PROCESS_SRC).not.toContain("(hasPriorSession && !opts.fresh && !hasChannel) ? '--continue ' : ''")
    expect(PROCESS_SRC).toContain('const usesLaunchSecret = providerEnv !== \'\' || apiKeyEnv !== \'\'')
    expect(PROCESS_SRC).toContain('fleetTokenLaunch: oauthTokenEnv !== \'\'')
    expect(PROCESS_SRC).toContain('installedCli = hasAnyChannel ? (await measureClaudeCliVersion()).version : null')
    expect(PROCESS_SRC).toContain("const continueFlag = continueDecision.useContinue ? '--continue ' : ''")
  })
  it('a resumed channel launch is verified with the plugin-liveness probe and its outcome goes through applyContinueVerifyOutcome', () => {
    const at = PROCESS_SRC.indexOf('if (continueFlag && hasAnyChannel && name !== MAIN_AGENT_ID) {')
    expect(at).toBeGreaterThan(-1)
    const block = PROCESS_SRC.slice(at, at + 1000)
    expect(block).toContain('verifyContinueLaunch({')
    expect(block).toContain('probeChannelPluginLiveness(pid, agentProvider, name)')
    // card 56344ff4: the post-resolve tail (kill/relaunch/log) is no longer inline here -- it moved
    // into applyContinueVerifyOutcome, which carries its own behavioural tests (Y11/Y2 mutation
    // pins, above) instead of a source-text check on its branches.
    expect(block).toContain('applyContinueVerifyOutcome(name, session, v, myLaunchGeneration)')
  })
  it('every launch bumps its own agentLaunchGeneration entry BEFORE the verify window opens', () => {
    const newSessionAt = PROCESS_SRC.indexOf("runTmux(startTarget, ['new-session', '-d', '-s', session, buildLaunchCmd(dir)]")
    const continueAt = PROCESS_SRC.indexOf('if (continueFlag && hasAnyChannel && name !== MAIN_AGENT_ID) {')
    const between = PROCESS_SRC.slice(newSessionAt, continueAt)
    expect(newSessionAt).toBeGreaterThan(-1)
    expect(continueAt).toBeGreaterThan(newSessionAt)
    expect(between).toContain('const myLaunchGeneration = Symbol()')
    expect(between).toContain('agentLaunchGeneration.set(name, myLaunchGeneration)')
  })
  it('stopAgentProcessUnlocked bumps the generation before killing the session AND before the not-running early return (card 466f21fe F1, card 2b2fbabc F2)', () => {
    const stopAt = PROCESS_SRC.indexOf('async function stopAgentProcessUnlocked(name: string)')
    expect(stopAt).toBeGreaterThan(-1)
    const killAt = PROCESS_SRC.indexOf("kill-session", stopAt)
    const notRunningAt = PROCESS_SRC.indexOf("return { ok: false, error: 'Agent is not running' }", stopAt)
    const bumpAt = PROCESS_SRC.indexOf('agentLaunchGeneration.set(name, Symbol())', stopAt)
    expect(notRunningAt).toBeGreaterThan(stopAt)
    expect(bumpAt).toBeGreaterThan(stopAt)
    expect(bumpAt).toBeLessThan(killAt)
    // The actual F2 behaviour (that this moved bump really runs before the early return, not just
    // textually above it) is proven by execution in the 'card 2b2fbabc F2' describe block above.
    expect(bumpAt).toBeLessThan(notRunningAt)
  })
})

describe('card eb26a3e4 point 2: non-router session kills also bump the launch generation', () => {
  const HEALER_SRC = readFileSync(join(ROOT, 'src', 'web', 'reauth-healer.ts'), 'utf-8')
  it('restartFirstRunGatedAgent bumps the generation BEFORE killing the session, not after', () => {
    const fnAt = HEALER_SRC.indexOf('async function restartFirstRunGatedAgent(name: string, session: string)')
    expect(fnAt).toBeGreaterThan(-1)
    const bumpAt = HEALER_SRC.indexOf('bumpAgentLaunchGeneration(name)', fnAt)
    const killAt = HEALER_SRC.indexOf('kill-session', fnAt)
    expect(bumpAt).toBeGreaterThan(fnAt)
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
