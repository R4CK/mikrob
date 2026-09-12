import { describe, it, expect } from 'vitest'
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  gateDecision,
  extractAddress,
  threadReplyRequest,
  threadMembershipDecision,
  extractParticipants,
  fetchThreadParticipants,
  buildThreadDenyMsg,
  // @ts-expect-error -- plain .mjs hook script, no types
} from '../../scripts/email-send-gate.mjs'
import {
  injectEmailSendGate,
  hasThreadReplyCapability,
  emailGateCommandStale,
  EMAIL_THREAD_REPLY_CAPABILITY,
  EMAIL_THREAD_REPLY_FLAG,
} from '../web/agent-scaffold.js'
import { MAIN_AGENT_ID } from '../config.js'
import { sanitizeCapabilityTag } from '../prompt-safety.js'

const ROOT = join(__dirname, '..', '..')
const GATE = join(ROOT, 'scripts', 'email-send-gate.mjs')

// Thread-scoped reply narrowing (BONIMAIL910, owner decision 2026-09-10):
// ONE capability-holding agent may send, but only into an existing thread and
// only to addresses already in it. Everything here proves BOTH arms -- the
// in-thread allow AND the out-of-thread deny -- plus the fail-closed edges.

describe('extractAddress', () => {
  it('parses bare addresses and Name <addr> forms, lowercased', () => {
    expect(extractAddress('Sara@Example.COM')).toBe('sara@example.com')
    expect(extractAddress('Kiss Sara <sara@example.com>')).toBe('sara@example.com')
    expect(extractAddress('  x@y.hu  ')).toBe('x@y.hu')
  })

  it('returns empty on anything that is not a single clean address', () => {
    expect(extractAddress('not-an-address')).toBe('')
    expect(extractAddress('a@b.hu, c@d.hu')).toBe('')
    expect(extractAddress('')).toBe('')
    expect(extractAddress(null)).toBe('')
    expect(extractAddress({})).toBe('')
  })
})

describe('threadReplyRequest', () => {
  it('accepts a well-formed reply into an existing thread', () => {
    const r = threadReplyRequest({
      threadId: '198f2b4c7d3e1a09',
      to: ['partner@ceg.hu'],
      cc: ['Masik Fel <masik@ceg.hu>'],
    })
    expect(r.ok).toBe(true)
    expect(r.threadId).toBe('198f2b4c7d3e1a09')
    expect(r.recipients).toEqual(['partner@ceg.hu', 'masik@ceg.hu'])
  })

  it('denies without a threadId (a new thread can never be opened)', () => {
    expect(threadReplyRequest({ to: ['partner@ceg.hu'] }).ok).toBe(false)
    expect(threadReplyRequest({ threadId: '', to: ['x@y.hu'] }).ok).toBe(false)
    expect(threadReplyRequest({ threadId: '   ', to: ['x@y.hu'] }).ok).toBe(false)
    expect(threadReplyRequest({ threadId: 42, to: ['x@y.hu'] }).ok).toBe(false)
  })

  it('denies with no recipients or an unparseable recipient (fail-closed)', () => {
    expect(threadReplyRequest({ threadId: 't1' }).ok).toBe(false)
    expect(threadReplyRequest({ threadId: 't1', to: [] }).ok).toBe(false)
    expect(threadReplyRequest({ threadId: 't1', to: ['jo@cim.hu', 'nem cim'] }).ok).toBe(false)
  })

  it('counts bcc as recipients too (no hidden new address)', () => {
    const r = threadReplyRequest({ threadId: 't1', to: ['a@b.hu'], bcc: ['rejtett@uj.hu'] })
    expect(r.ok).toBe(true)
    expect(r.recipients).toContain('rejtett@uj.hu')
  })
})

