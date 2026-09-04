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
import { resolveDashboardOrigin } from '../web/agent-scaffold.js'

const SRC = readFileSync(
  join(import.meta.dirname, '..', 'web', 'agent-process.ts'), 'utf-8')

describe('agent launch command: vault keys are shell-escaped (card 1075d0e4)', () => {
  // The exact shape of the defect. Any secret-bearing env export that interpolates through double
  // quotes is the bug, whatever the variable is called.
  // SHAPE, not a name list. The first version of this test named two variables and matched only the
  // double-quoted form -- so it pinned the three instances just fixed and was blind to a fourth,
  // three lines above, where ANTHROPIC_BASE_URL took OLLAMA_URL as a BARE `${...}` (Cybersec NO-GO on
  // aa8d7f7d). A guard written from the instances you just fixed describes your diff, not the class.
  it('no ANTHROPIC_* export interpolates a value without shSingleQuote', () => {
    const UNESCAPED = /ANTHROPIC_\w+=(?:"\$\{|\$\{(?!shSingleQuote\())/
    const offenders = SRC.split('\n')
      .map((line, i) => [i + 1, line] as const)
      .filter(([, line]) => UNESCAPED.test(line))
    expect(
      offenders.map(([n, l]) => `${n}: ${l.trim()}`),
      'an ANTHROPIC_* export reaches the launch command line with an unescaped interpolation. That ' +
        'command runs at tmux launch, BEFORE the hook layer exists, so no PreToolUse guard can see ' +
        'it. Wrap the value in shSingleQuote(...), as the model name already is.',
    ).toEqual([])
  })

  // The instance the narrow guard missed, named explicitly so a future edit cannot quietly drop it
  // back to a bare interpolation. OLLAMA_URL is cfg()-sourced, i.e. the same operator-settable input
  // class as the vault keys -- it is not a constant.
  it('the ollama BASE_URL is escaped too, not just the keys', () => {
    expect(SRC).toContain('ANTHROPIC_BASE_URL=${shSingleQuote(OLLAMA_URL)}')
    expect(SRC).not.toContain('ANTHROPIC_BASE_URL=${OLLAMA_URL}')
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

  // Card 1075d0e4 second round, MikroB's third item: DASHBOARD_PUBLIC_URL is a config string with no
  // validation that lands in the curl recipes written into every agent's CLAUDE.md. One step longer
  // than the launch path -- an agent must run the snippet -- but they run these by design.
  it('resolveDashboardOrigin refuses anything that is not a plain http(s) origin', () => {
    // The shape that would smuggle shell into a documented recipe.
    expect(resolveDashboardOrigin('http://x;touch /tmp/pwned;#', 3420)).toBe('http://localhost:3420')
    expect(resolveDashboardOrigin('http://h$(id)', 3420)).toBe('http://localhost:3420')
    expect(resolveDashboardOrigin('http://h`id`', 3420)).toBe('http://localhost:3420')
    // ...while the legitimate values still pass through untouched.
    expect(resolveDashboardOrigin('https://dash.example.com', 3420)).toBe('https://dash.example.com')
    expect(resolveDashboardOrigin('http://10.0.0.5:8080/', 3420)).toBe('http://10.0.0.5:8080')
    expect(resolveDashboardOrigin('', 3420)).toBe('http://localhost:3420')
  })

  it("a value containing a single quote cannot break out either", () => {
    const quoted = shSingleQuote("a'b")
    expect(quoted).toBe("'a'\\''b'")
  })
})
