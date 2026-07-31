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

  it('the START branch dump is deliberately NOT redacted (no code typed yet, public URL only)', () => {
    // Cybersec explicitly scoped the finding to --paste. Redacting the start dump would hide the
    // authorize URL that MikroB has to relay to Peti -- breaking the flow to fix a non-problem.
    const startBranch = src.slice(src.indexOf('  start)'))
    const dumpLine = startBranch.split('\n').find((l) => l.includes('capture-pane') && l.includes('tail'))
    expect(dumpLine).toBeDefined()
    expect(dumpLine).not.toContain('redact_code')
  })
})