describe('threadMembershipDecision (the two control arms)', () => {
  const participants = ['szota.szabolcs.ai@gmail.com', 'partner@ceg.hu']

  it('ALLOWS a recipient already in the thread (control 1: the open arm)', () => {
    expect(threadMembershipDecision(['partner@ceg.hu'], participants).allow).toBe(true)
  })

  it('DENIES a recipient outside the thread (control 2: the closed arm)', () => {
    const v = threadMembershipDecision(['idegen@masik.hu'], participants)
    expect(v.allow).toBe(false)
    expect(v.reason).toContain('idegen@masik.hu')
  })

  it('denies when ANY recipient is outside, even if others are inside', () => {
    expect(threadMembershipDecision(['partner@ceg.hu', 'idegen@masik.hu'], participants).allow).toBe(false)
  })

  it('is case-insensitive on the participant side', () => {
    expect(threadMembershipDecision(['partner@ceg.hu'], ['Partner@Ceg.HU']).allow).toBe(true)
  })

  it('denies on an empty participant list (fail-closed)', () => {
    expect(threadMembershipDecision(['partner@ceg.hu'], []).allow).toBe(false)
    expect(threadMembershipDecision(['partner@ceg.hu'], undefined).allow).toBe(false)
  })
})

describe('extractParticipants', () => {
  it('collects From/To/Cc/Reply-To addresses across the thread, deduped', () => {
    const thread = {
      messages: [
        { payload: { headers: [
          { name: 'From', value: 'Kiss Sara <sara@ceg.hu>' },
          { name: 'To', value: 'szota.szabolcs.ai@gmail.com, Masik <masik@ceg.hu>' },
          { name: 'Subject', value: 'nem cim, nem szamit' },
        ] } },
        { payload: { headers: [
          { name: 'from', value: 'szota.szabolcs.ai@gmail.com' },
          { name: 'Cc', value: 'SARA@CEG.HU' },
        ] } },
      ],
    }
    const got = extractParticipants(thread)
    expect(got.sort()).toEqual(['masik@ceg.hu', 'sara@ceg.hu', 'szota.szabolcs.ai@gmail.com'].sort())
  })

  it('returns [] on an empty or malformed payload', () => {
    expect(extractParticipants({})).toEqual([])
    expect(extractParticipants(null)).toEqual([])
    expect(extractParticipants({ messages: [{}] })).toEqual([])
  })
})

describe('fetchThreadParticipants (injected I/O, no network)', () => {
  const keys = JSON.stringify({ installed: {
    client_id: 'cid', client_secret: 'cs', token_uri: 'https://oauth2.googleapis.com/token',
  } })
  const thread = {
    messages: [{ payload: { headers: [{ name: 'From', value: 'partner@ceg.hu' }] } }],
  }

  it('uses the stored access token while it is fresh', async () => {
    const creds = JSON.stringify({ access_token: 'AT', refresh_token: 'RT', expiry_date: Date.now() + 3_600_000 })
    const calls: string[] = []
    const fetchImpl = async (url: string, init?: { headers?: Record<string, string> }) => {
      calls.push(url)
      expect(init?.headers?.Authorization).toBe('Bearer AT')
      return { ok: true, json: async () => thread }
    }
    const got = await fetchThreadParticipants('t1', {
      fetchImpl,
      readFile: (p: string) => (p.endsWith('credentials.json') ? creds : keys),
    })
    expect(got).toEqual(['partner@ceg.hu'])
    expect(calls).toHaveLength(1)
    expect(calls[0]).toContain('/threads/t1?format=metadata')
  })

  it('refreshes an expired token first', async () => {
    const creds = JSON.stringify({ access_token: 'OLD', refresh_token: 'RT', expiry_date: Date.now() - 1000 })
    const calls: string[] = []
    const fetchImpl = async (url: string, init?: { headers?: Record<string, string> }) => {
      calls.push(url)
      if (url.includes('oauth2.googleapis.com')) return { ok: true, json: async () => ({ access_token: 'NEW' }) }
      expect(init?.headers?.Authorization).toBe('Bearer NEW')
      return { ok: true, json: async () => thread }
    }
    const got = await fetchThreadParticipants('t1', {
      fetchImpl,
      readFile: (p: string) => (p.endsWith('credentials.json') ? creds : keys),
    })
    expect(got).toEqual(['partner@ceg.hu'])
    expect(calls).toHaveLength(2)
  })

  it('throws on refresh failure, thread-fetch failure, or unreadable creds', async () => {
    const creds = JSON.stringify({ access_token: 'AT', refresh_token: 'RT', expiry_date: 0 })
    await expect(fetchThreadParticipants('t1', {
      fetchImpl: async () => ({ ok: false, status: 401, json: async () => ({}) }),
      readFile: (p: string) => (p.endsWith('credentials.json') ? creds : keys),
    })).rejects.toThrow()
    await expect(fetchThreadParticipants('t1', {
      fetchImpl: async () => ({ ok: true, json: async () => ({}) }),
      readFile: () => { throw new Error('ENOENT') },
    })).rejects.toThrow()
  })

  it('URL-encodes the threadId (no path escape into another API route)', async () => {
    const creds = JSON.stringify({ access_token: 'AT', expiry_date: Date.now() + 3_600_000 })
    let seen = ''
    await fetchThreadParticipants('a/../b?x=1', {
      fetchImpl: async (url: string) => { seen = url; return { ok: true, json: async () => thread } },
      readFile: (p: string) => (p.endsWith('credentials.json') ? creds : keys),
    })
    expect(seen).toContain('/threads/a%2F..%2Fb%3Fx%3D1?')
  })
})

