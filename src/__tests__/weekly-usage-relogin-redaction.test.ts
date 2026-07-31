// The --paste failure dump must not print the OAuth code (card b5746e1e).
//
// Cybersec consequence-finding on e5411be1: the failure branch prints the panel's last lines so a
// failed login is diagnosable -- but the code was JUST typed into that panel, and the output goes to
// stderr, i.e. into MikroB's transcript and logs. That is MORE durable than the argv leak it followed
// (argv lives for one process; a transcript lives until someone prunes it).
//
// The dump is kept (it shows WHY the login failed); the code is stripped from it (we already know
// what we sent, so it has no diagnostic value). These tests drive the SAME redaction the failure
// branch uses, via the script's --redact-stdin seam -- the branch itself needs a live panel, and an
// untested redaction is exactly the thing that silently stops redacting.
import { describe, it, expect } from 'vitest'
import { execFileSync } from 'node:child_process'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { readFileSync } from 'node:fs'

const SCRIPT = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  'store',
  'weekly-usage-relogin.sh',
)

/** Pipe `text` through the script's redaction with CODE set. */
function redact(text: string, code?: string): string {
  return execFileSync('bash', [SCRIPT, '--redact-stdin'], {
    input: text,
    encoding: 'utf-8',
    env: { ...process.env, ...(code === undefined ? {} : { CODE: code }) },
  })
}

describe('the OAuth code never survives the dump', () => {
  it('removes the EXACT code we sent', () => {
    const code = 'ac_9f3b21QeR-oauth-code'
    const out = redact(`Login failed\nYou entered: ${code}\nTry again\n`, code)
    expect(out).not.toContain(code)
    expect(out).toContain('***REDACTED***')
  })

  it('removes EVERY occurrence, not just the first', () => {
    const code = 'ac_9f3b21QeR-oauth-code'
    const out = redact(`${code}\nmiddle\n${code}\n`, code)
    expect(out).not.toContain(code)
    expect(out.match(/\*\*\*REDACTED\*\*\*/g)).toHaveLength(2)
  })

  it('masks a long token even when CODE is not set (the exact match cannot fire)', () => {
    // Defence for the case where the terminal broke or mangled the code so an exact match misses it.
    const out = redact('error\nQWERTYuiop1234567890asdfgh\n')
    expect(out).not.toContain('QWERTYuiop1234567890asdfgh')
    expect(out).toContain('***REDACTED***')
  })

  it('masks a long token that does NOT equal CODE (mangled-echo case)', () => {
    const out = redact('junk\nAAAABBBBCCCCDDDDEEEEFFFFGGGG\n', 'something-else-entirely')
    expect(out).not.toContain('AAAABBBBCCCCDDDDEEEEFFFFGGGG')
  })

  it('a code containing regex/shell metacharacters is still removed literally', () => {
    // The code is replaced as a literal string, so `.` `*` `$` `/` cannot turn into a pattern.
    const code = 'a.b*c$d/e[f]g+h?i'
    const out = redact(`code=${code}\n`, code)
    expect(out).not.toContain(code)
  })

  it('does not crash on empty input or empty CODE', () => {
    expect(redact('', '')).toBe('')
    expect(redact('plain text\n', '')).toContain('plain text')
  })
})

describe('the dump stays useful -- redaction is not a blanket wipe', () => {
  it('keeps ordinary failure text intact', () => {
    const out = redact('Login failed: network timeout after 30s\nRetry in 5m\n', 'zzz')
    expect(out).toContain('Login failed: network timeout after 30s')
    expect(out).toContain('Retry in 5m')
    expect(out).not.toContain('***REDACTED***')
  })

  it('keeps short tokens (error codes, statuses) readable', () => {
    const out = redact('status=401 reason=invalid_grant attempt=2\n', 'zzz')
    expect(out).toContain('401')
    expect(out).toContain('invalid_grant')
  })
})

describe('the wiring, not just the helper', () => {
  const src = readFileSync(SCRIPT, 'utf-8')

  it('the --paste failure dump actually pipes through redact_code', () => {
    // A perfect redaction function that the failure branch does not call would be useless.
    const pasteBranch = src.slice(src.indexOf('--paste|--paste-file)'), src.indexOf('  start)'))
    expect(pasteBranch).toContain('redact_code')
    expect(pasteBranch).toMatch(/capture-pane[^\n]*\|\s*redact_code|redact_code/)
  })

  it('the --paste dump captures with -J so a wrapped code is one matchable token', () => {
    const pasteBranch = src.slice(src.indexOf('--paste|--paste-file)'), src.indexOf('  start)'))
    const dumpLine = pasteBranch.split('\n').find((l) => l.includes('capture-pane') && l.includes('tail'))
    expect(dumpLine).toBeDefined()
    expect(dumpLine).toContain('-J')
  })

  // REVERSED BY CARD 201a8de7. The original reasoning was that the start branch has no code to leak
  // and that redacting would hide the authorize URL MikroB relays to Peti. The first half only held
  // for the FIRST run (ensure_pane returns immediately for an existing session and never clears it,
  // so re-running start after a failed paste prints a panel that still shows the code). The second
  // half does not hold at all: this dump is the branch where NO URL was found -- the success path
  // printed `OAUTH_URL:` and exited above it, so redaction cannot hide a URL that is not there.
  it('the START branch dump IS redacted too (card 201a8de7)', () => {
    const startBranch = src.slice(src.indexOf('  start)'))
    const dumpLine = startBranch.split('\n').find((l) => l.includes('capture-pane') && l.includes('tail'))
    expect(dumpLine).toBeDefined()
    expect(dumpLine).toContain('redact_code')
  })
})

