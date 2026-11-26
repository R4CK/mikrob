// FLEET_TEST_PRIORITY=land (card b7d8ecc4) is a SELF-REPORTED bare env var -- any caller can
// export it and jump the land-priority lane ahead of every normal run. Card e99c3dc1 (MikroB
// decision 39179, corrected scope 39196, tightened GO 25163) hardens the claim: fleet-test.sh
// now verifies it against the ACTUAL holder of marveen-land.sh's own develop-push lock before
// honouring it, by walking the ancestor PID chain for a process that (a) has the develop-lock
// file open on some fd, (b) actually HOLDS the flock on that exact fd (per that fd's own
// /proc/<pid>/fdinfo "lock:" line -- MEASURED to be the one that reliably reports a live flock()
// hold on this platform, unlike the machine-wide /proc/locks listing, which did not show it even
// though a second process's flock -n correctly blocked and fuser -v correctly reported it; an
// open fd alone proves nothing, since any process can open a world-readable file), and (c) whose
// own cmdline names store/marveen-land.sh. Any incomplete check falls back to normal priority,
// never land (fail-closed).
//
// Card 81c6fbb5 Q3 matters here: run_fg_killable's subshell deliberately closes ITS OWN copy of
// the land-lock fd before exec'ing fleet-test.sh, so the fd only ever lives on marveen-land.sh's
// own long-lived process, past the immediate parent -- the harness below reproduces exactly that
// shape (an outer process holding the lock, an inner subshell that closes its copy, then the
// script under test) rather than a flat two-level chain.
//
// HERMETIC BY CONSTRUCTION (MikroB msg 25163's constraint, after CYBERSEC's 15:12:35 incident on
// this same card's earlier round): every lock file here lives under a fresh mktemp dir. No literal
// real-install or real-test-tree path appears anywhere in this file -- grepped below as its own
// test, not just asserted in prose -- and `--effective-priority` exits before any lock/tree/
// CPU-slot machinery runs, so asking never touches the real install at all.
import { describe, it, expect, afterEach } from 'vitest'
import { execFileSync } from 'node:child_process'
import { readFileSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { tmpdir } from 'node:os'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const SCRIPT = join(ROOT, 'store', 'fleet-test.sh')

const tmpDirs: string[] = []
function freshDir(): string {
  const d = mktempDirSafe()
  tmpDirs.push(d)
  return d
}
function mktempDirSafe(): string {
  return mkdtempSync(join(tmpdir(), 'e99c3dc1-land-lock-'))
}
afterEach(() => {
  while (tmpDirs.length) {
    const d = tmpDirs.pop()!
    rmSync(d, { recursive: true, force: true })
  }
})

/** Runs an "ancestor" bash process that optionally holds the develop-lock flock, then forks a
 * subshell that closes ITS OWN copy of the fd (mirroring run_fg_killable, card 81c6fbb5 Q3)
 * before the grandchild runs `fleet-test.sh --effective-priority` with FLEET_TEST_PRIORITY=land
 * pointed at the given lock file. Returns the printed effective priority, trimmed. */
function effectivePriorityUnderAncestor(opts: { lockFile: string; holdFlock: boolean; marker: string }): string {
  const body = `
if [ "$HOLD_FLOCK" = "1" ]; then
  exec {FD}>>"$LOCKFILE"
  flock "$FD" || exit 9
else
  exec {FD}>>"$LOCKFILE"
fi
(
  { exec {FD}>&-; } 2>/dev/null
  MARVEEN_LAND_DEVELOP_LOCK_FILE="$LOCKFILE" FLEET_TEST_PRIORITY=land bash "$SCRIPT" --effective-priority
) &
wait $!
`
  return execFileSync('bash', ['-c', body, opts.marker], {
    encoding: 'utf-8',
    env: { ...process.env, LOCKFILE: opts.lockFile, HOLD_FLOCK: opts.holdFlock ? '1' : '0', SCRIPT },
  }).trim()
}

describe('fleet-test.sh verifies a FLEET_TEST_PRIORITY=land claim before honouring it (card e99c3dc1)', () => {
  it('no ancestor at all (lock file does not even exist): falls back to normal (fail-closed default)', () => {
    const dir = freshDir()
    const lockFile = join(dir, 'develop.lock') // never created
    const out = execFileSync('bash', [SCRIPT, '--effective-priority'], {
      encoding: 'utf-8',
      env: { ...process.env, FLEET_TEST_PRIORITY: 'land', MARVEEN_LAND_DEVELOP_LOCK_FILE: lockFile },
    }).trim()
    expect(out).toBe('normal')
  })

  it('THE PROPERTY: an ancestor that holds the flock AND names marveen-land.sh grants land priority', () => {
    const dir = freshDir()
    const lockFile = join(dir, 'develop.lock')
    const out = effectivePriorityUnderAncestor({ lockFile, holdFlock: true, marker: 'store/marveen-land.sh' })
    expect(out).toBe('land')
  })

  it('CONTROL: holding the flock is not enough if the ancestor is not marveen-land.sh (impostor holder)', () => {
    const dir = freshDir()
    const lockFile = join(dir, 'develop.lock')
    const out = effectivePriorityUnderAncestor({ lockFile, holdFlock: true, marker: 'unrelated-process' })
    expect(out).toBe('normal')
  })

  it('CONTROL: an open fd on the lock file is not enough without an actual flock (MikroB 25163 tightening)', () => {
    const dir = freshDir()
    const lockFile = join(dir, 'develop.lock')
    const out = effectivePriorityUnderAncestor({ lockFile, holdFlock: false, marker: 'store/marveen-land.sh' })
    expect(out).toBe('normal')
  })

  it('this file names no real install path anywhere (MikroB msg 25163 constraint)', () => {
    const text = readFileSync(join(ROOT, 'src', '__tests__', 'fleet-test-land-priority-verified.test.ts'), 'utf-8')
    expect(text).not.toMatch(/\/home\/neon\/marveen(?!-agent-worktrees)/)
  })
})

describe('fleet-test.sh timeout message distinguishes a LAND-blocked wait (card e99c3dc1, point 2)', () => {
  /** Extracts fleet_test_any_land_ticket_pending's own source, same technique marveen-land.sh's
   * own selftest uses to extract release_land_lock_fd (awk from the def line to its closing
   * brace) -- exercised against a throwaway ticket dir, never the real queue. */
  function extractFunction(name: string): string {
    const src = readFileSync(SCRIPT, 'utf-8')
    const fn = src
      .split('\n')
      .reduce<{ lines: string[]; inFn: boolean; done: boolean }>(
        (acc, line) => {
          if (acc.done) return acc
          if (!acc.inFn && line.startsWith(`${name}() {`)) return { ...acc, inFn: true, lines: [line] }
          if (acc.inFn) {
            acc.lines.push(line)
            if (line === '}') return { ...acc, inFn: false, done: true }
          }
          return acc
        },
        { lines: [], inFn: false, done: false },
      ).lines.join('\n')
    expect(fn, `could not extract ${name} from ${SCRIPT} -- selftest and production have drifted`).toMatch(
      new RegExp(`^${name}\\(\\) \\{`),
    )
    return fn
  }

  it('fleet_test_any_land_ticket_pending: true iff a rank-0 ticket file is present', () => {
    const fnSrc = extractFunction('fleet_test_any_land_ticket_pending')
    const dir = freshDir()
    const run = (): boolean => {
      try {
        execFileSync('bash', ['-c', `${fnSrc}\nfleet_test_any_land_ticket_pending "$1"`, 'driver', dir])
        return true
      } catch {
        return false
      }
    }
    expect(run()).toBe(false) // empty dir
    writeFileSync(join(dir, '1-000000000001.111.1'), '')
    expect(run()).toBe(false) // only a normal (rank 1) ticket
    writeFileSync(join(dir, '0-000000000002.222.2'), '')
    expect(run()).toBe(true) // a land (rank 0) ticket is now present
  })

  it('the timeout branch checks fleet_test_any_land_ticket_pending and names it in its own die() message', () => {
    const text = readFileSync(SCRIPT, 'utf-8')
    const codeOnly = text
      .split('\n')
      .filter((l) => !/^\s*#/.test(l))
      .join('\n')
    const timeoutGuard = codeOnly.indexOf('-ge "$LOCK_WAIT_SECONDS"')
    const landCheck = codeOnly.indexOf('fleet_test_any_land_ticket_pending "$TREE_TICKET_DIR"')
    const landMessage = codeOnly.indexOf('queued behind a LAND ticket')
    expect(timeoutGuard).toBeGreaterThan(-1)
    expect(landCheck).toBeGreaterThan(timeoutGuard)
    expect(landMessage).toBeGreaterThan(landCheck)
  })

  it('CONTROL: a timeout branch with the land-check deleted is rejected by the same reading', () => {
    const text = readFileSync(SCRIPT, 'utf-8')
    const mutant = text.replace(
      /if fleet_test_any_land_ticket_pending "\$TREE_TICKET_DIR"; then\n\s*die 3 "timed out[^\n]*queued behind a LAND ticket[^\n]*"\n\s*fi\n/,
      '',
    )
    expect(mutant).not.toBe(text) // the replace must actually have matched something
    const codeOnly = mutant
      .split('\n')
      .filter((l) => !/^\s*#/.test(l))
      .join('\n')
    expect(codeOnly.indexOf('queued behind a LAND ticket')).toBe(-1)
  })
})
