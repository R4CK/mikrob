// CYBERED GO 38496 finding F-3 (card 8ab5eef3): the `unset TMUX TMUX_PANE` line added to
// store/fleet-test.sh had no test pinning it -- deleting it would turn nothing red. This runs the
// REAL script prefix (everything up to and including that line, not a hand-written stand-in)
// under bash with TMUX/TMUX_PANE pre-set, and asserts they are gone from the resulting environment.
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { execFileSync } from 'node:child_process'

const PROJECT_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const SCRIPT = join(PROJECT_ROOT, 'store', 'fleet-test.sh')
const UNSET_LINE = 'unset TMUX TMUX_PANE'

function prefixThroughUnset(scriptText: string): string {
  const idx = scriptText.indexOf(UNSET_LINE)
  if (idx < 0) throw new Error(`could not find "${UNSET_LINE}" in fleet-test.sh`)
  return scriptText.slice(0, idx + UNSET_LINE.length)
}

function runPrefix(script: string): string {
  return execFileSync('bash', ['-c', `${script}\nenv`], {
    encoding: 'utf-8',
    env: { ...process.env, TMUX: '/tmp/decoy-sock,12345,0', TMUX_PANE: '%3', FLEET_TEST_TREE: '/tmp/irrelevant-8ab5eef3' },
  })
}

describe('fleet-test.sh clears $TMUX/$TMUX_PANE before anything else runs (card 8ab5eef3, CYBERED F-3)', () => {
  const scriptText = readFileSync(SCRIPT, 'utf-8')
  const prefix = prefixThroughUnset(scriptText)

  it('REAL CODE: TMUX and TMUX_PANE are gone from the environment after this prefix runs', () => {
    const env = runPrefix(prefix)
    expect(env).not.toMatch(/^TMUX=/m)
    expect(env).not.toMatch(/^TMUX_PANE=/m)
  })

  it('MUTATION: removing the unset line leaves TMUX/TMUX_PANE set (proves the test catches the regression)', () => {
    const mutated = prefix.replace(UNSET_LINE, '')
    expect(mutated, 'the mutation did not apply').not.toBe(prefix)
    const env = runPrefix(mutated)
    expect(env).toMatch(/^TMUX=/m)
    expect(env).toMatch(/^TMUX_PANE=/m)
  })
})
