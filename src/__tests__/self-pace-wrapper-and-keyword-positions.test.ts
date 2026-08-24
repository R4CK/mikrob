// Card ec20dd23, Cybersec (HIGH, live-measured on the installed binaries): the ANCHORED branch --
// the real command-level protection for the scheduler binaries that are not English words -- could
// be walked around two different ways.
//
// 1. ITS COMMAND-POSITION CLASS NAMED ONLY PUNCTUATION. Every shell keyword that introduces a
//    command (`then`, `do`, `else`, and, found while fixing, `if`, `elif`, `while`, `until`, plus a
//    brace group) sits exactly where a separator would, and the shell runs what follows it as a
//    command. The class simply did not say so, so `if true; then <binary> -; fi` passed while the
//    identical bare command was denied.
//
// 2. THE GATE NEVER LOOKED INSIDE A STRING A SHELL WOULD RUN. maskInertLiterals blanks quoted
//    regions before the anchored scan -- which is what makes prose inert, and is load-bearing
//    everywhere else in the file. But the argument of `bash -c` / `sh -c` / `eval` is not inert: it
//    IS the program. The one construct whose quotes mean "run this" was the one the gate refused to
//    read. Same one step out, with a different trigger: `echo "<binary> -" | bash` and
//    `... | xargs bash -c` put the program in another command's argv.
//
// MEASURED BEFORE THE FIX: 22 of 23 vectors below were ALLOWED. Cybersec reported eight; the rest
// are the same class, found by asking what else occupies a command position or executes a string.
//
// WHY THE BENIGN HALF IS THE LOAD-BEARING ONE HERE. This fix denies MORE, so its failure mode is
// turning a governance gate into an obstacle -- an agent that cannot grep for the word, read a
// runbook, or write a commit message about it. Each of those is pinned below, and the reason none
// of them trips is structural rather than lucky: an extracted string is scanned by the SAME
// anchored checks, so a binary sitting in ARGUMENT position (behind `echo`, `grep`, `cat`) is
// ignored there exactly as it is in the outer command.
//
// Names are assembled from parts: this file is itself scanned by the gate it tests.
import { describe, it, expect } from 'vitest'
// @ts-expect-error -- plain .mjs hook script, no types
import { gateDecision, executableStrings } from '../../scripts/self-pace-gate.mjs'

const CT = 'cron' + 'tab'
const SR = 'systemd' + '-run'
const LC = 'launch' + 'ctl'
const NL = String.fromCharCode(10)
const bash = (command: string): boolean => Boolean(gateDecision('Bash', { command }).deny)

describe('a shell KEYWORD is a command position too (card ec20dd23)', () => {
  const KEYWORDS: Array<[string, string]> = [
    ['then arm (reported)', `if true; then ${CT} -; fi`],
    ['do body of a for loop (reported)', `for i in 1; do ${CT} -; done`],
    ['else arm (reported)', `if false; then :; else ${CT} -; fi`],
    ['then arm with the other binary (reported)', `if true; then ${SR} --on-active=60 /bin/true; fi`],
    ['elif arm', `if false; then :; elif true; then ${CT} -; fi`],
    ['while body', `while true; do ${CT} -; done`],
    ['until body', `until false; do ${CT} -; done`],
    ['a while CONDITION, which is also a command', `while ${CT} -; do :; done`],
    ['brace group', `{ ${CT} -; }`],
  ]
  it.each(KEYWORDS)('%s', (_name, cmd) => {
    expect(bash(cmd)).toBe(true)
  })
})

describe('a string a shell will execute is scanned like a command (card ec20dd23)', () => {
  const WRAPPED: Array<[string, string]> = [
    ['bash -c, double-quoted (reported)', `bash -c "${CT} -"`],
    ['eval, double-quoted (reported)', `eval "${CT} -"`],
    ['bash -c, no quotes at all (reported)', `bash -c ${CT}`],
    ['sh -c', `sh -c "${CT} -"`],
    ['zsh -c', `zsh -c "${CT} -"`],
    ['bash -lc, a combined flag', `bash -lc "${CT} -"`],
    ['eval, single-quoted', `eval '${CT} -'`],
    ['a wrapper nested in a keyword arm', `if true; then bash -c "${CT} -"; fi`],
    ['the other binaries travel the same way', `bash -c "${LC} submit -l self -- /bin/sh"`],
    ['and the third one', `bash -c "${SR} --on-active=60 /bin/true"`],
  ]
  it.each(WRAPPED)('%s', (_name, cmd) => {
    expect(bash(cmd)).toBe(true)
  })

  const PIPED: Array<[string, string]> = [
    ['xargs handing a shell a -c string (reported)', `echo "${CT} -" | xargs -0 bash -c`],
    ['xargs with sh', `echo "${CT} -" | xargs sh -c`],
    ['a bare pipe into bash', `echo "${CT} -" | bash`],
    ['a bare pipe into sh', `echo "${CT} -" | sh`],
  ]
  it.each(PIPED)('%s', (_name, cmd) => {
    // Here the program sits in ANOTHER command's argv, so the trigger is the consumer reading a
    // program from stdin -- not the quoting.
    expect(bash(cmd)).toBe(true)
  })
})

