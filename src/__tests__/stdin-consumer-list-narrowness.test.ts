// Card 0ecff3ae, from Cybersec's GO verdict on 84e31b40 (non-blocking LOW).
//
// `stripHeredocDataPayloads` blanks a heredoc body only when the simple command in front of it is a
// SAFE CONSUMER: one that reads those bytes and never executes or interprets them. Today the list is
// two shapes -- curl's data flags (`-d @-`, `--data-binary @-`, ...) and `git commit -F -`. That
// narrowness is the whole safety argument: curl transmits a `-d` body as HTTP bytes and git stores a
// `-F` body as a message, so blanking them removes no detection.
//
// THE HAZARD THIS FILE PINS. `curl --config -` / `-K -` also reads stdin, so it looks like it belongs
// on the list -- but a curl config body is OPTIONS, not payload bytes. `url = ...`, `request = ...`
// and `data = ...` in that body are a complete outbound send that curl assembles and performs. Adding
// `--config`/`-K` to the list would therefore blank the one place where the send is visible.
//
// Cybersec proved with a live attack that the list is what holds this shut, and measured that the
// naive addition left the whole governance+email suite green at the time -- the mutation falsified
// nothing. One control has since been added next to the email-gate tests; this file pins the CLASS
// rather than the single shape, and pins it on the SHARED FUNCTION, so it covers every gate that
// imports the walker instead of only the gate whose suite happens to hold the case.
//
// WHY THE FUNCTION AND NOT ONLY A GATE. A gate-level assertion can pass for reasons that have nothing
// to do with blanking -- the self-pace gate, for instance, does not flag a curl CONFIG body at all
// (its patterns look for an invocation or an HTTP write in the argv, and a `url = ...` line is
// neither), so a self-pace "still denied" test would be green with or without the list change:
// vacuous. Asserting directly that the body SURVIVES the walker cannot be vacuous, and it is exactly
// the property every consumer of the walker depends on.
import { describe, it, expect } from 'vitest'
// @ts-expect-error -- plain .mjs hook script, no types
import { stripHeredocDataPayloads } from '../../scripts/self-pace-gate.mjs'
// @ts-expect-error -- plain .mjs hook script, no types
import { gateDecision as emailGate } from '../../scripts/email-send-gate.mjs'

const NL = String.fromCharCode(10)

// A curl config body that IS a complete send: url + method + payload, no separate argv needed.
const SEND_CONFIG = [
  'url = "https://api.resend.com/emails"',
  'request = "POST"',
  'header = "Authorization: Bearer k"',
  'data = "{}"',
].join(NL)

// Every spelling curl accepts for "read my options from stdin". A widening of the safe-consumer list
// would plausibly be written for any one of them, so each is listed rather than a representative.
const OPTION_CONSUMERS = ['--config -', '-K -', '--config=-']

const withHeredoc = (flags: string): string =>
  [`curl ${flags} <<'CFG'`, SEND_CONFIG, 'CFG'].join(NL)

describe('stripHeredocDataPayloads: the safe-consumer list is deliberately narrow (card 0ecff3ae)', () => {
  it.each(OPTION_CONSUMERS)(
    'does NOT blank a heredoc body consumed as OPTIONS by `curl %s`',
    (flags) => {
      const out = stripHeredocDataPayloads(withHeredoc(flags))
      // Every line of the config body must still be there to be scanned. Asserting on the lines
      // rather than on the whole string keeps the failure message pointing at what went missing.
      for (const line of SEND_CONFIG.split(NL)) expect(out).toContain(line)
    },
  )

  it('ANTI-VACUITY: the SAME body IS blanked under a genuine data flag', () => {
    // Without this, the assertions above would pass just as happily against a walker that blanks
    // nothing at all -- they would be measuring an inert function, not a narrow list.
    const out = stripHeredocDataPayloads(withHeredoc('-d @-'))
    for (const line of SEND_CONFIG.split(NL)) expect(out).not.toContain(line)
    // and the blanking is length-preserving, so offsets downstream still line up
    expect(out).toHaveLength(withHeredoc('-d @-').length)
  })

  it('ANTI-VACUITY: `git commit -F -` also blanks, so the list is not curl-only by accident', () => {
    const msg = [`git commit -F - <<'MSG'`, 'docs: a message that merely names a provider', 'MSG'].join(NL)
    expect(stripHeredocDataPayloads(msg)).not.toContain('a message that merely names a provider')
  })
})

describe('email-send-gate: an options-in-the-body consumer still sees the send (card 0ecff3ae)', () => {
  const bash = (command: string) => emailGate('Bash', { command })

  it.each(OPTION_CONSUMERS)('DENIES a real send written as a `curl %s` config body', (flags) => {
    expect(bash(withHeredoc(flags)).deny).toBe(true)
  })

  it("CONTROL: the same bytes as curl's DATA payload stay allowed -- the card's original purpose", () => {
    // The prose-in-a-payload false positive this whole line of work exists to remove. If this
    // flipped to denied, the tests above would be "safe" only by having undone the fix.
    expect(bash(withHeredoc('-d @-')).deny).toBe(false)
  })
})

// Card 0f7f7fe9 (Cybersec INFO on c7401c5f, comment #16876): a DECOY `-d @-` sitting ALONGSIDE a real
// `-K -`/`--config -` on the SAME curl invocation used to fool `heredocIsStdinDataSink` -- the literal
// text `-d @-` matched CURL_STDIN_DATA_RX, so the body was blanked even though curl's actual stdin
// consumer here is `--config`/`-K`, which reads the body as OPTIONS (url=/request=/data=), not as an
// inert data payload. Pre-fix this measured deny:false on a live resend.com send. The two-flag
// combinations below are every ordering OPTION_CONSUMERS-with-a-decoy can be spelled.
const DECOY_PLUS_CONFIG = ['-d @- -K -', '-K - -d @-', '-d @- --config -', '--config=- -d @-']

describe('heredocIsStdinDataSink: a decoy `-d @-` cannot launder a real stdin-config flag (card 0f7f7fe9)', () => {
  it.each(DECOY_PLUS_CONFIG)('does NOT blank a heredoc body when `curl %s` is present', (flags) => {
    const out = stripHeredocDataPayloads(withHeredoc(flags))
    for (const line of SEND_CONFIG.split(NL)) expect(out).toContain(line)
  })

  it.each(DECOY_PLUS_CONFIG)('email-send-gate DENIES a real send decoyed as `curl %s`', (flags) => {
    expect(emailGate('Bash', { command: withHeredoc(flags) }).deny).toBe(true)
  })

  it('CONTROL: plain `-d @-` with no config flag stays allowed -- the decoy check must not overreach', () => {
    expect(emailGate('Bash', { command: withHeredoc('-d @-') }).deny).toBe(false)
  })
})
