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

// ROUND 2 (QA FAIL on the round-1 fix, same card 0f7f7fe9). The round-1 CURL_CONFIG_STDIN_RX only
// matched `-K`/`--config` with a SEPARATOR (space or `=`) before the trailing `-`. Real curl 8.18.0
// also accepts the getopt-style ATTACHED short-option form with no separator at all -- `-K-` -- and
// QA measured `curl -K- < file` behaving IDENTICALLY to `curl -K - < file`. Re-deriving the fix from
// curl's actual short-option grammar (rather than re-testing only the reported shape) additionally
// surfaced flag CLUSTERING: curl merges boolean short flags onto the same token as a value-taking one
// (`-sK-` behaves exactly like `-s -K -`), which a bare `-K-` match anchored only at a preceding space
// does not catch. Both are pinned here from the grammar, not from the patch, per the lesson in
// `build-an-enumeration-from-the-grammar-not-from-the-patch`.
const ATTACHED_CONFIG_CONSUMERS = ['-K-', '-sK-', '-svK-']

// Forms curl actually REJECTS (confirmed with the real binary: `--config-` -> "option --config-: is
// unknown"; `-K=-` -> tries to open a literal file named `=-` and errors). Neither is a live stdin
// consumer, so neither belongs in ATTACHED_CONFIG_CONSUMERS. Whether the regex happens to match one
// of them is not a safety question either way, because the underlying curl call errors out before it
// ever sends anything -- there is no live payload to protect against. `-K=-` DOES match (matched
// already pre-round-2, unchanged here) so its body stays visible/denied; `--config-` does NOT match
// (also unchanged) so it is treated the same as plain `-d @-` and allowed -- both are asserted below
// exactly to pin that neither shape regressed, not because "allowed" is the safety-relevant outcome.

describe('heredocIsStdinDataSink: attached/clustered short-option `-K` forms (card 0f7f7fe9, round 2)', () => {
  it.each(ATTACHED_CONFIG_CONSUMERS)(
    'does NOT blank a heredoc body when `curl -d @- %s` is present (attached/clustered -K)',
    (flag) => {
      const out = stripHeredocDataPayloads(withHeredoc(`-d @- ${flag}`))
      for (const line of SEND_CONFIG.split(NL)) expect(out).toContain(line)
    },
  )

  it.each(ATTACHED_CONFIG_CONSUMERS)('email-send-gate DENIES a real send decoyed as `curl -d @- %s`', (flag) => {
    expect(emailGate('Bash', { command: withHeredoc(`-d @- ${flag}`) }).deny).toBe(true)
  })

  it.each(ATTACHED_CONFIG_CONSUMERS)('same DENY holds with the flags reversed (`curl %s -d @-`)', (flag) => {
    expect(emailGate('Bash', { command: withHeredoc(`${flag} -d @-`) }).deny).toBe(true)
  })

  it("CONTROL: `-K=-` (invalid curl syntax, but still matches the shape) keeps denying, unchanged", () => {
    expect(emailGate('Bash', { command: withHeredoc('-d @- -K=-') }).deny).toBe(true)
  })

  it("CONTROL: `--config-` (invalid curl syntax, no separator, no clustering equivalent) stays " +
    "allowed exactly as before round 2 -- harmless because the real curl call errors ('option " +
    "--config-: is unknown') before it can ever send, so there is no live payload here to protect", () => {
    expect(emailGate('Bash', { command: withHeredoc('-d @- --config-') }).deny).toBe(false)
  })

  it('CONTROL: attached `-d@-` (no separator) is not itself a new hole -- it is simply never recognized ' +
    'as the safe-data shape, so the body stays visible and the send is still caught', () => {
    expect(emailGate('Bash', { command: withHeredoc('-d@-') }).deny).toBe(true)
    expect(emailGate('Bash', { command: withHeredoc('-d@- -K -') }).deny).toBe(true)
    expect(emailGate('Bash', { command: withHeredoc('-d@- -K-') }).deny).toBe(true)
  })

  it('CONTROL: plain `-d @-` with no config flag at all stays allowed after the round-2 widening', () => {
    expect(emailGate('Bash', { command: withHeredoc('-d @-') }).deny).toBe(false)
  })

  it('CONTROL: round-1 separated/`=` forms still deny (no regression from the round-2 rewrite)', () => {
    for (const flags of DECOY_PLUS_CONFIG) {
      expect(emailGate('Bash', { command: withHeredoc(flags) }).deny).toBe(true)
    }
  })
})

