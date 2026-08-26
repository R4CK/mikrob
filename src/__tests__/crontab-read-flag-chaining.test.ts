// Card f35b8d92 (Cybersec HIGH, live-measured on the installed gate): SCHEDULER_READ_RX /
// SCHEDULER_CMDWORD_READ_RX / UNANCHORED_SCHEDULER_READ_RX all recognised a pure read by PREFIX
// only -- "starts with `crontab -l`" -- never checking what follows. crontab(1) (cronie source,
// Cybersec's own read of it) parses its flags with getopt in a chain where every flag OVERWRITES
// the same mode variable and the LAST one wins, so `crontab -l -r` genuinely DELETES the crontab
// (a real self-destructive write), not lists it -- and the prefix-match let it straight through as
// a "read". Measured passing on the pre-fix gate.
//
// FIX: a bounded negative lookahead (CRONTAB_NO_WRITE_FLAG_FOLLOWS) requires no `-r`/`-e`/`-i`
// (crontab's own write-shaped flags, alone or combined in a getopt cluster like `-er`) anywhere
// before the next real command boundary (`;`/`&`/`|`/backtick/newline) -- bounded there so it
// cannot reach past the CURRENT crontab invocation into an unrelated later command on the same
// line. Scoped to crontab only: launchctl's read subcommands are a single positional argv[1], not
// a getopt flag chain, and atq takes no mode-flipping flag -- neither shares this mechanism (see
// the constant's own header comment in self-pace-gate.mjs for the full reasoning).
import { describe, it, expect } from 'vitest'
// @ts-expect-error -- plain .mjs hook script, no types
import { gateDecision } from '../../scripts/self-pace-gate.mjs'

const bash = (command: string): boolean => Boolean(gateDecision('Bash', { command }).deny)

describe('crontab -l flag-chaining: the reported bypass is closed (card f35b8d92)', () => {
  it('crontab -l -r (the exact reported shape) now denies', () => {
    expect(bash('crontab -l -r')).toBe(true)
  })
  it('crontab -lr (combined getopt cluster) denies too', () => {
    expect(bash('crontab -lr')).toBe(true)
  })
  it('crontab -r -l (write flag first) denies', () => {
    expect(bash('crontab -r -l')).toBe(true)
  })
  it('crontab -l -e (edit) denies', () => {
    expect(bash('crontab -l -e')).toBe(true)
  })
  it('crontab -l -i (interactive remove) denies', () => {
    expect(bash('crontab -l -i')).toBe(true)
  })
})

describe('crontab -l flag-chaining: genuine reads stay allowed (card f35b8d92)', () => {
  it('plain crontab -l still allowed', () => {
    expect(bash('crontab -l')).toBe(false)
  })
  it('crontab -l | grep claude still allowed (pipe boundary stops the lookahead)', () => {
    expect(bash('crontab -l | grep claude')).toBe(false)
  })
  it('crontab -l -u alice still allowed (a second read-neutral flag after -l)', () => {
    expect(bash('crontab -l -u alice')).toBe(false)
  })
  it('crontab -l; echo done still allowed (unrelated command after a real separator)', () => {
    expect(bash('crontab -l; echo done')).toBe(false)
  })
  it('quoted forms still allowed, unaffected by the new lookahead', () => {
    expect(bash('crontab "-l"')).toBe(false)
    expect(bash("crontab '-l'")).toBe(false)
  })
})

describe('crontab -l flag-chaining: sibling read forms unaffected (card f35b8d92)', () => {
  // launchctl/atq do not share the flag-chaining mechanism (positional subcommand / no mode flag),
  // so the fix does not touch their patterns -- confirmed here they still behave as before.
  it('launchctl list still allowed', () => {
    expect(bash('launchctl list')).toBe(false)
  })
  it('launchctl list followed by an unrelated word (an argument TO list, not a second op)', () => {
    expect(bash('launchctl list load')).toBe(false)
  })
  it('atq still allowed', () => {
    expect(bash('atq')).toBe(false)
  })
})

describe('crontab -l flag-chaining: the heredoc-line and command-word paths too (card f35b8d92)', () => {
  // The card's own three affected consumers: the anchored SCHEDULER_READ_RX (covered above via
  // gateDecision directly), SCHEDULER_CMDWORD_READ_RX (word-expansion path), and the heredoc-line
  // UNANCHORED_SCHEDULER_READ_RX subtraction. Exercised through gateDecision on realistic shapes
  // for each.
  it('a quoted-word-expansion crontab -l -r still denies (SCHEDULER_CMDWORD_READ_RX path)', () => {
    expect(bash('cr"o"ntab -l -r')).toBe(true)
  })
  it('crontab -l -r inside a heredoc body still denies (UNANCHORED_SCHEDULER_READ_RX path)', () => {
    const cmd = 'bash <<\'EOF\'\ncrontab -l -r\nEOF'
    expect(bash(cmd)).toBe(true)
  })
  it('a genuine crontab -l inside a heredoc body still allowed', () => {
    const cmd = 'bash <<\'EOF\'\ncrontab -l\nEOF'
    expect(bash(cmd)).toBe(false)
  })
})
