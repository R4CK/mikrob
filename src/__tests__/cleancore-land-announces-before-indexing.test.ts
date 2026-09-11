// Card dba14f8e. cleancore-land.sh used to print its LANDED line LAST, after two graph refreshes.
//
// MEASURED, which is why this is a card and not a preference: on CleanCore the graphify build takes
// 23+ minutes on an IDLE machine and ~56 minutes under load. One landing was timed end to end --
// started 06:22, pushed 06:24, returned 07:00: THIRTY-SIX MINUTES of silence after the push had
// already succeeded. (The "~13s" the old comment quoted is the marveen number; it does not carry.)
//
// The silence caused a real error rather than mere impatience: an agent waiting on the script
// concluded the landing had not happened and started a SECOND full landing against an
// already-landed sha, whose typecheck was then killed by the contention the extra run helped make.
//
// TWO PROPERTIES, and the second is the one that actually fixes it. Printing earlier helps only a
// reader that streams; the fleet runs noisy commands through noisy-run.sh, which shows NOTHING
// until the command EXITS. So the script must also return promptly -- which it can only do if the
// backgrounded child does not inherit stdout. A child holding the pipe open keeps every reader
// waiting for EOF no matter how early the line was printed.

import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const SRC = readFileSync(join(__dirname, '..', '..', 'store', 'cleancore-land.sh'), 'utf-8')

/** Comments stripped: a commented-out `&` or a LANDED line in prose must not vouch for the code. */
const CODE = SRC.split('\n')
  .map((l) => l.replace(/#.*$/, ''))
  .join('\n')

/** The script calls it as `"$(dirname "$0")/graphify.sh" build` -- the closing quote sits between
 *  the two words, so the needle has to tolerate it. A plain 'graphify.sh build' matches nothing. */
const graphifyLine = (): string | undefined =>
  CODE.split('\n').find((l) => /graphify\.sh"?\s+build/.test(l))

describe('cleancore-land.sh announces the landing before rebuilding any index (card dba14f8e)', () => {
  it('the scan sees the real script -- otherwise every check below is vacuous', () => {
    expect(CODE).toContain('LANDED')
    expect(CODE).toContain('graphify.sh')
    expect(SRC.length).toBeGreaterThan(5000)
  })

  it('the LANDED line comes BEFORE the graphify build', () => {
    const landed = CODE.indexOf('echo "LANDED')
    const graphify = CODE.indexOf('graphify.sh')
    expect(landed).toBeGreaterThan(-1)
    expect(graphify).toBeGreaterThan(-1)
    expect(
      landed,
      'LANDED must be printed before the graph rebuild, not after it',
    ).toBeLessThan(graphify)
  })

  it('the graphify build runs in the background', () => {
    const line = graphifyLine()
    expect(line, 'no graphify build invocation found').toBeTruthy()
    expect(line!.trimEnd().endsWith('&'), `graphify is not backgrounded: ${line}`).toBe(true)
  })

  // THE LOAD-BEARING ONE. Without the redirect the child inherits stdout, the pipe stays open, and
  // the caller waits exactly as long as before -- the LANDED line simply arrives earlier inside a
  // buffer nobody is reading yet. `&` alone is not the fix.
  it("the backgrounded build does not inherit the caller's stdout", () => {
    const line = graphifyLine()!
    // The needle must require a redirect to a DESTINATION, not merely the character `>`. The first
    // version of this assertion accepted `2>&1` -- which contains a `>` but sends stdout nowhere --
    // and a mutant that dropped the file redirect kept the suite green. Caught by mutation, not by
    // reading it. So: a `>` that is not an fd-dup (`2>&1`) and not followed by `&`.
    expect(
      /(&>|(^|[^0-9&])>)\s*[^&\s]/.test(line),
      `graphify must redirect its output to a destination, or the caller still waits for EOF: ${line}`,
    ).toBe(true)
    // And specifically NOT into the pipeline the old version used, which is stdout by another name.
    expect(line).not.toMatch(/\|\s*(tail|sed|head)\b/)
  })

  it('says where the background output went, so the result stays reachable', () => {
    expect(CODE).toMatch(/GRAPH_LOG=/)
    expect(SRC).toMatch(/graphify: rebuilding the code graph in the background/)
  })

  // blast-radius stays synchronous ON PURPOSE (measured at 0s when the graph is current), so this
  // pins the deliberate asymmetry rather than letting a future reader "tidy" it into a match.
  it('blast-radius stays in the foreground, and still runs after the announcement', () => {
    const landed = CODE.indexOf('echo "LANDED')
    const blast = CODE.indexOf('blast-radius-check.py')
    expect(blast).toBeGreaterThan(landed)
    const line = CODE.split('\n').find((l) => /blast-radius-check\.py"?\s+--refresh/.test(l))!
    expect(line, 'no blast-radius refresh invocation found').toBeTruthy()
    expect(line.trimEnd().endsWith('&')).toBe(false)
  })
})
