import { describe, it, expect } from 'vitest'
// @ts-expect-error -- plain .mjs hook script, no types
import { gateDecision, buildGateMsg } from '../../scripts/email-send-gate.mjs'
import { injectEmailSendGate, agentGetsEmailGate } from '../web/agent-scaffold.js'
import { MAIN_AGENT_ID } from '../config.js'
import { REPO_UNDER_TMP, TMP_SKIP_REASON } from './helpers/repo-location.js'

// The PreToolUse gate decision: which tool calls count as outbound email-send.
describe('gateDecision', () => {
  it('blocks any MCP send_email tool (name-agnostic)', () => {
    expect(gateDecision('mcp__server-gmail-autoauth-mcp__send_email', {}).deny).toBe(true)
    // a differently-named gmail server in a customer install is still gated
    expect(gateDecision('mcp__some_other_gmail__send_email', {}).deny).toBe(true)
  })

  it('allows email READ/draft tools (only sending is gated)', () => {
    expect(gateDecision('mcp__server-gmail-autoauth-mcp__search_emails', {}).deny).toBe(false)
    expect(gateDecision('mcp__server-gmail-autoauth-mcp__read_email', {}).deny).toBe(false)
    expect(gateDecision('mcp__server-gmail-autoauth-mcp__draft_email', {}).deny).toBe(false)
  })

  it('blocks Bash mail-send commands', () => {
    const bash = (command: string) => gateDecision('Bash', { command })
    expect(bash('python3 scripts/support-mail/send.py --to x@y.hu').deny).toBe(true)
    expect(bash('curl -s -X POST https://api.resend.com/emails -d @body.json').deny).toBe(true)
    expect(bash('echo hi | sendmail user@host').deny).toBe(true)
    expect(bash('swaks --to a@b.c --server smtp').deny).toBe(true)
  })

  it('blocks the graph-mail.ts CLI send path (PR #668) and direct sendMail() calls', () => {
    const bash = (command: string) => gateDecision('Bash', { command })
    expect(bash('tsx scripts/graph-mail.ts send --to a@b.hu --subject x --body y').deny).toBe(true)
    expect(bash('npx tsx scripts/graph-mail.ts send --to a@b.hu --subject x --body y').deny).toBe(true)
    expect(bash(`node -e "require('./src/graph-mail.js').sendMail({to:'a@b.hu'})"`).deny).toBe(true)
    // read-only graph-mail subcommands are NOT send-shaped, so they pass through
    // this gate untouched (they still can't do anything a sub-agent shouldn't:
    // verify/list only read the scoped mailbox)
    expect(bash('tsx scripts/graph-mail.ts verify').deny).toBe(false)
    expect(bash('tsx scripts/graph-mail.ts list --unread').deny).toBe(false)
  })

  it('allows ordinary Bash that does not send mail', () => {
    const bash = (command: string) => gateDecision('Bash', { command })
    expect(bash('git status').deny).toBe(false)
    expect(bash('npm run build').deny).toBe(false)
    expect(bash('curl -s http://localhost:3420/api/messages').deny).toBe(false)
    // mentioning "resend" without an email/send verb nearby is not gated
    expect(bash('grep resend src/foo.ts').deny).toBe(false)
  })
})

