// Card 0ca2322b (c5f98f82 follow-up). The regex-based static detector in
// fleet-test-no-test-tree-reassignment-after-guard.test.ts only recognizes a literal
// `TEST_TREE=` substring, so it is blind to any write form that reaches the same variable
// without spelling that substring: `: "${TEST_TREE:=...}"`, `TEST_TREE[0]=`, `TEST_TREE+=`,
// `mapfile`/`readarray TEST_TREE`, a `for`/`select TEST_TREE in ...` loop variable, `printf -v`
// (quoted or glued), `declare -n`/`local -n` indirection, and a backslash-newline split between
// the name and `=`. RedHat's suggestion (comment 32216), which MikroB adopted over patching the
// regex form-by-form (comment 32226): declare `readonly TEST_TREE` right after the guard ends --
// bash then refuses EVERY one of those write forms at runtime, closing the whole class in one
// line instead of enumerating it. These tests run the REAL script text (not a hand-written
// stand-in) through bash itself, so they prove the runtime behavior directly rather than
// pattern-matching source.
import { describe, it, expect } from 'vitest'
import { readFileSync, writeFileSync, rmSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { join, dirname } from 'node:path'
import { tmpdir } from 'node:os'
import { randomUUID } from 'node:crypto'
import { fileURLToPath } from 'node:url'

const PROJECT_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const SCRIPT_PATH = join(PROJECT_ROOT, 'store', 'fleet-test.sh')
const GUARD_END = '# <<< ROOT_GUARD_BLOCK_END'
const READONLY_LINE = 'readonly TEST_TREE'
const CD_ROOT_CALL = 'cd "$ROOT" || die 3 "cannot cd to $ROOT"'

function scriptText(): string {
  return readFileSync(SCRIPT_PATH, 'utf-8')
}

function extractPrefixThrough(text: string, marker: string, afterIndex = 0): string {
  const at = text.indexOf(marker, afterIndex)
  if (at < 0) throw new Error(`could not find marker ${JSON.stringify(marker)}`)
  return text.slice(0, at + marker.length)
}

/** Runs `prefix` followed by `extra` as a real bash script and returns its exit code + output. */
function run(prefix: string, extra: string): { code: number; out: string } {
  const tmp = join(tmpdir(), `fleet-test-readonly-probe-${randomUUID()}.sh`)
  writeFileSync(tmp, `${prefix}\n${extra}\n`)
  try {
    const r = spawnSync('bash', [tmp], { encoding: 'utf-8', timeout: 10_000 })
    return { code: r.status ?? -1, out: `${r.stdout ?? ''}${r.stderr ?? ''}` }
  } finally {
    rmSync(tmp, { force: true })
  }
}

describe('fleet-test.sh: readonly TEST_TREE closes the blind-write-form class (card 0ca2322b)', () => {
  it('REAL CODE: `readonly TEST_TREE` sits between ROOT_GUARD_BLOCK_END and the real cd "$ROOT" call', () => {
    const text = scriptText()
    const guardEndAt = text.indexOf(GUARD_END)
    const readonlyAt = text.indexOf(READONLY_LINE, guardEndAt)
    const cdAt = text.indexOf(CD_ROOT_CALL, guardEndAt)
    expect(guardEndAt).toBeGreaterThan(-1)
    expect(readonlyAt).toBeGreaterThan(guardEndAt)
    expect(cdAt).toBeGreaterThan(readonlyAt)
  })

  // Each of these write forms is exactly one of the blind forms named on the card. Run the REAL
  // script's own prefix up through the readonly declaration, then attempt the form -- bash must
  // refuse every one with a nonzero exit and a "readonly variable" message.
  const BLIND_WRITE_FORMS: Array<[string, string]> = [
    ['array-assign', 'TEST_TREE[0]="/evil"'],
    ['plus-equals', 'TEST_TREE+="/evil"'],
    ['mapfile', 'mapfile -t TEST_TREE < /dev/null'],
    ['readarray', 'readarray TEST_TREE < /dev/null'],
    ['for-loop-var', 'for TEST_TREE in /a /b; do :; done'],
    ['select-loop-var', 'select TEST_TREE in /a /b; do break; done <<< "1"'],
    ['printf-v-quoted', 'printf -v TEST_TREE %s "/evil"'],
    ['printf-v-glued', 'printf -vTEST_TREE %s "/evil"'],
    ['nameref-declare-n', 'declare -n ref=TEST_TREE; ref="/evil"'],
    ['nameref-local-n', 'f() { local -n ref=TEST_TREE; ref="/evil"; }; f'],
    ['line-continuation', 'TEST_TREE\\\n="/evil"'],
  ]

  it.each(BLIND_WRITE_FORMS)('blocks the "%s" write form at runtime', (_label, form) => {
    const prefix = extractPrefixThrough(scriptText(), READONLY_LINE)
    const { code, out } = run(prefix, form)
    expect(code).not.toBe(0)
    expect(out).toContain('readonly variable')
  })

  // The one named form that is NOT an exploit, and is argued rather than pinned as "blocked":
  // `: "${TEST_TREE:=...}"` only assigns when the variable is unset or null. By the time this
  // point in the script runs, TEST_TREE was unconditionally set a few lines above (line 31) to
  // either $FLEET_TEST_TREE or a non-empty default -- so this form is a guaranteed no-op here
  // regardless of readonly, not a bypass of it. Pinned as "exits clean, value unchanged", not
  // "refused", because that is what actually happens and is the stronger, more specific claim.
  it('the assign-default form ("${TEST_TREE:=...}") is a no-op here, not a bypass -- TEST_TREE is never unset/null at this point', () => {
    const prefix = extractPrefixThrough(scriptText(), READONLY_LINE)
    const { code, out } = run(prefix, ': "${TEST_TREE:=/evil}"\necho "TEST_TREE=$TEST_TREE"')
    expect(code).toBe(0)
    expect(out).not.toContain('/evil')
    expect(out).toMatch(/TEST_TREE=\/home\/neon\/marveen-test|TEST_TREE=\S+marveen-test/)
  })

  // AFTER-CD WINDOW (card's own "pin the after-cd window" criterion): the regex detector this
  // card follows up on only ever looked at the gap BEFORE the real `cd "$ROOT"` call -- it says
  // nothing about anything after. This runs the real prefix through the ACTUAL cd call (not a
  // hand-copied stand-in) and then attempts a write -- readonly must still refuse it, because the
  // declaration protects the variable for the rest of the shell's life, not just the pre-cd gap.
  // MUTATION PROOF: if `readonly TEST_TREE` were removed from fleet-test.sh (the after-cd window
  // "emptied" of protection), this write would SUCCEED and this assertion would go red.
  it('MUTATION-PROOF: a write attempted AFTER the real cd "$ROOT" call is still refused (after-cd window)', () => {
    const prefix = extractPrefixThrough(scriptText(), CD_ROOT_CALL)
    const { code, out } = run(prefix, 'TEST_TREE="/evil"')
    expect(code).not.toBe(0)
    expect(out).toContain('readonly variable')
  })

  it('MUTATION: removing the readonly line makes the after-cd write succeed (proves the pin above is non-vacuous)', () => {
    const prefixWithReadonly = extractPrefixThrough(scriptText(), CD_ROOT_CALL)
    const mutated = prefixWithReadonly.replace(`${READONLY_LINE}\n`, '')
    expect(mutated, 'the mutation did not apply').not.toBe(prefixWithReadonly)
    const { code, out } = run(mutated, 'TEST_TREE="/evil"; echo "TEST_TREE=$TEST_TREE"')
    expect(code).toBe(0)
    expect(out).toContain('TEST_TREE=/evil')
  })
})
