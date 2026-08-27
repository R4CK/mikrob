import { describe, it, expect } from 'vitest'
// @ts-expect-error -- plain .mjs hook script, no types
import { gateDecision } from '../../scripts/email-send-gate.mjs'

// SUBGATEPOZ822: the gate blocked the DELIVERY of the mail-gate fix three
// times in one afternoon (commit message, PR body heredoc, card-comment
// sqlite write) plus five more content hits across the fleet -- all because
// the old trigger matched send-patterns anywhere in the command string. The
// old header premise ("a sub-agent has no legitimate need to invoke these")
// broke: the developer of the mail tooling is a sub-agent. (Writing THIS
// file was itself blocked by the live gate's old patterns -- the eighth
// measured false positive of the day.)
//
// Per Marveen's strict condition (msg 14282): this is a HARD-deny whose
// mistakes act outward, so REAL send attempts must keep failing -- the
// positive controls below are the acceptance bar, not decor.
//
// Card 72f5f13b merge decision, resolved by card c7401c5f: gateDecision for Bash now runs
// isSendInvocation() composed with heredocFeedsSend() (self-pace-gate.mjs's heredocOwnerRecords,
// the same hardened ownership walker the fork's ~150 adversarial heredoc-ownership cases exercise,
// generalized to classify an INTERPRETER owner) instead of the legacy SEND_PATTERNS content-scan.
// See scripts/email-send-gate.mjs's gateDecision comment for the full trade-off.
describe('gateDecision Bash: content about mail no longer denies (the measured FP classes)', () => {
  const bash = (command: string) => gateDecision('Bash', { command })

  it('a git commit whose MESSAGE names the mailer binaries passes', () => {
    expect(bash('git commit -q -m "fix(hooks): sendmail/msmtp/swaks are now matched in program position, send.py needs --to"').deny).toBe(false)
  })

  it('a PR-create with a heredoc body that documents the send patterns passes', () => {
    expect(bash(`gh pr create --title "gate fix" --body-file /tmp/b.md <<'EOF'\nthe old trigger matched sendmail and api.resend.com anywhere\nEOF`).deny).toBe(false)
  })

  it('a card-comment sqlite write quoting the evidence passes', () => {
    expect(bash(`sqlite3 store/claudeclaw.db "INSERT INTO kanban_comments (card_id, author, content) VALUES ('X','Samu','a send.py es a sendmail mintak a tartalomra tuzeltek')"`).deny).toBe(false)
  })

  it('an inter-agent message about the mail infrastructure passes', () => {
    expect(bash(`curl -s -X POST http://localhost:3420/api/messages -d '{"from":"samu","to":"marveen","content":"az api.resend.com kulcs rotalva, a graph-mail send ut tesztelesre var"}'`).deny).toBe(false)
  })

  it('READING the send tooling passes (cat, grep)', () => {
    expect(bash('cat scripts/support-mail/send.py').deny).toBe(false)
    expect(bash('grep -n sendMail scripts/graph-mail.ts').deny).toBe(false)
  })
})

