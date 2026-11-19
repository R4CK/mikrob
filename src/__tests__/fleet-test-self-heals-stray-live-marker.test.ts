// fleet-test.sh must self-heal a stray live-marker left by its OWN prior run, not refuse forever
// (card 5dcde7d3).
//
// THE FAILURE, measured. The three live markers (store/.dashboard-token, store/claudeclaw.db,
// store/.claude-oauth-token) are all gitignored, so the pre-checkout `git clean -fdq` (see
// fleet-test-cleans-before-checkout.test.ts, its sibling for the same branch) never removes them.
// If some test, at any point, opens one of them for real via a path that resolves into the shared
// test tree instead of a temp/override path, the file survives every future run and permanently
// trips the "belt and braces" live-marker check further down the script -- reproduced three times
// in one session (backend2, cards c5baa683/d6aecead/34587175): a single stray store/claudeclaw.db
// refused 553 of 649 files with ZERO test failures, on every subsequent landing attempt, until
// someone noticed and deleted it by hand.
//
// WHY THIS TEST IS STRUCTURAL, not an execution of the real script -- same reasoning as this
// script's other structural tests (fleet-test-cleans-before-checkout.test.ts and siblings):
// reproducing a stray marker needs a real git worktree and a real leaked file, which is exactly the
// scenario a cheap, side-effect-free suite must not manufacture. What actually needs protecting is
// an ORDER (the wipe happens before the belt-and-braces check) and a SAFETY CONDITION (the wipe only
// fires when the tree is provably a linked worktree, never the live install) -- properties of the
// script's text.
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const SCRIPT = join(ROOT, 'store', 'fleet-test.sh')

const MARKERS = ['store/.dashboard-token', 'store/claudeclaw.db', 'store/.claude-oauth-token']

/** Only the update branch (the tree already exists) -- a freshly created worktree cannot have a
 *  stray marker from a "prior run" yet. */
function updateBranch(text: string): string {
  const fromCreate = text.indexOf('worktree add')
  if (fromCreate < 0) return ''
  const elseAt = text.indexOf('\nelse\n', fromCreate)
  if (elseAt < 0) return ''
  const fiAt = text.indexOf('\nfi\n', elseAt)
  return fiAt < 0 ? '' : text.slice(elseAt, fiAt)
}

function problems(text: string): string[] {
  const found: string[] = []
  const branch = updateBranch(text)
  if (!branch) return ['this test is looking at the wrong file (no update branch found)']

  const at = (needle: string | RegExp) =>
    typeof needle === 'string' ? branch.indexOf(needle) : (branch.match(needle)?.index ?? -1)

  const guard = at(/if \[ -f "\$TEST_TREE\/\.git" \]; then/)
  const rm = branch.indexOf('rm -f', guard < 0 ? 0 : guard)
  if (guard < 0) found.push('no .git-is-a-file safety guard before wiping markers')
  if (rm < 0 || (guard >= 0 && rm < guard)) found.push('the marker wipe is not gated by the safety guard')

  for (const m of MARKERS) {
    if (rm >= 0 && !branch.slice(rm, rm + 400).includes(m)) found.push(`marker not wiped: ${m}`)
  }

  // Card e5c13c0e: the agents/ wipe shares this SAME guard (one if-block, not a second guard
  // occurrence -- see that card's own comment in fleet-test.sh for why a second occurrence would
  // silently defeat the mutation-proof check above). It must sit between the guard and the guard's
  // own closing `fi`, after the marker wipe.
  const agentsRm = branch.indexOf('rm -rf "$TEST_TREE/agents"', rm < 0 ? 0 : rm)
  const fiAfterRm = branch.indexOf('\n  fi\n', rm < 0 ? 0 : rm)
  if (agentsRm < 0) found.push('agents/ wipe not found')
  if (agentsRm >= 0 && rm >= 0 && agentsRm < rm) found.push('the agents/ wipe runs before the marker wipe (expected after)')
  if (agentsRm >= 0 && fiAfterRm >= 0 && agentsRm > fiAfterRm) found.push('the agents/ wipe sits OUTSIDE the safety-guard if-block')

  // The wipe must precede the belt-and-braces check, which lives OUTSIDE this branch (after the
  // if/else closes), so we check its position in the FULL text instead of the branch slice.
  const wipeInFullText = text.indexOf('rm -f "$TEST_TREE/store/.dashboard-token"')
  const beltAndBraces = text.indexOf('Belt and braces')
  if (wipeInFullText < 0) found.push('this test is looking at the wrong file (no marker wipe found)')
  if (beltAndBraces < 0) found.push('this test is looking at the wrong file (no belt-and-braces check found)')
  if (wipeInFullText >= 0 && beltAndBraces >= 0 && wipeInFullText > beltAndBraces) {
    found.push('the wipe runs AFTER the belt-and-braces check -- too late to help')
  }

  return found
}

