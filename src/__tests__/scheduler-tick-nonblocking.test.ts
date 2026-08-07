// Guard: nothing on the SCHEDULER TICK may run a child process synchronously (card 92e2bb1b).
//
// Generalises the card-955f014e fix. Anything the tick calls runs on the main thread, so a
// synchronous child freezes the whole event loop -- HTTP server included -- for its full duration.
// command-task.ts was the 60-second case; runPreCheck() in schedule-runner.ts was the same shape with
// a 10-second ceiling, once per tick, and had been there the whole time.
//
// SCOPE, deliberately narrow and measured rather than assumed. A repo-wide "no sync child_process on
// the server" rule is NOT implementable today: `src/web/**` has 30+ files and hundreds of such call
// sites (updates.ts alone has 20). Most are short, bounded, local commands. Banning the API globally
// would land red and be switched off, which is worse than no rule. So the invariant covers exactly the
// two files that execute ON the tick, where the cost is a frozen dashboard rather than a slow function.
//
// The optional part of the card -- `-m/--max-time` on self-curls -- is a soft guideline by MikroB's own
// decision, so it is NOT gated here.
import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const WEB = join(dirname(fileURLToPath(import.meta.url)), '..', 'web')
const ROUTES = join(WEB, 'routes')

const SYNC_CHILD_APIS = ['spawnSync', 'execSync', 'execFileSync'] as const
const SYNC_CALL_RX = new RegExp(`\\b(?:${SYNC_CHILD_APIS.join('|')})\\(`)

/** Source with `//` comment lines dropped -- a comment describing a removed call is not a call. */
function codeOf(file: string, base = WEB): string {
  const src = readFileSync(join(base, file), 'utf-8')
  expect(src.length, `${file} is empty -- an empty read would make every assertion vacuous`).toBeGreaterThan(0)
  return src.split('\n').filter((l) => !l.trim().startsWith('//')).join('\n')
}

/**
 * The tick path, DERIVED from what schedule-runner actually imports (card 095edfec).
 *
 * It used to be the hand-written pair ['command-task.ts', 'schedule-runner.ts'], and the hand was
 * wrong: schedule-mcp-precheck.ts is imported by schedule-runner, called from runPreCheck on every
 * tick with an mcp_servers requirement, and ran `execFileSync('/bin/ps', ...)` -- up to 3 seconds
 * of frozen event loop that this guard was blind to for as long as it existed. A list someone has
 * to remember to extend drifts behind the code; an import walk cannot.
 */