describe('gateDecision Bash: POSITIVE CONTROLS -- real send attempts still deny (msg 14282 acceptance bar)', () => {
  const bash = (command: string) => gateDecision('Bash', { command })

  it('the mail script executed with a recipient denies (python and direct)', () => {
    expect(bash('python3 scripts/support-mail/send.py --to x@y.hu --subject T --body B').deny).toBe(true)
    expect(bash('./scripts/support-mail/send.py --to=x@y.hu < /tmp/b.txt').deny).toBe(true)
  })

  it('the classic mailers deny, also mid-pipeline and behind env prefixes', () => {
    expect(bash('echo hi | sendmail user@host').deny).toBe(true)
    expect(bash('SMTP_DEBUG=1 msmtp a@b.hu < /tmp/m.txt').deny).toBe(true)
    expect(bash('swaks --to a@b.c --server smtp').deny).toBe(true)
  })

  it('a QUOTED provider URL in curl argument position denies (the normal curl spelling)', () => {
    expect(bash(`curl -X POST "https://api.resend.com/emails" -d @/tmp/mail.json`).deny).toBe(true)
    expect(bash(`curl 'https://api.resend.com/emails' -d @/tmp/mail.json`).deny).toBe(true)
  })

  it('a wrapper shell -c string is analyzed recursively and denies', () => {
    expect(bash(`bash -c "python3 scripts/support-mail/send.py --to a@b.hu --subject X"`).deny).toBe(true)
    expect(bash(`sh -c 'echo m | sendmail a@b.hu'`).deny).toBe(true)
  })

  it('interpreter code-strings that send deny (code handed to an interpreter is operation)', () => {
    expect(bash(`python3 -c "import smtplib; s = smtplib.SMTP('smtp.x.hu'); s.sendmail('a','b','m')"`).deny).toBe(true)
    expect(bash(`node -e "require('./src/graph-mail.js').sendMail({to:'a@b.hu'})"`).deny).toBe(true)
  })

  it('naive exec-shape in interpreter code denies; exec alone or mailer-name alone does not (msg 14298)', () => {
    expect(bash(`python3 -c "import subprocess; subprocess.run(['sendmail','-t','a@b.hu'])"`).deny).toBe(true)
    expect(bash(`node -e "require('child_process').execSync('msmtp a@b.hu < /tmp/m.txt')"`).deny).toBe(true)
    expect(bash(`python3 -c "import subprocess; subprocess.run(['ls','-la'])"`).deny).toBe(false)
    expect(bash(`python3 -c "print('a sendmail utvonala regen mas volt')"`).deny).toBe(false)
  })

  it('heredoc stripping is ORDER-INDEPENDENT: marker-first file-writes stay content, heredoc-FED senders still deny (round 3)', () => {
    expect(bash(`cat <<'EOF' > /tmp/notes.md\nsendmail --to x@y.hu is how the legacy path worked\nEOF`).deny).toBe(false)
    expect(bash(`sendmail -t a@b.hu <<'EOF'\ntorzs sora\nEOF`).deny).toBe(true)
  })

  it('an unparseable command falls back to the legacy patterns (never weaker than before)', () => {
    expect(bash(`echo "unbalanced quote and sendmail mentioned`).deny).toBe(true)
    expect(bash(`echo "unbalanced quote, harmless text`).deny).toBe(false)
  })
})

