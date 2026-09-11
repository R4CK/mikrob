// One source for "which directory is this agent's working dir" (card 5b6dd606).
//
// THE DEFECT THIS PINS, and it is not hypothetical. Four modules each carried their own private
// `workingDirFor(name)` with the same two-line body. They were copies, so they could drift -- and
// they did: context-restart-gate-runner's copy built `join(PROJECT_ROOT, 'agents', name)` by hand
// while the others went through agentDir() (safeJoin, throws on a traversal-shaped name). Card
// 78c14372 repaired that ONE copy. Repairing a copy leaves the mechanism that produced it, which
// is what this file removes: all four now call the already-exported agentConfigRoot(), and a fifth
// copy cannot be added back without failing here.
//
// The scan runs on COMMENT-STRIPPED source. A guard that matches prose matches its own rationale
// -- including the paragraph above, which names the very declaration it forbids.
import { describe, it, expect } from 'vitest'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { agentConfigRoot } from '../web/agent-config.js'
import { MAIN_AGENT_ID, PROJECT_ROOT } from '../config.js'

const WEB_ROOT = join(import.meta.dirname, '..', 'web')

/** Every .ts file under src/web, recursively. */
function tsFiles(dir: string): string[] {
  const out: string[] = []
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry)
    if (statSync(p).isDirectory()) out.push(...tsFiles(p))
    else if (entry.endsWith('.ts')) out.push(p)
  }
  return out
}

/** Source with `//` line comments and /* *\/ blocks removed. */
function stripComments(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .filter((l) => !l.trim().startsWith('//'))
    .join('\n')
}

// The four modules that used to hold a private copy. Named explicitly rather than derived, so
// deleting a call site is a visible change here and not a silently shrinking scan.
const FORMER_COPY_HOLDERS = [
  'routes/agent-hud.ts',
  'routes/agent-conversation.ts',
  'context-guard-runner.ts',
  'context-restart-gate-runner.ts',
]

describe('agent working dir has exactly one source (card 5b6dd606)', () => {
  it('no module under src/web declares its own workingDirFor', () => {
    const offenders = tsFiles(WEB_ROOT).filter((f) =>
      /(?:function|const)\s+workingDirFor\b/.test(stripComments(readFileSync(f, 'utf-8'))),
    )
    expect(offenders.map((f) => f.slice(WEB_ROOT.length + 1))).toEqual([])
  })

  it.each(FORMER_COPY_HOLDERS)('%s resolves the working dir through agentConfigRoot', (rel) => {
    const raw = readFileSync(join(WEB_ROOT, rel), 'utf-8')
    const code = stripComments(raw)
    // The stripping is pinned too: if it ever stopped removing anything, the negative below would
    // go vacuous in the silent direction (it would start passing on prose).
    expect(code.length).toBeLessThan(raw.length)
    expect(code).toContain('agentConfigRoot(')
    expect(code).not.toMatch(/join\(\s*PROJECT_ROOT\s*,\s*['"]agents['"]/)
  })

  // The property the diverged copy did NOT have, and the reason the divergence was a SEC card
  // rather than a tidiness one. Asserted on the shared helper, so it now holds for every caller
  // by construction instead of per copy.
  it('agentConfigRoot refuses a traversal-shaped name instead of building the path', () => {
    expect(() => agentConfigRoot('../outside-agents')).toThrow(/traversal/i)
    expect(() => agentConfigRoot('/etc')).toThrow(/traversal/i)
  })

  it('agentConfigRoot still answers normally -- the guard is not just a refusal', () => {
    expect(agentConfigRoot(MAIN_AGENT_ID)).toBe(PROJECT_ROOT)
    expect(agentConfigRoot('backend2')).toBe(join(PROJECT_ROOT, 'agents', 'backend2'))
  })
})