describe('BENIGN: the gate must not become an obstacle (card ec20dd23)', () => {
  // This fix denies more, so this is the half that says whether it went too far. Every row is
  // something an agent legitimately does while working ON the scheduler machinery.
  const OK: Array<[string, string]> = [
    ['the read form is still allowed', `${CT} -l`],
    ['the read form through a wrapper', `bash -c "${CT} -l"`],
    ['the other read form', `${LC} list`],
    ['naming it in prose', `echo "the ${CT} entry is unversioned"`],
    ['naming it in prose INSIDE a wrapper', `bash -c "echo the ${CT} entry is unversioned"`],
    ['grepping for it', `grep -n "${CT}" store/notes.md`],
    ['reading a runbook about it', `cat docs/${CT}-runbook.md`],
    ['a directory path containing the name', `ls /etc/${CT}.d`],
    ['a commit message about it', `git commit -m "docs: explain the ${CT} entry"`],
    ['an unrelated wrapper', 'bash -c "echo hello"'],
  ]
  it.each(OK)('%s', (_name, cmd) => {
    expect(bash(cmd)).toBe(false)
  })

  it('prose in a heredoc naming the binary is still allowed', () => {
    expect(bash([`cat > n <<'XEOF'`, `the ${CT} entry is unversioned`, 'XEOF'].join(NL))).toBe(false)
  })
})

describe('executableStrings (card ec20dd23)', () => {
  it('returns the program out of a -c wrapper', () => {
    expect(executableStrings(`bash -c "${CT} -"`)).toContain(`${CT} -`)
  })

  it('returns the program out of an eval', () => {
    expect(executableStrings(`eval '${CT} -'`)).toContain(`${CT} -`)
  })

  it('returns quoted literals ONLY when something runs a program from stdin', () => {
    // Otherwise every quoted string in every command would be re-scanned as a command, which is
    // precisely the prose-is-inert property the rest of the file depends on.
    expect(executableStrings(`echo "${CT} -" | bash`)).toContain(`${CT} -`)
    expect(executableStrings(`echo "${CT} -"`)).toEqual([])
  })

  it('never returns its own input, so the caller can recurse without a depth guard', () => {
    // The termination argument for gateDecision calling itself. If an extraction ever returned the
    // whole input, that recursion would not end.
    for (const cmd of [`bash -c "${CT} -"`, `eval '${CT} -'`, `echo "${CT} -" | sh`, `${CT} -`]) {
      expect(executableStrings(cmd)).not.toContain(cmd)
    }
  })

  it('finds nothing in an ordinary command', () => {
    expect(executableStrings(`${CT} -l`)).toEqual([])
  })
})

describe('ANTI-VACUITY (card ec20dd23)', () => {
  it('the plain invocation is still denied, and a read is still allowed', () => {
    // Without this, a change that broke the scheduler check entirely would leave the DENY rows above
    // passing for the wrong reason and the BENIGN rows passing trivially.
    expect(bash(`${CT} -`)).toBe(true)
    expect(bash(`${CT} -l`)).toBe(false)
  })
})

