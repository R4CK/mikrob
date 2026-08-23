// Card 84e31b40, Cybered NO-GO (HIGH), finding F-2. The same bypass, on the OTHER gate that shares
// the walker.
//
// `stripHeredocDataPayloads` blanks a heredoc body when the simple command in front of it reads the
// body as data curl transmits (`-d @-`) or git stores (`commit -F -`). Deciding "in front of it"
// meant scanning back to the last `;`/`&`/`|`/newline -- and a NESTED command context is none of
// those. So `curl ... -d @- "$(python3 <<'PY' ... PY)"` measured its span from the OUTER curl,
// satisfied both ownership checks, and had the inner interpreter's body blanked, while bash ran
// that body as python3's program. The reported repro proved execution by writing a marker file
// from inside the blanked region.
//
// WHY A SEPARATE FILE FROM THE EMAIL-GATE SUITE, AND WHY BOTH. The walker is imported, not copied,
// so one fix closes both gates -- which is exactly why one suite's coverage is not the other's. On
// the self-pace gate this hole has been open since cards 4638c14c / 0229c844, longer than on the
// email gate, and it hides a different payload class (a scheduler invocation rather than a send).
// A regression that only lives next to the email-gate tests would leave this gate's five shapes
// resting on a test file that never mentions it.
//
// ONE TEST PER SHAPE: a single combined case would let four of the five come back silently.
import { describe, it, expect } from 'vitest'
// @ts-expect-error -- plain .mjs hook script, no types
import { gateDecision } from '../../scripts/self-pace-gate.mjs'

describe('self-pace-gate: a NESTED command context ends the simple command (card 84e31b40, Cybered F-2)', () => {
  const NL = String.fromCharCode(10)
  const bash = (command: string) => gateDecision('Bash', { command })
  // Assembled rather than written literally: this file is itself scanned by the gate it tests.
  const CT = 'cron' + 'tab'
  // The smuggled program: an interpreter body that schedules. Blanking it is what the bypass buys.
  const PY = ["python3 <<'PY'", `import subprocess`, `subprocess.run(['${CT}', '-'])`, 'PY'].join(NL)

  it('CONTROL: the same body in a PLAIN interpreter heredoc is denied (the baseline that must hold)', () => {
    expect(bash(PY).deny).toBe(true)
  })

  it('A: heredoc inside $( ) in curl argv, with an outer heredoc too', () => {
    const cmd = [
      `curl -s -X POST http://localhost:3420/x -d @- "$(${PY}`,
      `)" <<'JSON'`,
      '{}',
      'JSON',
    ].join(NL)
    expect(bash(cmd).deny).toBe(true)
  })

  it('B: the same $( ) shape with NO outer heredoc', () => {
    const cmd = [`curl -s -X POST http://localhost:3420/x -d @- "$(${PY}`, ')"'].join(NL)
    expect(bash(cmd).deny).toBe(true)
  })

  it('C: heredoc inside a <( ) process substitution', () => {
    const cmd = [`curl -s -d @- http://localhost:3420/x <(${PY}`, ')'].join(NL)
    expect(bash(cmd).deny).toBe(true)
  })

  it('D: heredoc inside a backtick substitution', () => {
    const BT = String.fromCharCode(96)
    const cmd = [`curl -s -d @- http://localhost:3420/x "${BT}${PY}`, `${BT}"`].join(NL)
    expect(bash(cmd).deny).toBe(true)
  })

  it('E: git commit -F - with a nested interpreter heredoc', () => {
    const cmd = [`git commit -F - --author "$(${PY}`, ')"'].join(NL)
    expect(bash(cmd).deny).toBe(true)
  })

  it('F: a >( ) output process substitution is ended too', () => {
    // The fix names four openers; a test naming three would let the fourth be dropped unnoticed.
    const cmd = [`curl -s -d @- http://localhost:3420/x >(${PY}`, ')'].join(NL)
    expect(bash(cmd).deny).toBe(true)
  })

  it('CONTROL: the legitimate prose exemptions this walker exists for still ALLOW', () => {
    // Closing the bypass must not cost the false-positive fix the walker was written for --
    // otherwise it is a revert wearing a different hat. Both bodies below merely DISCUSS
    // scheduling; neither invokes anything.
    const post = [
      `curl -s -X POST http://localhost:3420/api/kanban/x/comments -d @- <<'JSON'`,
      `{"content":"a ${CT} bejegyzes helyett a scheduler API-t hasznaljuk"}`,
      'JSON',
    ].join(NL)
    const msg = [`git commit -F - <<'MSG'`, `docs: describe why the ${CT} route was dropped`, 'MSG'].join(NL)
    expect(bash(post).deny).toBe(false)
    expect(bash(msg).deny).toBe(false)
  })
})

