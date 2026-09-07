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

/** Every match of `re` in `content`, as `line: text` strings, one entry per match.
 *
 *  NOT "test each line separately" (card 5fcfd76c): a pattern's `\s*` can span newlines, so a
 *  prettier-wrapped two-line declaration --
 *    const someBinaryPath =
 *      resolveFromPath('some-binary')
 *  -- matches a FULL-CONTENT test, but splitting on '\n' and testing each half alone finds it
 *  on NEITHER line (the first has no `resolveFromPath`, the second has no `const ... =`), so a
 *  per-line loop silently produces zero offenders for a real match. A single content-wide
 *  `exec` loop, with the line number derived from the match's own index, catches single-line
 *  AND multi-line matches alike.
 *
 *  `re` must already carry the `g` flag (each caller below builds its own fresh RegExp) -- a
 *  SHARED global regex reused across calls would leak `lastIndex` state between them, and reusing
 *  one of the exported pattern constants directly (rather than a fresh copy) would leak into the
 *  unrelated one-off strings the second describe block below tests with `.test()`.
 */
function execOffenders(re: RegExp, content: string): string[] {
  const lines = content.split('\n')
  const offenders: string[] = []
  let match: RegExpExecArray | null
  while ((match = re.exec(content)) !== null) {
    // The patterns below only capture up to the opening paren, so match[0] alone would
    // truncate "const TMUX = resolveFromPath(" mid-call. Report the STARTING line's own full
    // text instead, located from the match's index rather than by re-testing each line alone.
    const lineNo = content.slice(0, match.index).split('\n').length
    offenders.push(`${lineNo}: ${lines[lineNo - 1].trim()}`)
    if (match[0].length === 0) re.lastIndex++ // never loop forever on a zero-width match
  }
  return offenders
}

// ---------------------------------------------------------------------------------------------
// Card 51950c11 (Cybersec finding on 2a653b4b, live-fire confirmed by QA via an injected two-line
// throw into mcp-list.ts -- 11/11 green before the fix here, caught after): EAGER_CONST_RE only
// recognises the literal identifier `resolveFromPath` called directly on the right of `=`. Four
// further shapes reach the SAME import-time throw without matching that one pattern. All are
// latent (0 occurrences today) -- this closes the gap before one lands, not in response to one.

/** Shape: an ALIASED import (`import { resolveFromPath as rfp } from '...'`) then an eager call
 *  through the alias. EAGER_CONST_RE only knows the literal name "resolveFromPath", so a rename
 *  at the import boundary makes every later use invisible to it. */
function aliasedImportOffenders(content: string): string[] {
  const aliasMatch = content.match(/\bresolveFromPath\s+as\s+(\w+)\b/)
  if (!aliasMatch || aliasMatch[1] === 'resolveFromPath') return []
  const re = new RegExp(
    `^(?:export\\s+)?(?:const|let|var)\\s+\\w+\\s*=\\s*${aliasMatch[1]}\\s*\\(`, 'gm',
  )
  return execOffenders(re, content)
}

/** Shape: a NAMESPACE import of platform.js (`import * as platform from '.../platform.js'`)
 *  then an eager call as `platform.resolveFromPath(...)`. Same blind spot as the alias case, one
 *  level indirected through a property access instead of a renamed binding. */
function namespaceImportOffenders(content: string): string[] {
  const nsMatch = content.match(/\bimport\s*\*\s*as\s+(\w+)\s+from\s+['"][^'"]*platform(?:\.js)?['"]/)
  if (!nsMatch) return []
  const re = new RegExp(
    `^(?:export\\s+)?(?:const|let|var)\\s+\\w+\\s*=\\s*${nsMatch[1]}\\.resolveFromPath\\s*\\(`, 'gm',
  )
  return execOffenders(re, content)
}

/** Shape: a WRAPPED call -- resolveFromPath nested inside another call expression on the RHS,
 *  e.g. `const claudeBin = String(resolveFromPath('claude'))`. Still eager: an argument
 *  expression evaluates before the outer call does, regardless of what the outer call is.
 *  Explicitly NOT flagged: the direct case (already covered by EAGER_CONST_RE, excluded here to
 *  avoid a duplicate offender for the same line) and the LAZY shape where resolveFromPath sits
 *  inside a function/arrow body that is defined but not immediately invoked -- that resolves at
 *  CALL time, which is the behaviour this whole file exists to require. */