// Cybersec NO-GO, card c7401c5f, comment #16876: the two heredoc-owner allowlist regexes
// (HEREDOC_INERT_CONSUMER_RX, HEREDOC_INTERPRETER_RX) terminated with a bare `\b`, which is
// satisfied the instant a listed name is a PREFIX of a longer identifier -- so `cat-relay`,
// `gh-copilot`, `node.exe`, etc. matched too, landing on an allowlist that either skips scanning
// the heredoc body entirely (inert list) or scans it with the narrower interpreter-only check
// (interpreter list) instead of the full SEND_PATTERNS scan an unrecognised binary gets. Fixed by
// replacing the trailing `\b` with a true end-of-token lookahead. Battery below reproduces
// Cybersec's exact differential-tested cases (42bfd8b9 vs 312dc04f, then re-verified against the
// fix).
describe('gateDecision Bash: heredoc-owner allowlist prefix bypass (Cybersec NO-GO #16876, B-1)', () => {
  const bash = (command: string) => gateDecision('Bash', { command })

  it('inert-list prefix bypass: a binary whose name merely STARTS WITH cat/gh now stays scanned and denies', () => {
    expect(bash(`cat-relay <<'EOF'\nsendmail a@b.hu\nEOF`).deny).toBe(true)
    expect(bash(`cat.sh <<'EOF'\nsendmail a@b.hu\nEOF`).deny).toBe(true)
    expect(bash(`cat.pl <<'EOF'\nsendmail a@b.hu\nEOF`).deny).toBe(true)
    expect(bash(`gh-copilot <<'EOF'\nsendmail a@b.hu\nEOF`).deny).toBe(true)
    expect(bash(`gh-anything <<'EOF'\nsendmail a@b.hu\nEOF`).deny).toBe(true)
    expect(bash(`gh.sh <<'EOF'\nsendmail a@b.hu\nEOF`).deny).toBe(true)
    expect(bash(`./cat-relay <<'EOF'\nsendmail a@b.hu\nEOF`).deny).toBe(true)
    expect(bash(`sudo cat-relay <<'EOF'\nsendmail a@b.hu\nEOF`).deny).toBe(true)
  })

  it('interpreter-list prefix bypass: a binary whose name merely STARTS WITH node/sh/bun/python/npx/tsx now stays fully scanned and denies', () => {
    expect(bash(`node-relay <<'EOF'\nsendmail a@b.hu\nEOF`).deny).toBe(true)
    expect(bash(`node.exe <<'EOF'\nsendmail a@b.hu\nEOF`).deny).toBe(true)
    expect(bash(`sh-relay <<'EOF'\nsendmail a@b.hu\nEOF`).deny).toBe(true)
    expect(bash(`sh.evil <<'EOF'\nsendmail a@b.hu\nEOF`).deny).toBe(true)
    expect(bash(`bun-relay <<'EOF'\nsendmail a@b.hu\nEOF`).deny).toBe(true)
    expect(bash(`python-relay <<'EOF'\nsendmail a@b.hu\nEOF`).deny).toBe(true)
    expect(bash(`npx-relay <<'EOF'\nsendmail a@b.hu\nEOF`).deny).toBe(true)
    expect(bash(`tsx-relay <<'EOF'\nsendmail a@b.hu\nEOF`).deny).toBe(true)
    expect(bash(`/usr/local/bin/node-relay <<'EOF'\nsendmail a@b.hu\nEOF`).deny).toBe(true)
  })

  it('controls: a genuinely unknown argv0, and a name with no real word-boundary transition, stay denied (unchanged by the fix)', () => {
    expect(bash(`zzqq <<'EOF'\nsendmail a@b.hu\nEOF`).deny).toBe(true)
    expect(bash(`catfish <<'EOF'\nsendmail a@b.hu\nEOF`).deny).toBe(true)
    expect(bash(`cat_relay <<'EOF'\nsendmail a@b.hu\nEOF`).deny).toBe(true)
  })

  it('controls: the OLDER curl/git allowlists were already correctly strict (their own required data-sink shape masks the shared \\b prefix laxity) -- unaffected by this fix, still deny', () => {
    expect(bash(`git-anything <<'EOF'\nsendmail a@b.hu\nEOF`).deny).toBe(true)
    expect(bash(`curl-anything <<'EOF'\nsendmail a@b.hu\nEOF`).deny).toBe(true)
  })

  it('legitimate cases keep passing: real cat/gh and real interpreters (incl. version suffixes) with harmless heredoc bodies', () => {
    expect(bash(`cat <<'EOF'\nnothing interesting here\nEOF`).deny).toBe(false)
    expect(bash(`sudo cat <<'EOF'\nnothing interesting here\nEOF`).deny).toBe(false)
    expect(bash(`/bin/cat <<'EOF'\nnothing interesting here\nEOF`).deny).toBe(false)
    expect(bash(`gh <<'EOF'\nnothing interesting here\nEOF`).deny).toBe(false)
    // node20 / python3.11: version-suffixed interpreter names now correctly recognised, so a
    // heredoc that only MENTIONS "sendmail" in a harmless string does not false-deny (it gets the
    // narrower code-shaped check, same as plain `node`/`python3` already did) -- a separate,
    // Cybersec-measured win over the old regex, which never matched these at all and fell back to
    // the broad SEND_PATTERNS substring scan.
    expect(bash(`node20 <<'JS'\nconsole.log('the sendmail path used to be different')\nJS`).deny).toBe(false)
    expect(bash(`python3.11 <<'PY'\nprint('python3 ... send.py --to a@b.hu is legacy docs text')\nPY`).deny).toBe(false)
    expect(bash(`env python3 <<'PY'\nprint('hello')\nPY`).deny).toBe(false)
    expect(bash(`npx <<'EOF'\nnothing interesting here\nEOF`).deny).toBe(false)
    expect(bash(`bash <<'EOF'\nnothing interesting here\nEOF`).deny).toBe(false)
  })

  it('interpreters (incl. version suffixes) still deny a genuine code-shaped send in the heredoc body', () => {
    expect(bash(`node20 <<'JS'\nrequire('./src/graph-mail.js').sendMail({to:'a@b.hu'})\nJS`).deny).toBe(true)
    expect(bash(`python3.11 <<'PY'\nimport smtplib\nsmtplib.SMTP('smtp.x.hu')\nPY`).deny).toBe(true)
  })
})

// Cybersec NO-GO, card c7401c5f, comment #16876, B-2: extractSubstitutions' $(...) depth counter
// tracked backslash-escapes and single-quotes but not double-quotes, so a `)` INSIDE a
// double-quoted string closed the substitution early -- anything in the raw command AFTER that
// paren never got recursed into by substitutionSends(). Fixed by mirroring the existing
// single-quote branch for `"`.
describe('gateDecision Bash: extractSubstitutions double-quote depth bypass (Cybersec NO-GO #16876, B-2)', () => {
  const bash = (command: string) => gateDecision('Bash', { command })

  it('a `)` inside a double-quoted string no longer truncates the substitution before a real sender', () => {
    expect(bash(`echo "$(echo "a)b"; sendmail a@b.hu)"`).deny).toBe(true)
  })

  it('control: the same shape without the embedded paren already denied (unaffected baseline)', () => {
    expect(bash(`echo "$(echo "ab"; sendmail a@b.hu)"`).deny).toBe(true)
  })

  it('control: the sender BEFORE the embedded paren already denied (unaffected baseline)', () => {
    expect(bash(`echo "$(sendmail a@b.hu; echo "a)b")"`).deny).toBe(true)
  })
})