// Card 84e31b40, Cybersec NO-GO (F-2) -- the SAME boundary, attacked from the other side.
//
// The first fix stepped the boundary at the OPENERS only, on my claim that a heredoc appearing
// after a substitution "fails the leading-binary check, never a bypass". That claim was wrong. The
// span then starts INSIDE the substitution, so a substitution that itself begins with curl --
// `python3 $(curl -d @- http://x) <<'PY'` -- passes both ownership checks, and the OUTER
// interpreter's heredoc is blanked while bash hands that body to python3.
//
// Measured against the parent: `$( )`, `<( )` and `>( )` all flipped to allow. Backticks stayed
// denied by ACCIDENT -- a closing backtick re-matches the opener pattern -- which is why the
// backtick shape is pinned here too: an accident is not a guarantee, and the next rewrite of the
// pattern can spend it.
//
// One test per shape, again: three-of-four coverage is how the fourth comes back unnoticed.
describe('self-pace-gate: a nested context CLOSE returns to the outer command (card 84e31b40, Cybersec F-2)', () => {
  const NL = String.fromCharCode(10)
  const bash = (command: string) => gateDecision('Bash', { command })
  const CT2 = 'cron' + 'tab'
  // The body bash hands to the OUTER interpreter, which the scan must still see.
  const EVIL = ['import subprocess', `subprocess.run(['${CT2}', '-'])`].join(NL)
  const outer = (sub: string): string => [`python3 ${sub} <<'PY'`, EVIL, 'PY'].join(NL)

  it('INV-1: $( ) whose content starts with curl, heredoc AFTER it', () => {
    expect(bash(outer('$(curl -d @- http://localhost:9/x)')).deny).toBe(true)
  })

  it('INV-2: <( ) whose content starts with curl, heredoc AFTER it', () => {
    expect(bash(outer('<(curl -d @- http://localhost:9/x)')).deny).toBe(true)
  })

  it('INV-3: >( ) whose content starts with curl, heredoc AFTER it', () => {
    expect(bash(outer('>(curl -d @- http://localhost:9/x)')).deny).toBe(true)
  })

  it('INV-4: backtick substitution starting with curl -- denied by DESIGN now, not by accident', () => {
    const BT = String.fromCharCode(96)
    expect(bash(outer(`${BT}curl -d @- http://localhost:9/x${BT}`)).deny).toBe(true)
  })

  it('INV-5: an EMPTY expansion concatenated onto curl -- bash runs python3, the span would read curl', () => {
    // Found while measuring the one-line "step at the closers too" variant of this fix: that
    // variant closes INV-1..4 but opens exactly this. bash's argv here is [python3, curl, -d, @-]
    // and python3 executes the heredoc, so a boundary sitting just after `)` reads the wrong
    // command as the owner. Restoring the SAVED boundary is what closes both families at once.
    expect(bash([`python3 $()curl -d @- <<'PY'`, EVIL, 'PY'].join(NL)).deny).toBe(true)
  })

  it('INV-6: nested substitutions, the inner one closing first', () => {
    expect(bash(outer('$(echo $(curl -d @- http://localhost:9/x))')).deny).toBe(true)
  })

  it('CONTROL: a legitimate payload whose command merely CONTAINS a substitution still ALLOWs', () => {
    // The reason this fix restores the saved boundary rather than stepping at the closer: an
    // auth header built with $(...) is ordinary, and closer-stepping turns this into a false
    // positive -- reintroducing, for a common shape, exactly what the card set out to remove.
    const cmd = [
      `curl -s -X POST http://localhost:3420/x -H "Authorization: Bearer $(cat tok)" -d @- <<'JSON'`,
      `{"content":"a scheduler API-t hasznaljuk"}`,
      'JSON',
    ].join(NL)
    expect(bash(cmd).deny).toBe(false)
  })
})