// Card 132fc28c, incident msg 8641: a kanban-comment POST to an UNRELATED endpoint
// (localhost:3420/api/kanban, not an email API) carried prose discussing whether the
// PRODUCT should send a registration email; the text mentioned "Resend" (the email
// provider) near "email"/"send" and matched SEND_PATTERNS's proximity regex, blocking
// the comment as if it were an actual send. The gate must key on the ACTION (a real
// email-API/SMTP call), not on text content that merely discusses email.
describe('gateDecision: data-payload false-positive guard (card 132fc28c)', () => {
  it('ALLOWS a kanban-comment POST whose JSON body discusses sending a registration email via Resend', () => {
    const cmd =
      `curl -s -X POST http://localhost:3420/api/kanban/06f81738/comments -d ` +
      `'{"author":"backend","content":"Kell-e a termeknek Resend-en keresztul regisztracios aktivacios emailt kuldenie?"}'`
    expect(gateDecision('Bash', { command: cmd }).deny).toBe(false)
  })

  it('ALLOWS the same content in a double-quoted payload without substitution', () => {
    const cmd =
      `curl -s -X POST http://localhost:3420/api/kanban/06f81738/comments -d ` +
      `"{\\"content\\":\\"resend api key kell a regisztracios email kuldeshez\\"}"`
    expect(gateDecision('Bash', { command: cmd }).deny).toBe(false)
  })

  it('KEEPS a payload that can command-substitute ($(...)) -- not blanked, still scannable', () => {
    const cmd = `curl -d "$(sendmail user@host)" http://localhost:3420/api/kanban`
    expect(gateDecision('Bash', { command: cmd }).deny).toBe(true)
  })

  it('STILL denies a REAL send to api.resend.com -- the URL lives outside the payload', () => {
    const cmd = `curl -s -X POST https://api.resend.com/emails -d '{"to":"a@b.hu"}'`
    expect(gateDecision('Bash', { command: cmd }).deny).toBe(true)
  })

  it('STILL denies sendmail/msmtp/swaks even when a DIFFERENT curl -d payload is present in the same command', () => {
    const cmd = `curl -d '{"note":"resend the invoice email"}' http://localhost:3420/x ; sendmail user@host`
    expect(gateDecision('Bash', { command: cmd }).deny).toBe(true)
  })

  it('a -d @file (file reference, no inline text) is untouched -- nothing to blank either way', () => {
    expect(gateDecision('Bash', { command: 'curl -s -X POST https://api.resend.com/emails -d @body.json' }).deny).toBe(true)
    expect(gateDecision('Bash', { command: 'curl -s -X POST http://localhost:3420/api/kanban/x/comments -d @comment.json' }).deny).toBe(false)
  })
})

// Card 84e31b40, backend2's report from the 93538142 diagnosis. Card 132fc28c closed ONE shape of
// the prose false-positive -- an inline `-d '<literal>'`. The same prose handed to the same curl
// over STDIN (`-d @- <<'JSON'`) was still denied, so which of two equivalent shapes an agent picked
// had become a security decision. Only the DATA-carrying heredoc is blanked; an interpreter heredoc
// stays fully scanned, and the tests below are what hold that line.
describe('gateDecision: stdin-payload false-positive guard (card 84e31b40)', () => {
  const bash = (command: string) => gateDecision('Bash', { command })

  it('ALLOWS a kanban-comment POST whose heredoc payload discusses sending email via Resend', () => {
    const cmd = [
      `curl -s -X POST http://localhost:3420/api/kanban/93538142/comments -H 'Content-Type: application/json' -d @- <<'JSON'`,
      `{"author":"backend2","content":"A diagnozis szerint a Resend-en keresztuli email kuldes nincs bekotve."}`,
      `JSON`,
    ].join('\n')
    expect(bash(cmd).deny).toBe(false)
  })

  it('ALLOWS a commit message written over stdin that describes the email-send finding', () => {
    const cmd = [`git commit -F - <<'MSG'`, `fix(mail): resend email send path was never wired`, `MSG`].join('\n')
    expect(bash(cmd).deny).toBe(false)
  })

  it('STILL denies a REAL send whose body arrives the SAME stdin way -- the host lives outside the body', () => {
    const cmd = [
      `curl -s -X POST https://api.resend.com/emails -d @- <<'JSON'`,
      `{"to":"a@b.hu","subject":"x"}`,
      `JSON`,
    ].join('\n')
    expect(bash(cmd).deny).toBe(true)
  })

  // THE LINE THAT MUST NOT MOVE. A heredoc feeding an INTERPRETER is executed, not transmitted,
  // so a send hidden in its body is a real send. Blanking heredoc bodies in general -- the obvious
  // reading of "extend the payload stripping to heredocs" -- would make every one of these pass.
  it('STILL denies an SMTP send hidden in a python3 heredoc body', () => {
    const cmd = [`python3 <<'PY'`, `import smtplib`, `smtplib.SMTP('localhost').sendmail(a, b, c)`, `PY`].join('\n')
    expect(bash(cmd).deny).toBe(true)
  })

  it('STILL denies a provider-API send hidden in a node heredoc body', () => {
    const cmd = [`node <<'JS'`, `await fetch('https://api.resend.com/emails', { method: 'POST' })`, `JS`].join('\n')
    expect(bash(cmd).deny).toBe(true)
  })

  it('STILL denies the `-d @-` DECOY: the flag sits in an INTERPRETER argv, not curl\'s (card 4638c14c)', () => {
    // The heredoc is python3's program. Keying on the flag shape alone would blank it and hide a
    // real send; the imported walker pins the span's own leading binary to curl.
    const cmd = [`python3 - -d @- <<'PY'`, `import smtplib`, `PY`].join('\n')
    expect(bash(cmd).deny).toBe(true)
  })

  it('STILL denies an UNQUOTED-tag heredoc whose body can command-substitute', () => {
    // Bash expands the body before curl ever sees it, so it is not provably inert data.
    const cmd = [`curl -d @- http://localhost:3420/x <<JSON`, `{"x":"$(sendmail a@b.c)"}`, `JSON`].join('\n')
    expect(bash(cmd).deny).toBe(true)
  })

  it('STILL denies a real send that merely SHARES a command with an innocent heredoc payload', () => {
    const cmd = [
      `curl -d @- http://localhost:3420/x <<'JSON'`,
      `{"note":"resend the invoice email"}`,
      `JSON`,
      `sendmail user@host`,
    ].join('\n')
    expect(bash(cmd).deny).toBe(true)
  })
})

