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
import { readFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
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

  // THE OTHER HALF OF THE CONTROL (card 7bb39672). Taking a slot bounds how many suites run at
  // once; it says nothing about how much CPU each one takes. vitest defaults maxWorkers to the core
  // count, so a run that takes a slot and then spawns nproc workers puts nproc*SLOTS workers on
  // nproc cores -- measured here as 12 + 6 on a 12-core box, load ~22, and three false-red landings
  // in one day on a test that shells out and never gets scheduled. cleancore-suite-run.sh has capped
  // this since it was written; this script took the slot and not the cap.
  const cap = at(/DEFAULT_MAX_WORKERS=/)
  if (cap < 0) found.push('no per-run worker cap -- the slot bounds RUNS, nothing bounds WORKERS')
  else {
    // Derived from the SAME slot count the pool is sized by. A hardcoded number (or a second,
    // same-shaped variable) is how the cap and the pool drift apart the next time either moves.
    if (!/DEFAULT_MAX_WORKERS=\$\(\(CORES \/ CPU_SLOTS\)\)/.test(t))
      found.push('the worker cap is not derived from CORES / CPU_SLOTS')
    // A cap computed and never passed to vitest is decoration -- and checking for it ANYWHERE near
    // the call site does not say that, because the computation block itself contains the flag. That
    // was measured, not reasoned about: the first version of this check windowed 600 chars around
    // `npx vitest` and survived a mutant that deleted the cap from BOTH invocations, because the
    // window still caught the declaration. The property is "every vitest invocation carries it", so
    // the assertion has to read the invocation LINES.
    const invocations = t.split('\n').filter((l) => /npx vitest run/.test(l))
    if (invocations.length === 0) found.push('no npx vitest invocation found at all')
    else if (!invocations.every((l) => /WORKER_ARGS/.test(l)))
      found.push('a vitest invocation does not carry the computed worker cap')
    // AND the cap must be a flag vitest ACCEPTS, not merely one we pass. vitest 2.1.9 rejects a
    // bare --maxWorkers in this repo -- "options.minThreads and options.maxThreads must not
    // conflict" -- and exits 1 having run nothing. The first version of this cap shipped without
    // --minWorkers and broke every fleet-test run, i.e. every landing for every agent, while this
    // very contract stayed green: it asserted the flag was PASSED, never that the runner took it.
    // That gap is the reason for this line.
    // Anchored to the ASSIGNMENT line, not to the file. Two earlier versions of this check were
    // vacuous for the same reason and both were found by mutation, not by reading: the flag name
    // also appears in the echo that reports the cap and in the comment above it, so a file-wide
    // regex stays green after the flag is deleted from the array that actually reaches vitest.
    const assign = t.split('\n').filter((l) => /WORKER_ARGS=\(/.test(l) && !/WORKER_ARGS=\(\)/.test(l))
    if (assign.length === 0) found.push('no WORKER_ARGS assignment carrying the cap')
    else if (!assign.every((l) => /--minWorkers/.test(l) && /--maxWorkers/.test(l)))
      found.push('the cap is assigned without BOTH --minWorkers and --maxWorkers (vitest 2.x rejects a lone --maxWorkers as conflicting)')
    // A caller who passed their own --maxWorkers has already made the CPU-budget decision; silently
    // overriding it would make this a policy rather than a default, unlike the CleanCore side.
    if (!/caller_set_max_workers/.test(t))
      found.push('a caller-supplied --maxWorkers is not honoured')
  }
  if (!/CLEANCORE_SUITE_LOCK_PREFIX/.test(t)) found.push('does not read CLEANCORE_SUITE_LOCK_PREFIX')
  // The prefix must resolve to the SAME anchor cleancore-suite-run.sh defaults to, or the two never
  // actually share a file even when neither env var is overridden.
  if (!/store\/\.cleancore-suite-slot/.test(t)) found.push('the default prefix does not match cleancore-suite-run.sh\'s own default')

  // A wait with no bound hangs a landing on one stuck holder forever; a wait that is not fatal on
  // timeout silently proceeds unsynchronised, which is the exact bug this card fixes.
  const waitLoop = at(/while ! acquire_cpu_slot/)
  if (waitLoop < 0) found.push('the CPU-slot wait is not a bounded retry loop')
  else if (!/CPU_WAIT_MAX_S/.test(t.slice(waitLoop, waitLoop + 400))) found.push('the CPU-slot wait has no bound')
  else {
    // ANCHORED TO THE TIMEOUT BRANCH, not to a character distance from the loop head (card
    // 492a6d5c's Cybersec delta). This used to read "a `die` appears within 400 chars of the loop",
    // and adding the PAUSED-SEMAPHORE notice -- legitimate work, and required by that NO-GO --
    // pushed the `die` to 435 and turned the guard red. The proximity number was never the
    // property; "the branch that detects the timeout is the branch that dies" is, and any `die`
    // inside that window used to satisfy the old reading whether or not it belonged to this branch.
    // So this is a narrowing, not a loosened window to let my own change through.
    const timeoutBranch = at(/-ge "\$CPU_WAIT_MAX_S"/)
    if (timeoutBranch < 0) found.push('the CPU-slot wait has no timeout branch')
    else if (!/\bdie\b/.test(t.slice(timeoutBranch, t.indexOf('\n  fi', timeoutBranch) + 1)))
      found.push('a CPU-slot wait timeout is not fatal')
  }

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

  it('CONTROL: a NON-FATAL CPU-slot timeout is caught (the property, not the character distance)', () => {
    // Read on MUTATED TEXT, never by mutating the file and running it -- and that distinction is
    // not fastidiousness. Removing the `die` is exactly what lets a run fall THROUGH the CPU gate
    // into a real worktree checkout, build and full suite; done live it starts the runaway this
    // whole card exists to prevent (measured the hard way while writing this case). The guard is a
    // source reader, so the honest way to exercise it is to hand it the source.
    const nonFatal = text.replace('die 3 "no shared CPU slot after', 'echo 3 "no shared CPU slot after')
    expect(nonFatal, 'the mutation must actually change the text, or this case is vacuous').not.toBe(text)
    expect(problems(nonFatal)).toContain('a CPU-slot wait timeout is not fatal')
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
  /** ASYNC twin of runPastCpuSlot, and the reason it has to exist: the fake dashboard below lives in
   *  THIS process, and execFileSync blocks this event loop -- so a child that POSTs a comment waits
   *  on a response that cannot be produced until the child exits. Measured: each comment burned its
   *  full `curl --max-time 10`, two of them, and the case died at 22s against a 20s budget. Running
   *  the child asynchronously keeps the loop free to serve it. */
  function runPastCpuSlotAsync(env: NodeJS.ProcessEnv): Promise<{ stderr: string }> {
    return new Promise((resolve) => {
      const p = spawn('bash', [SCRIPT, '--ref', 'HEAD'], {
        env: { ...process.env, FLEET_TEST_LOCK_WAIT: '1', ...env },
        stdio: ['ignore', 'pipe', 'pipe'],
      })
      let stderr = ''
      p.stderr.on('data', (c) => (stderr += c))
      p.on('close', () => resolve({ stderr }))
    })
  }

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

  // --- Cybersec NO-GO on this card (comment 712a8349): a waiter must ANNOUNCE ITSELF ------------
  // The two cases below are behavioural, not source pins: a fake dashboard captures what the script
  // actually POSTs. The pair is the point -- a script that posted the notice unconditionally would
  // pass the first case and fail the second, and unconditional notices are exactly what trains
  // people to skip them.
  //
  // TWO RACES THIS HARNESS HAS TO SURVIVE, both measured rather than guessed -- the first version
  // failed BOTH cases, and in OPPOSITE directions, which is what said the harness and not the
  // script was wrong. Run by hand, the script posted both comments correctly.
  //   1. `runPastCpuSlot` is execFileSync: it BLOCKS this event loop, so the child's POSTs sit in
  //      the socket queue and Node cannot handle them until the run returns. Reading `seen`
  //      immediately therefore reads it too early. Hence waitFor below.
  //   2. `listen(0)` takes an ephemeral port, and a port freed by one case can be handed to the
  //      next -- so a late POST from the PREVIOUS case lands in THIS case's capture. That is what
  //      put a SEMAPHORE comment in the negative control. Each case now uses its own agent name and
  //      filters on it, so crosstalk cannot be mistaken for its own traffic.
  async function withFakeDashboard(
    agent: string,
    fn: (base: string, seen: string[]) => void | Promise<void>,
  ): Promise<void> {
    const { createServer } = await import('node:http')
    const seen: string[] = []
    const srv = createServer((req, res) => {
      if (req.url === '/api/kanban') {
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify([{ id: `card-${agent}`, status: 'in_progress', assignee: agent }]))
        return
      }
      let body = ''
      req.on('data', (c) => (body += c))
      req.on('end', () => {
        seen.push(body)
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end('{}')
      })
    })
    await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r))
    const port = (srv.address() as { port: number }).port
    try {
      await fn(`http://127.0.0.1:${port}`, seen)
    } finally {
      srv.close()
    }
  }

  /** Own traffic only: see race 2 above. */
  const mine = (seen: string[], agent: string) => seen.filter((b) => b.includes(`"${agent}"`))

  /** Polls until the predicate holds or the budget runs out, then returns what it saw either way --
   *  so a failure reports the ACTUAL captured traffic instead of an empty timeout message. */
  async function waitFor(
    seen: string[],
    agent: string,
    ok: (bodies: string) => boolean,
    ms = 4000,
  ): Promise<string> {
    const deadline = Date.now() + ms
    for (;;) {
      const bodies = mine(seen, agent).join('\n')
      if (ok(bodies) || Date.now() > deadline) return bodies
      await new Promise((r) => setTimeout(r, 50))
    }
  }

  /** A THROWAWAY token, never the live one: the endpoint here is a test server, and a real token is
   *  only as safe as what it is sent to. */
  function throwawayToken(): string {
    const f = join(anchor, 'probe-token')
    mkdirSync(anchor, { recursive: true })
    writeFileSync(f, 'test-token-not-real\n')
    return f
  }

  it('a QUEUEING run posts PAUSED-SEMAPHORE to the waiting card, so the stuck-monitor does not take it away', async () => {
    await withFakeDashboard('probe-queue', async (base, seen) => {
      mkdirSync(`${anchor}/store`, { recursive: true })
      holdSlot(1, 5)
      holdSlot(2, 5)
      await runPastCpuSlotAsync({
        MARVEEN_MAIN: anchor,
        CLEANCORE_SUITE_WAIT_MAX_S: '2',
        CLEANCORE_SUITE_POLL_S: '1',
        FLEET_TEST_AGENT: 'probe-queue',
        KANBAN_COMMENT_API: base,
        KANBAN_COMMENT_TOKEN_FILE: throwawayToken(),
      })
      const bodies = await waitFor(seen, 'probe-queue', (b) => /GIVING UP/.test(b))
      expect(bodies, 'the waiting card must be told it is queueing, not dead').toMatch(
        /PAUSED-SEMAPHORE/,
      )
      // Giving up must ALSO be said out loud, and must say it is not a test result -- otherwise a
      // run that never happened reads on the card exactly like one that passed.
      expect(bodies).toMatch(/GIVING UP/)
      expect(bodies).toMatch(/NEM teszt-eredmeny/)
    })
  }, 20000)

  it('CONTROL: a run that gets a slot IMMEDIATELY posts NOTHING -- the routine case stays quiet', async () => {
    await withFakeDashboard('probe-free', async (base, seen) => {
      mkdirSync(`${anchor}/store`, { recursive: true })
      holdRealTreeLock(3)
      await runPastCpuSlotAsync({
        MARVEEN_MAIN: anchor,
        FLEET_TEST_AGENT: 'probe-free',
        KANBAN_COMMENT_API: base,
        KANBAN_COMMENT_TOKEN_FILE: throwawayToken(),
      })
      // Give a comment every chance to ARRIVE before concluding none was sent: asserting emptiness
      // right after a blocking run would pass even if one were on its way.
      const bodies = await waitFor(seen, 'probe-free', () => false, 1200)
      expect(
        bodies,
        'a notice that fires on healthy traffic is one people learn to skip',
      ).toBe('')
    })
  }, 20000)

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


// Card 7bb39672, Cybered's delta request -- and the gap that let the outage land.
//
// Everything above is a SOURCE contract: it proves the cap is composed and reaches the invocation
// lines. It cannot prove vitest ACCEPTS it, and that is precisely what went wrong: a bare
// --maxWorkers is valid on vitest 3.x (where cleancore-suite-run.sh's copy of this pattern has run
// for months) and is REJECTED on the 2.1.9 this repo pins, because minThreads keeps its core-count
// default and then exceeds maxThreads. The flag was passed, the runner refused it, every fleet-test
// run exited 1 having collected nothing, and the contract suite stayed green throughout. Cybered's
// own harness could not see it either -- it proved argument passing with a stub npx, and a stub
// accepts everything.
//
// So this case LAUNCHES THE REAL vitest with the flags the script actually composes, in a throwaway
// project with one trivial test. Deliberately NOT through fleet-test.sh: that would reset and
// rebuild a whole tree, take a shared CPU slot this very suite may already hold, and recurse. The
// conflict lives in vitest's own pool defaults, not in this repo's config -- measured: it
// reproduces in a bare temp project -- so a temp project is enough to catch it, and is seconds.
//
// The flags are READ OUT OF THE SCRIPT, never hardcoded here. A copy would pass while the script
// drifted, which is the same class of blindness this case exists to close.
describe('the composed worker cap is a flag vitest ACCEPTS, not merely one we pass (card 7bb39672)', () => {
  const flagsFromScript = (): string[] => {
    const line = readFileSync(SCRIPT, 'utf-8')
      .split('\n')
      .find((l) => /WORKER_ARGS=\(/.test(l) && !/WORKER_ARGS=\(\)/.test(l))
    if (!line) throw new Error('no WORKER_ARGS assignment found in fleet-test.sh')
    const inner = line.slice(line.indexOf('(') + 1, line.lastIndexOf(')'))
    // $MAX_WORKERS is a shell expansion; any positive integer exercises the same pool check.
    return inner
      .split(/\s+/)
      .filter(Boolean)
      .map((tok) => tok.replace(/^"|"$/g, ''))
      .map((tok) => (tok.includes('$') ? '2' : tok))
  }

  const runVitestWith = (flags: string[]): { status: number; out: string } => {
    const dir = mkdtempSync(join(tmpdir(), 'fleet-pool-probe-'))
    try {
      writeFileSync(join(dir, 'a.test.ts'), "import { it, expect } from 'vitest'\nit('t', () => expect(1).toBe(1))\n")
      const bin = join(ROOT, 'node_modules', '.bin', 'vitest')
      try {
        const out = execFileSync(bin, ['run', '--root', dir, ...flags], {
          encoding: 'utf-8',
          stdio: 'pipe',
          timeout: 120_000,
        })
        return { status: 0, out }
      } catch (e) {
        const err = e as { status?: number; stdout?: string; stderr?: string }
        return { status: err.status ?? 1, out: `${err.stdout ?? ''}${err.stderr ?? ''}` }
      }
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  }

  it("vitest starts its pool with the script's own flags", () => {
    const r = runVitestWith(flagsFromScript())
    expect(r.out).not.toMatch(/must not conflict/)
    expect(r.status).toBe(0)
  })

  it('NEGATIVE CONTROL: a lone --maxWorkers is what the pool rejects, so this case can fail', () => {
    // Without this, the case above would pass just as happily against a vitest that accepts
    // anything -- and "the runner accepts everything" is exactly the assumption that hid the
    // outage. This pins that the probe can tell the two apart on THIS vitest.
    const r = runVitestWith(['--maxWorkers', '2'])
    expect(r.out).toMatch(/must not conflict/)
  })
})