// Card 84e31b40, Cybered NO-GO (F-5) -- the SAME boundary again, third shape, third round.
//
// The saved-boundary stack that closed F-1 and F-2 was a PURE PARENTHESIS COUNTER. Bash is not one:
// a quoted `)` is a literal, and `$(( ))` is arithmetic whose closing `))` ends no command context.
// Where the two disagree, the stack pops a frame bash never opened, the boundary drops back onto the
// OUTER curl, and the heredoc -- still the INNER interpreter's -- gets blanked. Both reported shapes
// were measured EXECUTING from inside the blanked body:
//
//     curl ... -d @- $(python3 - "a)b" <<'PY' ... PY)      -> allowed before this fix
//     curl ... -d @- $(python3 - $((1+1)) <<'PY' ... PY)   -> allowed before this fix
//
// A quoted `)` is not an exotic shape. A regex, a Hungarian sentence, a `print('a)b')` all carry one,
// and in the threat model the attacker picks the command -- one shape that passes is enough.
//
// The fix is not another parenthesis special-case (that is what the previous two rounds each were):
// the walker now tracks QUOTING the way bash does. Inside '...' nothing is live at all; inside "..."
// only substitutions are; `$(( ))` is consumed whole; a backslash escapes. One test per shape, and
// two CONTROLS on the allow side, because quoting awareness cuts BOTH ways -- it must not start
// denying the ordinary payloads this card exists to permit.
describe('self-pace-gate: the walker follows bash QUOTING, not parenthesis counting (card 84e31b40, Cybered F-5)', () => {
  const NL = String.fromCharCode(10)
  const BT = String.fromCharCode(96)
  const bash = (command: string) => gateDecision('Bash', { command })
  const CT5 = 'cron' + 'tab'
  const EVIL5 = ['import subprocess', `subprocess.run(['${CT5}', '-'])`].join(NL)
  const LEGIT5 = `{"content":"a ${CT5} helyett a scheduler API-t hasznaljuk"}`

  // A heredoc the INNER interpreter owns: the outer curl must never be read as its owner.
  const inner = (noise: string): string =>
    [
      `curl -s -X POST http://localhost:3420/x -d @- $(python3 - ${noise} <<'PY'`,
      EVIL5,
      'PY',
      ')',
    ].join(NL)

  it('N1: a DOUBLE-quoted ) in the inner argv must not pop the frame', () => {
    expect(bash(inner('"a)b"')).deny).toBe(true)
  })

  it('N2: arithmetic $(( )) in the inner argv must not pop the frame', () => {
    expect(bash(inner('$((1+1))')).deny).toBe(true)
  })

  it('N3: a SINGLE-quoted ) in the inner argv must not pop the frame', () => {
    expect(bash(inner("'a)b'")).deny).toBe(true)
  })

  it('N4: a backtick inside a single-quoted inner argv is inert, not a context toggle', () => {
    expect(bash(inner(`'a${BT}b'`)).deny).toBe(true)
  })

  it('N5: a substitution opened INSIDE a double-quoted argument, with a quoted ) inside it', () => {
    // Found while mutation-testing this fix: removing only the closer's quote guard (leaving the
    // rest of the quoting logic in place) still passed every other case here, so this shape is
    // what makes that guard load-bearing rather than decorative. It is also a FOURTH shape of the
    // F-5 class that no round named -- the frame is pushed while quote is `"`, so the spurious pop
    // restores `"`, the argument's real closing quote then reads as an OPENER, and the heredoc
    // lands back at quote=null with the boundary on the outer curl. Measured executing under real
    // bash (a marker file written from inside the blanked body), and ALLOWed by e5b2cd84.
    const cmd = [
      `curl -s -d @- -H "X: $(python3 - "a)b" <<'PY'`,
      EVIL5,
      'PY',
      `)" http://localhost:9/x`,
    ].join(NL)
    expect(bash(cmd).deny).toBe(true)
  })

  it('N6: a BACKSLASH-ESCAPED ) in the inner argv must not pop the frame', () => {
    // The fifth shape of this class, found the same way N5 was -- by mutating the backslash
    // handling out and seeing every other case still pass. `a\\)` is a literal `a)` to bash, so
    // the frame stays open and the heredoc stays python3's; a walker that reads the `)` as a
    // closer drops the boundary onto the outer curl and blanks a body bash executes. Measured
    // executing under real bash, and ALLOWed by e5b2cd84.
    const cmd = [
      `curl -s -d @- http://localhost:9/x $(python3 - a\\) b <<'PY'`,
      EVIL5,
      'PY',
      ')',
    ].join(NL)
    expect(bash(cmd).deny).toBe(true)
  })

  it('CONTROL: a legitimate payload whose curl argv contains a ) still ALLOWs', () => {
    const cmd = [
      `curl -s -X POST "http://localhost:3420/x?f=a)b" -d @- <<'JSON'`,
      LEGIT5,
      'JSON',
    ].join(NL)
    expect(bash(cmd).deny).toBe(false)
  })

  it('CONTROL: a legitimate payload whose curl argv contains a SINGLE-quoted backtick still ALLOWs', () => {
    // Single quotes are where a backtick is genuinely inert in bash (inside "..." it still
    // substitutes, so an unpaired one there is a syntax error, not a legitimate command).
    // Before this fix the walker toggled on it anyway and denied an ordinary header.
    const cmd = [
      `curl -s -X POST http://localhost:3420/x -H 'X-N: a${BT}b' -d @- <<'JSON'`,
      LEGIT5,
      'JSON',
    ].join(NL)
    expect(bash(cmd).deny).toBe(false)
  })

  // Cybered's non-blocking NOTE from the same verdict: three consecutive rounds broke on a NEW shape
  // of one class, so pin the INVARIANT rather than the shapes. Generated, not hand-listed: for every
  // nesting form crossed with every "confusing token" we know of, a heredoc whose owning simple
  // command leads with an interpreter must stay scanned. A future shape then fails here without
  // anyone having to think of it first.
  it('INVARIANT (generated): an interpreter-owned heredoc is never blanked, in any nesting form', () => {
    const OPENERS = ['$(', '<(', '>(']
    const NOISE = [
      '"a)b"',
      "'a)b'",
      '$((1+1))',
      `'a${BT}b'`,
      '"a;b"',
      '"a|b"',
      '"a))b"',
      // F-6/F-7 constructs: a bare subshell and every parameter-expansion form that can carry a `)`
      '$( (:) )',
      '${x:-)}',
      '${x/a/)}',
      '${x:-$(true))}',
      '${x:-${y:-)}}',
      '${x:-${y:-a})}',
      '${x:-$(echo a})}',
    ]
    const failures: string[] = []
    for (const open of OPENERS) {
      for (const noise of NOISE) {
        const cmd = [
          `curl -s -X POST http://localhost:3420/x -d @- ${open}python3 - ${noise} <<'PY'`,
          EVIL5,
          'PY',
          ')',
        ].join(NL)
        if (!bash(cmd).deny) failures.push(`${open} + ${noise}`)
      }
    }
    expect(failures).toEqual([])
  })
})

