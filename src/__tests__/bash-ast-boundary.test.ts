// Card f16b3165 -- the tree-sitter-bash boundary recogniser and its dark launch.
//
// ARMING. tree-sitter is an OPTIONAL dependency (adding it touches package-lock.json, which no
// agent may stage), so the AST assertions can only run where it is installed. Rather than let that
// turn into a suite that silently proves nothing, the file reports out loud which mode it ran in --
// the same pattern governance-gates.test.ts uses for its tmp-checkout gate. Point
// SELF_PACE_AST_MODULE_PATH at an install to arm it.
//
// The DISARMED assertions are not a formality: "no dependency" is the state this lands in, and the
// contract in that state (every call returns null, the walker's behaviour is untouched, the gate
// still denies what it denied before) is exactly what makes landing this safe. Those run always.
import { describe, expect, it, beforeAll } from 'vitest'
// @ts-expect-error -- plain .mjs hook script, no types
import { heredocOwnerSpans, astAvailable } from '../../scripts/bash-ast.mjs'
// @ts-expect-error -- plain .mjs hook script, no types
import { stripHeredocDataPayloads, gateDecision } from '../../scripts/self-pace-gate.mjs'

const ARMED = astAvailable()

beforeAll(() => {
  console.log(
    ARMED
      ? '[bash-ast-boundary.test.ts] ARMED -- tree-sitter present, AST assertions ran.'
      : '[bash-ast-boundary.test.ts] DISARMED -- tree-sitter absent; only the null-contract assertions ran. ' +
        'Set SELF_PACE_AST_MODULE_PATH to an install to arm the grammar battery.'
  )
})

// heredocOwnerSpans comes from an untyped .mjs hook script; naming its shape once here keeps the
// rest of the file type-checked instead of spreading `any` through it.
type OwnerSpans = Map<number, number> | null

const PAYLOAD = "curl -sS -d @- http://x <<'J'\nBODY\nJ"

// The six forms named in the card as never covered by the hand-written walker, plus the classes
// seven previous review rounds produced. Ground-truthed with `bash -n`: every entry except the
// extglob one is valid bash (extglob needs `shopt -s extglob` at PARSE time, so bash rejects it
// too -- it is here to pin that an unparseable input yields no opinion rather than a guess).
const GRAMMAR_BATTERY: Record<string, string> = {
  'arith (( ))': `(( x = 1 )) && ${PAYLOAD}`,
  select: `select v in a b; do\n${PAYLOAD}\ndone`,
  '[[ ]] test': `[[ -f x ]] && ${PAYLOAD}`,
  coproc: `coproc CP {\n${PAYLOAD}\n}`,
  'function f()': `function f() {\n${PAYLOAD}\n}`,
  'case arm': `case $x in a)\n${PAYLOAD}\n;; esac`,
  'brace group': `{\n${PAYLOAD}\n}`,
  negation: `! ${PAYLOAD}`,
  subshell: `(\n${PAYLOAD}\n)`,
  while: `while true; do\n${PAYLOAD}\ndone`,
  until: `until false; do\n${PAYLOAD}\ndone`,
  'nested $( )': `echo $(\n${PAYLOAD}\n)`,
  pipe: `true | ${PAYLOAD}`,
}

describe('bash-ast: the null contract (runs armed or not)', () => {
  it('returns null, never a guess, when it cannot form an opinion', () => {
    // Oversized input declines BEFORE parsing, in both modes -- the cap is not dependency-gated.
    expect(heredocOwnerSpans('x'.repeat(200000))).toBeNull()
  })

  it('leaves the existing gate behaviour intact in the shipped (dependency-absent) state', () => {
    // This is the assertion that makes landing safe: with no tree-sitter installed, the gate must
    // still deny a scheduler call and still exempt a legitimate curl payload.
    expect(gateDecision('Bash', { command: 'crontab -e' }).deny).toBe(true)
    const legit = "curl -sS -d @- http://x <<'J'\ncrontab -e\nJ"
    expect(gateDecision('Bash', { command: legit }).deny).toBe(false)
    // And an interpreter heredoc is NOT exempted, dependency or not.
    const interp = "python3 <<'PY'\ncrontab -e\nPY"
    expect(gateDecision('Bash', { command: interp }).deny).toBe(true)
  })

  it('does not throw on input the walker also has to survive', () => {
    expect(() => heredocOwnerSpans('')).not.toThrow()
    expect(() => heredocOwnerSpans(undefined as unknown as string)).not.toThrow()
    expect(() => heredocOwnerSpans("curl -d @- <<'J'\nunterminated")).not.toThrow()
  })
})

