// Card 79bb0364: the fifth false positive of the at(1)/batch(1) collision class, and the first one
// where the trigger is not "what English word follows" but a COMPARISON OPERATOR.
//
// The redirect alternative in the invocation shape read "anything after a `<` is a real submit".
// That is true for batch(1) and false for at(1), so an ordinary comparison of a variable named
// `at` was read as `at < FILE` and denied. backend2 measured it while gating 51273fc0: three
// blocked Bash calls in three languages, the common line a `<=` comparison against zero, and the
// difference test that settles the diagnosis rather than guessing -- the SAME code with the
// variable renamed `pos` passes.
//
// The card carried a SECOND reported class (Cybersec 23941): a markdown code span holding a JS
// condition, inside a quoted heredoc body, blocked their verdict comment six times. Measured here
// it is the SAME root, not a second one -- a backtick is a command-position character, so the code
// span put the word in command position. Their diagnosis named the or-operator in the condition as
// half the trigger; the same span WITHOUT the or-operator denies identically, so it is not part of
// it. That distinction is load-bearing rather than pedantic: the remedy they proposed for the
// or-operator theory -- skip a heredoc body whose delimiter is QUOTED -- would open the vectors
// pinned at the bottom of this file. A quoted delimiter stops the OUTER shell from substituting;
// it does not stop `bash <<'EOF'` or `python3 <<'PY'` from EXECUTING that body.
//
// WHY THE SECOND HALF IS THE LOAD-BEARING ONE, same as the sibling suite: the change makes the
// branch deny LESS, so the risk is a hole, not a false positive.
//
// Assembled from parts, like the sibling English-word suite: this file is itself scanned by the
// gate it tests.
import { describe, it, expect } from 'vitest'
// @ts-expect-error -- plain .mjs hook script, no types
import { gateDecision } from '../../scripts/self-pace-gate.mjs'

const NL = String.fromCharCode(10)
const AT = 'a' + 't'
const BATCH = 'bat' + 'ch'
const LT = String.fromCharCode(60)
const LE = LT + '='
const TICK = String.fromCharCode(96)
const OR = String.fromCharCode(124, 124)
const bash = (command: string): boolean => Boolean(gateDecision('Bash', { command }).deny)
/** A quoted-delimiter heredoc body -- the carrier in every reported repro. */
const doc = (...lines: string[]): string => [`cat > note.txt <<'XEOF'`, ...lines, 'XEOF'].join(NL)

describe('a comparison of a variable named "at" is not an at(1) redirect (card 79bb0364)', () => {
  // Every row here was measured DENIED on the pre-fix file.
  const CASES: Array<[string, string]> = [
    ['the reported line, in a JS body', `  if (${AT} ${LE} 0) return 0`],
    ['the reported line, in a python body', `if ${AT} ${LE} 0:`],
    ['zero spaces around the operator', `if (${AT}${LE}0) return`],
    ['strict less-than against a bare name', `while (${AT} ${LT} n) ${AT} += 1`],
    ['the comparison at the very start of a body line', `${AT} ${LE} 0 and fail()`],
    ['a heredoc operator, which at(1) cannot submit through either', `${AT} ${LT}${LT} JOB`],
    [
      'Cybersec 23941, verbatim: the condition inside a markdown code span',
      `proba: ${TICK}${AT} ${LE} 0 ${OR} ${AT} === email.length - 1${TICK} esetben`,
    ],
    [
      'the same code span WITHOUT the or-operator -- so the or-operator is not the trigger',
      `proba: ${TICK}${AT} ${LE} 0${TICK} esetben`,
    ],
  ]
  for (const [name, line] of CASES) {
    it(`ALLOWS ${name}`, () => {
      expect(bash(doc(line))).toBe(false)
    })
  }

  // The difference test the card names as the thing that settles the diagnosis. It is a BENCH
  // control, not an assertion about the fix: it passed before and passes after. If it ever fails,
  // the harness is measuring something other than the variable name.
  it('difference test: the same code with the variable renamed passes (before AND after)', () => {
    expect(bash(doc(`proba: ${TICK}pos ${LE} 0 ${OR} pos === email.length - 1${TICK} esetben`))).toBe(false)
  })

  // DELIBERATE BEHAVIOUR CHANGE, pinned so it is a decision and not an accident. The card asked
  // for this form to stay denied while `at < n` started passing -- the two are the same text, so
  // no lexical guard can do both. It is resolved in at(1)'s own direction: at(1) REQUIRES a
  // timespec, so a bare redirect exits with a usage error and schedules nothing. This is the same
  // argument that already licensed dropping the end-of-segment branch for at(1) alone (12f80902).
  it('ALLOWS a bare redirect with no timespec -- at(1) cannot submit through it', () => {
    expect(bash(doc(`${AT} ${LT} jobfile`))).toBe(false)
  })
})