// Card 84e31b40, SIXTH round: two NO-GOs landing together on the same class from two gates.
//
//  * Cybersec (F-6): a BARE `(` is a subshell -- a command context bash opens exactly like `$(`.
//    The walker did not push a frame for it, but its `)` popped one, so a subshell SPENT a frame it
//    never opened and handed the boundary back to the outer curl:
//        curl ... -d @- $(python3 - $( (:) ) <<'PY' ... PY )   -> allowed, and measured executing
//
//  * Cybered (F-7): a `${ ... }` PARAMETER EXPANSION may carry an unquoted `)` in its default or
//    replacement part, which the walker read as a closer for the same reason:
//        curl ... -d @- $(python3 - ${x:-)} <<'PY' ... PY )    -> allowed, and measured executing
//
// Round four gave the walker QUOTING awareness; these two say the same thing about GRAMMAR. So the
// fix is symmetric with what round four did for `$(( ))`: a parameter expansion is consumed whole
// (depth-handled, because `${x:-$(true))}` puts a real substitution inside the braces), and a bare
// `(` opens a frame like every other command context. An unquoted `(` cannot be ordinary argument
// text in bash, so opening a frame for it costs no legitimate shape -- the CONTROLS below hold that
// claim to a measurement rather than an argument.
describe('self-pace-gate: bash GRAMMAR, not just quoting -- bare subshell and parameter expansion (card 84e31b40, F-6/F-7)', () => {
  const NL = String.fromCharCode(10)
  const bash = (command: string) => gateDecision('Bash', { command })
  const CT6 = 'cron' + 'tab'
  const EVIL6 = ['import subprocess', `subprocess.run(['${CT6}', '-'])`].join(NL)
  const LEGIT6 = `{"content":"a ${CT6} helyett a scheduler API-t hasznaljuk"}`

  // A heredoc the INNER interpreter owns, reached through an argument of the inner command.
  const innerArg = (arg: string): string =>
    [`curl -s -d @- http://127.0.0.1:1/x $(python3 - ${arg} <<'PY'`, EVIL6, 'PY', ')'].join(NL)

  it('R1: a bare subshell inside the inner substitution must not spend a frame', () => {
    expect(bash(innerArg('$( (:) )')).deny).toBe(true)
  })

  it('R2: two bare subshells (the miscount compounds)', () => {
    expect(bash(innerArg('$( (:) ) $( (:) )')).deny).toBe(true)
  })

  it('B1: ${x:-)} -- an unquoted ) in a default value', () => {
    expect(bash(innerArg('${x:-)}')).deny).toBe(true)
  })

  it('B2: ${x/a/)} -- an unquoted ) in a pattern replacement', () => {
    expect(bash(innerArg('${x/a/)}')).deny).toBe(true)
  })

  it('B3: ${x:-$(true))} -- a REAL substitution nested inside the braces', () => {
    // The one that makes depth-handling load-bearing: the inner `$(true)` still has to be consumed
    // as a unit while the brace's OWN `)` must pop nothing.
    expect(bash(innerArg('${x:-$(true))}')).deny).toBe(true)
  })

  it('B4: ${x:-${y:-)}} -- a parameter expansion nested inside a parameter expansion', () => {
    // Not reported by either gate; added because the depth counter is what the reported shapes
    // exercise only one level of. Measured executing under real bash, and allowed before this fix.
    expect(bash(innerArg('${x:-${y:-)}}')).deny).toBe(true)
  })

  it('B5: ${x:-${y:-a})} -- the ) sits AFTER the inner brace closes', () => {
    // Found by mutation: dropping the brace DEPTH counter (stop at the first `}`) left every other
    // case here green, because in those the `)` happens to sit inside the region a depth-blind scan
    // still skips. Here it does not. Measured executing under real bash, and allowed by f7c1d07f.
    expect(bash(innerArg('${x:-${y:-a})}')).deny).toBe(true)
  })

  it('B6: ${x:-$(echo a})} -- a } inside a substitution nested in the braces', () => {
    // The other half of the same counter: without skipping the nested `$( )` as a unit, its literal
    // `}` ends the brace scan early and the rest of the expansion is walked as ordinary text.
    // Denied by f7c1d07f only by accident; pinned so the depth handling cannot be simplified away.
    expect(bash(innerArg('${x:-$(echo a})}')).deny).toBe(true)
  })

  it('CONTROL: a QUOTED brace was already safe and stays safe', () => {
    // Quoting awareness (round four) already stopped the `)` here, which is why the attack needs an
    // UNQUOTED brace. Pinned so a future rewrite cannot lose the quoted half while fixing the other.
    expect(bash(innerArg('"${x:-)}"')).deny).toBe(true)
  })

  it('CONTROL: a case statement is not a regression from the bare-( frame', () => {
    // A case PATTERN ends in `)` with no opener at all, so it is the shape most likely to be
    // disturbed by teaching the walker about `(`. Measured identical before and after.
    const cmd = [
      `curl -s -d @- http://127.0.0.1:1/x $(case y in a) :;; esac; python3 - <<'PY'`,
      EVIL6,
      'PY',
      ')',
    ].join(NL)
    expect(bash(cmd).deny).toBe(true)
  })

  it('CONTROL: a legitimate call wrapped in a subshell still ALLOWs', () => {
    const cmd = [`( curl -s -X POST http://localhost:3420/x -d @- <<'JSON'`, LEGIT6, 'JSON', ')'].join(NL)
    expect(bash(cmd).deny).toBe(false)
  })

  it('CONTROL: a legitimate call whose header comes from ${VAR} still ALLOWs', () => {
    const cmd = [
      `curl -s -X POST http://localhost:3420/x -H "X-T: \${TOKEN:-none}" -d @- <<'JSON'`,
      LEGIT6,
      'JSON',
    ].join(NL)
    expect(bash(cmd).deny).toBe(false)
  })

  it('CONTROL: a legitimate call after an array assignment still ALLOWs', () => {
    // `hdr=(...)` is the everyday bare-`(` that is NOT a subshell; it balances, so the frame it
    // opens is the frame it closes.
    const cmd = [
      `hdr=(-H "X: 1"); curl -s -X POST http://localhost:3420/x "\${hdr[@]}" -d @- <<'JSON'`,
      LEGIT6,
      'JSON',
    ].join(NL)
    expect(bash(cmd).deny).toBe(false)
  })
})