// ROUND 3 (Cybered NO-GO on the round-2 fix, same card 0f7f7fe9, comment #16926). Rounds 1-2 closed
// curl's own getopt grammar (attached/clustered/separated/`=`), but CURL_CONFIG_STDIN_RX runs on the
// RAW owner-span text -- before shell quote-removal. Live-confirmed with real curl 8.18.0: shell
// quoting or backslash-escaping around the flag changes nothing about which argv curl actually
// receives, so all five shapes below resolve to the identical, already-denied `-K -` argv while the
// RAW text no longer matches the regex. Pinned from the grammar (bash quote-removal has exactly four
// mechanisms: single quotes, double quotes, `$'...'`, and a bare backslash-escape), not from the one
// reported shape, per this file's own standing lesson.
const QUOTED_CONFIG_CONSUMERS = ['"-K" -', '-"K" -', "'-K' -", '--"config" -', '\\-K -']

describe('heredocIsStdinDataSink: shell-quoted/escaped `-K`/`--config` forms (card 0f7f7fe9, round 3)', () => {
  it.each(QUOTED_CONFIG_CONSUMERS)(
    'does NOT blank a heredoc body when `curl -d @- %s` is present (quoted/escaped -K)',
    (flag) => {
      const out = stripHeredocDataPayloads(withHeredoc(`-d @- ${flag}`))
      for (const line of SEND_CONFIG.split(NL)) expect(out).toContain(line)
    },
  )

  it.each(QUOTED_CONFIG_CONSUMERS)('email-send-gate DENIES a real send decoyed as `curl -d @- %s`', (flag) => {
    expect(emailGate('Bash', { command: withHeredoc(`-d @- ${flag}`) }).deny).toBe(true)
  })

  it('same DENY holds for a quoted+clustered form (`-s"K"-`, not individually reported but implied ' +
    'by the same grammar: quoting can wrap any single character of a clustered short-option run)', () => {
    expect(emailGate('Bash', { command: withHeredoc('-d @- -s"K"-') }).deny).toBe(true)
  })

  it('CONTROL: quoting UNRELATED text (a URL, no config flag anywhere) does not create a false deny', () => {
    expect(emailGate('Bash', { command: withHeredoc('-d @- "https://example.com/x"') }).deny).toBe(false)
  })

  it('ACCEPTED TRADE-OFF, pinned deliberately (same direction as the pre-existing `-oK-` false ' +
    'positive): de-quoting an UNRELATED quoted argument that merely CONTAINS the text `-K -` (e.g. a ' +
    'quoted header value) also stops the blank -- over-caution, not a bypass, since the body just ' +
    'stays scanned instead of being silently exempted', () => {
    expect(emailGate('Bash', { command: withHeredoc('-d @- -H "X-Debug: -K -"') }).deny).toBe(true)
  })

  it('CONTROL: all round-1/round-2 (unquoted) forms still deny -- no regression from the de-quoted check', () => {
    for (const flags of [...DECOY_PLUS_CONFIG, ...ATTACHED_CONFIG_CONSUMERS.map((f) => `-d @- ${f}`)]) {
      expect(emailGate('Bash', { command: withHeredoc(flags) }).deny).toBe(true)
    }
  })

  it('CONTROL: plain `-d @-` with no config flag at all stays allowed after the round-3 widening', () => {
    expect(emailGate('Bash', { command: withHeredoc('-d @-') }).deny).toBe(false)
  })
})

