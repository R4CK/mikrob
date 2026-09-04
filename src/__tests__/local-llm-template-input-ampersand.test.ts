// `&` in a --task input must survive the {{INPUT}} substitution (card a3b4e0f4).
//
// THE DEFECT, measured on bash 5.3.9 while testing this card's new template. store/local-llm.sh
// splices the caller's text into a template with `${USER_TPL//\{\{INPUT\}\}/$PROMPT}`, and bash
// treats a bare `&` in the REPLACEMENT half of ${var//pat/rep} as "the text the pattern matched".
// So an input containing `cd X && grep foo` reached the model as
//   cd X {{INPUT}}{{INPUT}} grep foo
// -- the caller's own command rewritten into the placeholder's name, silently, with no error on any
// path. It hits EVERY --task template, because that line is the single substitution site for all of
// them, and it bites hardest on exactly the inputs that carry shell commands: this card's
// corpus-driven-test-cases (whose whole input is a command corpus), shell-script, commit-msg,
// bugfix-draft, log-summary.
//
// WHY THIS TEST EXECUTES BASH INSTEAD OF GREPPING THE SOURCE. The bug is a bash SEMANTIC, not a
// spelling, so a test asserting the file contains `//&/\\&` would pass on any string that looks
// right and prove nothing about what bash does with it. This one lifts the real line out of the
// shipped script and runs it, so it fails if the escape is dropped -- and would have failed before
// the fix.
import { describe, it, expect } from 'vitest'
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { STORE_DIR } from '../config.js'

const SCRIPT = join(STORE_DIR, 'local-llm.sh')

/**
 * The lines in local-llm.sh that splice the caller's text into a --task template: the escaping step
 * and the substitution itself. Lifted from the shipped file rather than restated here, so this test
 * measures what actually runs. A rename fails loudly instead of silently testing nothing.
 */
function substitutionLines(): string[] {
  const lines = readFileSync(SCRIPT, 'utf8')
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.startsWith('ESCAPED_INPUT=') || l.startsWith('PROMPT="${USER_TPL//'))
  expect(
    lines.some((l) => l.startsWith('PROMPT="${USER_TPL//')),
    'could not find the {{INPUT}} substitution line in store/local-llm.sh',
  ).toBe(true)
  return lines
}

/** Run the shipped substitution against one input and return what the model would receive. */
function spliceThroughShippedLine(input: string): string {
  const script = [
    'USER_TPL="Task: {{INPUT}} end"',
    'PROMPT="$1"',
    ...substitutionLines(),
    'printf %s "$PROMPT"',
  ].join('\n')
  return execFileSync('bash', ['-c', script, 'bash', input], { encoding: 'utf8' })
}

describe('{{INPUT}} substitution preserves ampersands (card a3b4e0f4)', () => {
  it('a chained shell command survives verbatim', () => {
    const input = 'cd X && grep -rn foo'
    const out = spliceThroughShippedLine(input)
    expect(out).toBe(`Task: ${input} end`)
    // The exact corruption that shipped: `&&` became the placeholder's own name, twice.
    expect(out).not.toContain('{{INPUT}}')
  })

  it('a single `&`, a background `&` and a sed backreference all pass through', () => {
    for (const input of ['a & b', "sed 's/x/&/'", 'run &', '&&&', 'a&&b&&c']) {
      expect(spliceThroughShippedLine(input), `input: ${input}`).toBe(`Task: ${input} end`)
    }
  })

  it('input without an ampersand is unchanged -- the fix adds no new behaviour', () => {
    const input = 'grep -rn foo /abs/dir'
    expect(spliceThroughShippedLine(input)).toBe(`Task: ${input} end`)
  })

  it('a literal backslash next to an ampersand is not swallowed', () => {
    // `\&` in the input must stay `\&`: the escape the fix adds must not eat a user backslash.
    const input = String.raw`printf '%s' '\&' && echo done`
    expect(spliceThroughShippedLine(input)).toBe(`Task: ${input} end`)
  })
})
