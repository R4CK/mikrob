import { describe, it, expect, afterEach } from 'vitest'
import { mkdirSync, rmSync, readFileSync, writeFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import {
  HOOK_NODE_BIN,
  hookCommand,
  hookCommandWired,
  injectEmailSendGate,
  injectSelfPaceGate,
  injectEgressGate,
  ensureEgressGate,
  ensureGovernanceGateCommands,
  EGRESS_GATE_MATCHER,
} from '../web/agent-scaffold.js'
import { PROJECT_ROOT } from '../config.js'
import { REPO_UNDER_TMP, TMP_SKIP_REASON } from './helpers/repo-location.js'

// Review feedback on PR #803, pinned as tests:
//  1. every injector must write a QUOTED absolute interpreter path -- an
//     unquoted execPath with a space in it is split by `sh -c`, exit 127,
//     silently non-enforcing: the exact failure the PR closes, reintroduced;
//  2. the wired-already comparison must be the JSON-escaped one everywhere,
//     otherwise a backslash (Windows) path never settles and every boot
//     rewrites settings.json;
//  3. the ensure* migrations must be idempotent: second call returns false.

const TEST_AGENT = 'hookquoting-test-agent'
const testAgentDir = join(PROJECT_ROOT, 'agents', TEST_AGENT)

afterEach(() => {
  rmSync(testAgentDir, { recursive: true, force: true })
})

function ptuCommands(settings: Record<string, unknown>): string[] {
  const hooks = settings.hooks as Record<string, unknown>
  const ptu = hooks.PreToolUse as { hooks: { command: string }[] }[]
  return ptu.flatMap((e) => e.hooks.map((h) => h.command))
}

describe('hookCommand builder', () => {
  it('quotes BOTH the interpreter and the script path', () => {
    const cmd = hookCommand('/some/dir/gate.mjs')
    expect(cmd).toContain(`"${HOOK_NODE_BIN}" "/some/dir/gate.mjs"`)
  })

  // A missing interpreter must BLOCK, not fall through with 127. process.execPath
  // is a version-pinned path on brew, so a node upgrade can dangle it; without
  // this guard the gate goes silent again on a different route.
  it('blocks with a message when the interpreter is gone, instead of exiting 127', () => {
    const cmd = hookCommand('/some/dir/gate.mjs')
    expect(cmd).toMatch(/^test -x /)
    expect(cmd).toContain('exit 2')
    // the three things the operator needs: what is missing, that this blocks,
    // and the way out
    expect(cmd).toContain(HOOK_NODE_BIN)
    expect(cmd).toContain('BLOKKOL')
    expect(cmd).toContain('inditsd ujra a dashboardot')
  })
})

// A parancs nem a quoted interpreterrel KEZDODIK, hanem tartalmazza azt: elotte all
// egy `test -x <BIN> || { echo ...; exit 2; }` or, hogy egy elmozdult interpreter
// BLOKKOLJON, ne 127-tel csendben atengedjen. Az allitas ezert includes(), es a
// vedett tulajdonsag valtozatlan: abszolut, idezojelezett interpreter, soha nem
// csupasz `node`.
// These three describe blocks call the real injectors/ensure* migrations, which derive their
// script path from PROJECT_ROOT and run it through isUnsafeHookCommand -- so from a /tmp worktree
// the registration guard correctly rejects its own scripts and every assertion here goes red for a
// reason that has nothing to do with the code under test (see helpers/repo-location.ts).
describe.skipIf(REPO_UNDER_TMP)('injectors write a quoted absolute interpreter, never a bare node', () => {
  for (const [label, inject] of [
    ['injectEmailSendGate', injectEmailSendGate],
    ['injectSelfPaceGate', injectSelfPaceGate],
    ['injectEgressGate', injectEgressGate],
  ] as const) {
    it(label, () => {
      const s: Record<string, unknown> = {}
      inject(s)
      const commands = ptuCommands(s)
      expect(commands.length).toBeGreaterThan(0)
      for (const cmd of commands) {
        expect(cmd.includes(`"${HOOK_NODE_BIN}" "`)).toBe(true)
        expect(cmd).not.toMatch(/^node /)
      }
    })
  }
})

describe.skipIf(REPO_UNDER_TMP)('hookCommandWired', () => {
  it('finds a freshly injected command (posix path)', () => {
    const s: Record<string, unknown> = {}
    injectEgressGate(s)
    const cmd = hookCommand(join(PROJECT_ROOT, 'scripts', 'hooks', 'egress-gate.mjs'))
    const ptuJson = JSON.stringify((s.hooks as Record<string, unknown>).PreToolUse)
    expect(hookCommandWired(ptuJson, cmd)).toBe(true)
  })

  it('settles on a backslash (Windows-style) path where the raw compare does not', () => {
    // Reproduces review point 1: the raw includes() disagrees with the
    // serialized form exactly where the escaped form matches.
    const cmd = '"C:\\Program Files\\nodejs\\node.exe" "C:\\marveen\\scripts\\hooks\\egress-gate.mjs"'
    const ptuJson = JSON.stringify([{ matcher: 'WebFetch', hooks: [{ type: 'command', command: cmd, timeout: 10 }] }])
    expect(hookCommandWired(ptuJson, cmd)).toBe(true)   // escaped compare: settles
    expect(ptuJson.includes(cmd)).toBe(false)           // raw compare: never settles
  })
})

describe.skipIf(REPO_UNDER_TMP)('ensure* migrations are idempotent (true, then false)', () => {
  it('ensureEgressGate', () => {
    mkdirSync(join(testAgentDir, '.claude'), { recursive: true })
    expect(ensureEgressGate(TEST_AGENT)).toBe(true)
    expect(ensureEgressGate(TEST_AGENT)).toBe(false)
    const written = JSON.parse(readFileSync(join(testAgentDir, '.claude', 'settings.json'), 'utf-8'))
    for (const cmd of ptuCommands(written)) {
      expect(cmd.includes(`"${HOOK_NODE_BIN}" "`)).toBe(true)
    }
  })

  // QA's finding on card 91c4a369: the tests for the widened egress matcher all called
  // injectEgressGate DIRECTLY, so the CONDITIONAL path -- the one that decides whether the migration
  // fires at all -- was never exercised. That branch is the whole delivery mechanism: every agent
  // already references egress-gate.mjs with the old `WebFetch` matcher, so if ensureEgressGate keeps
  // answering "already wired", the new matcher reaches nobody and the enforcement is decorative.
  it('ensureEgressGate REWIRES an agent whose matcher is the old WebFetch-only one', () => {
    mkdirSync(join(testAgentDir, '.claude'), { recursive: true })
    // A settings file in exactly the state the fleet was in: correct script, correct interpreter,
    // STALE matcher. Everything the old idempotency check looked at is already right here.
    const stale = {
      hooks: {
        PreToolUse: [
          {
            matcher: 'WebFetch',
            hooks: [
              {
                type: 'command',
                command: hookCommand(join(PROJECT_ROOT, 'scripts', 'hooks', 'egress-gate.mjs')),
                timeout: 10,
              },
            ],
          },
        ],
      },
    }
    writeFileSync(
      join(testAgentDir, '.claude', 'settings.json'),
      JSON.stringify(stale, null, 2),
      'utf-8'
    )

    expect(ensureEgressGate(TEST_AGENT), 'a stale matcher must NOT count as wired').toBe(true)
    const written = JSON.parse(
      readFileSync(join(testAgentDir, '.claude', 'settings.json'), 'utf-8')
    ) as { hooks: { PreToolUse: { matcher: string }[] } }
    const egress = written.hooks.PreToolUse.filter((e) =>
      JSON.stringify(e).includes('egress-gate.mjs')
    )
    expect(egress, 'replaced in place, not appended alongside the stale entry').toHaveLength(1)
    expect(egress[0]?.matcher).toBe(EGRESS_GATE_MATCHER)
    // ANCHORED on purpose: Claude Code matches the matcher against the whole tool name, so an
    // unanchored proxy here passed for a bare `mcp__firecrawl__` prefix that fired for nothing.
    expect(
      new RegExp(`^(?:${EGRESS_GATE_MATCHER})$`).test('mcp__firecrawl__firecrawl_scrape')
    ).toBe(true)
    // ...and it settles: a second call has nothing left to do.
    expect(ensureEgressGate(TEST_AGENT), 'the migration must be idempotent once current').toBe(
      false
    )
  })

  it('ensureGovernanceGateCommands upgrades a legacy bare-node entry, then settles', () => {
    mkdirSync(join(testAgentDir, '.claude'), { recursive: true })
    const legacy = {
      hooks: {
        PreToolUse: [
          { matcher: 'Bash|send_email', hooks: [{ type: 'command', command: `node ${join(PROJECT_ROOT, 'scripts', 'email-send-gate.mjs')}`, timeout: 10 }] },
          { matcher: 'Bash', hooks: [{ type: 'command', command: `node ${join(PROJECT_ROOT, 'scripts', 'self-pace-gate.mjs')}`, timeout: 10 }] },
        ],
      },
    }
    const settingsPath = join(testAgentDir, '.claude', 'settings.json')
    writeFileSync(settingsPath, JSON.stringify(legacy, null, 2))

    expect(ensureGovernanceGateCommands(TEST_AGENT)).toBe(true)
    expect(ensureGovernanceGateCommands(TEST_AGENT)).toBe(false)

    expect(existsSync(settingsPath)).toBe(true)
    const written = JSON.parse(readFileSync(settingsPath, 'utf-8'))
    const commands = ptuCommands(written)
    expect(commands.some((c) => c.includes('email-send-gate.mjs'))).toBe(true)
    expect(commands.some((c) => c.includes('self-pace-gate.mjs'))).toBe(true)
    for (const cmd of commands) {
      expect(cmd.includes(`"${HOOK_NODE_BIN}" "`)).toBe(true)
      expect(cmd).not.toMatch(/^node /)
    }
  })
})

// Always runs: a CI log must never be ambiguous about whether the tmp-sensitive suites above were
// armed or skipped (card 252e36d3 -- 13 phantom "failures" were once tracked as a real red baseline).
describe('tmp-checkout env gate (always runs)', () => {
  it('reports whether the hook-registration suites in this file were armed or skipped', () => {
    if (REPO_UNDER_TMP) {
      console.log(`[hook-command-quoting.test.ts] SKIPPED hook-registration suites -- ${TMP_SKIP_REASON}`)
    } else {
      console.log('[hook-command-quoting.test.ts] ARMED -- checkout is outside /tmp, hook-registration assertions ran.')
    }
    expect(typeof REPO_UNDER_TMP).toBe('boolean')
  })
})
