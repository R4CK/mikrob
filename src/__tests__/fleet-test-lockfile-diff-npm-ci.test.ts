// fleet-test.sh must stop silently symlinking $ROOT/node_modules into the landing worktree when
// the worktree's package-lock.json has DIVERGED from $ROOT's (card 466decff, source: 2f05b3e3's
// landing attempt). The symlink is a correctness shortcut that only holds when the two lockfiles
// agree -- a dependency-bump branch (e.g. vitest 2.1.9 -> 5.0.3) changes the worktree's lockfile
// while $ROOT (the live install, shared by every concurrently-running agent) is still on the OLD
// one until someone separately updates it. Measured: the suite's own run banner printed
// "RUN v2.1.9" while the merge result's package.json asked for vitest ^5.0.3 -- the symlink made
// the landing test the WRONG packages with zero indication anything was off.
//
// $ROOT/node_modules must never be written to from fleet-test.sh (that is the live install); the
// fix is a real `npm ci` INSIDE the worktree, and only when the lockfiles disagree -- the cheap
// symlink stays the default for the common (no dependency change) case.
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const SCRIPT = join(ROOT, 'store', 'fleet-test.sh')
const LOCK_DIFF_CHECK = 'cmp -s "$TEST_TREE/package-lock.json" "$ROOT/package-lock.json"'
const NPM_CI_CMD = 'npm --prefix "$TEST_TREE" ci --include=dev'
const SYMLINK_CMD = 'ln -s "$ROOT/node_modules" "$TEST_TREE/node_modules"'

function problems(text: string): string[] {
  const found: string[] = []

  const diffAt = text.indexOf(LOCK_DIFF_CHECK)
  const ciAt = text.indexOf(NPM_CI_CMD)
  const symlinkAt = text.indexOf(SYMLINK_CMD)
  const nativeCheckAt = text.indexOf("new (require('better-sqlite3'))(':memory:')")

  if (diffAt < 0) found.push('no lockfile-diff check between $TEST_TREE and $ROOT found -- the symlink would be used unconditionally again')
  if (ciAt < 0) found.push('no `npm ci` targeting $TEST_TREE found -- a lockfile divergence has no real-install fallback')
  if (symlinkAt < 0) found.push('the plain-symlink fallback for the matching-lockfile case is gone')

  // The npm ci branch must be gated BEHIND the diff check, and the symlink must still exist as the
  // other branch of the same conditional -- not deleted outright (that would break the common case).
  if (diffAt >= 0 && ciAt >= 0 && ciAt < diffAt) {
    found.push('npm ci runs before the lockfile-diff check -- it would run unconditionally')
  }
  if (diffAt >= 0 && symlinkAt >= 0 && symlinkAt < diffAt) {
    found.push('the symlink appears before the lockfile-diff check -- it is not actually conditioned on the diff')
  }

  // $ROOT/node_modules must never appear as a write target anywhere in the file.
  const rootNodeModulesWrites = [
    `rm -rf "$ROOT/node_modules"`,
    `rm -f "$ROOT/node_modules"`,
    `npm --prefix "$ROOT"`,
    `npm ci --prefix "$ROOT"`,
  ]
  for (const needle of rootNodeModulesWrites) {
    if (text.includes(needle)) found.push(`found a write targeting $ROOT/node_modules: ${needle}`)
  }

  // Ordering sanity against an existing, unrelated anchor: the native-binding check (which already
  // must run on a REAL node_modules, symlinked or not) still has to come after this whole block.
  if (ciAt >= 0 && nativeCheckAt >= 0 && nativeCheckAt < ciAt) {
    found.push('the native-binding health check runs before the npm-ci branch -- it would check a stale/missing node_modules')
  }

  return found
}

describe('fleet-test.sh runs a real npm ci in the worktree when the lockfile diverges from $ROOT, instead of symlinking (card 466decff)', () => {
  const text = readFileSync(SCRIPT, 'utf-8')

  it('has the lockfile-diff check gating a real npm-ci branch, with the symlink kept as the matching-lockfile fallback', () => {
    expect(problems(text)).toEqual([])
  })

  it('never writes to $ROOT/node_modules directly', () => {
    expect(text).not.toMatch(/\brm\s+-r?f\s+"\$ROOT\/node_modules"/)
    expect(text).not.toMatch(/npm\s+(--prefix\s+"\$ROOT"|ci\s+--prefix\s+"\$ROOT")/)
  })

  it('MUTATION-PROOF: dropping the lockfile-diff check (always-symlink again) is caught', () => {
    const alwaysSymlink = text.replace(
      /if ! cmp -s "\$TEST_TREE\/package-lock\.json" "\$ROOT\/package-lock\.json"[\s\S]*?\n(?=# Belt and braces)/,
      `if [ ! -e "$TEST_TREE/node_modules" ]; then\n  ln -s "$ROOT/node_modules" "$TEST_TREE/node_modules" 2>/dev/null \\\\\n    || die 3 "could not link node_modules into $TEST_TREE"\nfi\n\n`,
    )
    expect(alwaysSymlink, 'the mutation did not apply').not.toBe(text)
    expect(problems(alwaysSymlink)).toContain('no lockfile-diff check between $TEST_TREE and $ROOT found -- the symlink would be used unconditionally again')
  })

  it('MUTATION-PROOF: removing the npm-ci fallback entirely (leaving only the diff check) is caught', () => {
    const noCiBranch = text.replace(NPM_CI_CMD, 'true # npm ci removed')
    expect(noCiBranch, 'the mutation did not apply').not.toBe(text)
    expect(problems(noCiBranch)).toContain('no `npm ci` targeting $TEST_TREE found -- a lockfile divergence has no real-install fallback')
  })

  it('MUTATION-PROOF: npm ci silently targeting $ROOT instead of $TEST_TREE is caught', () => {
    const wrongTarget = text.replace(NPM_CI_CMD, 'npm --prefix "$ROOT" ci --include=dev')
    expect(wrongTarget, 'the mutation did not apply').not.toBe(text)
    expect(problems(wrongTarget)).toContain('found a write targeting $ROOT/node_modules: npm --prefix "$ROOT"')
  })
})
