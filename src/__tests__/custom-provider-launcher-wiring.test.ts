// Card 657b32f2 (WhiteHat follow-up on f1800242 CYBERSEC GO, comment 14832):
//
// F1 (MEDIUM): startAgentProcessUnlocked is not itself integration-tested (tmux/filesystem side
// effects, same reason agent-launch-key-quoting.test.ts and provider-env-adoption.test.ts pin their
// launcher call sites from the SOURCE rather than driving them end-to-end). Two mutants survived at
// the launcher call site that resolveProviderEnv's own unit tests cannot see, because they live one
// layer up:
//   (a) customProviderId silently not passed through to resolveProviderEnv -> the model-string
//       heuristic decides instead, against the fleet token, for what the agent's config says should
//       be a custom provider.
//   (b) the catch block falls back to `providerEnv = ''` instead of refusing the start -> the agent
//       launches WITHOUT the custom provider after a registry/vault failure, instead of not launching
//       at all.
//
// F4 (LOW): a remote (ssh) agent's customProviderId is read but never consulted before
// startAgentProcessUnlocked delegates to startRemoteAgentProcess, which has no provider-env override
// at all -- the setting silently does nothing. Fixed (this card) with a loud refusal instead, pinned
// below both as a pure-predicate unit test and as a source-shape test that the refusal actually runs
// before the remote delegation.
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { refuseRemoteCustomProvider } from '../web/agent-process.js'

const SRC = readFileSync(join(import.meta.dirname, '..', 'web', 'agent-process.ts'), 'utf-8')

// The launcher body, isolated by its own start/end markers (the same slice-between-declarations
// technique approvals-delivery.test.ts and agent-launch-key-quoting.test.ts already use for a
// too-expensive-to-integration-test call site) so a change to an unrelated function cannot make
// these assertions pass or fail for the wrong reason.
const LAUNCHER_START = 'async function startAgentProcessUnlocked('
const LAUNCHER_END = 'async function stopAgentProcessUnlocked('
const launcherBody = SRC.slice(SRC.indexOf(LAUNCHER_START), SRC.indexOf(LAUNCHER_END))
if (launcherBody.length < 2000) throw new Error('startAgentProcessUnlocked slice looks wrong -- marker text may have moved')

describe('F1: the launcher actually wires customProviderId through to resolveProviderEnv', () => {
  it('passes customProviderId as the 3rd argument of the real resolveProviderEnv call', () => {
    expect(launcherBody).toMatch(/resolveProviderEnv\([\s\S]*?,\s*customProviderId\)\.exportsStr/)
  })

  it('a resolveProviderEnv failure refuses the start (ok: false), never a silent empty providerEnv', () => {
    const catchBlock = launcherBody.slice(launcherBody.indexOf('let providerEnv: string'))
    const tryBlock = catchBlock.slice(0, catchBlock.indexOf('catch (err)'))
    const afterCatch = catchBlock.slice(catchBlock.indexOf('catch (err)'), catchBlock.indexOf('catch (err)') + 300)
    expect(tryBlock).toContain('let providerEnv: string')
    expect(afterCatch).toMatch(/return \{ ok: false, error: `customProvider:/)
    // The negative: the catch body must NOT merely assign an empty string and fall through.
    expect(afterCatch).not.toMatch(/providerEnv\s*=\s*['"]{2}/)
  })
})

describe('F4: a remote agent refuses a customProvider it cannot honor', () => {
  it('refuseRemoteCustomProvider(unit): remote + a set id -> refusal message naming the id', () => {
    const msg = refuseRemoteCustomProvider(true, 'my-ollama')
    expect(msg).toContain('my-ollama')
    expect(msg).toMatch(/remote/i)
  })

  it('refuseRemoteCustomProvider(unit): remote + no id -> null (nothing to honor, nothing to refuse)', () => {
    expect(refuseRemoteCustomProvider(true, null)).toBeNull()
  })

  it('refuseRemoteCustomProvider(unit): local + a set id -> null (the local path DOES honor it)', () => {
    expect(refuseRemoteCustomProvider(false, 'my-ollama')).toBeNull()
  })

  it('the launcher calls refuseRemoteCustomProvider BEFORE delegating to startRemoteAgentProcess', () => {
    const remoteBranch = launcherBody.slice(launcherBody.indexOf('if (remote.host && remote.workdir)'))
    const refusalIdx = remoteBranch.indexOf('refuseRemoteCustomProvider(')
    const delegateIdx = remoteBranch.indexOf('return startRemoteAgentProcess(')
    expect(refusalIdx).toBeGreaterThan(0)
    expect(delegateIdx).toBeGreaterThan(refusalIdx)
    // And the refusal must actually be acted on (an early return), not just called and ignored.
    const between = remoteBranch.slice(refusalIdx, delegateIdx)
    expect(between).toMatch(/return \{ ok: false, error: refusal \}/)
  })
})
