// Card 74181db2: the outgoing-copy-gate reaches ROLE agents, behind a kill-switch that is
// OFF by default.
//
// What made this card necessary is measured on the live install: all 15 role agents carry
// ZERO occurrences of `outgoing-copy-gate` in either settings file, so CLAUDE.md's spelling
// rule ("binds every agent in the fleet") held for them by discipline alone. What made it a
// DECISION rather than a fix is the price: wiring a PreToolUse Bash hook costs a python start
// on every Bash call of every role agent, median 23.5 ms on this host for a command the gate
// has no interest in -- which is the common case.
//
// So these tests are mostly about the SWITCH, not the audit. The audit itself is pinned in
// scripts/hooks/outgoing-copy-gate.selftest.py, against the real hook process.
import { afterEach, describe, expect, it } from 'vitest'
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  agentGetsOutgoingCopyGate,
  injectOutgoingCopyGate,
  outgoingCopyGateEnabled,
  removeOutgoingCopyGate,
  OUTGOING_COPY_GATE_ENV,
  OUTGOING_COPY_GATE_MATCHER,
  ensureGovernanceGateCommands,
  injectEmailSendGate,
  injectSelfPaceGate,
} from '../web/agent-scaffold.js'
import { KNOWN_HOOK_SCRIPTS } from '../web/hook-registration-guard.js'
import { MAIN_AGENT_ID, PROJECT_ROOT } from '../config.js'

const ON = { [OUTGOING_COPY_GATE_ENV]: 'on' } as NodeJS.ProcessEnv

function entriesFor(settings: Record<string, unknown>): unknown[] {
  const hooks = settings.hooks as Record<string, unknown> | undefined
  return Array.isArray(hooks?.PreToolUse) ? (hooks?.PreToolUse as unknown[]) : []
}
const gateEntries = (s: Record<string, unknown>) =>
  entriesFor(s).filter((e) => JSON.stringify(e).includes('outgoing-copy-gate.py'))

describe('the kill-switch defaults to OFF, and that direction is the load-bearing one', () => {
  it('an unset variable means OFF -- the INVERSE of the <GUARD>=off convention', () => {
    // The other guards default to protecting, so a typo in their variable costs protection.
    // This one changes the cost profile of every Bash call in the fleet, so a typo must leave
    // us where we already are rather than silently switching 14 agents on.
    expect(outgoingCopyGateEnabled({} as NodeJS.ProcessEnv)).toBe(false)
    expect(agentGetsOutgoingCopyGate('backend', {} as NodeJS.ProcessEnv)).toBe(false)
  })

  it('only the affirmative spellings turn it on; anything else is off', () => {
    for (const v of ['1', 'on', 'true', 'yes', 'ON', ' True ']) {
      expect(outgoingCopyGateEnabled({ [OUTGOING_COPY_GATE_ENV]: v } as NodeJS.ProcessEnv)).toBe(true)
    }
    // `off` and `0` matter specifically: an operator turning it back off must not be read as
    // "the variable is set, therefore enabled".
    for (const v of ['', 'off', '0', 'false', 'no', 'maybe']) {
      expect(outgoingCopyGateEnabled({ [OUTGOING_COPY_GATE_ENV]: v } as NodeJS.ProcessEnv)).toBe(false)
    }
  })

  it('the MAIN agent never gets it, even switched on -- its own settings already carry the gate', () => {
    expect(agentGetsOutgoingCopyGate(MAIN_AGENT_ID, ON)).toBe(false)
    expect(agentGetsOutgoingCopyGate('backend', ON)).toBe(true)
  })
})

describe('injection is idempotent and reversible', () => {
  it('wires ONE entry on the Bash matcher', () => {
    const s: Record<string, unknown> = {}
    injectOutgoingCopyGate(s)
    const got = gateEntries(s)
    expect(got).toHaveLength(1)
    expect((got[0] as { matcher?: string }).matcher).toBe(OUTGOING_COPY_GATE_MATCHER)
  })

  it('re-running does not accumulate duplicates (respawn re-runs the scaffold)', () => {
    const s: Record<string, unknown> = {}
    injectOutgoingCopyGate(s)
    injectOutgoingCopyGate(s)
    injectOutgoingCopyGate(s)
    expect(gateEntries(s)).toHaveLength(1)
  })

  it('leaves OTHER PreToolUse entries alone in both directions', () => {
    const foreign = { matcher: 'Bash', hooks: [{ type: 'command', command: 'node /x/email-send-gate.mjs' }] }
    const s: Record<string, unknown> = { hooks: { PreToolUse: [foreign] } }
    injectOutgoingCopyGate(s)
    expect(entriesFor(s)).toHaveLength(2)
    removeOutgoingCopyGate(s)
    expect(entriesFor(s)).toEqual([foreign])
  })

  it('REMOVAL is what makes "default off" hold for an already-scaffolded agent', () => {
    // Without this, an agent scaffolded while the switch was on would keep the hook forever:
    // unsetting the variable would look like it worked while every Bash call still paid for a
    // python start. The switch has to work in both directions or it is not a switch.
    const s: Record<string, unknown> = {}
    injectOutgoingCopyGate(s)
    expect(removeOutgoingCopyGate(s)).toBe(true)
    expect(gateEntries(s)).toHaveLength(0)
    // ...and removing from a settings file that never had it is a no-op, not an error.
    expect(removeOutgoingCopyGate(s)).toBe(false)
    expect(removeOutgoingCopyGate({})).toBe(false)
  })
})

