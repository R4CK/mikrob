// Card 2a653b4b: no module-level `const X = resolveFromPath(...)` anywhere in src.
//
// WHY THE PATTERN AND NOT A FILE LIST. resolveFromPath THROWS when the binary is not on PATH, and at
// module level that happens at IMPORT time -- so a transient PATH gap, or an environment where
// `claude` is not installed, fails the whole module load and takes every importer down with it. The
// consequence is not partial: it is not one feature degrading, it is the dashboard (and the scheduler
// that lives inside it) failing to boot. platform.ts's own makeLazyBinResolver comment says exactly
// this, and agent-process.ts and channel-monitor.ts already follow it.
//
// Ten occurrences across nine files were converted on this card. Listing those nine files here would
// pin history; what needs pinning is the SHAPE, so the tenth occurrence cannot be written quietly in
// a file nobody thought to add to a list. Function-local `resolveFromPath(...)` calls are deliberately
// fine -- those resolve at call time, which is the behaviour we want, so the pattern is anchored to
// column zero.
import { describe, it, expect } from 'vitest'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const SRC = join(fileURLToPath(new URL('../..', import.meta.url)), 'src')

/** A top-level binding initialised straight from resolveFromPath. Anchored to column zero on
 *  purpose: an indented one is inside a function and resolves lazily by construction. */
const EAGER_CONST_RE = /^(?:export\s+)?(?:const|let|var)\s+\w+\s*=\s*resolveFromPath\s*\(/m

function tsFiles(dir: string): string[] {
  const out: string[] = []
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) out.push(...tsFiles(full))
    else if (entry.endsWith('.ts') || entry.endsWith('.tsx')) out.push(full)
  }
  return out
}

describe('no eager module-level resolveFromPath constants (card 2a653b4b)', () => {
  it('src/**/*.ts holds none -- a PATH gap must not be able to fail an import', () => {
    const offenders: string[] = []
    for (const file of tsFiles(SRC)) {
      const content = readFileSync(file, 'utf-8')
      if (!EAGER_CONST_RE.test(content)) continue
      content.split('\n').forEach((line, i) => {
        if (EAGER_CONST_RE.test(line)) offenders.push(`${file.slice(SRC.length + 1)}:${i + 1}: ${line.trim()}`)
      })
    }
    expect(offenders).toEqual([])
  })

  it('the sweep actually walks a meaningful number of files', () => {
    // A path typo would make the loop above scan nothing and pass forever. This is the same
    // non-vacuity problem the docs-corpus guards in this repo hit: green is the expected state
    // either way, so the count has to be asserted separately.
    expect(tsFiles(SRC).length).toBeGreaterThan(200)
  })
})

describe('EAGER_CONST_RE: non-vacuous, and correctly ignores the lazy shapes', () => {
  const forbidden = [
    "const TMUX = resolveFromPath('tmux')",
    "const CLAUDE = resolveFromPath('claude')",
    "export const TMUX = resolveFromPath('tmux')",
    "let TMUX = resolveFromPath('tmux')",
    "const TMUX  =  resolveFromPath ('tmux')",
  ]
  for (const s of forbidden) {
    it(`flags: ${s}`, () => expect(EAGER_CONST_RE.test(s)).toBe(true))
  }

  const allowed = [
    // Function-local: resolves at CALL time, which is the whole point.
    "    const bin = resolveFromPath('claude')",
    "  const claudeBin = claudeBin ?? resolveFromPath('claude')",
    // The replacement shape.
    "const tmuxBin = makeLazyBinResolver('tmux')",
    // Prose naming the forbidden shape must not trip the guard, or the comment explaining the rule
    // would break the rule (measured elsewhere in this repo: a guard that matches its own rationale).
    "// a module-level `const TMUX = resolveFromPath('tmux')` throws at import time",
  ]
  for (const s of allowed) {
    it(`ignores: ${s.trim().slice(0, 56)}`, () => expect(EAGER_CONST_RE.test(s)).toBe(false))
  }
})
