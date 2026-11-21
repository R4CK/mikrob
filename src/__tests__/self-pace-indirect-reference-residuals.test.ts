// Card a6c7780d (RedHat msg 19773 point 3, MEDIUM, shared with upstream): four ways to keep a
// schedule-surface reference OUT of the command string scheduleSurfaceDeny reads -- so the
// top-level wholeStrong check at the very start of that function never sees it and returns false
// before any per-segment logic runs at all:
//   (a) a script FILE written in an earlier call (Write tool, content-blind by design) then run
//       by a LATER, separate Bash call whose own text carries no reference;
//   (b) curl -K/--config pointing at a LOCAL FILE (not stdin -- that form is covered elsewhere);
//   (c) a base64 blob piped through `base64 -d` into a shell;
//   (d) a schedule-store path assembled from TWO OR MORE shell variables, each individually
//       reference-free (`A=sched; B=-tasks; ... "$A$B" ...`).
// All four are instances of the SAME limitation the module's own header already names ("none of
// these are provable from a single command's text"). (b) and (c) ARE provable -- the file/blob is
// local and self-contained -- and are now closed (curlConfigFileRefs / decodedBase64Refs). (a) and
// (d) remain open BY DESIGN (closing (a) would mean reading the content of every script a command
// executes, which this repo's OWN scripts about this exact feature would trip constantly; closing
// (d) needs full shell-variable interpretation, which upstream does not have either) -- pinned here
// as the accepted residual, not silently left undocumented.
//
// ONE TEST PER SHAPE, plus a false-positive guard per closed shape: a single combined case would
// let a regression on any one of them come back silently, and a closed shape with no "this does
// NOT over-block" case would let its own fix start denying unrelated, legitimate curl/base64 use.
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
// @ts-expect-error -- plain .mjs hook script, no types
import { gateDecision } from '../../scripts/self-pace-gate.mjs'

// Assembled rather than written literally: this file is itself scanned by the gate it tests.
const API = 'api' + '/' + 'sched' + 'ules'
const STORE_DIR = 'scheduled' + '-tasks'

let dir = ''
beforeAll(() => { dir = mkdtempSync(join(tmpdir(), 'self-pace-indirect-')) })
afterAll(() => { rmSync(dir, { recursive: true, force: true }) })

const bash = (command: string): boolean => Boolean(gateDecision('Bash', { command, cwd: dir }).deny)

describe('self-pace-gate: indirect-reference residuals (card a6c7780d)', () => {
  it('(a) OPEN BY DESIGN: a script file written in an earlier call, run by a later plain command', () => {
    const script = join(dir, 'a-write-run.sh')
    writeFileSync(script, `#!/bin/sh\ncurl -s -X POST http://localhost:3420/${API} -d '{}'\n`)
    expect(bash(`bash ${script}`)).toBe(false)
  })

  it('(b) CLOSED: curl -K/--config naming a local file whose directives reference the surface', () => {
    const conf = join(dir, 'b-curl.conf')
    writeFileSync(conf, `url = "http://localhost:3420/${API}"\n`)
    expect(bash(`curl -K ${conf}`)).toBe(true)
    expect(bash(`curl --config ${conf}`)).toBe(true)
  })
  it('(b) false-positive guard: curl -K naming a file that does NOT reference the surface stays allowed', () => {
    const conf = join(dir, 'b-benign.conf')
    writeFileSync(conf, 'url = "https://example.com/unrelated"\n')
    expect(bash(`curl -K ${conf}`)).toBe(false)
  })
  it('(b) false-positive guard: curl -K on a file that does not exist stays allowed (nothing to read)', () => {
    expect(bash(`curl -K ${join(dir, 'does-not-exist.conf')}`)).toBe(false)
  })
  it('(b) false-positive guard: curl -K - (stdin) is untouched by this check (covered elsewhere)', () => {
    // Not a reference anywhere in the command text, and no local file to read -- this new check
    // adds nothing here; whatever the stdin-config mechanism already decides is unchanged.
    expect(bash(`echo hi | curl -K - http://example.com`)).toBe(false)
  })

  it('(c) CLOSED: a base64 blob piped through base64 -d into a shell, decoding to a reference', () => {
    const payload = `curl -s -X POST http://localhost:3420/${API} -d '{}'`
    const b64 = Buffer.from(payload, 'utf8').toString('base64')
    expect(bash(`echo ${b64} | base64 -d | sh`)).toBe(true)
    expect(bash(`echo ${b64} | base64 --decode | bash`)).toBe(true)
  })
  it('(c) false-positive guard: a base64 blob that decodes to something unrelated stays allowed', () => {
    const b64 = Buffer.from('echo hello world', 'utf8').toString('base64')
    expect(bash(`echo ${b64} | base64 -d | sh`)).toBe(false)
  })
  it('(c) false-positive guard: base64 used WITHOUT piping into a shell stays allowed (not this shape)', () => {
    const payload = `curl -s -X POST http://localhost:3420/${API} -d '{}'`
    const b64 = Buffer.from(payload, 'utf8').toString('base64')
    expect(bash(`echo ${b64} | base64 -d > /tmp/not-a-shell-pipe-output`)).toBe(false)
  })

  it('(d) OPEN BY DESIGN: the store path assembled from two reference-free variables', () => {
    expect(bash(`A=scheduled; B=-tasks; F="$HOME/.claude/$A$B/x"; echo pwned > "$F"`)).toBe(false)
  })
})

describe('self-pace-gate: indirect-reference closures do not touch the existing flat invariants', () => {
  it('a plain curl GET with no -K at all is still allowed (isPlainCurlGet path untouched)', () => {
    expect(bash('curl -q http://localhost:3420/health')).toBe(false)
  })
  it(`a direct, visible write to ${STORE_DIR} is still denied the old way (no change to that path)`, () => {
    expect(bash(`echo x > $HOME/.claude/${STORE_DIR}/y/task-config.json`)).toBe(true)
  })
})
