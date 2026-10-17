// Card 9906af70 (WhiteHat2 N1 follow-up on 5d9eeaf8, Gate-SHA dcb36eb3, comment 20943):
// scripts/migrate.sh, ported from upstream, carried the Bearer token in curl's own argv
// (-H "$AUTH_HEADER" where AUTH_HEADER="Authorization: Bearer $(cat ...)") -- readable by any
// local process via /proc/<pid>/cmdline. token-argv-doc-sweep.test.ts's repo-wide sweep already
// catches this class generically; this is the dedicated pin the card asked for, specifically on
// this file, so a future edit that reintroduces the pattern fails close to the change that did it.
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const SRC = readFileSync(join(import.meta.dirname, '..', '..', 'scripts', 'migrate.sh'), 'utf8')

describe('scripts/migrate.sh: the auth header never reaches curl argv', () => {
  it('builds the header into a 0600 temp file, not a shell variable interpolated into -H', () => {
    expect(SRC).toContain('HDR_FILE="$(mktemp)"; chmod 600 "$HDR_FILE"')
    expect(SRC).toMatch(/printf 'Authorization: Bearer %s\\n' "\$\(cat "\$TOKEN_FILE"\)" > "\$HDR_FILE"/)
  })

  it('both curl calls read the header via -H @"$HDR_FILE", never -H "$AUTH_HEADER"', () => {
    const codeLines = SRC.split('\n').filter((l) => !l.trim().startsWith('#'))
    const curlCalls = codeLines.filter((l) => l.includes('-H @"$HDR_FILE"'))
    expect(curlCalls.length).toBe(2)
    expect(SRC).not.toMatch(/-H "\$AUTH_HEADER"/)
    expect(SRC).not.toContain('AUTH_HEADER=')
  })

  it('the temp header file is cleaned up on exit', () => {
    expect(SRC).toContain("trap 'rm -f \"$HDR_FILE\"' EXIT")
  })

  it('the no-token fallback still sends a header curl accepts (non-empty -H), via the same file', () => {
    expect(SRC).toContain("printf 'X-No-Auth: 1\\n' > \"$HDR_FILE\"")
  })
})
