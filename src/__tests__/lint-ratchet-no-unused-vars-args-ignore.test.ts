// RedHat N1, f3dd0c65 delta-gate (card e94fea8e): commit 7b4e903ec raised the
// @typescript-eslint/no-unused-vars lint-ratchet baseline 185 -> 197, entirely for
// `(..._a: unknown[]) => ...`-style vitest-mock args this codebase already uses as its own
// "ignored on purpose" convention -- a ratchet LOOSENING for a non-issue, not a real regression.
// The fix adds `argsIgnorePattern: '^_'` to the rule in eslint.config.mjs and pulls the baseline
// back to the real measured count (84, well under the pre-regression 185 -- the broader codebase
// had accumulated far more of this convention than the one regression this card targeted).
//
// Two things are pinned, not one: the CONFIG TEXT (so a future edit cannot silently drop the
// option without anyone reading the file), and the ACTUAL ESLINT BEHAVIOUR on a real scratch file
// run through the real, shipped config (guards-that-pin-behaviour point 1 -- ask the tool for the
// resolved value, do not just reason from the text). The behavioural checks also double as the
// "a NEW non-underscore unused var must still turn the ratchet red" acceptance criterion: they
// prove the mutation this card's Kész-ha asks for, without running the full lint-ratchet.sh pass
// (which lints the whole repo and would make this test needlessly slow and also dependent on the
// repo's live total finding count rather than the one rule under test).
import { describe, it, expect } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..')

function code(text: string): string {
  return text
    .split('\n')
    .filter((l) => !/^\s*\/\//.test(l))
    .join('\n')
}

describe('eslint.config.mjs: no-unused-vars carries argsIgnorePattern (card e94fea8e)', () => {
  it('the rule assignment line itself carries the option, not just a nearby comment', () => {
    const text = readFileSync(join(ROOT, 'eslint.config.mjs'), 'utf-8')
    const assignmentLines = code(text)
      .split('\n')
      .filter((l) => /'@typescript-eslint\/no-unused-vars':/.test(l))
    expect(assignmentLines).toHaveLength(1)
    expect(assignmentLines[0]).toMatch(/argsIgnorePattern:\s*'\^_'/)
  })
})

describe('eslint behaviourally honours argsIgnorePattern on a real scratch file (card e94fea8e)', () => {
  function lintScratch(body: string): { ruleIds: string[] } {
    const dir = mkdtempSync(join(ROOT, 'src', '__tests__', 'lint-ratchet-scratch-'))
    try {
      const file = join(dir, 'probe.ts')
      writeFileSync(file, body)
      let out = ''
      try {
        out = execFileSync('npx', ['eslint', '--format', 'json', file], { cwd: ROOT, encoding: 'utf-8' })
      } catch (e: any) {
        // ESLint exits 1 when it finds lint errors -- that is the expected/measured outcome for
        // the non-underscore case below, not a test infra failure.
        out = String(e.stdout ?? '')
      }
      const report = JSON.parse(out) as Array<{ messages: Array<{ ruleId: string | null }> }>
      const ruleIds = (report[0]?.messages ?? []).map((m) => m.ruleId).filter((r): r is string => !!r)
      return { ruleIds }
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  }

  it('an underscore-prefixed unused function arg is NOT flagged', () => {
    const { ruleIds } = lintScratch(
      'export function probe(_unusedArg: string): number {\n  return 1\n}\n',
    )
    expect(ruleIds).not.toContain('@typescript-eslint/no-unused-vars')
  })

  // CONTROL (the card's own mutation acceptance criterion): a NEW, non-underscore unused
  // variable must still turn the ratchet red -- argsIgnorePattern narrows the exemption to names
  // starting with `_`, it does not disable the rule.
  it('CONTROL: a new, non-underscore-prefixed unused variable is STILL flagged', () => {
    const { ruleIds } = lintScratch('const mutationCheckUnusedVar = 42\nexport const x = 1\n')
    expect(ruleIds).toContain('@typescript-eslint/no-unused-vars')
  })
}, 30000)