describe('the pruner knows this script is ours', () => {
  it('outgoing-copy-gate.py is in KNOWN_HOOK_SCRIPTS', () => {
    // Now that THIS app writes the entry into role settings, a missing-file entry is ours to
    // prune. Unlisted it would read as a foreign hook and be kept forever.
    expect(KNOWN_HOOK_SCRIPTS).toContain('outgoing-copy-gate.py')
  })
})

// --- THE CALL SITES, not just the functions ----------------------------------------
//
// Testing the injector alone would have proved nothing about whether anything CALLS it --
// the exact shape of an earlier finding of mine, where a hook was correct and reached an
// arbitrary subset of agents because only one of its two wiring paths existed. So these drive
// `ensureGovernanceGateCommands` against a real settings file, in both switch positions.
describe('ensureGovernanceGateCommands acts on the switch in BOTH directions', () => {
  const TEST_AGENT = 'outgoingcopy-test-agent'
  const testAgentDir = join(PROJECT_ROOT, 'agents', TEST_AGENT)
  const settingsPath = join(testAgentDir, '.claude', 'settings.json')
  const prevEnv = process.env[OUTGOING_COPY_GATE_ENV]

  afterEach(() => {
    rmSync(testAgentDir, { recursive: true, force: true })
    if (prevEnv === undefined) delete process.env[OUTGOING_COPY_GATE_ENV]
    else process.env[OUTGOING_COPY_GATE_ENV] = prevEnv
  })

  function seed(): void {
    mkdirSync(join(testAgentDir, '.claude'), { recursive: true })
    // Seeded with the two gates already current, so the ONLY thing the repair pass can have
    // left to do is this card's -- otherwise a `true` return would prove nothing.
    const settings: Record<string, unknown> = {}
    injectEmailSendGate(settings)
    injectSelfPaceGate(settings)
    writeFileSync(settingsPath, JSON.stringify(settings, null, 2))
  }
  const wiredNow = (): boolean =>
    JSON.stringify(JSON.parse(readFileSync(settingsPath, 'utf-8'))).includes('outgoing-copy-gate.py')

  it('switch OFF: an otherwise-current agent is left alone (no hook, no rewrite)', () => {
    delete process.env[OUTGOING_COPY_GATE_ENV]
    seed()
    expect(ensureGovernanceGateCommands(TEST_AGENT)).toBe(false)
    expect(wiredNow()).toBe(false)
  })

  it('switch ON: the repair pass wires it, then settles', () => {
    process.env[OUTGOING_COPY_GATE_ENV] = 'on'
    seed()
    expect(ensureGovernanceGateCommands(TEST_AGENT)).toBe(true)
    expect(wiredNow()).toBe(true)
    expect(ensureGovernanceGateCommands(TEST_AGENT), 'idempotent once current').toBe(false)
  })

  it('switched back OFF: the repair pass REMOVES it -- turning it off actually takes effect', () => {
    process.env[OUTGOING_COPY_GATE_ENV] = 'on'
    seed()
    ensureGovernanceGateCommands(TEST_AGENT)
    expect(wiredNow()).toBe(true)
    delete process.env[OUTGOING_COPY_GATE_ENV]
    expect(ensureGovernanceGateCommands(TEST_AGENT)).toBe(true)
    expect(wiredNow(), 'nothing else revisits an already-scaffolded settings file').toBe(false)
    expect(ensureGovernanceGateCommands(TEST_AGENT), 'and it settles again').toBe(false)
  })

  it('the main agent is never wired by the repair pass, switch on or off', () => {
    process.env[OUTGOING_COPY_GATE_ENV] = 'on'
    expect(agentGetsOutgoingCopyGate(MAIN_AGENT_ID)).toBe(false)
  })
})