// gateDecision itself must be unchanged in effect: send_email still denies for
// everyone; only the entrypoint's flagged path can narrow it.
describe('gateDecision regression (kind tag added, behavior unchanged)', () => {
  it('still denies every send_email, now tagged for the entrypoint', () => {
    const d = gateDecision('mcp__server-gmail-autoauth-mcp__send_email', { threadId: 't1', to: ['a@b.hu'] })
    expect(d.deny).toBe(true)
    expect(d.kind).toBe('send_email')
  })
})

describe('hasThreadReplyCapability', () => {
  it('grants only a sub-agent that carries the capability', () => {
    expect(hasThreadReplyCapability('boni', [EMAIL_THREAD_REPLY_CAPABILITY])).toBe(true)
    expect(hasThreadReplyCapability('boni', [])).toBe(false)
    expect(hasThreadReplyCapability('samu', ['other:cap'])).toBe(false)
  })

  it('never applies to the main agent (it is not gated at all)', () => {
    expect(hasThreadReplyCapability(MAIN_AGENT_ID, [EMAIL_THREAD_REPLY_CAPABILITY])).toBe(false)
  })
})

describe('injectEmailSendGate with the thread-reply flag', () => {
  const innerCommand = (s: Record<string, unknown>): string => {
    const pre = (s.hooks as Record<string, unknown>).PreToolUse as Array<Record<string, unknown>>
    expect(pre).toHaveLength(1)
    return (pre[0].hooks as Array<{ command: string }>)[0].command
  }

  it('default stays byte-identical shape: no flag', () => {
    const s: Record<string, unknown> = {}
    injectEmailSendGate(s)
    expect(innerCommand(s)).not.toContain(EMAIL_THREAD_REPLY_FLAG)
  })

  it('threadReply=true appends the flag to the hook command', () => {
    const s: Record<string, unknown> = {}
    injectEmailSendGate(s, true)
    const cmd = innerCommand(s)
    expect(cmd).toContain('email-send-gate.mjs')
    expect(cmd.endsWith(` ${EMAIL_THREAD_REPLY_FLAG}`)).toBe(true)
  })

  it('re-apply toggles cleanly in both directions (respawn regenerates)', () => {
    const s: Record<string, unknown> = {}
    injectEmailSendGate(s, true)
    injectEmailSendGate(s, false)
    expect(innerCommand(s)).not.toContain(EMAIL_THREAD_REPLY_FLAG)
    injectEmailSendGate(s, true)
    expect(innerCommand(s)).toContain(EMAIL_THREAD_REPLY_FLAG)
  })
})