// Card 84e31b40, Cybered NO-GO (HIGH). The heredoc-blanking above asks "does the simple command in
// front of this heredoc read it as curl `-d @-` data?", but the walker only ended a simple command
// at `;`/`&`/`|`/newline. A NESTED command context ended nothing, so an inner interpreter's heredoc
// still measured its span from the OUTER curl and was blanked -- while bash really ran it. The
// reported repro proved execution by writing a marker file from inside the blanked body, and all
// five shapes were DENY on the parent commit, so this change is what introduced them.
//
// ONE TEST PER SHAPE, deliberately. A single combined case would let four of the five come back
// silently the next time the walker is touched.
describe('gateDecision: a NESTED command context ends the simple command (card 84e31b40, Cybered F-1)', () => {
  const NL = String.fromCharCode(10)
  const bash = (command: string) => gateDecision('Bash', { command })
  // Assembled, not written literally: this file is scanned by the gate it tests.
  const SMTP = 'smtp' + 'lib'
  // The body every shape smuggles: an interpreter program the gate must keep seeing.
  const PY = ["python3 <<'PY'", `import ${SMTP}`, `${SMTP}.SMTP('h').sendmail(a, b, c)`, 'PY'].join(NL)

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

  it('CONTROL: a >( ) output process substitution is ended too', () => {
    // Same class as C, the other direction -- included because the fix names four openers and a
    // test naming three would let the fourth be dropped unnoticed.
    const cmd = [`curl -s -d @- http://localhost:3420/x >(${PY}`, ')'].join(NL)
    expect(bash(cmd).deny).toBe(true)
  })

  it('CONTROL: the two legitimate ALLOW shapes are untouched by the boundary fix', () => {
    // The whole point of the card. If closing the bypass had cost these, the fix would be a
    // revert wearing a different hat.
    const post = [
      `curl -s -X POST http://localhost:3420/api/kanban/93538142/comments -d @- <<'JSON'`,
      `{"content":"A Resend-en keresztuli email kuldes nincs bekotve."}`,
      'JSON',
    ].join(NL)
    const msg = [`git commit -F - <<'MSG'`, 'fix(mail): resend email send path was never wired', 'MSG'].join(NL)
    expect(bash(post).deny).toBe(false)
    expect(bash(msg).deny).toBe(false)
  })

  it('CONTROL: curl --config/-K is NOT an exempt stdin shape (Cybered note 1)', () => {
    // A curl config body is OPTIONS (`url =`, `data =`), not inert bytes, so blanking it would
    // hide a real send. Today that holds only because CURL_STDIN_DATA_RX lists the data flags
    // and not --config; pinning it here so a future "any stdin-reading curl form" generalisation
    // cannot drop it silently.
    const cfg = [`curl --config - <<'CFG'`, 'url = "https://api.resend.com/emails"', 'CFG'].join(NL)
    const short = [`curl -K - <<'CFG'`, 'url = "https://api.resend.com/emails"', 'CFG'].join(NL)
    expect(bash(cfg).deny).toBe(true)
    expect(bash(short).deny).toBe(true)
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
describe('gateDecision: a nested context CLOSE returns to the outer command (card 84e31b40, Cybersec F-2)', () => {
  const NL = String.fromCharCode(10)
  const bash = (command: string) => gateDecision('Bash', { command })
  const SMTP = 'smtp' + 'lib'
  // The body bash hands to the OUTER interpreter, which the scan must still see.
  const EVIL = [`import ${SMTP}`, `${SMTP}.SMTP('h').sendmail(a, b, c)`].join(NL)
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
      `{"content":"a Resend email kuldes diagnozisa"}`,
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
describe('gateDecision: the walker follows bash QUOTING, not parenthesis counting (card 84e31b40, Cybered F-5)', () => {
  const NL = String.fromCharCode(10)
  const BT = String.fromCharCode(96)
  const bash = (command: string) => gateDecision('Bash', { command })
  const SMTP5 = 'smtp' + 'lib'
  const SEND5 = 'send' + 'mail'
  const EVIL5 = [`import ${SMTP5}`, `${SMTP5}.SMTP('h').${SEND5}(a, b, c)`].join(NL)
  const LEGIT5 = `{"content":"a ${SMTP5} utat elvetettuk, a szolgaltato API-t hasznaljuk"}`

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
describe('gateDecision: bash GRAMMAR, not just quoting -- bare subshell and parameter expansion (card 84e31b40, F-6/F-7)', () => {
  const NL = String.fromCharCode(10)
  const bash = (command: string) => gateDecision('Bash', { command })
  const SMTP6 = 'smtp' + 'lib'
  const SEND6 = 'send' + 'mail'
  const EVIL6 = [`import ${SMTP6}`, `${SMTP6}.SMTP('h').${SEND6}(a, b, c)`].join(NL)
  const LEGIT6 = `{"content":"a ${SMTP6} utat elvetettuk, a szolgaltato API-t hasznaljuk"}`

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


describe('buildGateMsg names the workaround, not just the escalation (card 84e31b40)', () => {
  it('tells a denied PROSE call what shape to use instead', () => {
    // Before this card the message only said "send it to <bot> for approval" -- meaningless advice
    // for a kanban comment, and the measured outcome was an agent that either gave up or started
    // obfuscating the text. Obfuscation is the worse of the two, so the message must name the
    // legitimate route.
    const msg: string = buildGateMsg('Marveen', 'Szabolcs')
    expect(msg).toContain('--data-binary @fajl')
    expect(msg).toContain('git commit -F fajl')
    expect(msg).toContain('ne obfuszkald')
  })

  it('the added guidance carries no brand/owner name, so a custom install stays clean', () => {
    const msg: string = buildGateMsg('Nova', 'John')
    expect(msg).not.toContain('Marveen')
    expect(msg).not.toMatch(/Szab(olcs|i)/)
  })
})

// The main-exempt guard: every sub-agent is gated, the main agent never is.
// Mirrors security-profile-resolution.test.ts -- pure, keyed on the configured
// MAIN_AGENT_ID (not a hardcoded name), so a customer install exempts its own owner.
describe('agentGetsEmailGate', () => {
  it('gates every sub-agent', () => {
    expect(agentGetsEmailGate('samu')).toBe(true)
    expect(agentGetsEmailGate('boni')).toBe(true)
    expect(agentGetsEmailGate('zara')).toBe(true)
  })

  it('NEVER gates the main agent (it retains email-send)', () => {
    expect(agentGetsEmailGate(MAIN_AGENT_ID)).toBe(false)
  })
})

// The settings.json wiring that installs the hook for a sub-agent.
describe.skipIf(REPO_UNDER_TMP)('injectEmailSendGate', () => {
  it('adds the PreToolUse email-gate hook', () => {
    const s: Record<string, unknown> = {}
    injectEmailSendGate(s)
    const hooks = (s.hooks as Record<string, unknown>).PreToolUse as Array<Record<string, unknown>>
    expect(hooks).toHaveLength(1)
    expect(hooks[0].matcher).toBe('Bash|send_email')
    const inner = (hooks[0].hooks as Array<{ command: string }>)[0]
    expect(inner.command).toContain('email-send-gate.mjs')
  })

  it('is idempotent (no duplicate entries on re-apply / respawn)', () => {
    const s: Record<string, unknown> = {}
    injectEmailSendGate(s)
    injectEmailSendGate(s)
    injectEmailSendGate(s)
    const hooks = (s.hooks as Record<string, unknown>).PreToolUse as unknown[]
    expect(hooks).toHaveLength(1)
  })

  it('preserves existing hooks (e.g. PreCompact) and other PreToolUse entries', () => {
    const s: Record<string, unknown> = {
      hooks: {
        PreCompact: [{ matcher: 'auto', hooks: [{ type: 'agent', prompt: 'x' }] }],
        PreToolUse: [{ matcher: 'WebFetch', hooks: [{ type: 'command', command: 'other.sh' }] }],
      },
    }
    injectEmailSendGate(s)
    const hooks = s.hooks as Record<string, unknown>
    expect((hooks.PreCompact as unknown[]).length).toBe(1)
    const pre = hooks.PreToolUse as Array<Record<string, unknown>>
    // the unrelated WebFetch entry is kept, the email-gate is appended
    expect(pre).toHaveLength(2)
    expect(pre.some((e) => JSON.stringify(e).includes('email-send-gate.mjs'))).toBe(true)
    expect(pre.some((e) => e.matcher === 'WebFetch')).toBe(true)
  })
})

// Always runs: a CI log must never be ambiguous about whether the tmp-sensitive suites above were
// armed or skipped (card 252e36d3 -- 13 phantom "failures" were once tracked as a real red baseline).
describe('tmp-checkout env gate (always runs)', () => {
  it('reports whether the hook-registration suites in this file were armed or skipped', () => {
    if (REPO_UNDER_TMP) {
      console.log(`[${'email-send-gate.test.ts'}] SKIPPED hook-registration suites -- ${TMP_SKIP_REASON}`)
    } else {
      console.log(`[${'email-send-gate.test.ts'}] ARMED -- checkout is outside /tmp, hook-registration assertions ran.`)
    }
    expect(typeof REPO_UNDER_TMP).toBe('boolean')
  })
})

// Card 84e31b40, SEVENTH round, Cybersec F-8: a `case` PATTERN's `)` is a SEPARATOR, not a closer.
//
//     curl ... -d @- $(case x in x) python3 <<'PY' ... PY ;; esac)
//
// bash reads that `)` as the end of the pattern and hands the heredoc to python3 inside the arm. The
// walker read it as a closer, popped the frame `$(` had opened, and measured the span from the OUTER
// curl -- the same miscount as F-5 (quoting), F-6 (bare subshell) and F-7 (parameter expansion),
// reached through a fourth construct. Measured executing from inside the blanked body.
//
// Measuring the family rather than the reported shape found FOUR more live ones: an alternation
// pattern `a|x)`, an extglob pattern `@(a|x))` (executes when extglob is on at PARSE time), a nested
// `case`, and a newline between `in` and the pattern; plus two that only reach the keyword through
// another reserved word (`then`, `do`).
//
// The fix is where this round differs from the previous ones: recognising the keyword LIBERALLY
// would have introduced a bypass rather than closing one. The pattern rule moves the boundary
// FORWARD, so whoever gets a fake `case` recognised gets to choose where the next span starts --
// `python3 - $(: case in x) curl -d @- <<'PY'` is a real bash command where `case` is an argument to
// `:`, and treating it as the keyword blanks a body python3 owns. So `case`/`esac` count only in
// COMMAND POSITION, and the reserved words that may precede a command (`then`, `do`, `if`, ...)
// advance the boundary instead of being counted as part of the command. That second half also
// removes a standing false positive: `for f in a b; do curl ... -d @- <<'JSON'` measured its span
// from `do` and denied a legitimate payload. K13/K14 hold the first claim; the CONTROLs hold the
// second -- both to a measurement, not an argument.
describe('gateDecision: bash GRAMMAR -- a case PATTERN terminator is not a frame closer (card 84e31b40, F-8)', () => {
  const NL = String.fromCharCode(10)
  const bash = (command: string) => gateDecision('Bash', { command })
  const SMTP8 = 'smtp' + 'lib'
  const SEND8 = 'send' + 'mail'
  const EVIL8 = [`import ${SMTP8}`, `${SMTP8}.SMTP('h').${SEND8}(a, b, c)`].join(NL)
  // Prose that WOULD trigger the gate if the heredoc body were not blanked.
  const HOT8 = `{"content":"ne ${SMTP8}.SMTP('h').${SEND8}(a, b, c) hivast irjunk, hanem az API-t"}`
  // The inner interpreter sits in a case ARM BODY inside the outer curl's argv.
  const caseArm = (head: string, tail: string): string =>
    [`curl -s -X POST http://127.0.0.1:1/x -d @- $(${head} python3 <<'PY'`, EVIL8, 'PY', tail].join(NL)
  // A legitimate call INSIDE a case arm, carrying prose that WOULD trigger if the body were not
  // blanked -- so an ALLOW here is evidence of blanking, not of a harmless payload.
  const legitArm = (head: string, tail: string): string =>
    [`${head} curl -s -X POST http://localhost:3420/x -d @- <<'JSON'`, HOT8, 'JSON', tail].join(NL)

  it('K1: a bare case pattern owns the arm body (the reported shape)', () => {
    expect(bash(caseArm('case x in x)', ';; esac)')).deny).toBe(true)
  })

  it('K4: an alternation pattern a|x)', () => {
    // Not reported. The `|` is a separator to the walker, so the pattern terminator arrives with the
    // boundary already moved -- and it was still popping the frame. Measured executing.
    expect(bash(caseArm('case x in a|x)', ';; esac)')).deny).toBe(true)
  })

  it('K5: an extglob pattern @(a|x))', () => {
    // Not reported. TWO `)` in a row, only the second of which ends the pattern: the extglob `(` has
    // to stay a frame while the pattern's own `)` does not pop one. Executes under a shell with
    // extglob already on at parse time (measured through `eval` with `shopt -s extglob` set first).
    expect(bash(caseArm('case x in @(a|x))', ';; esac)')).deny).toBe(true)
  })

  it('K6: a nested case, whose INNER arm owns the body', () => {
    // Not reported. Two pattern terminators at the same nesting depth; a single flag instead of a
    // stack loses the outer statement. Measured executing.
    expect(bash(caseArm('case x in x) case y in y)', ';; esac ;; esac)')).deny).toBe(true)
  })

  it('K9: a newline between `in` and the pattern', () => {
    // Not reported. The everyday multi-line layout -- and a newline is a separator, which is what
    // made this one distinct from K1 for the walker. Measured executing.
    expect(bash(caseArm('case x in' + NL + '  x)', ';; esac)')).deny).toBe(true)
  })

  it('K16: `then case` -- the keyword reached through another reserved word', () => {
    // Not reported. This is the shape that decides whether the command-position test is enough on
    // its own: without advancing the boundary past `then`, `case` is not in command position and the
    // whole rule silently does not apply. Measured executing.
    expect(bash(caseArm('if : ; then case x in x)', ';; esac; fi)')).deny).toBe(true)
  })

  it('K17: `do case` -- the same through a loop body', () => {
    expect(bash(caseArm('for i in a; do case x in x)', ';; esac; done)')).deny).toBe(true)
  })

  it('K2: the parenthesised (pattern) form', () => {
    // Closed since F-6 (the bare `(` opens a frame its `)` balances), and pinned here because the
    // F-8 fix has to stop that `(` from opening a frame at ALL -- otherwise the pattern's `)` pops
    // it and the arm body is measured from the wrong place again.
    expect(bash(caseArm('case x in (x)', ';; esac)')).deny).toBe(true)
  })

  it('K3: a second arm reached through ;;', () => {
    // Denied before this fix only because the `;;` had already moved the boundary. Pinned so the
    // arm-terminator bookkeeping cannot regress it.
    expect(bash(caseArm('case x in a) : ;; x)', ';; esac)')).deny).toBe(true)
  })

  it('K12: the (pattern) form reached through ;;', () => {
    expect(bash(caseArm('case x in a) : ;; (x)', ';; esac)')).deny).toBe(true)
  })

  it('K13: `case`/`in` as ARGUMENTS, not keywords -- the bypass the fix itself could open', () => {
    // `$(: case in x)` is a real bash command: `case` and `in` are arguments to `:`, the `)` really
    // does close the substitution, and the heredoc really does belong to python3. A walker that
    // recognised the keyword anywhere would move the boundary onto the `curl` and blank it. This is
    // why recognition is gated on command position.
    const cmd = [
      `python3 - $(: case in x) curl -d @- http://localhost:9/x <<'PY'`,
      EVIL8,
      'PY',
    ].join(NL)
    expect(bash(cmd).deny).toBe(true)
  })

  it('K14: the same with echo in front', () => {
    const cmd = [
      `python3 - $(echo case in x) curl -d @- http://localhost:9/x <<'PY'`,
      EVIL8,
      'PY',
    ].join(NL)
    expect(bash(cmd).deny).toBe(true)
  })

  it('CONTROL: a legitimate call inside a case arm ALLOWs (false positive removed)', () => {
    // Before this fix the span started at `case`, failed the leading-binary check, and the payload
    // was scanned as if it were a command -- a legitimate comment denied. The FP0 baseline below
    // proves the body is hot, so this ALLOW is blanking, not luck.
    expect(bash(legitArm('case y in a)', ';; esac')).deny).toBe(false)
  })

  it('CONTROL: FP0 baseline -- the same payload outside any case is blanked', () => {
    const cmd = [`curl -s -X POST http://localhost:3420/x -d @- <<'JSON'`, HOT8, 'JSON'].join(NL)
    expect(bash(cmd).deny).toBe(false)
  })

  it('CONTROL: FP0 negative -- the same payload NOT on curl stdin is denied', () => {
    // The anti-vacuity half: without the `-d @-` ownership there is no blanking, and the identical
    // text denies. So the two CONTROLs above measure the blanking, not the payload.
    const cmd = [`python3 - <<'JSON'`, HOT8, 'JSON'].join(NL)
    expect(bash(cmd).deny).toBe(true)
  })

  it('CONTROL: a legitimate call in a (pattern)-form arm ALLOWs', () => {
    expect(bash(legitArm('case y in (a)', ';; esac')).deny).toBe(false)
  })

  it('CONTROL: a legitimate call in the SECOND arm ALLOWs', () => {
    expect(bash(legitArm('case y in b) : ;; a)', ';; esac')).deny).toBe(false)
  })

  it('CONTROL: a legitimate call in a for..in..do body ALLOWs (false positive removed)', () => {
    expect(bash(legitArm('for f in a b; do', 'done')).deny).toBe(false)
  })

  it('CONTROL: a legitimate call after a COMPLETE case statement ALLOWs', () => {
    expect(bash(legitArm('case y in a) : ;; esac;', '')).deny).toBe(false)
  })

  it('CONTROL: a legitimate call whose header substitution CONTAINS a case ALLOWs', () => {
    // The `esac` has to put the walker back where it was: the substitution's own `)` must still pop
    // the frame, or the outer curl loses its span and a legitimate payload is denied.
    const cmd = [
      `curl -s -H "X: $(case y in a) echo 1 ;; esac)" -X POST http://localhost:3420/x -d @- <<'JSON'`,
      HOT8,
      'JSON',
    ].join(NL)
    expect(bash(cmd).deny).toBe(false)
  })

  it('CONTROL: ...and when that arm body contains its own `;`', () => {
    // The `;` inside the substitution belongs to it, not to the case arm. Counting it as an arm
    // terminator makes the substitution's closing `)` look like a pattern terminator, which loses
    // the outer curl's span.
    const cmd = [
      `curl -s -H "X: $(case y in a) date; echo 1 ;; esac)" -X POST http://localhost:3420/x -d @- <<'JSON'`,
      HOT8,
      'JSON',
    ].join(NL)
    expect(bash(cmd).deny).toBe(false)
  })

  // Generated, in the spirit of the F-5 invariant: for every case-arm head form we know of, an
  // interpreter-owned heredoc in the arm body must stay scanned. A future arm shape then fails here
  // without anyone having to think of it first.
  it('INVARIANT (generated): an interpreter-owned heredoc inside a case ARM is never blanked', () => {
    const ARMS: Array<[string, string]> = [
      ['case x in x)', ';; esac)'],
      ['case x in (x)', ';; esac)'],
      ['case x in a|x)', ';; esac)'],
      ['case x in @(a|x))', ';; esac)'],
      ['case x in a) : ;; x)', ';; esac)'],
      ['case x in a) : ;& x)', ';; esac)'],
      ['case x in a) : ;;& x)', ';; esac)'],
      ['case x in' + NL + '  x)', ';; esac)'],
      ['case x in x) case y in y)', ';; esac ;; esac)'],
      ['if : ; then case x in x)', ';; esac; fi)'],
      ['for i in a; do case x in x)', ';; esac; done)'],
      ['while :; do case x in x)', ';; esac; break; done)'],
      ['case x in a) : ;; (x)', ';; esac)'],
    ]
    const failures: string[] = []
    for (const [head, tail] of ARMS) {
      if (!bash(caseArm(head, tail)).deny) failures.push(head)
    }
    expect(failures).toEqual([])
  })
})
