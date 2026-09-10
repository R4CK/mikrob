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
import { execFileSync } from 'node:child_process'
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

  it('bare scheduler binary with no flags is denied (interactive editor = write)', () => {
    // `crontab` with no arguments opens the user's crontab in $EDITOR -- a write, not a read.
    // SCHEDULER_RX's crontab branch is bare (no shape guard), so it must match here even without
    // a flag. This pins the extraction path: executableStrings returns "crontab" (the composed
    // first word) from `eval "cron""tab" " -r"`, so gateDecision("crontab") must deny for the
    // bypass to be caught.
    expect(bash(CT)).toBe(true)
    expect(bash(SR)).toBe(true)
  })

  it('eval with adjacent-quoted pieces composing the binary name plus a second argument', () => {
    // bash: eval "cron""tab" " -r"
    // arg-1 = "crontab" (adjacent pieces joined by shell), arg-2 = " -r"
    // bash eval concatenates with a space and runs "crontab -r".
    // executableStrings returns the FIRST WORD of eval's argument ("crontab"), and
    // gateDecision("crontab") denies, so the bypass is caught without needing to see "-r".
    const Q = String.fromCharCode(34)
    expect(bash(`eval ${Q}cron${Q}${Q}tab${Q} ${Q} -r${Q}`)).toBe(true)
    expect(bash(`eval ${Q}${SR.split('-')[0]}${Q}${Q}-${SR.split('-')[1]}${Q}`)).toBe(true)
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

describe('round 4: ANSI-C escape obfuscation (QA FAIL on 223ac1f8)', () => {
  // MY OWN FALSE CLAIM, and the bug it hid. The round-3 unquoteWord carried a comment asserting that
  // ANSI-C and locale quoting "differ from the plain forms only in ways that cannot hide a binary
  // name". `$'...'` is in fact the ONE bash quoting form that performs real escape decoding, so
  // `bash -c $'\\x63rontab -'` runs the binary while the literal name never appears in the text the
  // anchored checks scan. QA proved it with live bash; I reproduced twelve shapes, seven more than
  // were reported.
  const D = String.fromCharCode(36)
  const BS = String.fromCharCode(92)
  const hex = (s: string): string => `${BS}x${s.charCodeAt(0).toString(16)}${s.slice(1)}`
  const oct = (s: string): string => `${BS}${s.charCodeAt(0).toString(8)}${s.slice(1)}`
  const uni = (s: string): string => `${BS}u${s.charCodeAt(0).toString(16).padStart(4, '0')}${s.slice(1)}`
  const bigU = (s: string): string => `${BS}U${s.charCodeAt(0).toString(16).padStart(8, '0')}${s.slice(1)}`
  const allHex = (s: string): string => [...s].map((c) => `${BS}x${c.charCodeAt(0).toString(16)}`).join('')
  const ansi = (payload: string): string => `${D}'${payload}'`

  it.each([
    ['hex-encoded first character', `bash -c ${ansi(hex(`${CT} -`))}`],
    ['octal-encoded first character', `bash -c ${ansi(oct(`${CT} -`))}`],
    ['\\u-encoded first character', `bash -c ${ansi(uni(`${CT} -`))}`],
    ['\\U-encoded first character', `bash -c ${ansi(bigU(`${CT} -`))}`],
    ['every character hex-encoded', `bash -c ${ansi(allHex(`${CT} -`))}`],
    ['hex-encoded mid-word', `bash -c ${ansi(`cr${BS}x6fntab -`)}`],
    ['on the here-string branch', `bash <<< ${ansi(hex(`${CT} -`))}`],
    ['on the eval branch', `eval ${ansi(hex(`${CT} -`))}`],
    ['on the sh -c branch', `sh -c ${ansi(hex(`${CT} -`))}`],
    ['the non-English-word binary', `bash -c ${ansi(hex(`${SR} --on-active=60 /bin/true`))}`],
    ['nested inside another wrapper', `bash -c "bash -c ${ansi(hex(`${CT} -`))}"`],
    ['ANSI-C piece concatenated with another', `bash -c ${ansi(hex('cron'))}${D}'tab -'`],
  ])('denies %s', (_name, cmd) => {
    expect(bash(cmd)).toBe(true)
  })

  it.each([
    ['locale quoting, which bash does NOT decode', `bash -c ${D}"${BS}x63rontab -"`],
    ['plain single quotes, which are literal', `bash -c '${BS}x63rontab -'`],
    ['ANSI-C spelling a neutral binary', `bash -c ${ansi(hex('echo hi'))}`],
    ['ANSI-C newline in a neutral program', `bash -c ${D}'echo hi${BS}nthere'`],
    ['prose mentioning an escape', `echo "the ${BS}x74 escape means t"`],
  ])('CONTROL stays allowed: %s', (_name, cmd) => {
    expect(bash(cmd)).toBe(false)
  })

  it('the LOCALE form is deliberately left literal, because bash leaves it literal', () => {
    // Checked against real bash: $'\\x74ouch' -> touch, while $"\\x74ouch" and '\\x74ouch' stay as
    // written. Decoding the locale form would deny a command bash never runs -- a false positive
    // manufactured by over-correcting. The scope of the fix is exactly one quoting form.
    const out = execFileSync('bash', ['-c', `printf '%s' ${D}"${BS}x74ouch"`], { encoding: 'utf-8' })
    expect(out).toBe(`${BS}x74ouch`)
  })

  it('decodes byte-for-byte the way bash does, including the cases people get wrong', () => {
    // A decoder that is merely "close" is a bug in both directions: under-decoding leaves the
    // bypass, over-decoding invents characters bash never produces. Compared against the only
    // authority that counts. Note \\z keeps its backslash and \\0 TRUNCATES the argument -- measured,
    // `bash -c $'ec\\0ho X'` reports `ec: command not found` rather than joining the halves.
    const cases = ['touch', `${BS}x74ouch`, `${BS}164ouch`, `${BS}u0074ouch`, `${BS}z`, `a${BS}tb`, `a${BS}'b`, `${BS}cA`]
    for (const body of cases) {
      const expected = execFileSync('bash', ['-c', `printf '%s' ${D}'${body}' | od -An -tx1 | tr -d ' \\n'`], {
        encoding: 'utf-8',
      }).trim()
      // executableStrings comes from an untyped .mjs hook script; name the shape once so the
      // comparison below stays type-checked instead of spreading `any` into it.
      const extracted = executableStrings(`bash -c ${D}'${body}'`) as string[]
      const got: string = extracted[0] ?? ''
      expect(Buffer.from(got, 'utf-8').toString('hex'), `body ${JSON.stringify(body)}`).toBe(expected)
    }
  })

  it('a long run of ANSI-C pieces does not backtrack forever (my own regression, twice)', () => {
    // Adding the ANSI-C alternative to the word grammar made `$'a'` matchable TWO ways, because the
    // pre-existing alternative already accepted an optional `$`. A long run of them followed by a
    // character that fails the word boundary then never finished -- the identical ambiguity this
    // pattern had been rewritten to remove one round earlier. `$'...'` now belongs solely to the
    // ANSI-C branch, `'...'` solely to the plain one.
    const cmd = `bash -c ${`${D}'a'`.repeat(20000)}(`
    const t0 = Date.now()
    bash(cmd)
    expect(Date.now() - t0).toBeLessThan(2000)
  })
})

describe('round 5: ANSI-C decoding on the stdin-shell branch (Cybersec NO-GO on 44cda339)', () => {
  // Round 4 taught unquoteWord to decode `$'...'`, and three of executableStrings' four extraction
  // paths (SHELL_C_RX, EVAL_RX, HERESTRING_RX) go through it. The fourth -- the quoted-literal scan
  // that only runs when STDIN_SHELL_RX matches (a bare `| bash`, `xargs ... bash -c`, or a process
  // substitution standing in for the script file) -- read literals with its own regex,
  // QUOTED_LITERAL_RX, which never knew about `$'...'` at all: `bash <(echo $'\\x63rontab -')` and
  // `echo $'\\x63rontab -' | bash` reached the real binary while the scan saw only the raw, still
  // encoded text. Cybersec proved it live on the installed crontab/systemd-run binaries.
  const D = String.fromCharCode(36)
  const BS = String.fromCharCode(92)
  const hex = (s: string): string => `${BS}x${s.charCodeAt(0).toString(16)}${s.slice(1)}`
  const oct = (s: string): string => `${BS}${s.charCodeAt(0).toString(8)}${s.slice(1)}`
  const ansi = (payload: string): string => `${D}'${payload}'`

  it.each([
    ['process substitution, hex-encoded', `bash <(echo ${ansi(hex(`${CT} -`))})`],
    ['process substitution, octal-encoded', `bash <(echo ${ansi(oct(`${CT} -`))})`],
    ['process substitution with < <( ) form', `bash < <(echo ${ansi(hex(`${CT} -`))})`],
    ['bare pipe into a shell', `echo ${ansi(hex(`${CT} -`))} | bash`],
    ['xargs handing a shell its -c argument', `echo ${ansi(hex(`${CT} -`))} | xargs bash -c`],
    ['ANSI-C with no escapes at all (still decoded, not just the encoded cases)', `echo ${ansi(`${CT} -`)} | bash`],
    ['the non-English-word binary', `echo ${ansi(hex(`${SR} --on-active=60 /bin/true`))} | bash`],
  ])('denies %s', (_name, cmd) => {
    expect(bash(cmd)).toBe(true)
  })

  it.each([
    ['plain quoting on the same branch stays denied (control, not a vacuous battery)', `echo '${CT} -' | bash`],
    ['locale quoting on the same branch: literal text still matches as written', `bash <(echo ${D}"${CT} -")`],
    ['ANSI-C spelling a neutral program', `echo ${ansi(hex('echo hi'))} | bash`],
    ['prose piped to a non-shell reader is untouched', `echo ${ansi(hex('hello there'))} | cat`],
  ])('%s', (_name, cmd) => {
    // The locale case is deliberately NOT a false-positive check: `$"..."` decodes nothing, so its
    // body is the plain literal text -- denying it is correct, matching unquoteWord's own handling.
    if (_name.startsWith('plain quoting') || _name.startsWith('locale quoting')) {
      expect(bash(cmd)).toBe(true)
    } else {
      expect(bash(cmd)).toBe(false)
    }
  })

  it('decodes on this branch byte-for-byte the way readAnsiC already does elsewhere (no second decoder)', () => {
    const extracted = executableStrings(`echo ${ansi(hex(`${CT} -`))} | bash`) as string[]
    expect(extracted).toContain(`${CT} -`)
  })

  it('a long run of ANSI-C pieces on this branch does not backtrack forever', () => {
    // The same ambiguity round 4 had to rule out for unquoteWord (`$'a'` matchable two ways) applies
    // here too, since QUOTED_LITERAL_RX now has both a `$'` alternative and a bare `'...'`
    // alternative: manually advancing lastIndex past readAnsiC's return point is what keeps them from
    // overlapping. 20000 repeats must stay fast, not merely correct.
    const cmd = `echo ${ansi('a').repeat(20000)} | bash(`
    const t0 = Date.now()
    bash(cmd)
    expect(Date.now() - t0).toBeLessThan(2000)
  })
})


// ROUND 7 (Cybersec delta-gate NO-GO on d838c8c1, card ec20dd23). The stdin-shell path extracted
// only QUOTED literals, so the identical payload walked past it by DROPPING the quotes. The old
// suite could not catch this because it only ever pinned the quoted spelling -- a textbook
// half-pinned invariant: every assertion passed, on the one half that already worked.
//
// So every shape below is pinned as a PAIR, quoted and unquoted, asserted in the same `it`. The
// pairing is the actual regression guard: a future change that re-narrows extraction back to
// quoted-only leaves the first half of each pair green and fails the second, which is exactly the
// signal that was missing. Splitting them into separate tests would let the same blind spot return.
describe('round 7: an UNQUOTED payload is executable text too (card ec20dd23)', () => {
  const SQ = String.fromCharCode(39)
  const DQ = String.fromCharCode(34)
  const q = (payload: string): string => `${SQ}${payload}${SQ}`
  const ONACT = '--on-' + 'active=1s'

  it('GROUND TRUTH: real bash runs an unquoted echo payload piped to a shell', () => {
    // Before asserting the gate should deny it, prove the shell actually executes it -- this file's
    // standing rule. If bash did NOT run it, denying would be an invented over-block, not a fix.
    const out = execFileSync('bash', ['-c', 'echo echo GROUNDTRUTH7 | sh'], { encoding: 'utf-8' })
    expect(out.trim()).toBe('GROUNDTRUTH7')
  })

  it('echo PAYLOAD | sh is denied whether or not the payload is quoted', () => {
    expect(bash(`echo ${q(`${CT} -r`)} | sh`)).toBe(true)
    expect(bash(`echo ${CT} -r | sh`)).toBe(true)
  })

  it('echo PAYLOAD | bash is denied whether or not the payload is quoted', () => {
    expect(bash(`echo ${q(`${CT} -r`)} | bash`)).toBe(true)
    expect(bash(`echo ${CT} -r | bash`)).toBe(true)
  })

  it('process substitution is denied whether or not the payload is quoted', () => {
    expect(bash(`bash <(echo ${q(`${CT} -r`)})`)).toBe(true)
    expect(bash(`bash <(echo ${CT} -r)`)).toBe(true)
  })

  it('printf carries a payload exactly as echo does, quoted or not', () => {
    expect(bash(`printf ${q(`${CT} -r`)} | sh`)).toBe(true)
    expect(bash(`printf ${CT} -r | sh`)).toBe(true)
  })

  it('the scheduler binary that is not an English word is covered by the same path', () => {
    expect(bash(`echo ${q(`${SR} ${ONACT} x`)} | sh`)).toBe(true)
    expect(bash(`echo ${SR} ${ONACT} x | sh`)).toBe(true)
  })

  // The option run has to be dropped, not carried: the anchored check needs the binary at a COMMAND
  // position, and a retained `-n` pushes it out of one. Measured on the fix's first cut -- keeping
  // echo's flags turned `echo -n <binary> ... | sh` into a live bypass OF THE FIX ITSELF, which is
  // why these are pinned rather than left to follow from the case above.
  it('an echo option word does not shield the payload behind it', () => {
    expect(bash(`echo -n ${CT} -r | sh`)).toBe(true)
    expect(bash(`echo -e ${CT} -r | sh`)).toBe(true)
    expect(bash(`echo -ne ${CT} -r | bash`)).toBe(true)
    expect(bash(`echo -E ${CT} -r | bash`)).toBe(true)
  })

  it('a QUOTED option word is dropped too, because bash tests the value not the quoting', () => {
    expect(bash(`echo ${q('-n')} ${CT} -r | sh`)).toBe(true)
  })

  it('a binary spelled with adjacent quoted pieces survives the per-word unquoting', () => {
    // The tail is split into words and unquoted PER WORD; a whole-tail unquote returns '' and
    // extracts nothing at all. This pins that the word-level path is the one actually in use.
    expect(bash(`echo cron${q('tab')} -r | sh`)).toBe(true)
    expect(bash(`echo ${DQ}cron${DQ}tab -r | sh`)).toBe(true)
  })

  it('the payload is still found past a separator and a wrapper', () => {
    expect(bash(`true ; echo ${CT} -r | sh`)).toBe(true)
    expect(bash(`if true; then echo ${CT} -r | sh; fi`)).toBe(true)
    expect(bash(`echo ${CT} -r | sudo sh`)).toBe(true)
    expect(bash(`command echo ${CT} -r | sh`)).toBe(true)
    expect(bash(`echo ${CT} -r|sh`)).toBe(true)
  })

  // THE LOAD-BEARING HALF. This round denies MORE, so its failure mode is a governance gate that
  // becomes an obstacle. None of these trip, and the reason is structural rather than lucky:
  // extraction widened, but the DENY still requires the extracted string to match the SAME anchored
  // checks on its own -- so an ordinary message, or a binary in argument position, stays ignored.
  it('CONTROL: ordinary text piped to a shell is not denied', () => {
    expect(bash('echo hello world | sh')).toBe(false)
    expect(bash('echo done | sh')).toBe(false)
    expect(bash('echo "all tests passed" | bash')).toBe(false)
    expect(bash('bash <(echo echo hi)')).toBe(false)
  })

  it('CONTROL: the read-only invocation stays allowed through this path too', () => {
    expect(bash(`echo ${CT} -l | sh`)).toBe(false)
  })

  it('CONTROL: the binary in ARGUMENT position is ignored here as everywhere else', () => {
    expect(bash(`echo skip ${CT} | sh`)).toBe(false)
  })

  it('CONTROL: an unrecognised dash-word is NOT treated as an option', () => {
    // bash prints `-x` verbatim, so stripping it would invent an over-block. The payload after it
    // therefore sits in argument position, and must stay allowed.
    expect(bash(`echo -x ${CT} | sh`)).toBe(false)
  })

  it('CONTROL: nothing in the pipeline runs the text, so nothing is extracted', () => {
    expect(bash(`echo ${CT} -r | grep x`)).toBe(false)
    expect(bash(`echo ${CT} -r`)).toBe(false)
  })

  it('the new word scan grows LINEARLY, not quadratically', () => {
    // Same budget the sibling quadratic suites enforce. The word pattern's alternatives are disjoint
    // on their first character, so no position has two ways to match -- but that is the claim, and
    // this is the measurement.
    const t0 = Date.now()
    bash(`echo ${'a'.repeat(400000)} | sh`)
    expect(Date.now() - t0).toBeLessThan(2000)
  })
})


// ROUND 8 (Cybersec delta-gate NO-GO on 97220cfe, card ec20dd23). Round 7 closed the reported
// bare-word shapes but left two of the same exec class open, and the first was NAMED in the
// original finding's own table -- which is the more useful lesson here: "the reported cases now
// pass" is not the same claim as "the finding's table is satisfied", and round 7 asserted the
// first while believing the second.
//
// #1 printf is NOT echo. Its first remaining word is the FORMAT; later arguments are substituted
//    into it, reusing the format until they run out. Round 7 pushed only the whole tail, so the
//    conversion (%s) sat in command position and the real binary sat in argument position -- where
//    the anchored check correctly ignores it. Round 7's own commit message said printf "carries a
//    payload exactly as echo does"; that sentence was the bug.
//
// #2 `source <(...)` and `. <(...)` run the FIFO's contents in the CURRENT shell. The proc-sub
//    branch only knew shell NAMES as a command position. This one predates round 7 (the quoted
//    spelling was open too), and the proof it was an oversight rather than a decision is that
//    HERESTRING_RX already carries the same two builtins on the `<<<` path.
describe('round 8: printf format semantics and source/. execution (card ec20dd23)', () => {
  const SQ = String.fromCharCode(39)
  const DQ = String.fromCharCode(34)
  const BSL = String.fromCharCode(92)
  const FMT_NL = `${SQ}%s${BSL}n${SQ}`
  const FMT_SP = `${SQ}%s ${SQ}`
  const ONCAL = '--on-' + 'calendar hourly'

  it('GROUND TRUTH: printf reuses its format, so the ARGUMENTS alone become the emitted line', () => {
    // The whole premise of #1. If printf did not re-apply the format per argument, the arguments
    // would not stand alone as a command and denying them would be an invented over-block.
    const out = execFileSync('bash', ['-c', `printf ${FMT_NL} MARKER8 -`], { encoding: 'utf-8' })
    expect(out).toBe('MARKER8\n-\n')
  })

  it('GROUND TRUTH: source and . really execute a process substitution in the current shell', () => {
    // Same rule as round 7's ground truth: prove the shell runs it before asserting the gate must
    // stop it. A harmless payload, never a scheduler.
    const viaSource = execFileSync('bash', ['-c', 'source <(echo echo SRC8)'], { encoding: 'utf-8' })
    expect(viaSource.trim()).toBe('SRC8')
    const viaDot = execFileSync('bash', ['-c', '. <(echo echo DOT8)'], { encoding: 'utf-8' })
    expect(viaDot.trim()).toBe('DOT8')
  })

  // --- #1 printf format string ---

  it('a payload behind a printf FORMAT is denied', () => {
    expect(bash(`printf ${FMT_NL} ${CT} - | sh`)).toBe(true)
    expect(bash(`printf ${FMT_SP} ${SR} ${ONCAL} /evil | sh`)).toBe(true)
    expect(bash(`printf ${DQ}%s${DQ} ${CT} -r | bash`)).toBe(true)
  })

  it('the format-only spellings stay denied -- the fix is ADDITIVE, not a replacement', () => {
    // printf emits its format too, so dropping the first word UNCONDITIONALLY would have turned
    // these existing DENYs into ALLOWs. Both readings are pushed; this pins that the old one
    // survived the new one.
    expect(bash(`printf ${CT} | sh`)).toBe(true)
    expect(bash(`printf -- ${CT} | sh`)).toBe(true)
  })

  it('CONTROL: an ordinary printf format with an ordinary argument is not denied', () => {
    expect(bash(`printf ${FMT_NL} hello | sh`)).toBe(false)
    expect(bash('printf hi | sh')).toBe(false)
  })

  // --- #2 source / . ---

  it('source and . with a process substitution are denied, quoted or not', () => {
    expect(bash(`source <(echo ${CT} -r)`)).toBe(true)
    expect(bash(`source <(echo ${DQ}${CT} -r${DQ})`)).toBe(true)
    expect(bash(`. <(echo ${CT} -r)`)).toBe(true)
    expect(bash(`. <(echo ${DQ}${CT} -r${DQ})`)).toBe(true)
  })

  it('the other scheduler binary travels the same path', () => {
    expect(bash(`. <(echo ${SR} ${ONCAL} x)`)).toBe(true)
  })

  it('a payload piped into source /dev/stdin is denied', () => {
    expect(bash(`echo ${CT} -r | source /dev/stdin`)).toBe(true)
    expect(bash(`echo ${CT} -r | . /dev/stdin`)).toBe(true)
  })

  it('the two fixes compose: a printf format inside a source proc-sub', () => {
    expect(bash(`source <(printf ${FMT_NL} ${CT} -r)`)).toBe(true)
  })

  it('the payload is still found past a wrapper and a separator', () => {
    expect(bash(`sudo source <(echo ${CT} -r)`)).toBe(true)
    expect(bash(`true ; source <(echo ${CT} -r)`)).toBe(true)
  })

  // THE LOAD-BEARING HALF. `.` is an extremely common character; teaching the proc-sub branch to
  // treat it as a command position is the kind of widening that turns a gate into an obstacle if it
  // is not pinned. None of these trip, because extraction widened while the DENY still requires the
  // extracted string to match the anchored checks on its own.
  it('CONTROL: ordinary source and . usage is not denied', () => {
    expect(bash('source <(echo hello world)')).toBe(false)
    expect(bash('. <(echo build done)')).toBe(false)
    expect(bash('source ~/.bashrc')).toBe(false)
  })

  it('CONTROL: everyday commands containing a dot or a proc-sub are untouched', () => {
    expect(bash('diff <(sort a.txt) <(sort b.txt)')).toBe(false)
    expect(bash('cd .. && bash <(echo echo hi)')).toBe(false)
    expect(bash('git diff HEAD~1 . | head')).toBe(false)
    expect(bash(`echo ${DQ}all done. now check${DQ} | cat`)).toBe(false)
  })

  it('both new paths grow LINEARLY, not quadratically', () => {
    const t0 = Date.now()
    bash(`source <(echo ${'a'.repeat(400000)})`)
    expect(Date.now() - t0).toBeLessThan(2000)
    const t1 = Date.now()
    bash(`printf ${SQ}%s${SQ} ${'a'.repeat(400000)} | sh`)
    expect(Date.now() - t1).toBeLessThan(2000)
  })
})
