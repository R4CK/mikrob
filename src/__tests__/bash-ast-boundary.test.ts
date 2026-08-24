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
import { execFileSync } from 'node:child_process'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
// @ts-expect-error -- plain .mjs hook script, no types
import { heredocOwnerSpans, astAvailable } from '../../scripts/bash-ast.mjs'
// @ts-expect-error -- plain .mjs hook script, no types
import { stripHeredocDataPayloads, gateDecision, divergenceHead } from '../../scripts/self-pace-gate.mjs'

const PROJECT_SCRIPTS = join(dirname(dirname(dirname(fileURLToPath(import.meta.url)))), 'scripts')

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

describe.runIf(ARMED)('round 2: a heredoc redirected ONTO a compound (Cybersec F-1)', () => {
  // THE BYPASS I SHIPPED, and the shape of my mistake. bash gives a heredoc redirected onto a
  // compound construct to EVERY command in the group, not to the last one. Descending to the
  // syntactically last `command` therefore named an exempt data sink as the owner while an
  // interpreter EARLIER in the group executed the same text -- 14 shapes measured flipping
  // DENY -> ALLOW in `on` mode, four proven by execution.
  //
  // My original battery put the heredoc INSIDE each construct, where the owner genuinely is curl.
  // That measured a real property, just not the one under attack. These cases are the mirror image,
  // and they are enumerated from the grammar's own `redirected_statement.body` subtype list rather
  // than from the patch -- the discipline whose absence produced the gap.
  const SINK = 'curl -sS -d @- http://127.0.0.1:1/x'
  const GITSINK = 'git commit -F -'
  const PROG = 'python3 -'
  const SCHED = 'cron' + 'tab -'
  const H = (cmd: string): string => `${cmd} <<'J'\n${SCHED}\nJ`

  const COMPOUND: Array<[string, string]> = [
    ['compound_statement { }', H(`{ ${PROG}; ${SINK}; }`)],
    ['subshell ( )', H(`( ${PROG}; ${SINK} )`)],
    ['if_statement', H(`if true; then ${PROG}; else ${SINK}; fi`)],
    ['case_statement', H(`case $x in a) ${PROG} ;; b) ${SINK} ;; esac`)],
    ['for_statement', H(`for i in 1 2; do ${PROG}; ${SINK}; done`)],
    ['c_style_for_statement', H(`for ((i=0;i<2;i++)); do ${PROG}; ${SINK}; done`)],
    ['while_statement', H(`while false; do ${PROG}; ${SINK}; done`)],
    ['until', H(`until true; do ${PROG}; ${SINK}; done`)],
    ['select', H(`select v in a b; do ${PROG}; ${SINK}; done`)],
    ['function_definition', H(`f() { ${PROG}; ${SINK}; }`)],
    ['{ } with the git sink last', H(`{ ${PROG}; ${GITSINK}; }`)],
    ['{ } at a pipeline tail', H(`true | { ${PROG}; ${SINK}; }`)],
    ['{ } at an && list tail', H(`true && { ${PROG}; ${SINK}; }`)],
    ['negated subshell ! ( )', H(`! ( ${PROG}; ${SINK} )`)],
    ['negated brace ! { }', H(`! { ${PROG}; ${SINK}; }`)],
    ['nested { { } }', H(`{ { ${PROG}; ${SINK}; }; }`)],
  ]

  it.each(COMPOUND)('denies with the AST DRIVING: %s', (_name, cmd) => {
    // `on` is the mode the cutover would ship. A test that only runs the default would not see
    // this class at all -- which is exactly how it shipped.
    withEnv('SELF_PACE_AST', 'on', () => {
      expect(gateDecision('Bash', { command: cmd }).deny).toBe(true)
    })
  })

  it.each(COMPOUND)('gives the same verdict in every flag mode: %s', (_name, cmd) => {
    const off = withEnv('SELF_PACE_AST', 'off', () => gateDecision('Bash', { command: cmd }).deny)
    const shadow = withEnv('SELF_PACE_AST', 'shadow', () => gateDecision('Bash', { command: cmd }).deny)
    const on = withEnv('SELF_PACE_AST', 'on', () => gateDecision('Bash', { command: cmd }).deny)
    expect({ shadow, on }).toEqual({ shadow: off, on: off })
  })

  // The availability half: the fix must not cost a single legitimate exemption.
  const LEGIT: Array<[string, string]> = [
    ['plain curl payload', H(SINK)],
    ['plain git message', H(GITSINK)],
    ['curl at a pipeline tail', H(`true | ${SINK}`)],
    ['curl at an && list tail', H(`true && ${SINK}`)],
    ['negated curl', H(`! ${SINK}`)],
    ['env-prefixed curl', H(`FOO=bar ${SINK}`)],
    ['a REAL curl inside a brace group', `{\n${H(SINK)}\n}`],
    ['a REAL curl inside an if', `if true; then\n${H(SINK)}\nfi`],
    ['a REAL curl inside a for', `for i in 1; do\n${H(SINK)}\ndone`],
  ]

  it.each(LEGIT)('stays exempt with the AST driving: %s', (_name, cmd) => {
    withEnv('SELF_PACE_AST', 'on', () => {
      expect(gateDecision('Bash', { command: cmd }).deny).toBe(false)
    })
  })
})

