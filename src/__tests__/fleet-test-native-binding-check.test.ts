// fleet-test.sh must fail ONCE, loudly, if better-sqlite3's native binding is missing/broken
// instead of letting the whole suite (measured: 786/786 files) fail one-by-one with a cryptic
// "Could not locate the bindings file" error each (card 5b06720f, incident 2026-09-18: a stray
// `pnpm install` in the shared checkout parked the compiled binding under node_modules/.ignored).
//
// STRUCTURAL text test, same reasoning as this script's sibling tests (e.g.
// fleet-test-self-heals-stray-live-marker.test.ts): actually reproducing a missing binding needs a
// real, broken node_modules, which a cheap side-effect-free suite must not manufacture. What needs
// protecting is an ORDER (the check runs after `cd "$TEST_TREE"`, so node_modules resolves
// correctly, and BEFORE the build/test run it exists to protect) and a FAILURE MODE (a `die 3`, not
// a swallowed/ignored error) -- properties of the script's text.
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const SCRIPT = join(ROOT, 'store', 'fleet-test.sh')

function problems(text: string): string[] {
  const found: string[] = []

  const cdAt = text.indexOf('cd "$TEST_TREE" || die 3 "cannot cd to $TEST_TREE"')
  const checkAt = text.indexOf("require('better-sqlite3')")
  const buildAt = text.indexOf('BUILD, because syncing the SOURCE')

  if (cdAt < 0) found.push('this test is looking at the wrong file (no cd into $TEST_TREE found)')
  if (checkAt < 0) found.push('no better-sqlite3 native-binding health check found')
  if (buildAt < 0) found.push('this test is looking at the wrong file (no BUILD section found)')

  if (cdAt >= 0 && checkAt >= 0 && checkAt < cdAt) {
    found.push('the health check runs BEFORE cd "$TEST_TREE" -- node would resolve the wrong node_modules')
  }
  if (checkAt >= 0 && buildAt >= 0 && checkAt > buildAt) {
    found.push('the health check runs AFTER the build/test-run section -- too late to fail loudly first')
  }

  if (checkAt >= 0) {
    const nearby = text.slice(checkAt, checkAt + 400)
    if (!/die 3/.test(nearby)) found.push('the health check does not `die 3` on failure')
  }

  return found
}

describe('fleet-test.sh fails loudly on a missing/broken native binding, before the full suite (card 5b06720f)', () => {
  const text = readFileSync(SCRIPT, 'utf-8')

  it('runs the check after cd into $TEST_TREE and before the build, and dies loudly on failure', () => {
    expect(problems(text)).toEqual([])
  })

  it('MUTATION-PROOF: removing the check entirely is caught', () => {
    const withoutCheck = text.replace(
      /\n# Native-binding health check[\s\S]*?fi\n/,
      '\n',
    )
    expect(withoutCheck, 'the mutation did not apply').not.toBe(text)
    expect(problems(withoutCheck)).toContain('no better-sqlite3 native-binding health check found')
  })

  it('MUTATION-PROOF: swallowing the failure (dropping die) instead of failing loudly is caught', () => {
    const swallowed = text.replace(
      /die 3 "better-sqlite3 native binding missing\/broken[^"]*"/,
      'true',
    )
    expect(swallowed, 'the mutation did not apply').not.toBe(text)
    expect(problems(swallowed)).toContain('the health check does not `die 3` on failure')
  })
})
