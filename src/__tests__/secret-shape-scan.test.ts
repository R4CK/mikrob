// store/secret-shape-scan.py is the shape-based pre-filter the repomix pack path runs BEFORE
// handing a tree to repomix (card 2f781b49). It exists because the bundled secretlint covers AWS by
// KEYWORD anchor: an access key ID is never detected in any form, and the secret-key rule ends in
// `\b` while its own 40-char class contains `/`, `+`, `=` -- so a secret ending in one of those
// silently passes. Both measured on the pinned 1.18.0.
//
// These tests RUN the scanner rather than grepping its source. The sibling repomix-wrapper-guard
// test greps on purpose (it would need the pinned binary to do otherwise), but this scanner is
// dependency-free Python, so the stronger test is available and a source grep would be the weaker
// choice -- the fleet has already been bitten by a source assertion that matched the PROSE of a
// comment describing the very bug it was meant to catch (card 5f00664c, QA round 4).
//
// The credential-shaped fixtures are assembled at runtime from fragments: writing a literal
// AKIA-shaped string into this file would (correctly) be refused by scripts/hooks/secret-write-guard.py.
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { REPO_ROOT } from './helpers/repo-location.js'

const SCANNER = join(REPO_ROOT, 'store/secret-shape-scan.py')
const WRAPPER = readFileSync(join(REPO_ROOT, 'store/repomix.sh'), 'utf8')

// Assembled, never literal -- see the header.
const AWS_ID = 'AKIA' + '3QF7TZ2XKLMNVBWD'
const SECRET_39 = 'k7Qm2ZpR4tYs9WxA1nCbE6uH0iJlO3vFgD8sT5r'
const DOC_ID = 'AKIAIOSFODNN7' + 'EXAMPLE'
const DOC_SECRET = 'wJalrXUtnFEMI/K7MDENG/bPxRfiCY' + 'EXAMPLEKEY'

let root: string

/** Run the scanner. Returns its exit code (0 clean, 4 findings) and stderr. */
function scan(dir: string): { code: number; err: string } {
  try {
    execFileSync('python3', [SCANNER, dir], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
    return { code: 0, err: '' }
  } catch (e) {
    const x = e as { status?: number; stderr?: string }
    return { code: x.status ?? -1, err: x.stderr ?? '' }
  }
}

function tree(name: string, files: Record<string, string>): string {
  const dir = join(root, name)
  mkdirSync(dir, { recursive: true })
  for (const [f, content] of Object.entries(files)) writeFileSync(join(dir, f), content)
  return dir
}

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'shape-scan-'))
})
afterAll(() => {
  rmSync(root, { recursive: true, force: true })
})

describe('store/secret-shape-scan.py -- the shapes repomix misses (card 2f781b49)', () => {
  it('catches a bare AWS access key ID, which the preset never detects in ANY form', () => {
    const d = tree('bare-id', { 'a.txt': `aws_access_key_id = ${AWS_ID}\n` })
    const r = scan(d)
    expect(r.code).toBe(4)
    expect(r.err).toContain('AWS access key id')
  })

  it('catches a 40-char secret whatever its LAST character is -- the `\\b` gap', () => {
    // The preset caught the letter/digit endings and missed `/`, `+`, `=`. All five must fail here,
    // otherwise this scanner has reproduced the very bug it exists to cover.
    for (const last of ['A', '9', '/', '+', '=']) {
      const d = tree(`last-${last === '/' ? 'slash' : last === '+' ? 'plus' : last === '=' ? 'eq' : last}`, {
        'a.txt': `aws_secret_access_key = ${SECRET_39}${last}\n`,
      })
      expect(scan(d).code, `secret ending in ${last}`).toBe(4)
    }
  })

  it('does NOT fire on a clean tree (a scanner that flags everything is not a control)', () => {
    const d = tree('clean', { 'a.ts': 'const x = 1 // prose about cleaning schedules\n' })
    expect(scan(d).code).toBe(0)
  })

  it("allows the vendor's DOCUMENTED example values -- by exact value, not by nearby words", () => {
    const d = tree('docs', {
      'a.txt': `aws_access_key_id = ${DOC_ID}\naws_secret_access_key = ${DOC_SECRET}\n`,
    })
    expect(scan(d).code).toBe(0)
  })

  it('is NOT silenced by a placeholder word near the match (the write-guard\'s window is not copied)', () => {
    // scripts/hooks/secret-write-guard.py skips a match when a placeholder appears within +-20
    // chars. Measured: a real-shaped key followed by `// <div>` or `# not an EXAMPLE` is let
    // through there. That is tolerable for our own writes; it is not, on third-party trees.
    for (const [name, line] of [
      ['jsx', `const k = "${AWS_ID}" // <div>\n`],
      ['word', `aws_key = ${AWS_ID}  # not an EXAMPLE\n`],
      ['dots', `aws_key = ${AWS_ID}  # ...\n`],
    ] as const) {
      const d = tree(`near-${name}`, { 'a.tsx': line })
      expect(scan(d).code, name).toBe(4)
    }
  })

  it('never echoes the matched secret into its own refusal message', () => {
    const d = tree('no-echo', { 'a.txt': `aws_access_key_id = ${AWS_ID}\n` })
    const r = scan(d)
    expect(r.code).toBe(4)
    expect(r.err).not.toContain(AWS_ID)
  })
})

describe('the wrapper actually RUNS the scanner (a filter nobody calls is not a filter)', () => {
  it('store/repomix.sh invokes secret-shape-scan.py on the pack path and refuses on failure', () => {
    expect(WRAPPER).toContain('secret-shape-scan.py')
    const call = WRAPPER.slice(WRAPPER.indexOf('secret-shape-scan.py'))
    expect(call).toMatch(/die \d+ "shape-based scan refused/)
  })
})
