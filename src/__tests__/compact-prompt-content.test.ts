import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

// The compaction the fleet triggers itself used to send a BARE `/compact` (card fed3f037, part a).
// What survives a compaction was therefore entirely the summariser's choice, and the thing that
// must NOT be paraphrased -- an instruction -- is exactly the thing that cannot be reconstructed
// from the work that followed.
//
// WHY THESE ASSERTIONS RUN ON COMMENT-STRIPPED SOURCE (CLAUDE.md rule 12, cards 06d36307/2f0c7d24),
// and HOW LOAD-BEARING that actually is, measured rather than assumed:
// the comment block above the constant discusses the old bare literal in prose, so the token
// `/compact` DOES appear in a comment. The full call expression asserted below does NOT -- checked
// both ways, raw and stripped, and the absence assertion answers the same on either today. So the
// stripping is not currently what makes that assertion correct, and claiming otherwise would be a
// rationale this file cannot back. It stays because the token is already quoted once: the moment
// anyone asserts on the bare `/compact` token, or quotes the call itself while explaining a later
// change, the raw file starts answering about prose instead of code.
const SRC = join(dirname(fileURLToPath(import.meta.url)), '..', 'web', 'routes', 'agents.ts')
const raw = readFileSync(SRC, 'utf8')
const stripped = raw
  .replace(/\/\*[\s\S]*?\*\//g, ' ')
  .split('\n')
  .map((l) => l.replace(/(^|[^:])\/\/.*$/, '$1'))
  .join('\n')

/** The SHIPPED compactPrompt(), lifted out of the source rather than retyped, so this exercises the
 *  real function body. Retyping it would test a copy and stay green while the shipped one rotted. */
function shippedCompactPrompt(env: string | undefined): string {
  const constMatch = stripped.match(/const COMPACT_INSTRUCTIONS =([\s\S]*?)\n\nfunction compactPrompt/)
  if (!constMatch) throw new Error('COMPACT_INSTRUCTIONS not found in agents.ts')
  const fnMatch = stripped.match(/function compactPrompt\(\): string \{[\s\S]*?\n\}/)
  if (!fnMatch) throw new Error('compactPrompt() not found in agents.ts')
  const js = `const process = { env: ${JSON.stringify({ COMPACT_PROMPT: env })} };
const COMPACT_INSTRUCTIONS =${constMatch[1]}
${fnMatch[0].replace('): string', ')')}
return compactPrompt()`
  return new Function(js)() as string
}

describe('the fleet-triggered /compact says what must not be paraphrased (card fed3f037, part a)', () => {
  it('is still a slash command FIRST -- Claude Code only recognises one as the first thing typed', () => {
    // The route's own comment is explicit that this is why /api/messages cannot carry it. An
    // instruction appended in front would silently turn the command into prose.
    expect(shippedCompactPrompt(undefined).startsWith('/compact ')).toBe(true)
  })

  it('names the categories that must survive VERBATIM', () => {
    const p = shippedCompactPrompt(undefined)
    for (const needle of ['VERBATIM', 'prohibition', 'acceptance criteria', 'NO-GO', 'open questions']) {
      expect(p).toContain(needle)
    }
    // The half that makes it a compaction rather than a refusal to compact.
    expect(p).toMatch(/Summarise freely/i)
  })

  it('keeps the measurement, not the adjective -- this fleet\'s own recurring loss', () => {
    expect(shippedCompactPrompt(undefined)).toMatch(/keep the number, not the adjective/i)
  })

  it('is ONE line: what is written is what reaches the pane', () => {
    // sendPromptToSession collapses newlines to spaces before typing, so a newline would not break
    // delivery -- it would silently change the text from the one reviewed here into another one.
    expect(shippedCompactPrompt(undefined)).not.toMatch(/\r?\n/)
  })

  it('COMPACT_PROMPT=bare restores the old literal exactly (the kill switch)', () => {
    // Code-quality rule 9: a fleet-wide change on a critical path stays revertible without a commit.
    expect(shippedCompactPrompt('bare')).toBe('/compact')
  })

  it('CONTROL: the route sends the BUILT prompt, not a bare literal', () => {
    // Without this the constant could be perfect and unused. Measured on comment-stripped source so
    // the explanatory quotation of the old literal cannot satisfy it.
    expect(stripped).toContain('await sendPromptToSession(session, compactPrompt(), host)')
    expect(stripped).not.toContain("sendPromptToSession(session, '/compact', host)")
  })
})
