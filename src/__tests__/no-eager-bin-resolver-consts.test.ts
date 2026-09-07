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

/** Every EAGER_CONST_RE match in `content`, as `line: text` strings.
 *
 *  NOT "test each line separately" (card 5fcfd76c): EAGER_CONST_RE's `\s*` already spans
 *  newlines, so a prettier-wrapped two-line declaration --
 *    const someBinaryPath =
 *      resolveFromPath('some-binary')
 *  -- matches the FULL-CONTENT test, but splitting on '\n' and testing each half alone finds
 *  it on NEITHER line (the first has no `resolveFromPath`, the second has no `const ... =`),
 *  so the old per-line loop silently produced zero offenders for a real match. A single
 *  content-wide `exec` loop, with the line number derived from the match's own index, catches
 *  single-line AND multi-line matches alike. A FRESH RegExp per call, not EAGER_CONST_RE
 *  itself with a `g` flag added: a shared global regex's `lastIndex` would leak across the
 *  unrelated one-off strings the second describe block below tests with `.test()`.
 */
function findOffenders(content: string): string[] {
  const re = new RegExp(EAGER_CONST_RE.source, EAGER_CONST_RE.flags + 'g')
  const lines = content.split('\n')
  const offenders: string[] = []
  let match: RegExpExecArray | null
  while ((match = re.exec(content)) !== null) {
    // EAGER_CONST_RE only captures up to the opening paren, so match[0] alone would truncate
    // "const TMUX = resolveFromPath(" mid-call. Report the STARTING line's own full text
    // instead (what the old per-line loop showed for the single-line case), located from the
    // match's index rather than by re-testing each line in isolation -- see the comment above.
    const lineNo = content.slice(0, match.index).split('\n').length
    offenders.push(`${lineNo}: ${lines[lineNo - 1].trim()}`)
    if (match[0].length === 0) re.lastIndex++ // never loop forever on a zero-width match
  }
  return offenders
}

describe('no eager module-level resolveFromPath constants (card 2a653b4b)', () => {
  it('src/**/*.ts holds none -- a PATH gap must not be able to fail an import', () => {
    const offenders: string[] = []
    for (const file of tsFiles(SRC)) {
      const content = readFileSync(file, 'utf-8')
      const rel = file.slice(SRC.length + 1)
      for (const hit of findOffenders(content)) offenders.push(`${rel}:${hit}`)
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

describe('findOffenders: catches the prettier-wrapped two-line form (card 5fcfd76c)', () => {
  it('a two-line eager const IS caught, attributed to the line it starts on', () => {
    const src = "import x from 'y'\nconst someBinaryPath =\n  resolveFromPath('some-binary')\n"
    expect(findOffenders(src)).toEqual(['2: const someBinaryPath ='])
  })

  it('CONTROL: the old per-line approach would have found NOTHING for the same input', () => {
    // Pins the actual regression: EAGER_CONST_RE matches the full two-line content (that part
    // was never broken), but neither individual line contains a complete match on its own.
    const lines = "const someBinaryPath =\n  resolveFromPath('some-binary')".split('\n')
    expect(lines.some((l) => EAGER_CONST_RE.test(l))).toBe(false)
    expect(EAGER_CONST_RE.test(lines.join('\n'))).toBe(true)
  })

  it('a single-line eager const is still caught (no regression on the common case)', () => {
    const src = "const TMUX = resolveFromPath('tmux')\n"
    expect(findOffenders(src)).toEqual(["1: const TMUX = resolveFromPath('tmux')"])
  })

  it('two offenders in one file are both reported, each on its own line', () => {
    const src = "const A = resolveFromPath('a')\nconst B =\n  resolveFromPath('b')\n"
    expect(findOffenders(src)).toEqual([
      "1: const A = resolveFromPath('a')",
      '2: const B =',
    ])
  })

  it('a clean file yields no offenders', () => {
    expect(findOffenders("const tmuxBin = makeLazyBinResolver('tmux')\n")).toEqual([])
  })
})