describe('emailGateCommandStale (migration sees a grant AND a revocation)', () => {
  const entry = (command: string) => [{
    matcher: 'Bash|.*send_email.*|.*manage_email.*',
    hooks: [{ type: 'command', command }],
  }]
  const base = '"/usr/bin/node" "/x/scripts/email-send-gate.mjs"'

  it('flags a wired-but-unflagged entry when the capability expects the flag', () => {
    expect(emailGateCommandStale(entry(base), `${base} ${EMAIL_THREAD_REPLY_FLAG}`)).toBe(true)
  })

  it('flags a still-flagged entry after the capability was revoked', () => {
    expect(emailGateCommandStale(entry(`${base} ${EMAIL_THREAD_REPLY_FLAG}`), base)).toBe(true)
  })

  it('is quiet when the entry matches the expectation', () => {
    expect(emailGateCommandStale(entry(base), base)).toBe(false)
    const flagged = `${base} ${EMAIL_THREAD_REPLY_FLAG}`
    expect(emailGateCommandStale(entry(flagged), flagged)).toBe(false)
  })

  it('ignores unrelated entries and tolerates a missing array', () => {
    expect(emailGateCommandStale([{ matcher: 'WebFetch', hooks: [{ command: 'x' }] }], base)).toBe(false)
    expect(emailGateCommandStale(undefined, base)).toBe(false)
  })
})

// Entrypoint integration: run the real script the way the hook runner does.
// The allow arm of the LIVE thread check needs the real mailbox and is proved
// in the two-control live probe (PR body); here every hermetic arm is pinned.
describe('gate script entrypoint (spawned, no network)', () => {
  const run = (args: string[], payload: unknown, env: Record<string, string> = {}) => {
    const out = execFileSync(process.execPath, [GATE, ...args], {
      input: JSON.stringify(payload),
      timeout: 15_000,
      env: { ...process.env, ...env },
    }).toString()
    return out ? JSON.parse(out) : null
  }
  const sendPayload = (tool_input: Record<string, unknown>) => ({
    tool_name: 'mcp__server-gmail-autoauth-mcp__send_email',
    tool_input,
  })

  it('WITHOUT the flag a send_email still gets the unconditional governance deny', () => {
    const res = run([], sendPayload({ threadId: 't1', to: ['barki@ceg.hu'] }))
    expect(res.hookSpecificOutput.permissionDecision).toBe('deny')
    expect(res.hookSpecificOutput.permissionDecisionReason).toContain('governance hard-gate')
  })

  it('with the flag but NO threadId: thread-gate deny, no network touched', () => {
    const res = run([EMAIL_THREAD_REPLY_FLAG], sendPayload({ to: ['partner@ceg.hu'] }))
    expect(res.hookSpecificOutput.permissionDecision).toBe('deny')
    expect(res.hookSpecificOutput.permissionDecisionReason).toContain('szal-kapu')
    expect(res.hookSpecificOutput.permissionDecisionReason).toContain('threadId hianyzik')
  })

  it('with the flag but unreadable credentials: fail-closed deny', () => {
    const res = run(
      [EMAIL_THREAD_REPLY_FLAG],
      sendPayload({ threadId: 't1', to: ['partner@ceg.hu'] }),
      {
        GMAIL_CREDENTIALS_PATH: '/nonexistent/credentials.json',
        GMAIL_OAUTH_PATH: '/nonexistent/keys.json',
      },
    )
    expect(res.hookSpecificOutput.permissionDecision).toBe('deny')
    expect(res.hookSpecificOutput.permissionDecisionReason).toContain('fail-closed')
  })

  it('with the flag, non-mail tools still pass (flag widens nothing else)', () => {
    expect(run([EMAIL_THREAD_REPLY_FLAG], { tool_name: 'Bash', tool_input: { command: 'git status' } })).toBeNull()
    // and a Bash SEND route stays denied even for the capable agent
    const res = run([EMAIL_THREAD_REPLY_FLAG], { tool_name: 'Bash', tool_input: { command: 'echo hi | sendmail x@y.hu' } })
    expect(res.hookSpecificOutput.permissionDecision).toBe('deny')
    expect(res.hookSpecificOutput.permissionDecisionReason).toContain('governance hard-gate')
  })

  it('deny message names the way out with the configured bot name', () => {
    expect(buildThreadDenyMsg('Marveen', 'proba')).toContain('Marveen')
    expect(buildThreadDenyMsg('Marveen', 'proba')).toContain('proba')
  })
})