describe('a real at(1)/batch(1) submit is STILL denied (card 79bb0364)', () => {
  const SUBMITS: Array<[string, string]> = [
    ['a plain timespec', `echo run.sh | ${AT} now + 1 minute`],
    ['a redirect FOLLOWED by a timespec -- the working redirect form', `${AT} ${LT} jobfile now + 5 minutes`],
    [
      'a redirect from a file named "=0" then a timespec -- the bypass a bare "reject <=" would open',
      `${AT} ${LE}0 now`,
    ],
    ['the -f flag form', `${AT} -f /tmp/job.sh now`],
    ['batch(1) keeps the bare redirect: it takes NO timespec, so this submits', `${BATCH} ${LT} /tmp/job.sh`],
    ['batch(1) keeps the end-of-segment branch: a bare batch reads stdin', `echo run.sh | ${BATCH}`],
  ]
  for (const [name, line] of SUBMITS) {
    it(`DENIES ${name}`, () => {
      expect(bash(doc(line))).toBe(true)
    })
  }

  it('DENIES the same submit outside a heredoc, through the anchored check', () => {
    expect(bash(`echo /tmp/job.sh | ${AT} now + 2 minutes`)).toBe(true)
  })
})

describe('a QUOTED heredoc delimiter does not make its body inert (card 79bb0364)', () => {
  // These four are the price of the remedy this card did NOT take. "There is no substitution in a
  // quoted-delimiter heredoc" is true of the OUTER shell and irrelevant to the consumer, which
  // executes the body. Each one is a vector the heredoc-body branch was built for (46c4ad4a); if a
  // later change skips quoted bodies, these are what goes green.
  it('DENIES tmux send-keys in a quoted python heredoc (this gate founding vector)', () => {
    const body = ['import subprocess', `subprocess.run(['tmux','send-keys','-t','x','go','Enter'])`]
    expect(bash([`python3 <<'PY'`, ...body, 'PY'].join(NL))).toBe(true)
  })
  it('DENIES a scheduler binary in a quoted bash heredoc', () => {
    expect(bash([`bash <<'EOF'`, 'crontab -r', 'EOF'].join(NL))).toBe(true)
  })
  it('DENIES a schedule-API write in a quoted bash heredoc', () => {
    const line = `curl -s -X POST http://localhost:3420/api/schedules -d '{}'`
    expect(bash([`bash <<'EOF'`, line, 'EOF'].join(NL))).toBe(true)
  })
  it('DENIES an at(1) submit in a quoted bash heredoc', () => {
    expect(bash([`bash <<'EOF'`, `echo run.sh | ${AT} now`, 'EOF'].join(NL))).toBe(true)
  })
})

// --- the batch(1) half, added after the first round shipped only the at(1) half ---------------
//
// QA FAIL on 127c11cc (comment 21161), and the finding is the sharp one: the card's title promised
// the comparison-operator class for BOTH ordinary-English-word binaries, the shipped fix hardened
// one of them, and the two names were then ASYMMETRIC inside the same collision class. QA
// reproduced it against gateDecision directly rather than from this file's fixtures.
//
// at(1) was closed by demanding a timespec, which batch(1) does not take. batch(1)'s own lever is
// the mirror image: it accepts NO OPERANDS, so `batch <= 0` -- a redirect from a file named `=`
// plus the operand `0` -- exits with a usage error and never described a working submit either.
// The carve-out is exactly that shape; every row below that IS a working submit stays denied.
describe('the same comparison, with the batch(1) name (QA FAIL on the first round)', () => {
  const ALLOWED: Array<[string, string]> = [
    ['a JS body line', `  if (${BATCH} ${LE} 0) return null`],
    ['a comparison against a name', `while (${BATCH} ${LE} n) ${BATCH} += 1`],
    ['at the very start of a body line', `${BATCH} ${LE} 0 and fail()`],
    ['inside a markdown code span', `proba: ${TICK}${BATCH} ${LE} 0 ${OR} done${TICK} esetben`],
  ]
  for (const [name, line] of ALLOWED) {
    it(`ALLOWS ${name}`, () => {
      expect(bash(doc(line))).toBe(false)
    })
  }

  // The carve-out is `< = whitespace OPERAND`. Everything that is still a WORKING submit has to stay
  // denied, and each of these was measured DENIED both before and after the change.
  const DENIED: Array<[string, string]> = [
    ['a redirect from a file named "=" with no operand', `${BATCH} ${LE}`],
    ['a redirect from a file named "=0"', `${BATCH} ${LE}0`],
    ['a heredoc into batch stdin', `${BATCH} ${LT}${LT} JOB`],
    ['the ordinary redirect form', `${BATCH} ${LT} /tmp/job.sh`],
    // The carve-out must not open on a REDIRECTION after the `=`: a redirection is not an operand,
    // so batch still has none and still submits.
    ['a file-descriptor redirect after the "="', `${BATCH} ${LE} 2>/dev/null`],
    ['an output redirect after the "="', `${BATCH} ${LE} >out`],
    ['an fd duplication after the "="', `${BATCH} ${LE} &1`],
    // STATED RESIDUAL, pinned so it is a decision rather than an oversight: this is a comparison in
    // code AND a real submit in bash, identical as text. Fail-closed is the only safe reading.
    ['a strict less-than against a bare name (the residual)', `${BATCH} ${LT} n`],
  ]
  for (const [name, line] of DENIED) {
    it(`DENIES ${name}`, () => {
      expect(bash(doc(line))).toBe(true)
    })
  }

  it('the at(1) side is unchanged by the batch fix (control, both directions)', () => {
    expect(bash(doc(`if (${AT} ${LE} 0) return`))).toBe(false)
    expect(bash(doc(`${AT} ${LT} jobfile now + 5 minutes`))).toBe(true)
    expect(bash(doc(`${AT} ${LE}0 now`))).toBe(true)
  })
})
