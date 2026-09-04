// Card 1075d0e4 (Cybered, found on the e80c011a gate): the vault-sourced API keys were interpolated
// into the agent launch command inside DOUBLE quotes, where `"` and `$(...)` still expand -- while
// the model name RIGHT NEXT TO THEM was already escaped with shSingleQuote. A vault value shaped
// `x";<command>;#` therefore ran as the fleet user at tmux launch, BEFORE the hook layer exists, so
// no PreToolUse guard could ever see it.
//
// WHY THIS IS A SOURCE-SHAPE TEST AND NOT ONLY A BEHAVIOUR ONE. The launch string is assembled from
// a dozen fragments and only executed inside a real tmux session, so there is no cheap seam to drive
// end-to-end. What CAN be pinned cheaply is the property that made it a vulnerability: a key must
// never reach the command line through `"${...}"`. That is also the shape a refactor silently
// reintroduces -- and one was in flight when this was written (4539b232 moved these exact lines into
// resolveProviderEnv and carried the raw interpolation along verbatim), which is the whole reason
// this file exists rather than a comment.
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { shSingleQuote } from '../web/agent-process.js'

const SRC = readFileSync(
  join(import.meta.dirname, '..', 'web', 'agent-process.ts'), 'utf-8')

describe('agent launch command: vault keys are shell-escaped (card 1075d0e4)', () => {
  // The exact shape of the defect. Any secret-bearing env export that interpolates through double
  // quotes is the bug, whatever the variable is called.
  it('no ANTHROPIC_* key is interpolated through double quotes', () => {
    const offenders = SRC.split('\n')
      .map((line, i) => [i + 1, line] as const)
      .filter(([, line]) => /(?:ANTHROPIC_AUTH_TOKEN|ANTHROPIC_API_KEY)="\$\{/.test(line))
    expect(
      offenders.map(([n, l]) => `${n}: ${l.trim()}`),
      'a vault key reaches the launch command line unescaped -- `x";<cmd>;#` would run at tmux ' +
        'launch, before any hook exists. Use shSingleQuote(...) as the model name already does.',
    ).toEqual([])
  })

  it('the key exports actually go through shSingleQuote', () => {
    const quoted = SRC.match(/(?:ANTHROPIC_AUTH_TOKEN|ANTHROPIC_API_KEY)=\$\{shSingleQuote\(/g) ?? []
    // Three call sites: deepseek, openrouter, and the per-agent ANTHROPIC_API_KEY.
    expect(quoted.length, 'expected all three key exports to be escaped').toBeGreaterThanOrEqual(3)
  })

  // The escaper itself, against the payload from the finding. If this ever stops holding, the
  // source-shape test above would still pass while the protection was gone.
  it('shSingleQuote neutralises the reported payload and preserves the value', () => {
    const payload = 'x";touch /tmp/pwned;#'
    const quoted = shSingleQuote(payload)
    expect(quoted.startsWith("'") && quoted.endsWith("'"), 'must be single-quoted').toBe(true)
    // Nothing inside a single-quoted span can start a command: no unescaped quote may appear.
    const inner = quoted.slice(1, -1)
    expect(inner.includes("'") && !inner.includes("'\\''"), 'a bare quote would end the span').toBe(false)
  })

  it("a value containing a single quote cannot break out either", () => {
    const quoted = shSingleQuote("a'b")
    expect(quoted).toBe("'a'\\''b'")
  })
})