// FORK ADAPTATION (card e3f0e4ed). Measured while adopting, and pinned because it will otherwise
// surprise someone: the capability is spelled with a COLON, and CAPABILITY_TAG_RE is
// /^[a-z0-9][a-z0-9-]{0,31}$/ -- in upstream's tree too, so this is not a fork defect. The
// sanitiser sits only on the FLEET ROSTER render (prompt-injection defence: DROP, never normalise),
// NOT on the grant path, which reads readAgentCapabilities raw. So the gate works and exactly one
// thing is lost: peers cannot see in their CLAUDE.md roster that an agent holds this capability --
// arguably the one capability where that visibility matters most. Pinned as a KNOWN consequence so
// that widening the regex is a decision someone makes on purpose, not a silent drift.

// ---------------------------------------------------------------------------
// Card bf2bf691 -- Cybersec's three follow-ups from the e3f0e4ed gate.
// ---------------------------------------------------------------------------

describe('the capability tag survives the roster sanitiser (card bf2bf691)', () => {
  // This REPLACES the earlier pair that pinned the colon form as a known consequence. The name was
  // changed rather than the regex widened, so the assertion flips: it must now round-trip.
  it('round-trips through sanitizeCapabilityTag, so peers SEE who holds it', () => {
    expect(sanitizeCapabilityTag(EMAIL_THREAD_REPLY_CAPABILITY)).toBe(EMAIL_THREAD_REPLY_CAPABILITY)
  })

  it('carries no colon -- the character that made it invisible', () => {
    expect(EMAIL_THREAD_REPLY_CAPABILITY).not.toContain(':')
  })

  it('the grant path still works with the new value', () => {
    expect(hasThreadReplyCapability('some-agent', [EMAIL_THREAD_REPLY_CAPABILITY])).toBe(true)
    expect(hasThreadReplyCapability('some-agent', ['email:thread-reply'])).toBe(false)
  })
})

describe('extractParticipants ignores the DISPLAY NAME (card bf2bf691)', () => {
  const thread = (headerValue: string) => ({
    messages: [{ payload: { headers: [{ name: 'From', value: headerValue }] } }],
  })

  it('a crafted display name cannot inject a stranger into the participant set', () => {
    // Cybersec's exact case: the old scan added BOTH addresses, so replying to the spoofed one
    // passed the membership check.
    const p = extractParticipants(thread('"ceo@ourcompany.com via Mailer" <attacker@evil.test>'))
    expect(p).toEqual(['attacker@evil.test'])
    expect(p).not.toContain('ceo@ourcompany.com')
  })

  // CYBERSEC H-1 (card bf2bf691, NO-GO on the first fix). RFC 5322 lets a quoted-string contain a
  // quoted-pair -- a backslash followed by ANY character, including a quote. The first splitter
  // toggled on every `"`, so the escaped quote ended the quoted string early and the comma after it
  // cut ONE legitimate mailbox into two entries. Measured on the landed code, this exact header
  // yielded ["victim@target.test", "attacker@evil.test"].
  //
  // The header is valid: a standards-following MTA passes it through unchanged. And this vector is
  // the reason the fix existed at all -- a Cc puts the address IN the message, delivered and visible
  // to the owner, while a display name adds a participant with zero delivery and no visible trace.
  it('an ESCAPED QUOTE cannot break out of the display name (Cybersec H-1)', () => {
    const p = extractParticipants(thread('"Doe\\" <victim@target.test>, evil" <attacker@evil.test>'))
    expect(p).toEqual(['attacker@evil.test'])
    expect(p).not.toContain('victim@target.test')
  })

  // CONTROL: the narrowing must not stop collecting the addresses that are really there, or the
  // participant set empties and every reply is denied -- safe, but the feature would be dead.
  it('still collects every REAL address, including a comma inside a quoted display name', () => {
    const p = extractParticipants(thread('"Doe, John" <j@x.test>, plain@y.test, <z@z.test>'))
    expect(p.sort()).toEqual(['j@x.test', 'plain@y.test', 'z@z.test'])
  })

  it('drops an entry it cannot parse rather than guessing (fail-closed)', () => {
    expect(extractParticipants(thread('not-an-address, ok@y.test'))).toEqual(['ok@y.test'])
  })
})

