// Regression pin (card ca6d7b9d, WhiteHat2 non-blocking finding on e73b17ef/Gate-SHA 4e5aef10):
// reverting agent-scaffold.ts's buildAgentIdHeaderBody() to the old argv-token curl form left
// 24 related files / 15228 tests green -- nothing pinned the fix itself. token-in-argv-guard.test.ts
// only scans the LIVE, already-rendered agents/*/CLAUDE.md files on disk; it says nothing about the
// GENERATOR that writes them, so a future edit to the generator alone would pass every existing
// test and silently start writing the leak into every agent's CLAUDE.md again on the next scaffold
// sweep.
//
// Card f19cb1e1 (CYBERSEC GO F1 on ca6d7b9d): the original "MUTATION PIN" assertion above used its
// own hand-rolled, case-sensitive regex (kodminosegi 12. elv violation -- a bespoke substring check
// instead of the real detector). Measured live: lowercase `authorization: bearer`, a long
// `--header "Authorization: Bearer ..."` flag, a backslash line-break right after `-H`, and curl's
// own `--oauth2-bearer $(...)` flag all survived it. Replaced with the SAME detector shape
// (findCurlInvocations + leaksTokenInArgv) token-in-argv-guard.test.ts uses for every other script
// in the repo, which this card also hardened there (case-insensitive + --oauth2-bearer, same
// finding). Own copy here, not a cross-test-file import: importing a .test.ts file as a module
// re-registers its describe/it calls in THIS file's run too (measured: 19850 tests became 39701),
// the same "own regex copy, no shared import" convention the email gates already follow.
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

interface CurlInvocation {
  readonly text: string
  readonly startLine: number
}

function splitAtCurl(text: string, startLine: number): CurlInvocation[] {
  const parts = text.split(/(?=\bcurl\b)/)
  return parts.filter((p) => /\bcurl\b/.test(p)).map((p) => ({ text: p, startLine }))
}

function findCurlInvocations(source: string): CurlInvocation[] {
  const lines = source.split('\n')
  const out: CurlInvocation[] = []
  let buf: string[] = []
  let startLine = -1
  let inCurl = false
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? ''
    if (!inCurl && /\bcurl\b/.test(line)) {
      inCurl = true
      startLine = i + 1
      buf = []
    }
    if (inCurl) {
      buf.push(line)
      if (!line.trimEnd().endsWith('\\')) {
        out.push(...splitAtCurl(buf.join('\n'), startLine))
        inCurl = false
      }
    }
  }
  return out
}

function leaksTokenInArgv(invocation: string): boolean {
  const headerBearer = /Authorization:\s*Bearer\s*(\$(\(|\{|[A-Za-z_])|`)/i.test(invocation)
  const oauth2Bearer = /--oauth2-bearer[\s=]+["'`]?(\$(\(|\{|[A-Za-z_])|`)/i.test(invocation)
  if (!headerBearer && !oauth2Bearer) return false
  if (oauth2Bearer) return true
  return !/-H\s+@/.test(invocation)
}

const __dirname = dirname(fileURLToPath(import.meta.url))
const SRC = readFileSync(join(__dirname, '..', 'web', 'agent-scaffold.ts'), 'utf-8')

function extractFn(name: string): string {
  const start = SRC.indexOf(`function ${name}(`)
  if (start < 0) throw new Error(`${name} missing from agent-scaffold.ts`)
  let depth = 0
  let i = SRC.indexOf('{', start)
  for (; i < SRC.length; i++) {
    if (SRC[i] === '{') depth++
    else if (SRC[i] === '}') { depth--; if (depth === 0) break }
  }
  return SRC.slice(start, i + 1)
}

describe('buildAgentIdHeaderBody never puts the token in curl argv', () => {
  const body = extractFn('buildAgentIdHeaderBody')

  it('uses the stdin idiom (agent-auth-header.sh | curl -H @-)', () => {
    // Card 52114c2f: the printf idiom moved INTO store/agent-auth-header.sh itself, so the
    // generated SOURCE (this extracts raw TS source text, not the evaluated string) no longer
    // spells "Authorization: Bearer" at all -- it references the agentAuthHeaderPath constant
    // and pipes the per-agent helper's stdout into curl's @- stdin idiom.
    expect(body).toContain('agentAuthHeaderPath')
    expect(body).toContain('curl -H @-')
  })

  it('MUTATION PIN: the real argv-leak detector finds nothing in the generated block', () => {
    const offenders = findCurlInvocations(body).filter((c) => leaksTokenInArgv(c.text))
    expect(offenders).toEqual([])
  })

  // The detector itself, pinned against the shapes CYBERSEC measured surviving the OLD hand-rolled
  // regex (M1: the original leaked form; M2/M3/M4: evasive variants of the same leak). These do not
  // mutate agent-scaffold.ts -- they prove the shared detector this test now relies on actually
  // catches each shape, independent of today's clean generator state.
  it('MUTATION PIN (detector-level): catches the original leak and every measured evasion', () => {
    const tokenPath = 'store/.dashboard-token'
    const forms = {
      'M1: the original leaked form': `curl -H "Authorization: Bearer $(cat ${tokenPath})" -s "$DASH/api/x"`,
      'M2: long --header flag': `curl --header "Authorization: Bearer $(cat ${tokenPath})" -s "$DASH/api/x"`,
      'M3: lowercase scheme/header name': `curl -s -H "authorization: bearer $(cat ${tokenPath})" "$DASH/api/x"`,
      'M4: backslash line-break right after -H': [
        `curl -s "$DASH/api/x" \\`,
        `  -H \\`,
        `    "Authorization: Bearer $(cat ${tokenPath})"`,
      ].join('\n'),
      'M5: curl --oauth2-bearer (no "Authorization" word at all)':
        `curl -s --oauth2-bearer "$(cat ${tokenPath})" "$DASH/api/x"`,
    }
    for (const [name, script] of Object.entries(forms)) {
      const offenders = findCurlInvocations(script).filter((c) => leaksTokenInArgv(c.text))
      expect(offenders.length, name).toBeGreaterThan(0)
    }
  })
})