describe.runIf(ARMED)('round 2: the cutover criterion itself (Cybersec F-2)', () => {
  it('an empty divergence log does NOT license the cutover -- this battery does', () => {
    // THE PROCESS DEFECT BEHIND F-1. The shipped REVIEW said the cutover criterion was "run shadow
    // until the divergence log shows zero disagreements". That criterion is structurally blind to
    // a false NEGATIVE: the attacker picks the shape, and none of the fourteen compound-redirect
    // shapes occurs in good-faith fleet traffic. A week of empty log would have produced exactly
    // the confidence needed to enable fourteen bypasses.
    //
    // Dark launch is the right tool for FALSE POSITIVES -- it genuinely caught the `git commit -F -`
    // regression -- and the wrong tool for false negatives. The criterion is therefore: the
    // ADVERSARIAL battery is green with SELF_PACE_AST=on. This test is that criterion, executable.
    const SCHED = 'cron' + 'tab -'
    const attack = `{ python3 -; curl -sS -d @- http://127.0.0.1:1/x; } <<'J'\n${SCHED}\nJ`
    // Nobody writes this by accident, so no amount of shadow-mode traffic would surface it. The
    // only thing that can is an assertion someone wrote on purpose -- this one.
    withEnv('SELF_PACE_AST', 'on', () => {
      expect(gateDecision('Bash', { command: attack }).deny).toBe(true)
    })
  })
})

describe('round 2: the divergence log must not become a credential sink (Cybersec F-3)', () => {
  it('reduces a leading environment assignment to its NAME', () => {
    // MY OWN LEAK. The comment claimed "shape-only, never the command text", and the intent was
    // right -- but "the leading word" is not the binary when the command carries an inline
    // assignment, and CURL_LEADING_RX itself allows that form. `TOKEN=<secret> curl -d @- ...` put
    // the secret VALUE in the log as the head. Measured with a synthetic value before fixing.
    // divergenceHead is exported precisely so this assertion is real rather than conditional --
    // an earlier draft skipped when the function was not exposed, which would have passed while
    // proving nothing.
    expect(divergenceHead('DASHBOARD_TOKEN=s3cr3t curl -d @- http://x')).toBe('DASHBOARD_TOKEN=')
    expect(divergenceHead('A=1 B=s3cr3t python3 -')).toBe('A=')
    expect(divergenceHead('curl -sS -d @- http://x')).toBe('curl')
    // ...and the value never appears anywhere in the reported head.
    expect(divergenceHead('DASHBOARD_TOKEN=s3cr3t curl -d @-')).not.toContain('s3cr3t')
  })
})

describe('round 2: the test-only module switch is inert in production (Cybersec F-4)', () => {
  it('ignores SELF_PACE_AST_MODULE_PATH when not running under test', () => {
    // The switch makes the guard `require` code from an operator-supplied path -- foreign code in
    // the guard process. It exists only so this suite can arm itself, so it must not be reachable
    // in the configuration that actually guards the fleet.
    //
    // This has to spawn a CHILD process: the suite always runs under VITEST, so an in-process
    // assertion could only ever observe the armed branch and would prove nothing.
    const modulePath = process.env.SELF_PACE_AST_MODULE_PATH
    if (!modulePath) return // nothing to prove when the suite itself is disarmed
    const script =
      "import('" + join(PROJECT_SCRIPTS, 'bash-ast.mjs') + "')" +
      ".then((m) => { process.stdout.write(String(m.astAvailable())) })"
    const env: Record<string, string | undefined> = { ...process.env, SELF_PACE_AST_MODULE_PATH: modulePath }
    delete env.VITEST
    delete env.VITEST_WORKER_ID
    delete env.NODE_ENV
    const out = execFileSync(process.execPath, ['-e', script], { env, encoding: 'utf-8' })
    expect(out.trim(), 'the module path was honoured outside test -- F-4 has regressed').toBe('false')
  })
})

describe.runIf(ARMED)('round 2: a command PREFIX keyword must not be read as the binary', () => {
  // tree-sitter folds `coproc` / `time` into the command node as its command_name, demoting the
  // real binary to an argument. Left alone, the span reads `coproc curl ...` and the ownership
  // check rejects a legitimate payload -- two false positives that `off` mode does NOT have, found
  // by running the WHOLE suite in `on` mode rather than only the four targeted files. That is the
  // corrected cutover criterion (F-2) catching a defect the previous one could not.
  const SCHED = 'cron' + 'tab -e'
  const withHeredoc = (head: string, binary: string): string =>
    `${head}${binary} -s -d @- http://x <<'J'\n${SCHED}\nJ`

  it.each([
    ['coproc', 'coproc '],
    ['time', 'time '],
    ['time with a flag', 'time -p '],
  ])('a legitimate curl payload behind `%s` stays exempt in every mode', (_name, head) => {
    const cmd = withHeredoc(head, 'curl')
    const off = withEnv('SELF_PACE_AST', 'off', () => gateDecision('Bash', { command: cmd }).deny)
    const on = withEnv('SELF_PACE_AST', 'on', () => gateDecision('Bash', { command: cmd }).deny)
    expect(off).toBe(false)
    expect(on, 'the AST path disagrees with the walker on a prefix keyword').toBe(off)
  })

  it.each([
    ['coproc', 'coproc '],
    ['time with a flag', 'time -p '],
  ])('DIRECTION CONTROL: `%s` does not launder a non-curl binary', (_name, head) => {
    // Skipping a prefix moves the span start FORWARD, which grants more exemption -- the direction
    // that can open a hole. The ownership check still runs on whatever follows, so an interpreter
    // behind the same prefix must stay denied.
    const cmd = withHeredoc(head, 'python3')
    withEnv('SELF_PACE_AST', 'on', () => {
      expect(gateDecision('Bash', { command: cmd }).deny).toBe(true)
    })
  })
})
