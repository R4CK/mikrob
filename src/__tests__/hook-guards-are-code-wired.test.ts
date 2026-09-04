// Every PreToolUse guard must be wired BY CODE, on both paths (card 2a07f29e).
//
// THE DEFECT THIS CLOSES, measured 2026-09-04. `noisy-command-guard.py` had existed since
// 2026-08-23 and CLAUDE.md rule 15 cited it as an armed control -- but nothing in the codebase
// ever registered it. It reached agents only because someone hand-added it to the SHARED
// ~/.claude/settings.json, which provisionIsolatedConfigDir() copies into each agent's
// .claude-config at provisioning time. Coverage was therefore an accident of WHEN each agent was
// provisioned relative to that hand-edit: three agents (marketing, penzugy, videooo) never got it,
// and any agent re-provisioned after someone tidies that shared file would lose it again.
//
// Same class as card 0fa54550 (npm guard hand-copied, 5 of 13 agents unguarded). Twice is a
// pattern, so this test is about the CLASS, not about one guard: it derives the guard list from
// the source and demands both halves for each. A new guard added with only an injector -- or only
// an ensurer -- fails here rather than a month later on an agent nobody checked.
//
// THE TWO HALVES, and why neither alone is enough:
//   inject<X>  in ensureAgentHooks' generation block -> reaches an agent when its settings.json is
//              regenerated, i.e. on the next spawn. Covers new agents; misses existing ones.
//   ensure<X>  in web.ts's boot backfill loop -> reaches agents that already have a settings.json.
//              Covers existing agents on a dashboard restart; a brand-new agent gets it from the
//              generation path first.
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const SRC = join(import.meta.dirname, '..')
const SCAFFOLD = readFileSync(join(SRC, 'web', 'agent-scaffold.ts'), 'utf-8')
const WEB = readFileSync(join(SRC, 'web.ts'), 'utf-8')

/** The generation block: from the governance-gate calls to the settings write that ends it. */
function generationBlock(src: string): string {
  const start = src.indexOf('if (agentGetsEmailGate(name)) injectEmailSendGate(existing)')
  expect(start, 'could not locate the hook-generation block in agent-scaffold.ts').toBeGreaterThan(-1)
  const end = src.indexOf('atomicWriteFileSync(settingsPath', start)
  expect(end).toBeGreaterThan(start)
  return src.slice(start, end)
}

/**
 * Derived from the source, not hand-listed: every `injectXGuard(existing)` whose body wires a
 * `scripts/hooks/<file>` command. A hand-written list is what let the previous two guards slip --
 * it can only ever check what someone remembered to add to it.
 */
function injectorsWiringAHookScript(src: string): { fn: string; script: string }[] {
  const out: { fn: string; script: string }[] = []
  const rx = /export function (inject\w+)\(existing[^)]*\)[^{]*\{([\s\S]*?)\n\}/g
  let m: RegExpExecArray | null
  while ((m = rx.exec(src)) !== null) {
    const script = /'scripts', 'hooks', '([^']+)'/.exec(m[2])
    if (script) out.push({ fn: m[1], script: script[1] })
  }
  return out
}

const INJECTORS = injectorsWiringAHookScript(SCAFFOLD)
const GEN = generationBlock(SCAFFOLD)

describe('every hook guard is registered by code, on both paths (card 2a07f29e)', () => {
  it('the derivation found a non-trivial number of guards (never vacuously green)', () => {
    // If the regex stops matching -- a refactor changes the signature, say -- this file would
    // silently assert nothing at all. That is the failure mode of the thing it is guarding.
    expect(INJECTORS.length).toBeGreaterThanOrEqual(7)
    expect(INJECTORS.map((i) => i.script)).toContain('noisy-command-guard.py')
    expect(INJECTORS.map((i) => i.script)).toContain('cd-chain-guard.py')
  })

  it.each(INJECTORS)('$script: the generation path calls $fn', ({ fn }) => {
    expect(GEN).toContain(`${fn}(existing)`)
  })

  it.each(INJECTORS)('$script: a matching ensure* exists and the boot backfill calls it', ({ fn }) => {
    const ensure = fn.replace(/^inject/, 'ensure')
    expect(SCAFFOLD, `${ensure} must exist in agent-scaffold.ts`).toContain(`export function ${ensure}(name: string)`)
    expect(WEB, `web.ts's backfill loop must call ${ensure}`).toContain(`${ensure}(agentName)`)
  })

  // The backfill only helps if it runs over EVERY agent, including the hidden technical ones --
  // HBGATEWIRE826 found the heartbeat agent running with zero dashboard-side hooks because the
  // loop used the dashboard-visibility list.
  it('the backfill loop covers the main agent and ALL agents, hidden ones included', () => {
    expect(WEB).toContain('for (const agentName of [MAIN_AGENT_ID, ...listAllAgentNames()])')
  })
})

// The reason the hand-added copy was invisible for two weeks, pinned so the next reader does not
// have to re-derive it. Both settings files are live; only one of them is owned by code.
describe('why a hand-added hook is not coverage', () => {
  it('the isolated config dir does NOT inherit the project settings -- it copies the SHARED file', () => {
    const proc = readFileSync(join(SRC, 'web', 'agent-process.ts'), 'utf-8')
    // settings.json is deliberately per-agent (not symlinked to the shared one)...
    expect(proc).toContain("const ISOLATED_CONFIG_SKIP = new Set(['settings.json'")
    // ...and it is seeded from ~/.claude/settings.json, NOT from agents/<name>/.claude/settings.json.
    expect(proc).toContain("const sharedSettings = join(realClaude, 'settings.json')")
  })

  it('the code-owned path is the PROJECT settings file, which is what ensure* writes', () => {
    expect(SCAFFOLD).toContain("return join(agentDir(name), '.claude', 'settings.json')")
  })
})
