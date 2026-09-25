// fleet-test.sh must fail ONCE, loudly, if better-sqlite3's native binding is missing/broken
// instead of letting the whole suite (measured: 786/786 files) fail one-by-one with a cryptic
// "Could not locate the bindings file" error each (card 5b06720f, incident 2026-09-18: a stray
// `pnpm install` in the shared checkout parked the compiled binding under node_modules/.ignored).
//
// CORRECTED per Cybered NO-GO (kanban komment 6091, card 5b06720f): the original check,
// `node -e "require('better-sqlite3')"`, is BLIND to exactly this failure. better-sqlite3
// 11.10.0 loads its native addon LAZILY, inside the Database CONSTRUCTOR (lib/database.js:
// `DEFAULT_ADDON || (DEFAULT_ADDON = require('bindings')('better_sqlite3.node'))`), not at
// require time -- so a bare require() succeeds even with a missing/broken binding. Cybered's own
// mutation proved the OLD structural test could not tell the two forms apart: swapping the check
// to the correct constructor form left the (then-only) text-based test 3/3 green regardless.
//
// The fix is one line (`new (require('better-sqlite3'))(':memory:')`), pinned two ways below:
// (1) the structural/order checks, updated to match the CONSTRUCTOR form specifically, not just
// the `require('better-sqlite3')` substring (which the corrected line still contains, hence the
// prior blind spot); (2) a BEHAVIORAL proof, per Cybered's own suggestion, that require() alone
// does not exercise the binding load while constructing does -- using better-sqlite3's own
// `nativeBinding` override option to force the addon-load branch to fail on a nonexistent path,
// without touching the real installed package (no filesystem mutation, no shared-tree risk).
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { execFileSync } from 'node:child_process'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const SCRIPT = join(ROOT, 'store', 'fleet-test.sh')
const SHIPPED_CHECK = "new (require('better-sqlite3'))(':memory:')"

function problems(text: string): string[] {
  const found: string[] = []

  const cdAt = text.indexOf('cd "$TEST_TREE" || die 3 "cannot cd to $TEST_TREE"')
  const checkAt = text.indexOf(SHIPPED_CHECK)
  const buildAt = text.indexOf('BUILD, because syncing the SOURCE')

  if (cdAt < 0) found.push('this test is looking at the wrong file (no cd into $TEST_TREE found)')
  if (checkAt < 0) found.push('no better-sqlite3 native-binding health check that actually CONSTRUCTS a Database found (a bare require() is blind to a lazily-loaded, missing binding)')
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
    expect(problems(withoutCheck)).toContain('no better-sqlite3 native-binding health check that actually CONSTRUCTS a Database found (a bare require() is blind to a lazily-loaded, missing binding)')
  })

  it('MUTATION-PROOF: swallowing the failure (dropping die) instead of failing loudly is caught', () => {
    const swallowed = text.replace(
      /die 3 "better-sqlite3 native binding missing\/broken[^"]*"/,
      'true',
    )
    expect(swallowed, 'the mutation did not apply').not.toBe(text)
    expect(problems(swallowed)).toContain('the health check does not `die 3` on failure')
  })

  it('MUTATION-PROOF (Cybered NO-GO, komment 6091): reverting to the BLIND require()-only form is caught', () => {
    const blinded = text.replace(SHIPPED_CHECK, "require('better-sqlite3')")
    expect(blinded, 'the mutation did not apply').not.toBe(text)
    expect(problems(blinded)).toContain('no better-sqlite3 native-binding health check that actually CONSTRUCTS a Database found (a bare require() is blind to a lazily-loaded, missing binding)')
  })

  it('BEHAVIORAL (Cybered NO-GO, komment 6091): require() alone does not exercise the native binding load; only constructing does', () => {
    // The real installed package, no filesystem mutation: force the addon-load branch inside
    // the Database constructor to fail via the documented `nativeBinding` override (a path that
    // does not exist), and prove require() succeeding beforehand told us nothing about it.
    const script = [
      "const Database = require('better-sqlite3');",
      'let requireThrew = false;',
      'try { void Database; } catch (e) { requireThrew = true; }',
      'let constructThrew = false;',
      "try { new Database(':memory:', { nativeBinding: '/definitely/does/not/exist/better_sqlite3.node' }); }",
      'catch (e) { constructThrew = true; }',
      'process.stdout.write(JSON.stringify({ requireThrew, constructThrew }));',
    ].join('\n')
    const out = execFileSync(process.execPath, ['-e', script], { cwd: ROOT, encoding: 'utf-8' })
    const result = JSON.parse(out) as { requireThrew: boolean; constructThrew: boolean }
    expect(result.requireThrew, 'require() itself should never throw here -- that is the blind spot').toBe(false)
    expect(result.constructThrew, 'constructing with a broken binding path should throw -- if it does not, this proof no longer holds').toBe(true)
  })

  it('CONTROL: the shipped check form succeeds on a healthy tree (no false positive)', () => {
    expect(() => execFileSync(process.execPath, ['-e', SHIPPED_CHECK], { cwd: ROOT })).not.toThrow()
  })
})
