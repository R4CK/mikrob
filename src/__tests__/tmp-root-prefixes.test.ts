// Card ec7bdad8. Two separate things are pinned here, and they share a cause: a list that
// exists in more than one place, and a DECISION that exists in more than one place.
//
// (1) THE LIST. The transient-root prefixes now live in one module (adopted from upstream),
//     but this fork carries a copy an import cannot reach: scripts/boot-hook-prune.py has the
//     same four prefixes in Python. Nothing would notice those two drifting apart, so the
//     cross-language pair is asserted here rather than trusted.
//
// (2) THE RECORD. ACKNOWLEDGED_CONFLICTS said hookScriptAlreadyEffectiveInOtherScope was
//     "NOT ADOPTED". The B-wave merge (card 42938a74) brought it in anyway -- it auto-merged
//     around the conflicts being resolved -- so the code was adopted and tested while the
//     written rule still refused it. At merge time a human acts on the WRITTEN RULE, so a rule
//     that contradicts the tree is the dangerous half. This is the same guard idiom
//     provider-env-adoption.test.ts uses for the MiniMax pin.
import { describe, it, expect } from 'vitest'
import { readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { TMP_ROOT_PREFIXES } from '../web/tmp-root-prefixes.js'
import { isUnsafeHookCommand } from '../web/agent-scaffold.js'

const REPO_ROOT = join(import.meta.dirname, '..', '..')

// A LIST-DRIVEN LOOP CANNOT CATCH A SHRINKING LIST: if someone deletes a prefix, every
// `for (const p of TMP_ROOT_PREFIXES)` assertion below simply runs one round less and stays
// green. So the list is ALSO pinned literally. Adding a prefix is a deliberate act and updates
// this line; losing one goes red. (Upstream's own reasoning, kept.)
const EXPECTED = ['/tmp/', '/var/tmp/', '/private/tmp/', '/dev/shm/']

describe('the shared list itself', () => {
  it('contains exactly the four transient roots, unchanged', () => {
    expect([...TMP_ROOT_PREFIXES].sort()).toEqual([...EXPECTED].sort())
  })
})

describe('the hook-command guard consumes the shared list', () => {
  it('refuses a hook command under every prefix in it', () => {
    for (const p of TMP_ROOT_PREFIXES) {
      expect(isUnsafeHookCommand(`python3 ${p}hooks/guard.py`), `hook guard: ${p}`).toBe(true)
    }
  })

  // Negative control: without this, a guard that returned true for EVERYTHING would pass the
  // assertion above and prove nothing. It has to name a script that REALLY EXISTS, because the
  // guard's second clause rejects a path that is not on disk -- which is how this control caught
  // its own first draft.
  it('still allows a durable, existing, non-transient hook command', () => {
    const real = join(REPO_ROOT, 'scripts', 'hooks', 'cd-chain-guard.py')
    expect(existsSync(real), 'the control needs a script that exists').toBe(true)
    expect(isUnsafeHookCommand(`python3 ${real}`)).toBe(false)
  })
})

describe('the copy an import cannot reach (scripts/boot-hook-prune.py)', () => {
  const PRUNE = readFileSync(join(REPO_ROOT, 'scripts', 'boot-hook-prune.py'), 'utf-8')

  it('carries the SAME four prefixes as the TypeScript module', () => {
    // Parsed out of the python tuple literal rather than substring-matched, so a prefix that
    // is merely MENTIONED in a comment there cannot satisfy this.
    const m = PRUNE.match(/^_TMP_PREFIXES\s*=\s*\(([^)]*)\)/m)
    expect(m, 'the _TMP_PREFIXES tuple was not found in boot-hook-prune.py').toBeTruthy()
    const pyPrefixes = [...m![1]!.matchAll(/'([^']+)'/g)].map((x) => x[1]!)
    expect(pyPrefixes.sort()).toEqual([...EXPECTED].sort())
  })
})

describe('the acknowledged-conflicts RECORD matches the tree (card ec7bdad8)', () => {
  // Prose corpus on purpose: what is asserted here is what a human MERGER WILL READ, not a
  // code fact -- so the source text is the right thing to read (CLAUDE.md rule 12's stated
  // exception). The code fact is measured separately, below, comment-stripped.
  const RULES = readFileSync(join(REPO_ROOT, 'src/fork-upstream/acknowledged-conflicts.ts'), 'utf-8')
  const SCAFFOLD = readFileSync(join(REPO_ROOT, 'src/web/agent-scaffold.ts'), 'utf-8')

  const stripComments = (src: string) =>
    src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')

  it('the function really IS wired -- the premise of the correction, measured not assumed', () => {
    const code = stripComments(SCAFFOLD)
    expect(code).toContain('export function hookScriptAlreadyEffectiveInOtherScope(')
    const calls = [...code.matchAll(/hookScriptAlreadyEffectiveInOtherScope\(/g)].length
    // one declaration + the call sites; the declaration alone would mean dead code, not a gate.
    expect(calls, 'expected the declaration plus its call sites').toBeGreaterThanOrEqual(2)
  })

  it('the rule no longer leaves the stale refusal standing alone', () => {
    // The refusal sentence survives as history -- that is more useful than deleting it -- but it
    // may not be the LAST word on the subject. The correction has to be present with it.
    expect(RULES).toContain('THAT REFUSAL NO LONGER DESCRIBES THE TREE')
    expect(RULES).toContain('hookScriptAlreadyEffectiveInOtherScope IS')
  })

  it('the rule names how it got in, so the next merger can check the same way', () => {
    expect(RULES).toContain('42938a74')
    expect(RULES).toContain('b92a5b66')
  })

  it('the rule forbids the wrong reflex: deleting a working, covered gate as cleanup', () => {
    expect(RULES).toMatch(/DO NOT 'restore' the fork behaviour by deleting the function/)
  })
})
