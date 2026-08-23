// Card 1ce3fd90 (Peti, 2026-08-23). A model STEP DOWN must respawn the agent with a FRESH session;
// a revert back up keeps the conversation.
//
// The measured incident: Fron Ted carried 593 843 accumulated tokens when the ladder dropped it to
// Haiku. The respawn used --continue, so the whole history was re-fed, uncached, into a SMALLER
// context window: two back-to-back compactions (52s + 63s), and the session then sat in
// "Context limit reached" and never produced a usable answer. The fallback that exists to keep an
// agent working had made it unusable.
//
// Two halves are pinned here, because two different things can break:
//   1. restartFor actually passes the flag through (behavioural, below).
//   2. the ONE call site asks for fresh on a step down (source-level -- see the comment there).
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const restartAgentProcess = vi.fn(async () => ({ ok: true }))
const hardRestartMarveenChannels = vi.fn(() => ({ ok: true }))

vi.mock('../logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() },
}))
vi.mock('../web/channel-monitor.js', () => ({ hardRestartMarveenChannels }))
vi.mock('../web/agent-process.js', () => ({
  agentRunState: () => 'running',
  agentSessionName: (n: string) => `agent-${n}`,
  restartAgentProcess,
  capturePane: () => null,
}))

const { restartFor } = await import('../web/model-fallback-runner.js')
const { MAIN_AGENT_ID } = await import('../config.js')

describe('restartFor carries the session-continuity decision', () => {
  beforeEach(() => {
    restartAgentProcess.mockClear()
    hardRestartMarveenChannels.mockClear()
  })

  it('fresh: true reaches restartAgentProcess -- the stepped-down agent starts clean', async () => {
    await restartFor('backend2', { fresh: true })
    expect(restartAgentProcess).toHaveBeenCalledWith('backend2', { fresh: true })
  })

  // CONTROL. Without this, "always pass fresh: true" would satisfy the case above, and the revert
  // would silently throw away a conversation the bigger model can perfectly well hold.
  it('CONTROL: fresh: false still reaches it -- a revert keeps the conversation', async () => {
    await restartFor('backend2', { fresh: false })
    expect(restartAgentProcess).toHaveBeenCalledWith('backend2', { fresh: false })
  })

  // Main has no --continue path to choose between (channels.sh always starts it fresh), so the flag
  // is not consulted there. Pinned so a later reader does not "fix" main by routing it through
  // restartAgentProcess, which would restart the wrong process.
  it('main restarts through the channels hard-restart, whatever the flag says', async () => {
    await restartFor(MAIN_AGENT_ID, { fresh: false })
    await restartFor(MAIN_AGENT_ID, { fresh: true })
    expect(hardRestartMarveenChannels).toHaveBeenCalledTimes(2)
    expect(restartAgentProcess).not.toHaveBeenCalled()
  })

  it('a failed main restart is an error, not a silent no-op', async () => {
    hardRestartMarveenChannels.mockReturnValueOnce({ ok: false } as { ok: boolean })
    await expect(restartFor(MAIN_AGENT_ID, { fresh: true })).rejects.toThrow()
  })
})

// The WIRING half. checkAgent is not exported and is six mocks deep in tmux/pane/config I/O, so a
// runtime harness for it would mostly assert its own mocks -- the same reasoning main-restart-platform
// .test.ts states for its source-level guards, and the same idiom. Comments are stripped first, so the
// explanation above restartFor cannot satisfy the assertion on its own.
//
// The LIMIT, said plainly: this pins the literal call, not its meaning. It would still pass if
// `steppingDown` were computed backwards. That direction is what the ladder-index expression above it
// carries, and it is shared with the parked-agent path.
describe('the model-switch call site asks for a fresh session on a step down', () => {
  const src = readFileSync(join(import.meta.dirname, '..', 'web', 'model-fallback-runner.ts'), 'utf8')
  const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')

  it('passes { fresh: steppingDown } and nothing else', () => {
    const calls = [...code.matchAll(/await\s+restartFor\(([^)]*)\)/g)].map((m) => m[1])
    expect(calls).toHaveLength(1)
    expect(calls[0]?.replace(/\s+/g, ' ')).toBe('name, { fresh: steppingDown }')
  })

  // Anti-vacuity: if restartFor were renamed, the regex above would find zero calls and the length
  // assertion would be the only thing standing. Prove the file still routes its restarts through it.
  it('the runner still has exactly one restart helper', () => {
    expect(code).toMatch(/export async function restartFor\(/)
  })
})
