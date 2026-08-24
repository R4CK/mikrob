// Card 14b573f3 (Cybered): bash removes a backslash before any non-special character during word
// expansion, so `ba\sh`, `\bash`, `b\ash`, `bas\h` (and combinations) all resolve to the real `bash`
// binary -- verified against real bash (`command -v ba\sh` -> /usr/bin/bash), not assumed. Cybered's
// own repro used only the position right before the trailing "sh" pair, on HERESTRING_RX and
// PROC_SUB_SHELL. Enumerating from the grammar (every letter position, every affected construct --
// this file's own standing lesson) rather than the one reported position/pair turned up two more
// affected constructs Cybered's report didn't name (SHELL_C_RX, STDIN_SHELL_RX's pipe branch), AND a
// live gap in the ALREADY-LANDED round-6 xargs fix (ccc2c742): its filler only accidentally covers
// most backslash positions by consuming them as ordinary filler characters, but misses a backslash
// right before the FINAL letter (`bas\h`, `das\h`) -- by then there is nothing left for the filler to
// consume and too little literal text left for the plain alternation to match.
//
// FIX: one shared SHELL_ALTERNATION (an escape-tolerant version of bash|sh|zsh|dash|ksh, optional
// backslash before every letter) used everywhere the plain list previously was, instead of three
// separately-patched copies.
import { describe, it, expect } from 'vitest'
// @ts-expect-error -- plain .mjs hook script, no types
import { gateDecision } from '../../scripts/self-pace-gate.mjs'

const CT = 'cron' + 'tab'
const bash = (command: string): boolean => Boolean(gateDecision('Bash', { command }).deny)

// Every position a backslash can sit within each of the five shell names, enumerated from the
// grammar (each name's own letters), not copied from the one position Cybered's report demonstrated.
// Up to (not including) the trailing position: a backslash AFTER the whole word (`bash\`) is a
// separate, already-covered case (see the "no false positives" control below) -- bash keeps a
// trailing backslash with nothing after it literal, it does not resolve to the plain name.
function backslashPositions(name: string): string[] {
  const out: string[] = []
  for (let i = 0; i < name.length; i += 1) {
    out.push(name.slice(0, i) + '\\' + name.slice(i))
  }
  return out
}
const SHELLS = ['bash', 'sh', 'zsh', 'dash', 'ksh']
const ALL_VARIANTS = SHELLS.flatMap((s) => backslashPositions(s).map((v): [string, string] => [s, v]))

describe('shell-name embedded-backslash: must deny on every construct (card 14b573f3 fix accumulator)', () => {
  describe.each(ALL_VARIANTS)('%s -> %s', (_shell, variant) => {
    it('SHELL_C_RX', () => {
      expect(bash(`${variant} -c "${CT} -r"`)).toBe(true)
    })
    it('HERESTRING_RX', () => {
      expect(bash(`${variant} <<< "${CT} -"`)).toBe(true)
    })
    it('PROC_SUB_SHELL', () => {
      expect(bash(`${variant} <(echo "${CT} -")`)).toBe(true)
    })
    it('STDIN_SHELL_RX pipe branch', () => {
      expect(bash(`echo "${CT} -" | ${variant}`)).toBe(true)
    })
    it('STDIN_SHELL_RX xargs branch', () => {
      expect(bash(`echo "${CT} -" | xargs ${variant} -c "id"`)).toBe(true)
    })
  })

  // Multiple backslashes in the same word (bash resolves this too -- verified: `\b\a\s\h` -> bash).
  it('multiple backslashes in one word, SHELL_C_RX', () => {
    expect(bash(`\\b\\a\\s\\h -c "${CT} -r"`)).toBe(true)
  })
  it('multiple backslashes in one word, HERESTRING_RX', () => {
    expect(bash(`\\d\\a\\s\\h <<< "${CT} -"`)).toBe(true)
  })
})

describe('shell-name embedded-backslash: no false positives (control)', () => {
  const MUST_ALLOW: Array<[string, string]> = [
    ['unrelated word containing the same letters, not a shell invocation', 'echo "the ash bin has a stash"'],
    ['a real path/binary that is not a shell', '/usr/bin/basher -c "echo hi"'],
    ['trailing backslash at end of word (bash keeps this literal, does not resolve)', 'bash\\ -c "echo hi"'],
  ]
  it.each(MUST_ALLOW)('%s', (_name, cmd) => {
    expect(bash(cmd)).toBe(false)
  })
})

describe('shell-name embedded-backslash: prior rounds still correct (regression check)', () => {
  it('plain unmodified shell names still denied on all five constructs', () => {
    for (const s of SHELLS) {
      expect(bash(`${s} -c "${CT} -r"`)).toBe(true)
      expect(bash(`${s} <<< "${CT} -"`)).toBe(true)
      expect(bash(`${s} <(echo "${CT} -")`)).toBe(true)
      expect(bash(`echo "${CT} -" | ${s}`)).toBe(true)
      expect(bash(`echo "${CT} -" | xargs ${s} -c "id"`)).toBe(true)
    }
  })
  it('path-prefixed shell name still denied (SHELL_C_RX)', () => {
    expect(bash(`/usr/bin/bash -c "${CT} -r"`)).toBe(true)
  })
  it('escaped pipe inside a real path prefix still denied (card 39cc3460 regression check)', () => {
    expect(bash(`/usr/lo\\|cal/bin/bash -c "${CT} -r"`)).toBe(true)
  })
})
