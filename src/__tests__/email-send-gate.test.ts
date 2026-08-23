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
    const NOISE = ['"a)b"', "'a)b'", '$((1+1))', `'a${BT}b'`, '"a;b"', '"a|b"', '"a))b"']
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