function wrappedCallOffenders(content: string): string[] {
  // The lookaheads sit DIRECTLY after `=`, each with its OWN `\s*` inside, rather than a shared
  // `\s*` living outside them before the checks run. A shared outer `\s*` is backtrackable: when
  // the lookahead correctly fails at its maximal (1-space) position, the engine backtracks that
  // `\s*` down to zero-width and re-checks the lookahead ONE CHARACTER EARLIER -- landing on the
  // space itself, where "resolveFromPath(" is no longer the very next text, so the negative
  // lookahead wrongly PASSES there instead. Measured directly: with the `\s*` left outside, the
  // direct case `const claudeBin = resolveFromPath('claude')` was (wrongly) also flagged as
  // "wrapped". Folding the whitespace into each lookahead removes the backtrackable gap the bug
  // lived in.
  const re = /^(?:export\s+)?(?:const|let|var)\s+\w+\s*=(?!\s*resolveFromPath\s*\()(?!\s*\([^)]*\)\s*=>)(?!\s*function\b)[^\n;]*?resolveFromPath\s*\(/gm
  return execOffenders(re, content)
}

/** Shape: `export default resolveFromPath(...)`. No variable name at all, so EAGER_CONST_RE
 *  (anchored on `const|let|var NAME =`) structurally cannot match it, yet the call is exactly as
 *  eager -- it runs the moment the module evaluates. */
function exportDefaultOffenders(content: string): string[] {
  const re = /^export\s+default\s+resolveFromPath\s*\(/gm
  return execOffenders(re, content)
}

/** Every offender in `content`, across all five recognised shapes, sorted by line number and
 *  DE-DUPLICATED: the namespace shape (`platform.resolveFromPath(...)`) is also, correctly, a
 *  wrapped-call in the sense that it is not the bare direct form -- both detectors legitimately
 *  match the same line, and only one report of it is useful. */
function findOffenders(content: string): string[] {
  const re = new RegExp(EAGER_CONST_RE.source, EAGER_CONST_RE.flags + 'g')
  const all = [
    ...execOffenders(re, content),
    ...aliasedImportOffenders(content),
    ...namespaceImportOffenders(content),
    ...wrappedCallOffenders(content),
    ...exportDefaultOffenders(content),
  ]
  return [...new Set(all)].sort((a, b) => parseInt(a, 10) - parseInt(b, 10))
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

describe('findOffenders: the four further shapes (card 51950c11)', () => {
  it('ALIASED import: `resolveFromPath as rfp` then an eager call through the alias', () => {
    const src = "import { resolveFromPath as rfp } from '../../platform.js'\nconst claudeBin = rfp('claude')\n"
    expect(findOffenders(src)).toEqual(["2: const claudeBin = rfp('claude')"])
  })

  it('...but an import with NO alias (or aliased back to its own name) is unaffected', () => {
    const src = "import { resolveFromPath } from '../../platform.js'\nconst helper = () => resolveFromPath('claude')\n"
    expect(findOffenders(src)).toEqual([])
  })

  it('NAMESPACE import: `import * as platform` then `platform.resolveFromPath(...)`', () => {
    const src = "import * as platform from '../../platform.js'\nconst claudeBin = platform.resolveFromPath('claude')\n"
    expect(findOffenders(src)).toEqual(["2: const claudeBin = platform.resolveFromPath('claude')"])
  })

  it('...but a namespace import of an UNRELATED module is unaffected', () => {
    const src = "import * as fs from 'node:fs'\nconst x = fs.readFileSync('claude')\n"
    expect(findOffenders(src)).toEqual([])
  })

  it('WRAPPED call: resolveFromPath nested inside another call expression', () => {
    const src = "const claudeBin = String(resolveFromPath('claude'))\n"
    expect(findOffenders(src)).toEqual(["1: const claudeBin = String(resolveFromPath('claude'))"])
  })

  it('...but the DIRECT form is reported once, not twice (no double-count with EAGER_CONST_RE)', () => {
    const src = "const claudeBin = resolveFromPath('claude')\n"
    expect(findOffenders(src)).toEqual(["1: const claudeBin = resolveFromPath('claude')"])
  })

  it('...and a LAZY wrapper (defined, not invoked) stays allowed -- the whole point of the pattern', () => {
    const src = "const claudeBin = () => resolveFromPath('claude')\n"
    expect(findOffenders(src)).toEqual([])
  })

  it('EXPORT DEFAULT: no variable name at all, but still eager', () => {
    const src = "export default resolveFromPath('claude')\n"
    expect(findOffenders(src)).toEqual(["1: export default resolveFromPath('claude')"])
  })

  it('...but a lazy export default (a function) stays allowed', () => {
    const src = "export default function claudeBin() { return resolveFromPath('claude') }\n"
    expect(findOffenders(src)).toEqual([])
  })

  it('all four new shapes are latent in real src today -- 0 occurrences, matching the card', () => {
    // The card's own premise: these are PREVENTIVE additions, not fixes for an existing miss.
    // If this ever fails, someone wrote one of the four shapes for real -- read the failure like
    // the main sweep test above, not like a false alarm in this file.
    const offenders: string[] = []
    for (const file of tsFiles(SRC)) {
      const content = readFileSync(file, 'utf-8')
      const rel = file.slice(SRC.length + 1)
      for (const hit of [
        ...aliasedImportOffenders(content),
        ...namespaceImportOffenders(content),
        ...wrappedCallOffenders(content),
        ...exportDefaultOffenders(content),
      ]) offenders.push(`${rel}:${hit}`)
    }
    expect(offenders).toEqual([])
  })
})