describe('fleet-test.sh self-heals a stray live-marker from its own prior run (card 5dcde7d3)', () => {
  const text = readFileSync(SCRIPT, 'utf-8')

  it('wipes all three markers, gated by the .git-is-a-file safety guard, before the belt-and-braces check', () => {
    expect(problems(text)).toEqual([])
  })

  it('MUTATION-PROOF: dropping the safety guard is caught', () => {
    // Card e5c13c0e: the body now also carries the agents/ wipe (comments included) between the
    // marker wipe and the closing `fi` -- [\s\S]*? (not \s*) so the capture spans that content
    // too, stripping the if/fi wrapper around BOTH wipes, not just the marker one.
    const unguarded = text.replace(
      /if \[ -f "\$TEST_TREE\/\.git" \]; then\n([\s\S]*?rm -f "\$TEST_TREE\/store\/\.dashboard-token" "\$TEST_TREE\/store\/claudeclaw\.db" "\$TEST_TREE\/store\/\.claude-oauth-token"\n[\s\S]*?rm -rf "\$TEST_TREE\/agents"\n)\s*fi\n/,
      '$1',
    )
    expect(unguarded, 'the mutation did not apply').not.toBe(text)
    expect(problems(unguarded)).toContain('no .git-is-a-file safety guard before wiping markers')
  })

  it('MUTATION-PROOF (card e5c13c0e): dropping the agents/ wipe is caught', () => {
    const noAgentsWipe = text.replace('    rm -rf "$TEST_TREE/agents"\n', '')
    expect(noAgentsWipe, 'the mutation did not apply').not.toBe(text)
    expect(problems(noAgentsWipe)).toContain('agents/ wipe not found')
  })

  it('MUTATION-PROOF: wiping only one of the three markers is caught, not just "some wipe exists"', () => {
    const partial = text.replace(
      '"$TEST_TREE/store/.dashboard-token" "$TEST_TREE/store/claudeclaw.db" "$TEST_TREE/store/.claude-oauth-token"',
      '"$TEST_TREE/store/claudeclaw.db"',
    )
    expect(partial, 'the mutation did not apply').not.toBe(text)
    const p = problems(partial)
    expect(p).toContain('marker not wiped: store/.dashboard-token')
    expect(p).toContain('marker not wiped: store/.claude-oauth-token')
    expect(p).not.toContain('marker not wiped: store/claudeclaw.db')
  })

  it('CONTROL: the guard structure alone (no wipe at all) is caught, not mistaken for compliance', () => {
    const noWipe = text.replace(
      /\n  if \[ -f "\$TEST_TREE\/\.git" \]; then\n[\s\S]*?rm -f "\$TEST_TREE\/store\/\.dashboard-token" "\$TEST_TREE\/store\/claudeclaw\.db" "\$TEST_TREE\/store\/\.claude-oauth-token"\n[\s\S]*?rm -rf "\$TEST_TREE\/agents"\n\s*fi\n/,
      '\n',
    )
    expect(noWipe, 'the mutation did not apply').not.toBe(text)
    expect(problems(noWipe)).toContain('this test is looking at the wrong file (no marker wipe found)')
  })
})
