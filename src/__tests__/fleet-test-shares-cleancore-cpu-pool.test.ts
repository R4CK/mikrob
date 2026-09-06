// fleet-test.sh must not run a full suite as a THIRD, uncoordinated CPU consumer alongside
// CleanCore's own suite-run semaphore (card 492a6d5c, backend3's measurement on card 779cd6a7).
//
// THE PROBLEM. store/cleancore-suite-run.sh already caps CleanCore's own full-suite runs to
// CLEANCORE_SUITE_SLOTS (default 2) concurrent, because a full suite starts one vitest worker per
// core and a CPU-starved main process misses the vitest worker-RPC's hardcoded 60s timeout --
// exit 1, zero test failures (the same false-red class fleet-test.sh's own machine-wide lock,
// cards 85faec1b/2f0c7d24, exists to prevent for marveen). Before this card, fleet-test.sh's lock
// only serialised fleet-test.sh runs against EACH OTHER: an agent landing on marveen (this script)
// while ALSO running a CleanCore suite in its own correctly-slotted 2/2 could still starve itself.
// Measured live: loadavg 10-24, cross-tenant-canary-callers.test.ts timing out with zero assertion
// failures, while the identical diff under identical load (loadavg 10.6) run alone was 9/9 green.
//
// THE FIX shares the exact same numbered lock files cleancore-suite-run.sh uses (same env var
// names, same default anchor), so a fleet-test.sh run and a CleanCore suite run draw from ONE pool
// instead of two uncoordinated ones -- backend3's proposal. It is a SEPARATE lock from the existing
// machine-wide tree mutex: that one answers "is it safe" (correctness, capped at 1); this one
// answers "is there room" (CPU, capped at CLEANCORE_SUITE_SLOTS), and it is acquired FIRST so a run
// never holds the tree lock uselessly while still queueing for CPU capacity.
import { describe, it, expect, afterEach } from 'vitest'
import { execFileSync, spawn, type ChildProcess } from 'node:child_process'
import { readFileSync, mkdirSync, rmSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { tmpdir } from 'node:os'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const SCRIPT = join(ROOT, 'store', 'fleet-test.sh')
const text = readFileSync(SCRIPT, 'utf-8')

/** Full-line comments removed -- a guard that reads the whole source can be satisfied by a COMMENT
 * quoting the shape it wants (measured on this exact file's OWN tree-lock guard, card 2f0c7d24/
 * 43ecdbe6). A trailing comment after code is deliberately not stripped; see
 * fleet-test-serialises-runs.test.ts for the full reasoning, reused verbatim here. */
function code(txt: string): string {
  return txt
    .split('\n')
    .filter((line) => !/^\s*#/.test(line))
    .join('\n')
}

function problems(source: string): string[] {
  const t = code(source)
  const found: string[] = []
  const at = (needle: string | RegExp) => (typeof needle === 'string' ? t.indexOf(needle) : (t.match(needle)?.index ?? -1))

  const cpuAcquire = at('acquire_cpu_slot')
  const treeLock = at('flock -n 9')
  const vitest = at('npx vitest')

  if (cpuAcquire < 0) found.push('no shared CPU-slot acquisition at all')
  if (treeLock < 0 || vitest < 0) found.push('this test is looking at the wrong file')
  // The CPU-capacity wait must happen BEFORE the tree mutex, so a run never holds the tree lock
  // uselessly while still queueing for CPU (this file's own module doc, and cleancore-suite-run.sh's
  // WHY-A-SEMAPHORE reasoning: the tree lock is about correctness, this one is about cores).
  if (cpuAcquire >= 0 && treeLock >= 0 && cpuAcquire > treeLock) found.push('the CPU slot is acquired AFTER the tree mutex')

  // Must read the EXACT variables cleancore-suite-run.sh reads, not same-shaped new ones -- a fresh
  // variable name that happens to default to the same value today is how the two pools quietly
  // drift apart the next time either script's default changes.
  if (!/CLEANCORE_SUITE_SLOTS/.test(t)) found.push('does not read CLEANCORE_SUITE_SLOTS')
  if (!/CLEANCORE_SUITE_LOCK_PREFIX/.test(t)) found.push('does not read CLEANCORE_SUITE_LOCK_PREFIX')
  // The prefix must resolve to the SAME anchor cleancore-suite-run.sh defaults to, or the two never
  // actually share a file even when neither env var is overridden.
  if (!/store\/\.cleancore-suite-slot/.test(t)) found.push('the default prefix does not match cleancore-suite-run.sh\'s own default')

  // A wait with no bound hangs a landing on one stuck holder forever; a wait that is not fatal on
  // timeout silently proceeds unsynchronised, which is the exact bug this card fixes.
  const waitLoop = at(/while ! acquire_cpu_slot/)
  if (waitLoop < 0) found.push('the CPU-slot wait is not a bounded retry loop')
  else if (!/CPU_WAIT_MAX_S/.test(t.slice(waitLoop, waitLoop + 400))) found.push('the CPU-slot wait has no bound')
  else if (!/\bdie\b/.test(t.slice(waitLoop, waitLoop + 400))) found.push('a CPU-slot wait timeout is not fatal')

  return found
}

describe('fleet-test.sh shares CleanCore\'s CPU-capacity pool (card 492a6d5c)', () => {
  it('acquires a shared CPU slot, bounded and fatal on timeout, before the tree mutex', () => {
    expect(problems(text)).toEqual([])
  })

  it('CONTROL: the same reading REJECTS the script with the acquisition removed', () => {
    const preFix = text.replace(/\nacquire_cpu_slot\(\)[\s\S]*?\ndone\n/, '\n')
    expect(code(preFix), 'the mutation did not apply -- the block was not found').not.toMatch(/acquire_cpu_slot/)
    expect(problems(preFix)).toContain('no shared CPU-slot acquisition at all')
  })

  it('CONTROL: acquiring the CPU slot AFTER the tree mutex is caught, not just a missing one', () => {
    // Move the whole acquisition block (constants stay put) to just after the tree lock's `fi`.
    const block = text.match(/\nacquire_cpu_slot\(\)[\s\S]*?\ndone\n/)?.[0]
    expect(block, 'the mutation did not apply -- the block was not found').toBeTruthy()
    const late = text.replace(block!, '\n') + '\n' + block
    expect(problems(late)).toContain('the CPU slot is acquired AFTER the tree mutex')
  })

  it('CONTROL: reading a differently-named variable is caught (the drift this card exists to prevent)', () => {
    const drifted = text.replace(/CLEANCORE_SUITE_SLOTS/g, 'FLEET_CPU_SLOTS')
    expect(drifted, 'the mutation did not apply').not.toMatch(/CLEANCORE_SUITE_SLOTS/)
    expect(problems(drifted)).toContain('does not read CLEANCORE_SUITE_SLOTS')
  })

  // --- The resolved value and live behaviour, not the source text (card 43ecdbe6's lesson) -------

  it('THE PROPERTY: --cpu-slot-path resolves to the exact anchor cleancore-suite-run.sh defaults to', () => {
    const out = execFileSync('bash', [SCRIPT, '--cpu-slot-path'], { encoding: 'utf-8' }).trim()
    expect(out).toBe('/home/neon/marveen/store/.cleancore-suite-slot')
  })

  it('THE PROPERTY: MARVEEN_MAIN moves the CPU-slot path, the same way it moves cleancore-suite-run.sh\'s', () => {
    const out = execFileSync('bash', [SCRIPT, '--cpu-slot-path'], {
      encoding: 'utf-8',
      env: { ...process.env, MARVEEN_MAIN: '/tmp/not-the-real-anchor' },
    }).trim()
    expect(out).toBe('/tmp/not-the-real-anchor/store/.cleancore-suite-slot')
  })
})

describe('fleet-test.sh behaviourally contends with cleancore-suite-run.sh\'s own slot files', () => {
  const anchor = join(tmpdir(), `fleet-test-cpu-pool-selftest-${process.pid}`)
  const REAL_TREE_LOCK = '/home/neon/marveen-test.lock'
  const holders: ChildProcess[] = []

  afterEach(() => {
    for (const h of holders.splice(0)) h.kill('SIGKILL')
    rmSync(anchor, { recursive: true, force: true })
  })

  function holdSlot(n: number, seconds: number): ChildProcess {
    const f = `${anchor}/store/.cleancore-suite-slot-${n}.lock`
    const p = spawn('bash', ['-c', `exec 8>"${f}"; flock 8; sleep ${seconds}`])
    holders.push(p)
    return p
  }

  /** Holds the REAL fleet tree mutex so a run that gets PAST the CPU-slot stage dies quickly on the
   * next lock instead of falling through into an actual worktree checkout + build + vitest run.
   * Safe: fleet-test.sh itself opens this file with `>` (truncating) on every real invocation, so
   * briefly holding an flock on it is the same interaction a normal run already has, just shorter. */
  function holdRealTreeLock(seconds: number): ChildProcess {
    const p = spawn('bash', ['-c', `exec 8>"${REAL_TREE_LOCK}"; flock 8; sleep ${seconds}`])
    holders.push(p)
    return p
  }

  /** Runs fleet-test.sh with the real tree mutex pre-held (and a short FLEET_TEST_LOCK_WAIT), so
   * ANY invocation that gets past the CPU-slot stage dies quickly at the tree-lock stage instead of
   * ever reaching a real worktree checkout or build/vitest run. This isolates the CPU-slot stage's
   * behaviour (queues or not) without risking a real suite execution as a side effect of the test. */
  function runPastCpuSlot(env: NodeJS.ProcessEnv): { stderr: string } {
    let stderr = ''
    try {
      execFileSync('bash', [SCRIPT, '--ref', 'HEAD'], {
        encoding: 'utf-8',
        env: { ...process.env, FLEET_TEST_LOCK_WAIT: '1', ...env },
        stdio: ['ignore', 'pipe', 'pipe'],
      })
    } catch (e: any) {
      stderr = String(e.stderr ?? '')
    }
    return { stderr }
  }

  it('queues, then gives up loudly, when both slots are held by cleancore-suite-run.sh-shaped locks', () => {
    mkdirSync(`${anchor}/store`, { recursive: true })
    holdSlot(1, 4)
    holdSlot(2, 4)
    const { stderr } = runPastCpuSlot({
      MARVEEN_MAIN: anchor,
      CLEANCORE_SUITE_WAIT_MAX_S: '2',
      CLEANCORE_SUITE_POLL_S: '1',
    })
    expect(stderr).toMatch(/all 2 shared CPU slot\(s\) busy/)
    expect(stderr).toMatch(/no shared CPU slot after/)
    // Never reached the tree-lock stage: the CPU-slot stage itself was the one that gave up.
    expect(stderr).not.toMatch(/another suite run holds the fleet lock/)
  }, 15000)

  it('CONTROL: with a free CPU pool, no queueing message appears, and the run reaches the tree-lock stage', () => {
    mkdirSync(`${anchor}/store`, { recursive: true })
    holdRealTreeLock(3)
    const { stderr } = runPastCpuSlot({ MARVEEN_MAIN: anchor })
    expect(stderr).not.toMatch(/shared CPU slot\(s\) busy/)
    // Proves it actually got PAST the CPU-slot stage, not just that nobody happened to log anything.
    expect(stderr).toMatch(/another suite run holds the fleet lock/)
  }, 10000)

  it('CLEANCORE_SUITE_SLOTS is honoured: a 3rd slot admits a run while 2 are held on the shared anchor', () => {
    mkdirSync(`${anchor}/store`, { recursive: true })
    holdSlot(1, 4)
    holdSlot(2, 4)
    holdRealTreeLock(3)
    const { stderr } = runPastCpuSlot({
      MARVEEN_MAIN: anchor,
      CLEANCORE_SUITE_SLOTS: '3',
      CLEANCORE_SUITE_WAIT_MAX_S: '2',
      CLEANCORE_SUITE_POLL_S: '1',
    })
    // Admitted -> proceeds past the CPU-slot stage silently and reaches the tree-lock stage.
    expect(stderr).not.toMatch(/shared CPU slot\(s\) busy/)
    expect(stderr).not.toMatch(/no shared CPU slot after/)
    expect(stderr).toMatch(/another suite run holds the fleet lock/)
  }, 10000)
})