describe('the timeout margin is pinned, not assumed (card bf2bf691)', () => {
  // THE PROPERTY THIS PROTECTS. The whole fail-closed guarantee rests on WHERE the deadline lands:
  // inside the script it becomes a DENY, but if the HOOK itself times out first, Claude Code treats
  // that as a non-blocking error -- fail-OPEN on the send path. Today two sequential 3.5s requests
  // sit under a 10s hook budget. Nothing enforced that, so a third request or a raised per-request
  // timeout would cross the line silently. Read statically from both sources rather than executed,
  // because the failure is a CONFIGURATION relationship, not a runtime behaviour.
  const GATE = readFileSync(join(ROOT, 'scripts', 'email-send-gate.mjs'), 'utf-8')
  const SCAFFOLD = readFileSync(join(ROOT, 'src', 'web', 'agent-scaffold.ts'), 'utf-8')

  const hookTimeoutS = (): number => {
    const fn = SCAFFOLD.slice(SCAFFOLD.indexOf('export function injectEmailSendGate('))
    const m = fn.slice(0, fn.indexOf('\n}')).match(/timeout:\s*(\d+)/)
    expect(m, 'the email gate hook registration no longer states a timeout').toBeTruthy()
    return Number(m![1])
  }

  const perRequestMs = (): number[] =>
    [...GATE.matchAll(/AbortSignal\.timeout\((\d+)\)/g)].map((m) => Number(m[1]))

  /** Source with comments removed and RegExp-literal declarations set aside.
   *
   *  Both exclusions were forced by measurement, not caution. Comments: a sentence naming a call is
   *  not a call. RegExp declarations: this gate's OWN detector for network verbs in sub-agent code
   *  is `const CODE_NETWORK_CALL = /\bfetch\s*\(|.../`, and a scan for `fetch(` matches inside it --
   *  my first version of the check below went red on that, which is the same "a name in prose, a log
   *  line AND code cannot be asserted by name" trap one level up.
   *
   *  The set-aside is PINNED rather than open-ended (see the control below): exactly one line may be
   *  ignored, and it must be that declaration. A second RegExp line appearing here turns the control
   *  red instead of quietly widening what the guard cannot see. */
  const scannable = (): { code: string; ignored: string[] } => {
    const noComments = GATE.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
    const ignored: string[] = []
    const code = noComments
      .split('\n')
      .filter((line) => {
        if (/^\s*const\s+\w+\s*=\s*\//.test(line)) {
          ignored.push(line.trim())
          return false
        }
        return true
      })
      .join('\n')
    return { code, ignored }
  }

  /** Every NETWORK CALL SITE, not just the injected-seam spelling (Cybersec M-1, card bf2bf691).
   *
   *  The first version counted `fetchImpl(` only. `fetch` is also in scope here -- the seam is
   *  `opts.fetchImpl ?? fetch` -- so a bare `fetch(...)` call was invisible to the guard. Cybersec
   *  measured it: an unbounded third call placed on a branch the tests do not walk left all 41 cases
   *  GREEN, with the guard's own two counters still reading 2 and 2. `fetchImpl` itself is not
   *  matched by the bare pattern (the `fetch` there is followed by `Impl`, not by a paren), and the
   *  seam ASSIGNMENT is not a call, so neither inflates the count. */
  const networkCallSites = (): number => {
    const { code } = scannable()
    return (
      [...code.matchAll(/\bfetchImpl\s*\(/g)].length +
      [...code.matchAll(/(?<![\w$.])fetch\s*\(/g)].length
    )
  }

  it('the measure is not vacuous -- both numbers are actually found', () => {
    expect(hookTimeoutS()).toBeGreaterThan(0)
    expect(perRequestMs().length).toBeGreaterThanOrEqual(2)
  })

  it('every network request in the gate carries a timeout -- none is unbounded', () => {
    // A fetch without a signal would wait forever and hand the deadline back to the hook, which is
    // the fail-open direction. Counted against the CALL SITES rather than trusting the sum.
    expect(perRequestMs().length).toBe(networkCallSites())
  })

  it('no network call bypasses the injected seam -- a bare fetch( is refused outright', () => {
    // The strong form of the case above, and the one that closes Cybersec M-1 rather than merely
    // counting past it: all I/O here goes through opts.fetchImpl, which is what makes this gate
    // testable without a network at all. A direct `fetch(` is therefore a defect in itself, whether
    // or not somebody remembered to give it a signal -- and it fails HERE instead of at the next
    // unbounded request on a branch no test walks.
    const { code } = scannable()
    const bare = [...code.matchAll(/(?<![\w$.])fetch\s*\(/g)].length
    expect(bare, 'a direct fetch( call bypasses the injected seam the tests rely on').toBe(0)
  })

  it('only ONE set-aside line can hide a fetch( -- and it is the network-verb DETECTOR', () => {
    // Without this the exclusion above is a hole that grows silently: a future `const X = /.../`
    // could take its own `fetch(` out of sight with it.
    //
    // NOT "exactly one line is set aside" -- measured, this file declares 15 RegExp constants and
    // setting the other 14 aside costs nothing, because none of them contains a fetch(-shaped token.
    // The property that matters is narrower: of everything the scan stops looking at, only the
    // detector may contain the very pattern the scan is searching for. My first version asserted the
    // wider thing and went red on a file that was perfectly fine -- a guard has to pin the real
    // invariant, not the most convenient one.
    const { ignored } = scannable()
    // Matched on the bare TOKEN rather than on a call shape, deliberately. Inside a regex literal
    // the gap is the literal text `\s*`, not whitespace, so a call-shaped pattern misses it -- my
    // first attempt did exactly that and reported zero. Being generous here can only make the
    // assertion below STRICTER (more lines flagged), which is the safe direction for an exclusion.
    const hidingAFetch = ignored.filter((l) => /fetch/.test(l))
    expect(hidingAFetch).toHaveLength(1)
    expect(hidingAFetch[0]).toContain('CODE_NETWORK_CALL')
  })

  it('the SUM of the per-request timeouts stays under the hook budget, with margin', () => {
    const budgetMs = hookTimeoutS() * 1000
    const total = perRequestMs().reduce((a, b) => a + b, 0)
    // Strictly less, and not merely by a rounding: the script still has to read two files, parse
    // JSON and write its decision after the last response.
    expect(
      total,
      `per-request timeouts total ${total}ms against a ${budgetMs}ms hook budget -- ` +
        'if the hook times out first the failure is NON-blocking, i.e. the send is ALLOWED',
    ).toBeLessThanOrEqual(budgetMs - 2000)
  })
})