describe('round 2: the three shapes both gates found still open (card ec20dd23)', () => {
  // Cybersec NO-GO (33/35 closed, three open) and Cybered NO-GO (HIGH), independently. The case-arm
  // finding they BOTH reported was already closed by the sibling card's unification between their
  // measurement and this round; these are the rest.
  const Q = String.fromCharCode(34)
  const BS = String.fromCharCode(92)

  describe('H-2: a shell fed its program on a HERE-STRING', () => {
    // No `-c` anywhere, so neither the wrapper nor the eval matcher saw it, and the program never
    // reaches argv -- but the shell runs it just the same.
    it.each([
      ['into bash', `bash <<< "${CT} -"`],
      ['into sh', `sh <<< "${CT} -"`],
      ['single-quoted body', `bash <<< '${CT} -'`],
      ['via source /dev/stdin', `source /dev/stdin <<< "${CT} -"`],
      ['via . /dev/stdin', `. /dev/stdin <<< "${CT} -"`],
    ])('%s', (_name, cmd) => {
      expect(bash(cmd)).toBe(true)
    })

    it('CONTROL: a here-string that runs nothing schedule-related is untouched', () => {
      expect(bash('bash <<< "echo hello"')).toBe(false)
    })
  })

  describe('F-2: options before -c', () => {
    // The old option run knew only bare short flags, so anything longer walked past it. Each of
    // these was measured executing the payload.
    it.each([
      ['a long option', `bash --norc -c "${CT} -"`],
      ['another long option', `bash --noprofile -c "${CT} -"`],
      ['a long option WITH an argument', `bash --rcfile /tmp/x -c "${CT} -"`],
      ['a short option with an argument', `bash -O extglob -c "${CT} -"`],
      ['several at once', `bash --norc --noprofile -O extglob -c "${CT} -"`],
      ['an end-of-options marker AFTER -c', `sh -c -- "${CT} -"`],
    ])('%s', (_name, cmd) => {
      expect(bash(cmd)).toBe(true)
    })

    it('CONTROL: the option run must not swallow the -c itself', () => {
      // The failure this guards is silent: if `-c` were consumed as just another option token, the
      // matcher would find no program and every wrapper would read as harmless.
      expect(bash(`bash -c "${CT} -"`)).toBe(true)
      expect(bash('bash --norc -c "echo hello"')).toBe(false)
    })
  })

  describe('H-3: a wrapper nested behind escaped quotes', () => {
    it('three levels deep, each escaping the last', () => {
      const cmd = `bash -c ${Q}bash -c ${BS}${Q}bash -c ${BS}${BS}${BS}${Q}${CT} -${BS}${BS}${BS}${Q}${BS}${Q}${Q}`
      expect(bash(cmd)).toBe(true)
    })

    it('and to arbitrary depth, because the unwrapping undoes one level per round', () => {
      // Measured 1..8. The stop-one-level-short failure was invisible at depth 1 and 2, which is
      // why depth is walked here rather than sampled.
      const nest = (n: number): string => {
        let out = `${CT} -`
        for (let i = 0; i < n; i += 1) out = `bash -c "${out.replace(/(["\\])/g, '\\$1')}"`
        return out
      }
      for (let n = 1; n <= 6; n += 1) expect(bash(nest(n)), `depth ${n}`).toBe(true)
    })

    it('a SINGLE-quoted body is literal and must NOT be unescaped', () => {
      // The shell does not process backslashes inside single quotes. Unescaping them anyway would
      // invent a program the shell never runs -- a false positive built by the fix itself.
      expect(bash(`bash -c 'echo ${BS}${Q}hello${BS}${Q}'`)).toBe(false)
    })
  })

  it('NOT A DoS SURFACE: the added option run has nested quantifiers', () => {
    // A governance gate that can be stalled is a way past it. Measured on the shapes that would
    // trigger catastrophic backtracking if the quantifiers were badly nested.
    const started = Date.now()
    bash('bash' + ' --opt val'.repeat(2000) + ` -c "${CT} -"`)
    bash('$('.repeat(500) + `${CT} -` + ')'.repeat(500))
    expect(Date.now() - started).toBeLessThan(5_000)
  })
})

