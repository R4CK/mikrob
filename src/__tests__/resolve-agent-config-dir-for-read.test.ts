// resolveAgentConfigDirForRead: the READ-side config-dir resolver (card 272361eb, B-wave 3/6).
//
// WHY IT IS NOT THE SAME QUESTION AS resolveAgentConfigDir. That one answers "what was configured",
// and returns null when nothing was. The launcher, however, auto-provisions an isolated config dir
// for a channel sub-agent with no explicit field (ensureIsolatedChannelConfigDir) and does NOT
// write the path back into the agent config. A reader that stops at "nothing configured" falls
// back to the host default and reports another agent's absence as this one's -- a plausible answer,
// not an error, which is the worst shape a wrong answer can take.
//
// Measured before adopting: 0 of 15 agents on this install are currently in that state, so this is
// a latent fix rather than a live defect. The path is reachable for the next auto-provisioned
// agent, and these cases pin the behaviour either way.
//
// The projectRootOverride parameter is what makes this testable without touching the real tree.
import { describe, it, expect } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { resolveAgentConfigDirForRead } from '../web/claude-plans.js'

/** A throwaway PROJECT_ROOT with an agents/<name>/.claude-config tree. */
function fakeRoot(name: string, opts: { projects: boolean }): { root: string; expected: string } {
  const root = mkdtempSync(join(tmpdir(), 'cfgdir-'))
  const isolated = join(root, 'agents', name, '.claude-config')
  mkdirSync(isolated, { recursive: true })
  if (opts.projects) mkdirSync(join(isolated, 'projects'), { recursive: true })
  return { root, expected: isolated }
}

describe('resolveAgentConfigDirForRead (card 272361eb)', () => {
  // A name that cannot have a configured field or a plan: it is not a real agent, so
  // resolveAgentConfigDir() returns null and the isolated-dir branch is the one under test.
  const NAME = 'agent-that-does-not-exist-272361eb'

  it('finds an auto-provisioned isolated dir that the agent config never recorded', () => {
    const f = fakeRoot(NAME, { projects: true })
    try {
      expect(resolveAgentConfigDirForRead(NAME, f.root)).toBe(f.expected)
    } finally {
      rmSync(f.root, { recursive: true, force: true })
    }
  })

  it('requires projects/ -- a half-provisioned dir must not shadow the shared root', () => {
    // The directory exists but carries no transcripts. Returning it would point a reader at an
    // empty tree while the agent is genuinely still using the shared ~/.claude.
    const f = fakeRoot(NAME, { projects: false })
    try {
      expect(resolveAgentConfigDirForRead(NAME, f.root)).toBeNull()
    } finally {
      rmSync(f.root, { recursive: true, force: true })
    }
  })

  it('returns null when there is no isolated dir at all', () => {
    const root = mkdtempSync(join(tmpdir(), 'cfgdir-empty-'))
    try {
      expect(resolveAgentConfigDirForRead(NAME, root)).toBeNull()
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('the context guard reads through THIS resolver, not the raw config field', () => {
    // Wiring, not just the predicate: the fix is worthless if the runner still calls the old one.
    // Same shape as the hook-guards wiring test -- assert the call site, from the source.
    //
    // COMMENTS ARE STRIPPED FIRST, and that is not a detail: the first version of this assertion
    // failed on the runner's own explanatory comment, which names the old function precisely
    // BECAUSE it is explaining what was replaced. A guard that matches its own rationale is the
    // same trap as a config guard matching its own comments.
    const raw = readFileSync(join(import.meta.dirname, '..', 'web', 'context-guard-runner.ts'), 'utf-8')
    const code = raw.split('\n').filter((l) => !l.trim().startsWith('//')).join('\n')
    // The stripping itself is pinned: if it ever stopped removing anything, the negative below
    // would go vacuous in the silent direction.
    expect(code.length).toBeLessThan(raw.length)
    expect(code).toContain('resolveAgentConfigDirForRead(name)')
    expect(code).not.toContain('readAgentClaudeConfigDir(')
  })
})

