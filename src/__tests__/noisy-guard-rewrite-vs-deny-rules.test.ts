// Card 214ca312 FINDING 2 (Cybered NO-GO): the open question behind the original engine-level
// probe was never "is sudo npm install denied" (sudo already falls back to block-and-suggest,
// regardless of mode) but "when the hook silently rewrites an ELIGIBLE command under
// NOISY_GUARD_MODE=rewrite, does a start-anchored permission deny rule still see the ORIGINAL
// command text, or only the rewritten one". A probe built on an isolated CLAUDE_CONFIG_DIR +
// a deny rule anchored on the literal text "Bash(npm install:*)" measured the answer directly
// (quoted in full in the DECISIONS.md entry and the card's REVIEW): the model's single Bash tool
// call already carried the REWRITTEN command ("bash .../noisy-run.sh npm install"), and that
// text does not start with "npm install" -- so the deny rule never had a chance to match. A deny
// rule anchored on a noisy program's own name is BYPASSED by a rewrite of that program.
//
// Today's actual deny lists (BASH_EGRESS_DENY, FLEET_BASELINE_DENY) anchor on sudo/wget/nc/ncat/
// telnet/rm/curl/git -- NONE of which NOISY_PATTERNS in noisy-command-guard.py ever matches, so
// there is NO live exposure. This test turns that "no overlap today" fact from an informal claim
// into an enforced invariant: if anyone ever adds a deny rule anchored on one of the noisy
// programs this guard rewrites (npm/pnpm/yarn/npx/go/cargo/python3/pytest/mvn/gradle(w)/tsc/
// webpack/vite/docker/apt(-get)/pip), this test goes red, forcing a conscious decision (keep
// NOISY_GUARD_MODE at the landed default `block`, or scope the new deny rule to not anchor on a
// program name alone) instead of a silent, newly-opened gap.
import { describe, it, expect } from 'vitest'
import { BASH_EGRESS_DENY, FLEET_BASELINE_DENY } from '../web/agent-scaffold.js'

// The first word of every program noisy-command-guard.py's NOISY_PATTERNS matches (kept in sync
// by hand with that file's own list -- there is no shared source between the TS and Python
// sides, so a future addition there needs the same addition here).
const NOISY_PROGRAM_NAMES = [
  'npm', 'pnpm', 'yarn', 'npx', 'go', 'cargo', 'python3', 'python', 'pytest',
  'mvn', 'gradle', 'gradlew', './gradlew', 'tsc', 'webpack', 'vite', 'docker',
  'docker-compose', 'apt', 'apt-get', 'pip', 'pip3',
]

function denyAnchorsOnNoisyProgram(rule: string): string | null {
  const body = rule.replace(/^Bash\(/, '').replace(/\)$/, '')
  const firstWord = body.split(/\s/)[0]?.replace(/:\*$/, '')
  if (!firstWord) return null
  return NOISY_PROGRAM_NAMES.includes(firstWord) ? firstWord : null
}

describe('a permission deny rule anchored on a noisy program is bypassed by NOISY_GUARD_MODE=rewrite (card 214ca312 FINDING 2)', () => {
  it('REAL CODE: no rule in BASH_EGRESS_DENY or FLEET_BASELINE_DENY anchors on a program noisy-command-guard.py rewrites', () => {
    const offenders = [...BASH_EGRESS_DENY, ...FLEET_BASELINE_DENY]
      .map((rule) => ({ rule, program: denyAnchorsOnNoisyProgram(rule) }))
      .filter((r) => r.program !== null)
    expect(
      offenders,
      offenders.length
        ? `${offenders.length} deny rule(s) anchor on a program this guard rewrites -- a ` +
          `rewrite would bypass them: ${JSON.stringify(offenders)}. Either keep ` +
          `NOISY_GUARD_MODE at the landed default "block", or make the rule not anchor on the ` +
          'bare program name.'
        : undefined
    ).toEqual([])
  })

  it('MUTATION: a hypothetical Bash(npm install:*) deny rule IS flagged (proves the check fires)', () => {
    const offenders = ['Bash(npm install:*)', 'Bash(sudo:*)']
      .map((rule) => ({ rule, program: denyAnchorsOnNoisyProgram(rule) }))
      .filter((r) => r.program !== null)
    expect(offenders).toEqual([{ rule: 'Bash(npm install:*)', program: 'npm' }])
  })

  it('a non-anchored, mid-command mention of a noisy program is NOT flagged (word-start only)', () => {
    expect(denyAnchorsOnNoisyProgram('Bash(*/npm *)')).toBe(null)
    expect(denyAnchorsOnNoisyProgram('Bash(curl -X POST:*)')).toBe(null)
  })
})
