// Card 8ab5eef3: tmux resolves its target server from $TMUX first, and only falls back to
// TMUX_TMPDIR's default socket when $TMUX is unset. A test file that sets TMUX_TMPDIR to a
// private directory and then calls a server-wide tmux operation (start-server, kill-server, or
// set-environment -g) WITHOUT also scoping the call with -L/-S silently targets the live,
// already-running server instead of its own private one if this process inherited $TMUX (e.g. a
// fleet-test run launched from an agent's own tmux pane) -- confirmed live: the fb3fff4d
// describe block in background-tasks.test.ts planted a fake bot token in, and then killed, the
// fleet's own default tmux server this way. This guard fails if any test file introduces a new
// unscoped server-wide tmux call without a `delete process.env.TMUX` appearing BEFORE it, close
// enough to actually be the guard for that call (a teardown's restore of the SAME var, which
// textually matches identically but runs AFTER the dangerous call already fired, does not count
// -- mutation-tested below: removing only the beforeEach clear, leaving the afterEach restore
// line untouched, must still fail this guard).
import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

const REPO_ROOT = join(import.meta.dirname, '..', '..')
const TEST_DIR = join(REPO_ROOT, 'src', '__tests__')

const HAS_GLOBAL_FLAG = /'-g'/
const HAS_SCOPE_FLAG = /'-L'|'-S'/
const CLEARS_TMUX_ENV = /delete\s+process\.env\.TMUX\b/g
// How far back (chars) a clear must appear before the dangerous call to count as guarding it --
// generous for a beforeEach block, but bounded so a file-wide "somewhere, who knows when" match
// (e.g. an unrelated afterEach restore hundreds of lines later in the file) cannot satisfy it.
const CLEAR_LOOKBACK_CHARS = 2500

function isServerWide(args: string): boolean {
  if (/'start-server'|'kill-server'/.test(args)) return true
  if (/'set-environment'/.test(args) && HAS_GLOBAL_FLAG.test(args)) return true
  return false
}

function findTmuxCalls(src: string): Array<{ args: string; index: number }> {
  const calls: Array<{ args: string; index: number }> = []
  const callRe = /(?:execFileSync|spawnSync)\(\s*'tmux'\s*,\s*\[([^\]]*)\]/g
  let m: RegExpExecArray | null
  while ((m = callRe.exec(src)) !== null) calls.push({ args: m[1], index: m.index })
  return calls
}

function clearIndicesBefore(src: string, beforeIndex: number): number[] {
  const indices: number[] = []
  let m: RegExpExecArray | null
  CLEARS_TMUX_ENV.lastIndex = 0
  while ((m = CLEARS_TMUX_ENV.exec(src)) !== null) {
    if (m.index < beforeIndex) indices.push(m.index)
  }
  return indices
}

function isGuardedByPrecedingClear(src: string, callIndex: number): boolean {
  return clearIndicesBefore(src, callIndex).some((clearIndex) => callIndex - clearIndex <= CLEAR_LOOKBACK_CHARS)
}

describe('tmux server-wide ops: scoped (-L/-S) or guarded by a preceding $TMUX clear (card 8ab5eef3)', () => {
  const files = readdirSync(TEST_DIR).filter((f) => f.endsWith('.test.ts'))
  expect(files.length).toBeGreaterThan(0) // control: the directory scan itself is not vacuous

  // This file's own control tests below exercise isServerWide()/HAS_SCOPE_FLAG/isGuardedByPreceding-
  // Clear on plain string literals shaped like tmux call arguments -- real text, not an actual
  // execFileSync('tmux', ...) call, but indistinguishable from one to a pure text scan. Excluded
  // from the scan it defines.
  const SELF = 'tmux-server-wide-ops-need-scope-or-cleared-env.test.ts'

  for (const file of files.filter((f) => f !== SELF)) {
    it(`${file}: no unscoped, unguarded server-wide tmux call`, () => {
      const src = readFileSync(join(TEST_DIR, file), 'utf-8')
      const unguarded = findTmuxCalls(src).filter(
        ({ args, index }) => isServerWide(args) && !HAS_SCOPE_FLAG.test(args) && !isGuardedByPrecedingClear(src, index)
      )

      expect(
        unguarded,
        `${file} calls a server-wide tmux op without -L/-S scoping and without a preceding ` +
          `'delete process.env.TMUX' close enough to guard it -- it can silently target the live ` +
          `server instead of its own: ${unguarded.map((u) => u.args).join(' | ')}`
      ).toEqual([])
    })
  }

  it('control: unscoped + unguarded is caught', () => {
    const fixture = `execFileSync('tmux', ['kill-server'])`
    expect(isServerWide("'kill-server'")).toBe(true)
    expect(HAS_SCOPE_FLAG.test("'kill-server'")).toBe(false)
    expect(isGuardedByPrecedingClear(fixture, fixture.indexOf('kill-server'))).toBe(false)
  })

  it('control: a clear AFTER the call (e.g. an unrelated afterEach restore) does not guard it', () => {
    const fixture = `execFileSync('tmux', ['kill-server'])\n/* ...200 lines later... */\ndelete process.env.TMUX`
    const callIndex = fixture.indexOf('kill-server')
    expect(isGuardedByPrecedingClear(fixture, callIndex)).toBe(false)
  })

  it('control: a clear shortly BEFORE the call does guard it', () => {
    const fixture = `delete process.env.TMUX\nexecFileSync('tmux', ['kill-server'])`
    const callIndex = fixture.indexOf('kill-server')
    expect(isGuardedByPrecedingClear(fixture, callIndex)).toBe(true)
  })

  it('control: a clear too far before the call (beyond the lookback window) does not guard it', () => {
    const filler = 'x'.repeat(CLEAR_LOOKBACK_CHARS + 100)
    const fixture = `delete process.env.TMUX\n${filler}\nexecFileSync('tmux', ['kill-server'])`
    const callIndex = fixture.indexOf('kill-server')
    expect(isGuardedByPrecedingClear(fixture, callIndex)).toBe(false)
  })

  it('control: a session-scoped call (kill-session) is not flagged as server-wide', () => {
    expect(isServerWide("'kill-session', '-t', sessionName")).toBe(false)
  })
})