describe.runIf(ARMED)('bash-ast: grammar battery (the six forms the walker never covered)', () => {
  for (const [name, src] of Object.entries(GRAMMAR_BATTERY)) {
    it(`names curl as the heredoc owner: ${name}`, () => {
      const spans: OwnerSpans = heredocOwnerSpans(src)
      expect(spans, `${name}: expected an opinion, got null`).not.toBeNull()
      const owners = ownerTexts(src, spans!)
      expect(owners.length, `${name}: expected exactly one heredoc`).toBe(1)
      expect(owners[0].startsWith('curl'), `${name}: owner was "${owners[0]}"`).toBe(true)
    })
  }

  it('an unparseable input yields NO opinion rather than a wrong one', () => {
    // extglob without `shopt -s extglob` is a syntax error in bash itself.
    expect(heredocOwnerSpans(`ls !(a|b) && ${PAYLOAD}`)).toBeNull()
  })

  it('gives an INTERPRETER heredoc to the interpreter, not to a curl elsewhere on the line', () => {
    // The bypass class that produced seven rounds of findings: the body bash actually feeds to
    // python3 must never be attributed to the outer curl and blanked.
    const src = "curl -d @- $(python3 <<'PY'\nimport os\nPY\n) <<'J'\nBODY\nJ"
    const spans: OwnerSpans = heredocOwnerSpans(src)
    const owners = ownerTexts(src, spans!)
    expect(owners.some((o) => o.startsWith('python3'))).toBe(true)
    expect(owners.filter((o) => o.startsWith('python3')).length).toBe(1)
  })

  it('attributes a piped heredoc to the LAST command, as bash does', () => {
    // Guards the prototype bug this file was written after: taking the pipeline HEAD instead of
    // the tail named `true` as the owner of curl's payload.
    const src = `true | ${PAYLOAD}`
    const spans: OwnerSpans = heredocOwnerSpans(src)
    const owners = ownerTexts(src, spans!)
    expect(owners[0].startsWith('curl')).toBe(true)
    expect(owners[0].startsWith('true')).toBe(false)
  })
})

describe.runIf(ARMED)('bash-ast: the measured DoS constraint', () => {
  it('still ANSWERS at nesting depth that overflows a recursive walk', () => {
    // Measured: the PARSER handles 50 000 levels of `$( )` in ~58 ms and scales linearly, but a
    // RECURSIVE tree walk blows the JS stack somewhere between 1000 and 5000 levels. So the walk
    // must stay iterative.
    //
    // ASSERT THE ANSWER, NOT THE ABSENCE OF A THROW. The first version of this test was
    // `expect(() => ...).not.toThrow()`, which a deliberately recursive mutant SURVIVED: this
    // module catches everything and returns null, so "does not throw" is true no matter what
    // happens inside. The observable consequence of the stack blowing is a silent degradation to
    // "no opinion" -- measured: recursive returns null from depth 5000 up while iterative keeps
    // answering -- so that is what has to be pinned.
    const deep = "curl -d @- <<'J'\nB\nJ\n" + 'echo ' + '$('.repeat(20000) + 'x' + ')'.repeat(20000)
    const spans: OwnerSpans = heredocOwnerSpans(deep)
    expect(spans, 'deep nesting degraded to "no opinion" -- is the walk recursive again?').not.toBeNull()
    expect(ownerTexts(deep, spans!)[0].startsWith('curl')).toBe(true)
  })

  it('declines oversized input instead of spending seconds on it', () => {
    const huge = 'echo ' + 'a '.repeat(200000)
    const t0 = Date.now()
    expect(heredocOwnerSpans(huge)).toBeNull()
    expect(Date.now() - t0).toBeLessThan(200)
  })
})

describe.runIf(ARMED)('bash-ast: dark-launch agreement with the hand-written walker', () => {
  // Change 7 of the plan-grilling verdict: the definition of done is the new battery closed with
  // ZERO regression on the good-faith controls. Agreement here is what licenses the cutover.
  const CONTROLS: Record<string, string> = {
    ...GRAMMAR_BATTERY,
    'plain payload': PAYLOAD,
    'git commit -F -': "git commit -F - <<'MSG'\nfix: thing\nMSG",
    'interpreter body': "python3 <<'PY'\nimport os\nPY",
    'curl with auth header': 'curl -H "Authorization: Bearer $(cat tok)" -d @- http://x <<\'J\'\nBODY\nJ',
    'no heredoc at all': 'echo hello world',
  }
  for (const [name, src] of Object.entries(CONTROLS)) {
    it(`shadow mode changes nothing: ${name}`, () => {
      // AST_MODE defaults to 'shadow', so this call already ran both recognisers. The walker's
      // output must be unchanged by their comparison.
      const shadow = stripHeredocDataPayloads(src)
      const off = withEnv('SELF_PACE_AST', 'off', () => stripHeredocDataPayloads(src))
      expect(shadow).toBe(off)
    })
  }
})

// heredocOwnerSpans returns BOUNDARY INDICES (see the module comment on why it must not
// reconstruct text). The owning command's text is the source from that index up to its `<<`.
function ownerTexts(src: string, spans: Map<number, number>): string[] {
  return [...spans.entries()].map(([hereIdx, start]) => src.slice(start, hereIdx).trim())
}

function withEnv<T>(key: string, value: string, fn: () => T): T {
  const prev = process.env[key]
  process.env[key] = value
  try {
    return fn()
  } finally {
    if (prev === undefined) delete process.env[key]
    else process.env[key] = prev
  }
}
