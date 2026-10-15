// Regression pin (card ca6d7b9d, WhiteHat2 non-blocking finding on e73b17ef/Gate-SHA 4e5aef10):
// reverting agent-scaffold.ts's buildAgentIdHeaderBody() to the old argv-token curl form left
// 24 related files / 15228 tests green -- nothing pinned the fix itself. token-in-argv-guard.test.ts
// only scans the LIVE, already-rendered agents/*/CLAUDE.md files on disk; it says nothing about the
// GENERATOR that writes them, so a future edit to the generator alone would pass every existing
// test and silently start writing the leak into every agent's CLAUDE.md again on the next scaffold
// sweep.
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

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

  it('uses the stdin idiom (printf | curl -H @-)', () => {
    expect(body).toContain("printf 'Authorization: Bearer %s")
    expect(body).toContain('curl -H @-')
  })

  it('MUTATION PIN: never declares the token inline on curl -H (the leaked form)', () => {
    // The exact shape that leaked: `-H "Authorization: Bearer $(cat <tokenPath>)"` baked straight
    // into curl's own argv, readable from /proc/<pid>/cmdline. If this re-appears, the mutation
    // this test exists to catch is back.
    expect(body).not.toMatch(/-H\s*["'`]?Authorization:\s*Bearer/)
  })
})
