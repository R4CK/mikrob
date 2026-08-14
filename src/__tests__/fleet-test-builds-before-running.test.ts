// fleet-test.sh must BUILD the tree it just synced, before it runs anything (card c32577e4).
//
// THE FAILURE THIS PINS WAS MEASURED, not imagined. Nine suites in this repo load dist/ rather than
// src/. dist/ is gitignored, so fleet-test.sh's `git reset --hard` never touches it and its
// `git clean -fd` never removes it: the artifact is whatever an earlier run left behind, from some
// other commit, with nothing recording which. Running
//     store/fleet-test.sh --ref ccb86e6 src/__tests__/local-llm-rag-routes-by-default.test.ts
// (ccb86e6 = the commit BEFORE the router's SEC-tag feature) synced a source containing zero
// occurrences of SECURITY_TAGS while dist/local-llm-router.js still held two, and reported five
// failures that described neither commit. A verdict about a commit that was never tested is worse
// than no verdict.
//
// WHY THIS TEST IS STRUCTURAL. Exercising the real script would mean creating a git worktree of this
// repo and running tsc -- seconds of work and a mutation of shared state, inside a suite that must
// stay cheap and side-effect free. What actually needs protecting is an ORDER and a FATALITY: build
// after the sync, before the run, and refuse to continue if the build fails. Those are properties of
// the script's text, and the control below keeps the reading honest.
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const SCRIPT = join(ROOT, 'store', 'fleet-test.sh')

/** Returns the problems found, so the same reading can be pointed at a deliberately broken copy. */
function problems(text: string): string[] {
  const found: string[] = []
  const at = (needle: string | RegExp) =>
    typeof needle === 'string' ? text.indexOf(needle) : (text.match(needle)?.index ?? -1)

  const build = at('npx tsc')
  const vitest = at('npx vitest')
  // The reset is what makes the source equal to TARGET; building before it would compile the
  // PREVIOUS ref's source and hand back an artifact that matches nothing.
  const reset = at('reset --hard')

  if (build < 0) found.push('no build step at all')
  if (vitest < 0) found.push('no vitest invocation (this test is looking at the wrong file)')
  if (build >= 0 && vitest >= 0 && build > vitest) found.push('the build runs AFTER the suite')
  if (build >= 0 && reset >= 0 && build < reset) found.push('the build runs BEFORE the source sync')

  // A build that fails and lets the run continue puts us back in the measured case above: the suite
  // proceeds against the previous commit's dist/.
  if (!/npx tsc[^\n]*\|\|\s*die\b/.test(text)) found.push('a failing build is not fatal')

  // The marker is the whole reason a repeat run can skip the build, so it has to be written only on
  // success and cleared first -- otherwise an interrupted build leaves a claim that dist is current.
  const clear = at(/rm -f "?\$?\{?BUILT_MARKER/)
  const write = at(/echo "\$TARGET" > "?\$?\{?BUILT_MARKER/)
  if (clear < 0) found.push('the build marker is not cleared before building')
  if (write < 0) found.push('the build marker is never written')
  if (clear >= 0 && build >= 0 && clear > build) found.push('the marker is cleared after the build')
  if (write >= 0 && build >= 0 && write < build) found.push('the marker is written before the build')

  return found
}

describe('fleet-test.sh builds the synced tree before testing it (card c32577e4)', () => {
  const text = readFileSync(SCRIPT, 'utf-8')

  it('builds after the sync, before the suite, and dies if the build fails', () => {
    expect(problems(text)).toEqual([])
  })

  it('CONTROL: the same reading REJECTS the script as it was before this card', () => {
    // Without this, "no problems found" and "the checks cannot detect anything" are the same result.
    // The mutation is the actual pre-fix state: the build block simply was not there.
    const preFix = text.replace(/\nBUILT_MARKER=[\s\S]*?\nfi\n/, '\n')
    expect(preFix, 'the mutation did not apply -- the block was not found').not.toContain('npx tsc')
    expect(problems(preFix)).toContain('no build step at all')
    expect(problems(preFix)).toContain('a failing build is not fatal')
  })

  it('CONTROL: an out-of-order build is caught, not just a missing one', () => {
    // Ordering is the half a "does it mention tsc" check would miss: a build placed after the run,
    // or before the reset, compiles the wrong thing and still contains every string above.
    const reordered = text.replace('npx tsc ||', 'true ||').replace('npx vitest run', 'npx tsc\nnpx vitest run')
    expect(problems(reordered)).toContain('a failing build is not fatal')
  })
})