function tickPathFiles(): string[] {
  const runner = readFileSync(join(WEB, 'schedule-runner.ts'), 'utf-8')
  const local = [...runner.matchAll(/^import[^']*'\.\/([\w.-]+)\.js'/gm)].map((m) => `${m[1]}.ts`)
  return ['schedule-runner.ts', ...new Set(local)].filter((f) => {
    try {
      readFileSync(join(WEB, f))
      return true
    } catch {
      return false
    }
  })
}

/**
 * Every route handler, DERIVED from the directory (card 095edfec, Cybersec). A single inbound
 * request runs these, so a blocking child freezes every OTHER request too -- agents.ts held three
 * `execSync('sleep N')` calls, one inside a 12-iteration loop (card 89d0bfde).
 *
 * A repo-wide ban is not implementable: ten route files call a sync child today, all local and
 * bounded, and a red guard gets switched off. So the derived set is compared against a PINNED
 * inventory: the known ten may keep their calls, and any ELEVENTH file fails this suite. That is
 * the difference from the old hand list, which stayed green no matter how many new offenders
 * appeared.
 */
const ROUTE_FILES = readdirSync(ROUTES).filter((f) => f.endsWith('.ts')).sort()

/** Route files that legitimately call a sync child TODAY, measured. Gate-reviewed as local and bounded. */
const KNOWN_SYNC_ROUTES = [
  'agent-terminal.ts',
  'agents-skills.ts',
  'background-tasks.ts',
  'connectors.ts',
  'integrated-repos.ts',
  'onboarding.ts',
  'skills.ts',
  'updates.ts',
  'vault-ssh-keys.ts',
] as const

describe('scheduler tick stays off the blocking path (card 92e2bb1b)', () => {
/**
 * On the tick path but NOT yet clean, pinned with its reason rather than hidden by narrowing the
 * derivation (card 095edfec).
 *
 * agent-process.ts is a direct (multi-line) import of schedule-runner and holds SIX sync child
 * calls -- including `execSync('sleep 3')` and `execSync('sleep 2')`, the exact anti-pattern this
 * suite bans elsewhere. It is the fleet's tmux control surface (start/restart/capture), so
 * converting it is a change of a different size and risk than this card, and doing it quietly here
 * would be worse than naming it. Listed so the guard stays green on the KNOWN state while any NEW
 * offender on the tick still fails, and so the debt is visible in the test rather than in nobody's
 * memory. Needs its own card.
 */
const KNOWN_SYNC_TICK_FILES = ['agent-process.ts'] as const

  it.each(tickPathFiles().filter((f) => !(KNOWN_SYNC_TICK_FILES as readonly string[]).includes(f)))('%s uses no synchronous child_process API', (file) => {
    const code = codeOf(file)
    for (const api of SYNC_CHILD_APIS) {
      expect(code, `${file} runs on the scheduler tick and must not call ${api}: it would freeze the event loop for the child's lifetime`)
        .not.toMatch(new RegExp(`\\b${api}\\(`))
    }
  })

  it.each(tickPathFiles())('%s awaits every child it starts', (file) => {
    const src = readFileSync(join(WEB, file), 'utf-8')
    // Every execFile call has to be wrapped in an awaited Promise; an un-awaited one would let the
    // tick continue while the child is still running, which is a different bug (interleaved runs).
    const execFileCalls = (src.match(/\bexecFile\(/g) ?? []).length
    if (execFileCalls === 0) return
    expect(src).toMatch(/new Promise/)
    expect(src).toMatch(/await /)
  })

  it('no NEW route file starts calling a synchronous child', () => {
    const offenders = ROUTE_FILES.filter((f) => SYNC_CALL_RX.test(codeOf(f, ROUTES))).sort()
    const unexpected = offenders.filter((f) => !(KNOWN_SYNC_ROUTES as readonly string[]).includes(f))
    expect(
      unexpected,
      `these route files call a synchronous child_process API and are not on the reviewed inventory:\n` +
        `${unexpected.join('\n')}\nA blocking child in a route handler freezes EVERY other request. ` +
        `Use execFileAsync (src/web/exec-async.ts), or add the file to KNOWN_SYNC_ROUTES with a reason if the ` +
        `call is genuinely local and bounded.`,
    ).toEqual([])
    // ...and the inventory must not rot in the other direction either: a file that stopped calling
    // one should leave the list, or the list slowly becomes a blanket exemption.
    const stale = (KNOWN_SYNC_ROUTES as readonly string[]).filter((f) => !offenders.includes(f))
    expect(stale, `these files no longer call a sync child and should leave KNOWN_SYNC_ROUTES: ${stale.join(', ')}`).toEqual([])
  })

  it.each(['agents.ts'])('%s spawns no synchronous child, and never a process just to wait', (file) => {
    const code = codeOf(file, ROUTES)
    for (const api of SYNC_CHILD_APIS) {
      expect(code, `${file} must not call ${api} on the request path`).not.toMatch(new RegExp(`\\b${api}\\(`))
    }
    // spawning `sleep` is the daftest form of it: a whole process to do what a timer does for free
    expect(code).not.toMatch(/['"`]sleep \d/)
  })

  it('keeps the two runners async, so the callers can await instead of blocking', () => {
    const runner = readFileSync(join(WEB, 'schedule-runner.ts'), 'utf-8')
    const cmd = readFileSync(join(WEB, 'command-task.ts'), 'utf-8')
    expect(runner).toMatch(/export async function runPreCheck/)
    expect(cmd).toMatch(/export async function runCommandTask/)
    expect(runner).toMatch(/await runPreCheck\(/)
    expect(runner).toMatch(/await runCommandTask\(/)
  })

  // Guards the SCOPE decision itself: this list is small on purpose, and shrinking it to nothing
  // would silently disable the rule.
  it('covers every file known to execute on the tick', () => {
    const tick = tickPathFiles()
    expect(tick).toContain('command-task.ts')
    expect(tick).toContain('schedule-runner.ts')
    // The file the hand-written list missed. Pinned by name so a future refactor that drops the
    // import cannot quietly shrink the guard's reach back to where it was.
    expect(tick).toContain('schedule-mcp-precheck.ts')
    // Derivation sanity: a broken import regex would yield just the seed file and pass everything.
    expect(tick.length, 'the tick list collapsed -- the import derivation is broken').toBeGreaterThan(3)
    expect(SYNC_CHILD_APIS.length).toBeGreaterThanOrEqual(3)
  })

  it('the tick exemption list stays honest -- exactly one entry, and it is really on the tick', () => {
    expect(KNOWN_SYNC_TICK_FILES).toEqual(['agent-process.ts'])
    // If it ever leaves the tick path the pin is stale and must go, or it silently exempts a file
    // the guard no longer needs to care about.
    expect(tickPathFiles()).toContain('agent-process.ts')
  })

  it('scans a plausible number of route files (a broken walk would pass vacuously)', () => {
    expect(ROUTE_FILES.length).toBeGreaterThan(30)
    expect(ROUTE_FILES).toContain('agents.ts')
  })
})