// ROUND 4 (Cybersec NO-GO on the round-3 fix, same card 0f7f7fe9). Round 3's dequoteCurlSpan handled
// three of bash's shell-quote-removal mechanisms (single quotes, double quotes, `$'...'` ANSI-C
// quoting) but missed the fourth: `$"..."` LOCALE quoting (bash manual 3.1.2.5). Cybersec measured
// 245 quoting shapes generated from the grammar (not the patch), all verified with real bash: 56
// bypassed pre-fix, all 56 the SAME single mechanism, zero others. `curl -d @- $"-K" -` denied
// end-to-end with a real resend.com send-config heredoc pre-fix; fix is one line (skip the `$` before
// an existing `"` branch, same body-parsing rules as plain double-quoting).
const LOCALE_QUOTED_CONFIG_CONSUMERS = [`$"-K" -`, `--$"config" -`, `-s$"K"-`]

describe('heredocIsStdinDataSink: locale-quoted `$"..."` `-K`/`--config` forms (card 0f7f7fe9, round 4)', () => {
  it.each(LOCALE_QUOTED_CONFIG_CONSUMERS)(
    'does NOT blank a heredoc body when `curl -d @- %s` is present (locale-quoted -K)',
    (flag) => {
      const out = stripHeredocDataPayloads(withHeredoc(`-d @- ${flag}`))
      for (const line of SEND_CONFIG.split(NL)) expect(out).toContain(line)
    },
  )

  it.each(LOCALE_QUOTED_CONFIG_CONSUMERS)('email-send-gate DENIES a real send decoyed as `curl -d @- %s`', (flag) => {
    expect(emailGate('Bash', { command: withHeredoc(`-d @- ${flag}`) }).deny).toBe(true)
  })

  it('CONTROL: a real, non-stdin `-K` config file with a locale-quoted path stays allowed', () => {
    expect(emailGate('Bash', { command: withHeredoc(`-d @- -K$"/etc/curlrc"`) }).deny).toBe(false)
  })

  it('CONTROL: locale-quoting UNRELATED text (a URL, no config flag anywhere) does not create a false deny', () => {
    expect(emailGate('Bash', { command: withHeredoc(`-d @- $"https://example.com/x"`) }).deny).toBe(false)
  })

  it('CONTROL: all round-1/2/3 forms still deny -- no regression from the round-4 widening', () => {
    for (const flags of [...DECOY_PLUS_CONFIG, ...ATTACHED_CONFIG_CONSUMERS.map((f) => `-d @- ${f}`)]) {
      expect(emailGate('Bash', { command: withHeredoc(flags) }).deny).toBe(true)
    }
    for (const flag of QUOTED_CONFIG_CONSUMERS) {
      expect(emailGate('Bash', { command: withHeredoc(`-d @- ${flag}`) }).deny).toBe(true)
    }
  })

  it('CONTROL: plain `-d @-` with no config flag at all stays allowed after the round-4 widening', () => {
    expect(emailGate('Bash', { command: withHeredoc('-d @-') }).deny).toBe(false)
  })

  // MUTATION-KILLING (Cybersec r4 GO, I-1): the round-4 test set above pins that the `$"..."`
  // branch exists, not that it skips the RIGHT number of characters. `i += 1` (skip just the `$`,
  // let the existing `"` branch parse the body) vs a mutated `i += 2` (also skip the opening `"`,
  // so the body is copied as literal text INCLUDING everything up to and past the real closing
  // quote) is invisible to every case above -- all of them still deny either way. This flag
  // ('-'$"K" '-') is the one shape that tells the two apart: correct code sees -K -, the
  // off-by-one variant does not. Measured: 735 live bypasses open under the mutant.
  it('MUTATION-KILLING: `\'-\'$"K" \'-\'` denies -- distinguishes correct `$"` char-skip count from an off-by-one', () => {
    expect(emailGate('Bash', { command: withHeredoc(`-d @- '-'$"K" '-'`) }).deny).toBe(true)
  })
})