// Card 4f352199 (Cybersec follow-up): the generic layer only fires on an unbroken 24-character run,
// so a code the TERMINAL wrapped mid-token can slip through -- each half may be shorter than 24.
describe('a code broken across a line boundary is still removed (card 4f352199)', () => {
  const code = 'ac_9f3b21QeR-oauth-code'

  it('catches the code when the terminal split it mid-token', () => {
    const wrapped = `Login failed\nYou entered: ${code.slice(0, 10)}\n${code.slice(10)}\nTry again\n`
    const out = redact(wrapped, code)
    // Neither half may survive: the halves are 10 and 13 chars, both under the generic threshold.
    expect(out).not.toContain(code.slice(0, 10))
    expect(out).not.toContain(code.slice(10))
    expect(out).toContain('***REDACTED***')
  })

  it('catches it even with padding whitespace inserted at the break', () => {
    const out = redact(`prompt> ${code.slice(0, 6)}  \n   ${code.slice(6)}\n`, code)
    expect(out).not.toContain(code.slice(6))
  })

  it('does NOT over-mask ordinary diagnostic text', () => {
    // The whitespace-tolerant pattern is built from the exact code, so it can only ever match that
    // character sequence -- a failure message must stay readable.
    const out = redact('Error: connection refused after 3 retries (exit 7)\n', code)
    expect(out.trim()).toBe('Error: connection refused after 3 retries (exit 7)')
  })

  it('is a no-op when no code was set (the start branch may run without one)', () => {
    const out = redact('panel is idle\n')
    expect(out.trim()).toBe('panel is idle')
  })
})

describe('the TUI wraps lines itself, and a code split that way is still a code (card 163576a0)', () => {
  // Cybersec R1 on 4f352199: `capture-pane -J` rejoins what the TERMINAL wrapped, but the TUI breaks
  // long user messages on its own -- newline plus indent -- so a code can arrive already split into
  // two runs, each shorter than the 24-char threshold. A 14-character fragment reached stderr.
  const WRAPPED = 'Login failed\nYour code: ac_9f3b21QeR\n  oauthCodeTail99xyz\nTry again\n'

  it('masks a code the TUI split across an INDENTED continuation, with no CODE known', () => {
    const out = redact(WRAPPED) // no CODE: layer 1 cannot help, this is layer 2b alone
    expect(out).not.toContain('ac_9f3b21QeR')
    expect(out).not.toContain('oauthCodeTail99xyz')
    expect(out).toContain('***REDACTED***')
  })

  it('keeps the line that FOLLOWS the wrapped token (the fix must not eat the next word)', () => {
    // De-wrapping every newline also fuses "Try" onto the token and masks it -- seen while building
    // this. Only an indented continuation is joined.
    const out = redact(WRAPPED)
    expect(out).toContain('Try again')
    expect(out).toContain('Login failed')
  })

  // Cybersec NO-GO on 0d38dc6: the first round ran the de-wrap AFTER the generic 24-char sweep, so a
  // split with one half >= 24 was partly masked first, the de-wrapped view no longer held a
  // candidate, and the OTHER half survived to stderr. Measured tails: split 24 -> 20 chars leaked,
  // 26 -> 18, 30 -> 14, 36 -> 8. The four original tests all used short-short splits, which is why
  // they stayed green -- and on a wide terminal short-short is the RARER shape.
  const LONG_CODE = `ac_${'x'.repeat(20)}QeR${'z'.repeat(18)}` // 44 chars
  const wrapAt = (n: number): string =>
    `Login failed\nYour code: ${LONG_CODE.slice(0, n)}\n  ${LONG_CODE.slice(n)}\nTry again\n`

  it('masks the split where the FIRST half is >= 24 (30/14) -- the regression case', () => {
    const out = redact(wrapAt(30))
    expect(out).not.toContain(LONG_CODE.slice(0, 30))
    expect(out).not.toContain(LONG_CODE.slice(30))
    expect(out).toContain('***REDACTED***')
  })

  it('masks the split where the SECOND half is >= 24 (10/34)', () => {
    const out = redact(wrapAt(10))
    expect(out).not.toContain(LONG_CODE.slice(0, 10))
    expect(out).not.toContain(LONG_CODE.slice(10))
  })

  it('leaves no fragment of the code at ANY split point', () => {
    // The table Cybersec measured, pinned: one case per split, both halves checked.
    for (const n of [10, 20, 24, 26, 30, 36]) {
      const out = redact(wrapAt(n))
      expect(out, `split ${n} head`).not.toContain(LONG_CODE.slice(0, n))
      expect(out, `split ${n} tail`).not.toContain(LONG_CODE.slice(n))
      expect(out, `split ${n} context`).toContain('Try again')
    }
  })

  it('leaves ordinary indented diagnostic text alone (no over-masking)', () => {
    // The alternative fix -- lowering the 24-char threshold -- would start masking words like these,
    // and a dump that redacts everything is a dump nobody reads.
    const dump =
      'Error: could not reach the auth server\n  retrying in 5 seconds\n  giving up after 3 attempts\n'
    expect(redact(dump)).toBe(dump)
  })

  it('still masks a contiguous long token (layer 2 is not weakened)', () => {
    expect(redact('token=abcdefghijklmnopqrstuvwxyz012345\n')).toContain('***REDACTED***')
  })
})
