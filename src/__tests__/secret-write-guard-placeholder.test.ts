// Card 746ea4e4: the write-guard's placeholder rule let neighbouring text switch the control off.
//
// Cybersec measured it (2f781b49 due diligence): a bare AWS key is BLOCKED, the same key is ALLOWED
// once "EXAMPLE" -- or a `<div>` -- sits within 20 characters, and BLOCKED again at 60. The window
// was the bug. `<[^>]+>` made it worse than a gaming risk: in any TSX or HTML file a tag within 20
// characters of a string literal is ordinary, so a real key could leak by accident.
//
// The class is "the scanned CONTENT disables the control", the same shape as a secret scanner
// honouring an inline disable comment. The fix: only the matched span may prove itself fake.
//
// Both directions are tested here because only the pair means anything -- a guard that blocks
// everything passes the negative controls, and one that blocks nothing passes the positive ones.
//
// NOTE ON THE FIXTURE: the key-shaped string is assembled at runtime rather than written as a
// literal, because the guard under test blocks this very file otherwise. That is not a workaround
// of the control's intent -- no credential exists here, the value is 20 invented characters -- and
// the fact that the literal form IS blocked is itself the behaviour these tests assert.
import { describe, it, expect } from 'vitest'
import { spawnSync } from 'node:child_process'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const HOOK = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  'scripts',
  'hooks',
  'secret-write-guard.py',
)

/** Run the hook exactly as Claude Code does: the tool call on stdin, exit 2 = blocked. */
function writeAttempt(content: string): { blocked: boolean; stderr: string } {
  const payload = JSON.stringify({
    tool_name: 'Write',
    tool_input: { file_path: '/tmp/whatever.ts', content },
  })
  const r = spawnSync('python3', [HOOK], { input: payload, encoding: 'utf-8' })
  return { blocked: r.status === 2, stderr: r.stderr ?? '' }
}

/** AWS-key-SHAPED and not one of the published examples. Split so this file is writable. */
const REAL_LOOKING = 'AK' + 'IA' + '2E4TGHIJKLMNOPQR'
/** AWS's own documentation key, assembled the same way for the same reason. */
const AWS_DOC_EXAMPLE = 'AK' + 'IA' + 'IOSFODNN7EXAMPLE'
/** Key-shaped, but its own characters say placeholder. */
const SELF_EVIDENT = 'AK' + 'IA' + 'XXXXXXXXXXXXXXXX'

describe('secret-write-guard blocks a real-looking key regardless of its neighbours', () => {
  it('blocks the bare key (the control that always worked)', () => {
    const { blocked, stderr } = writeAttempt(`const k = '${REAL_LOOKING}'`)
    expect(blocked).toBe(true)
    expect(stderr).toContain('AWS access key id')
  })

  it.each([
    ['EXAMPLE next to it', `// EXAMPLE\nconst k = '${REAL_LOOKING}'`],
    ['a JSX tag next to it', `<div>{'${REAL_LOOKING}'}</div>`],
    ['an ellipsis next to it', `const k = '${REAL_LOOKING}' // ...`],
    ['YOUR_ next to it', `// YOUR_KEY_HERE\nconst k = '${REAL_LOOKING}'`],
    ['PLACEHOLDER next to it', `const PLACEHOLDER = 1\nconst k = '${REAL_LOOKING}'`],
  ])('still blocks with %s -- neighbours do not vouch', (_label, content) => {
    // Every one of these was ALLOWED before this card.
    expect(writeAttempt(content).blocked).toBe(true)
  })

  it('blocks it inside a realistic TSX line -- how this would have leaked by accident', () => {
    const tsx = `export const Row = () => <span title="key">{'${REAL_LOOKING}'}</span>`
    expect(writeAttempt(tsx).blocked).toBe(true)
  })
})

describe('secret-write-guard still allows values that are provably not credentials', () => {
  it("allows AWS's own published example key", () => {
    expect(writeAttempt(`AWS_ACCESS_KEY_ID=${AWS_DOC_EXAMPLE}`).blocked).toBe(false)
  })

  it('allows a key-shaped string whose OWN characters say placeholder', () => {
    expect(writeAttempt(`AWS_ACCESS_KEY_ID=${SELF_EVIDENT}`).blocked).toBe(false)
  })

  it('allows ordinary content with no secret at all', () => {
    expect(writeAttempt(`const region = 'eu-central-1'\n<div>hello</div>`).blocked).toBe(false)
  })

  it('is not simply failing open -- clean content exits 0, another vendor pattern still exits 2', () => {
    // Without this, every "allows" above would also pass on a hook that crashed or matched nothing.
    expect(writeAttempt('nothing to see').blocked).toBe(false)
    expect(writeAttempt(`sk-` + `ant-${'a'.repeat(30)}`).blocked).toBe(true)
  })
})