describe('round 3: the three shapes Cybersec found still open (card ec20dd23)', () => {
  // Cybersec NO-GO on e08e191a, all live-measured with marker files. I reproduced every one before
  // touching the source (14 open shapes -- their 11 plus three more in the same families), and the
  // benign controls below are the load-bearing half, as always for a fix that denies MORE.
  const Q = String.fromCharCode(34)
  const D = String.fromCharCode(36)

  describe('F-1: PROCESS SUBSTITUTION as the program source', () => {
    // The class the card closed is "a shell gets its program somewhere other than argv" -- `| bash`
    // and `<<<` were covered, `<( )` was not, and it executes. Extra weight: the sibling card
    // 442f3289 removed the quote from its position grammar citing precisely this handling, so the
    // hole cost two cards' protection at once.
    it.each([
      ['bash <(echo prog)', `bash <(echo ${Q}${CT} -${Q})`],
      ['bash < <(echo prog)', `bash < <(echo ${Q}${CT} -${Q})`],
      ['sh <(printf prog)', `sh <(printf '%s' ${Q}${CT} -${Q})`],
      ['zsh < <(echo prog)', `zsh < <(echo ${Q}${CT} -${Q})`],
      ['the non-English-word binary too', `bash <(echo ${Q}${SR} --on-active=60 /bin/true${Q})`],
      ['nested inside a -c wrapper', `bash -c ${Q}bash <(echo '${CT} -')${Q}`],
    ])('%s', (_name, cmd) => {
      expect(bash(cmd)).toBe(true)
    })

    it.each([
      ['a neutral program', 'bash <(echo "ls -la")'],
      ['diff with two process substitutions (no shell)', 'diff <(sort a) <(sort b)'],
      ['prose that merely mentions the shape', 'echo "we use bash <(echo x) for this"'],
    ])('CONTROL stays allowed: %s', (_name, cmd) => {
      expect(bash(cmd)).toBe(false)
    })
  })

  describe('F-2: the program argument is a WORD, not one quoted piece', () => {
    // bash joins ADJACENT pieces into a single word and knows two further quoting forms, so the
    // old three-alternative matcher was handed `cron` or `$'cron` + `tab` and walked.
    it.each([
      ['ANSI-C quoting', `bash -c ${D}'${CT} -'`],
      ['locale quoting', `bash -c ${D}${Q}${CT} -${Q}`],
      ['adjacent double-quoted pieces', `bash -c ${Q}cron${Q}${Q}tab -${Q}`],
      ['adjacent single-quoted pieces', `bash -c 'cron''tab -'`],
      ['bare piece then quoted piece', `bash -c cron${Q}tab -${Q}`],
      ['ANSI-C on the here-string branch', `bash <<< ${D}'${CT} -'`],
      ['ANSI-C on the eval branch', `eval ${D}'${CT} -'`],
    ])('%s', (_name, cmd) => {
      expect(bash(cmd)).toBe(true)
    })

    it.each([
      ['ANSI-C quoting around a neutral program', `bash -c ${D}'echo hi'`],
      ['adjacent pieces around a neutral program', `bash -c ${Q}ec${Q}${Q}ho hi${Q}`],
    ])('CONTROL stays allowed: %s', (_name, cmd) => {
      expect(bash(cmd)).toBe(false)
    })

    it('the concatenated word is extracted whole', () => {
      expect(executableStrings(`bash -c ${Q}cron${Q}${Q}tab -${Q}`)).toContain(`${CT} -`)
    })

    it('the trailing word-boundary requirement declines only on NON-EXECUTABLE shapes', () => {
      // CORRECTING A CLAIM I INHERITED WITHOUT CHECKING. The gate report said the word-boundary
      // lookahead is what closes the concatenated shapes, so I wrote a test asserting exactly that
      // -- and a mutant DELETING the lookahead survived it. Measuring what that mutant actually
      // changes showed the claim does not hold for THIS formulation: concatenation is closed by the
      // alternating bare/quoted run itself (the cases above stay denied with the lookahead gone).
      // What the lookahead really does is DECLINE on a word that never reaches a real boundary.
      //
      // Removing it therefore denies MORE, not less, so it opens no bypass either way and the only
      // question is false positives. Ground-truthed with `bash -n`: all three shapes below are
      // SYNTAX ERRORS in bash, so nothing executes and declining costs no protection.
      expect(bash(`bash -c ${Q}cron${Q}tab(`)).toBe(false)
      expect(bash(`bash -c cron${Q}tab -${Q}(`)).toBe(false)
      expect(bash(`bash -c ${D}'${CT} -'(`)).toBe(false)
    })
  })

  describe('F-3: the here-string recogniser and an ordinary redirection', () => {
    // The filler excluded `&`, so the most common redirection in the world hid the program.
    it.each([
      ['2>&1 before the here-string', `bash 2>&1 <<< ${Q}${CT} -${Q}`],
      ['1>&2 before the here-string', `bash 1>&2 <<< ${Q}${CT} -${Q}`],
      ['2>/dev/null (control: was already denied)', `bash 2>/dev/null <<< ${Q}${CT} -${Q}`],
    ])('%s', (_name, cmd) => {
      expect(bash(cmd)).toBe(true)
    })

    it('a BARE `&` still ends the filler, so a here-string is not attributed across commands', () => {
      // DISCRIMINATING CONTROL. My first version here was `sleep 1 & bash <<< "echo hi"`, which a
      // mutant admitting a bare `&` SURVIVED -- the shell name and the `<<<` sit on the same side
      // of the `&` there, so both variants agree and the assertion proved nothing.
      //
      // The shape that separates them puts a real command boundary between the shell name and a
      // here-string belonging to something else. `bash job & cat <<< "<binary> -"` is valid bash
      // (checked with `bash -n`) in which `cat` merely PRINTS its input -- verified directly, it
      // echoes the text rather than running it -- so denying it would be a false positive. With a
      // bare `&` admitted, the filler runs from the shell name across `job & cat ` to the `<<<`
      // and does exactly that.
      expect(bash(`bash job & cat <<< ${Q}${CT} -${Q}`)).toBe(false)
      expect(bash(`bash x & tee f <<< ${Q}${CT} -${Q}`)).toBe(false)
      // ...while a here-string a SHELL really does read still denies, on either side of an `&`.
      expect(bash(`ls & bash <<< ${Q}${CT} -${Q}`)).toBe(true)
    })

    it('CONTROL: redirection plus a neutral here-string stays allowed', () => {
      expect(bash('bash 2>&1 <<< "echo hi"')).toBe(false)
    })
  })

  describe('the bare-word here-string body (Cybersec surviving mutant M5)', () => {
    // Cybersec's mutation pass showed this branch was unpinned: removing it kept the suite green
    // while turning these two from DENY into ALLOW. Measured as already correct on the source --
    // the gap was in the TESTS, so this is the missing pin, not a behaviour change.
    it.each([
      ['single bare word', `bash <<< ${CT}`],
      ['bare words with a flag', `bash <<< ${CT} -`],
    ])('%s', (_name, cmd) => {
      expect(bash(cmd)).toBe(true)
    })

    it('CONTROL: a neutral bare-word here-string stays allowed', () => {
      expect(bash('bash <<< ls')).toBe(false)
    })
  })

  describe('the word grammar must not become a DoS surface (my own regression)', () => {
    // MEASURED, NOT HYPOTHETICAL. My first version of the word pattern was the obvious
    // `(?:QUOTED|BARE+)+`, and it HUNG INDEFINITELY on a long bare run that never reaches an
    // accepting boundary: two adjacent bare runs can always be re-split, so the engine tries every
    // partition before failing. In a hook that runs on every Bash call that is a denial of service,
    // i.e. the fix would have opened a hole while closing fourteen. The grammar is now written so a
    // quoted piece is MANDATORY between two bare runs, making the partition unique.
    //
    // The round-2 DoS numbers did not cover this: they exercised a long OPTION run, a different
    // quantifier. Hence a dedicated case per quantifier the fix touched.
    it.each([
      ['long bare run that never reaches a boundary', `bash -c ${'a'.repeat(30000)}(`],
      ['long alternating quoted pieces then failure', `bash -c ${`${Q}a${Q}`.repeat(10000)}(`],
      ['long unterminated quote', `bash -c ${`${Q}a`.repeat(15000)}`],
      ['long here-string filler with no <<<', `bash ${'2>&1 '.repeat(6000)}`],
      ['long filler with no process substitution', `bash ${'2>&1 '.repeat(6000)}x`],
    ])('%s completes promptly', (_name, cmd) => {
      const t0 = Date.now()
      bash(cmd)
      // Two orders of magnitude of headroom over the measured 20-35ms, and still far below the
      // hook's 10s registration timeout -- a backtracking blowup does not finish in 2s.
      expect(Date.now() - t0).toBeLessThan(2000)
    })
  })

  describe('ANTI-VACUITY for round 3', () => {
    it('the benign controls are reachable, i.e. the gate is not denying everything', () => {
      expect(bash('ls -la')).toBe(false)
      expect(bash('bash -c "echo hi"')).toBe(false)
    })

    it('the anchored protection still works without any wrapper at all', () => {
      expect(bash(`${CT} -`)).toBe(true)
      expect(bash(`${CT} -l`)).toBe(false)
    })
  })
})
