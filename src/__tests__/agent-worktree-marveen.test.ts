// Card dc185b52: MikroB's REVERSED decision (komment 14285) after Cybersec's NO-GO (komment 14284)
// on the earlier branch-only attempt (store/agent-branch.sh, now RETIRED along with
// store/agent-branch-land.sh and this file's predecessor, src/__tests__/agent-branch.test.ts).
// Cybersec live-reproduced a TOCTOU race: agent-branch.sh's `git checkout` on the ONE shared working
// directory could swap file content out from under a DIFFERENT agent's ordinary Read-then-Write
// sequence (which never calls agent-branch.sh at all), silently losing that agent's already-
// committed work with no git error. Full per-agent worktree isolation -- the ALREADY-PROVEN
// CleanCore pattern (store/agent-worktree.sh) -- closes this STRUCTURALLY: nothing here ever runs
// `git checkout` against a path any other agent's tools might be reading or writing.
//
// Every test runs against a THROWAWAY bare-origin + main-clone pair under a real temp dir, never the
// live marveen checkout -- both scripts accept MARVEEN_MAIN / MARVEEN_WORKTREES / MARVEEN_LAND_TEST
// overrides for exactly this reason (store/fleet-test.sh itself hardcodes the real repo as ROOT, so
// marveen-land.sh's verification step is a stub here, not the real suite).
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { execFile, execFileSync } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdtempSync, rmSync, writeFileSync, chmodSync, mkdirSync, readlinkSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { tmpdir } from 'node:os'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const WORKTREE_SH = join(ROOT, 'store', 'agent-worktree-marveen.sh')
const LAND_SH = join(ROOT, 'store', 'marveen-land.sh')
const execFileP = promisify(execFile)

function git(repo: string, ...args: string[]): string {
  return execFileSync('git', ['-C', repo, ...args], { encoding: 'utf-8' }).trim()
}
function gitOk(repo: string, ...args: string[]): void {
  execFileSync('git', ['-C', repo, ...args], { stdio: 'ignore' })
}

let dir: string
let upstream: string
let main: string
let worktrees: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'marveen-worktree-test-'))
  upstream = join(dir, 'origin.git')
  main = join(dir, 'main')
  worktrees = join(dir, 'worktrees')
  execFileSync('git', ['init', '-q', '--bare', upstream])
  execFileSync('git', ['clone', '-q', upstream, main])
  gitOk(main, 'config', 'user.email', 't@t.local')
  gitOk(main, 'config', 'user.name', 't')
  gitOk(main, 'checkout', '-q', '-b', 'develop')
  writeFileSync(join(main, 'shared.txt'), 'aaa\nbbb\nccc\n')
  writeFileSync(join(main, 'f.txt'), 'hello\n')
  mkdirSync(join(main, 'node_modules'))
  writeFileSync(join(main, 'node_modules', 'marker.txt'), 'x\n')
  gitOk(main, 'add', 'f.txt', 'shared.txt')
  gitOk(main, 'commit', '-q', '-m', 'init')
  gitOk(main, 'push', '-q', '-u', 'origin', 'develop')
  gitOk(main, 'symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/develop')
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

async function runWorktree(agent: string, extraArgs: string[] = []): Promise<{ status: number; out: string }> {
  try {
    const { stdout, stderr } = await execFileP('bash', [WORKTREE_SH, agent, ...extraArgs], {
      encoding: 'utf-8',
      env: { ...process.env, MARVEEN_MAIN: main, MARVEEN_WORKTREES: worktrees },
    })
    return { status: 0, out: stdout + stderr }
  } catch (e) {
    const err = e as { code?: number; stdout?: string; stderr?: string }
    return { status: err.code ?? -1, out: (err.stdout ?? '') + (err.stderr ?? '') }
  }
}

function writeStub(exitCode: number): string {
  const p = join(dir, `stub-${exitCode}.sh`)
  writeFileSync(p, `#!/usr/bin/env bash\nexit ${exitCode}\n`)
  chmodSync(p, 0o755)
  return p
}

async function runLand(args: string[], testCmd: string): Promise<{ status: number; out: string }> {
  try {
    const { stdout, stderr } = await execFileP('bash', [LAND_SH, ...args], {
      encoding: 'utf-8',
      env: { ...process.env, MARVEEN_MAIN: main, MARVEEN_LAND_TEST: testCmd },
    })
    return { status: 0, out: stdout + stderr }
  } catch (e) {
    const err = e as { code?: number; stdout?: string; stderr?: string }
    return { status: err.code ?? -1, out: (err.stdout ?? '') + (err.stderr ?? '') }
  }
}

describe('agent-worktree-marveen.sh (card dc185b52)', () => {
  it('creates a worktree on agent/<agent>/work off the default branch', async () => {
    const r = await runWorktree('backend')
    expect(r.status).toBe(0)
    const tree = join(worktrees, 'backend')
    expect(git(tree, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe('agent/backend/work')
    expect(git(tree, 'rev-parse', 'HEAD')).toBe(git(main, 'rev-parse', 'origin/develop'))
  })

  it('links node_modules from main', async () => {
    await runWorktree('backend')
    const link = readlinkSync(join(worktrees, 'backend', 'node_modules'))
    expect(link).toBe(join(main, 'node_modules'))
  })

  it('is idempotent: a second call tops up without recreating', async () => {
    await runWorktree('backend')
    const r = await runWorktree('backend')
    expect(r.status).toBe(0)
    expect(r.out).toContain('worktree already present')
  })

  it('MUTATION-PROOF: edits made in one agent worktree never appear in main or another agent worktree (structural isolation, not discipline)', async () => {
    await runWorktree('backend')
    await runWorktree('fullstack')
    writeFileSync(join(worktrees, 'backend', 'shared.txt'), 'backend edited this\n')

    // main's own working tree is untouched
    expect(git(main, 'status', '--porcelain', '--', 'shared.txt')).toBe('')
    // a sibling agent's worktree is untouched -- each has its own checked-out files
    const fullstackContent = execFileSync('cat', [join(worktrees, 'fullstack', 'shared.txt')], {
      encoding: 'utf-8',
    })
    expect(fullstackContent).toBe('aaa\nbbb\nccc\n')
  })

  it('rejects an agent name with disallowed characters', async () => {
    const r = await runWorktree('Back_End!')
    expect(r.status).toBe(2)
  })

  it('--path prints the path without creating anything', async () => {
    const r = await runWorktree('backend', ['--path'])
    expect(r.status).toBe(0)
    expect(r.out.trim()).toBe(join(worktrees, 'backend'))
    expect(() => git(join(worktrees, 'backend'), 'rev-parse', 'HEAD')).toThrow()
  })
})

describe('marveen-land.sh (card dc185b52)', () => {
  async function commitInWorktree(agent: string, files: Record<string, string>): Promise<void> {
    await runWorktree(agent)
    const tree = join(worktrees, agent)
    gitOk(tree, 'config', 'user.email', `${agent}@t.local`)
    gitOk(tree, 'config', 'user.name', agent)
    for (const [name, content] of Object.entries(files)) {
      mkdirSync(dirname(join(tree, name)), { recursive: true })
      writeFileSync(join(tree, name), content)
    }
    gitOk(tree, 'add', ...Object.keys(files))
    gitOk(tree, 'commit', '-q', '-m', `${agent} work`)
  }

  it('lands a worktree branch onto the default branch and pushes to origin', async () => {
    await commitInWorktree('backend', { 'backend-new.txt': 'from backend\n' })

    const r = await runLand(['backend'], writeStub(0))
    expect(r.status).toBe(0)
    expect(r.out).toContain('LANDED')

    gitOk(main, 'fetch', '-q', 'origin', 'develop')
    const files = git(main, 'ls-tree', '-r', '--name-only', 'origin/develop')
    expect(files.split('\n')).toContain('backend-new.txt')
  })

  it('MUTATION-PROOF: refuses a real content conflict and pushes nothing', async () => {
    await commitInWorktree('backend', { 'shared.txt': 'aaa\nbbb\nccc\nbackend-tail\n' })
    writeFileSync(join(main, 'shared.txt'), 'aaa\nbbb\nccc\ndevelop-tail\n')
    gitOk(main, 'add', 'shared.txt')
    gitOk(main, 'commit', '-q', '-m', 'develop edits the same tail')
    gitOk(main, 'push', '-q', 'origin', 'develop')

    const before = git(main, 'rev-parse', 'origin/develop')
    const r = await runLand(['backend'], writeStub(0))
    expect(r.status).toBe(4)
    expect(r.out).toContain('CONFLICT')

    gitOk(main, 'fetch', '-q', 'origin', 'develop')
    expect(git(main, 'rev-parse', 'origin/develop')).toBe(before)
  })

  it('refuses when the verification command fails on the merge result, and pushes nothing', async () => {
    await commitInWorktree('backend', { 'backend-new.txt': 'x\n' })

    const before = git(main, 'rev-parse', 'origin/develop')
    const r = await runLand(['backend'], writeStub(1))
    expect(r.status).toBe(4)
    expect(r.out).toContain('REFUSED')

    gitOk(main, 'fetch', '-q', 'origin', 'develop')
    expect(git(main, 'rev-parse', 'origin/develop')).toBe(before)
  })

  it('a successful landing leaves the agent worktree untouched, but its branch is an ancestor of origin/develop', async () => {
    await commitInWorktree('backend', { 'backend-new.txt': 'x\n' })
    const preLandTip = git(join(worktrees, 'backend'), 'rev-parse', 'HEAD')

    await runLand(['backend'], writeStub(0))

    // the agent's own worktree is not auto-reset -- same precedent as CleanCore's landing script
    expect(git(join(worktrees, 'backend'), 'rev-parse', 'HEAD')).toBe(preLandTip)
    gitOk(main, 'fetch', '-q', 'origin', 'develop')
    expect(() => git(main, 'merge-base', '--is-ancestor', preLandTip, 'origin/develop')).not.toThrow()
  })

  it('--all lands every agent/*/work branch with unmerged work in one sweep', async () => {
    await commitInWorktree('backend', { 'backend-new.txt': 'x\n' })
    await commitInWorktree('fullstack', { 'fullstack-new.txt': 'y\n' })

    const r = await runLand(['--all'], writeStub(0))
    expect(r.status).toBe(0)
    expect(r.out).toContain('backend: LANDED')
    expect(r.out).toContain('fullstack: LANDED')

    gitOk(main, 'fetch', '-q', 'origin', 'develop')
    const files = git(main, 'ls-tree', '-r', '--name-only', 'origin/develop')
    expect(files.split('\n')).toEqual(expect.arrayContaining(['backend-new.txt', 'fullstack-new.txt']))
  })

  it('landing again after a clean land is a no-op, not an error', async () => {
    await commitInWorktree('backend', { 'backend-new.txt': 'x\n' })
    await runLand(['backend'], writeStub(0))

    const r = await runLand(['backend'], writeStub(0))
    expect(r.status).toBe(0)
    expect(r.out).toContain('already fully landed')
  })

  // ── Card 77075367: a src/-touching land is not a silent stale-dist gap ─────────────────────
  // A landed src/ change does not rebuild dist/ or restart mikrob-channels/mikrob-dashboard
  // (deliberately -- see land_one's header comment). f0389e81 landed a gated security fix that sat
  // inactive for ~1h because nothing said so. This does not rebuild anything; it only asserts the
  // land now SAYS so, at the one moment someone is already watching the output.

  it('warns when the landed change touches src/', async () => {
    await commitInWorktree('backend', { 'src/new-thing.ts': 'export const x = 1\n' })
    const r = await runLand(['backend'], writeStub(0))
    expect(r.status).toBe(0)
    expect(r.out).toContain('WARNING')
    expect(r.out).toContain('src/')
    expect(r.out).toContain('./update.sh')
  })

  it('does NOT warn when the landed change stays outside src/', async () => {
    await commitInWorktree('backend', { 'store/new-thing.sh': '#!/usr/bin/env bash\n' })
    const r = await runLand(['backend'], writeStub(0))
    expect(r.status).toBe(0)
    expect(r.out).not.toContain('WARNING')
  })

  // ── Card 65657bad: a lost push race is not a failure ───────────────────────────────────────
  // Measured on card 6cd3b6af: two consecutive PUSH FAILEDs, each because another agent landed
  // during the ~2-minute merge+fleet-test window, so the push was no longer fast-forward. The
  // script threw git's stderr away, so the message could not distinguish that from a real fault --
  // I re-ran the whole landing by hand twice to find out which it was.
  //
  // These reproduce the RACE, not the error string: the verification stub itself pushes a competing
  // commit to origin, which is exactly what a peer landing mid-test does.

  /** A verification stub that succeeds, and on its FIRST run pushes a competing commit to origin --
   *  the peer agent landing inside our merge+test window. Counts its own invocations so a test can
   *  assert how many full attempts the script actually made. */
  function writeRacingStub(opts: { racesOnRun: number }): { path: string; runs: () => number } {
    const counter = join(dir, 'stub-runs')
    const rival = join(dir, 'rival')
    const p = join(dir, 'stub-race.sh')
    writeFileSync(
      p,
      `#!/usr/bin/env bash\n` +
        `n=$(( $(cat ${counter} 2>/dev/null || echo 0) + 1 )); echo "$n" > ${counter}\n` +
        `if [ "$n" = "${opts.racesOnRun}" ]; then\n` +
        `  rm -rf ${rival}\n` +
        `  git clone -q --branch develop ${upstream} ${rival}\n` +
        `  git -C ${rival} config user.email r@t.local; git -C ${rival} config user.name rival\n` +
        `  echo rival > ${rival}/rival.txt\n` +
        `  git -C ${rival} add rival.txt\n` +
        `  git -C ${rival} commit -q -m "a peer agent lands during our fleet-test"\n` +
        `  git -C ${rival} push -q origin HEAD:develop\n` +
        `fi\n` +
        `exit 0\n`,
    )
    chmodSync(p, 0o755)
    return {
      path: p,
      runs: () => Number(execFileSync('cat', [counter], { encoding: 'utf-8' }).trim()),
    }
  }

  it('THE RACE: a peer landing mid-test is retried and lands, instead of reporting a failure', async () => {
    await commitInWorktree('backend', { 'backend-new.txt': 'x\n' })
    const stub = writeRacingStub({ racesOnRun: 1 })

    const r = await runLand(['backend'], stub.path)
    expect(r.status, `landing did not recover from the race:\n${r.out}`).toBe(0)
    expect(r.out).toContain('LANDED')
    expect(r.out).toMatch(/another agent landed during the merge\+test window/)
    // Two full attempts: the first lost the race, the second merged onto the new tip.
    expect(stub.runs()).toBe(2)
  })

  it('the retry RE-VERIFIES: the second attempt merges the peer commit and tests THAT', async () => {
    // The cheap wrong fix is to push the already-approved merge again onto the moved base, or to
    // skip the re-test to save two minutes. Either would put a merge result on develop that no
    // verification ever saw. Both commits must be present at the end.
    await commitInWorktree('backend', { 'backend-new.txt': 'x\n' })
    const stub = writeRacingStub({ racesOnRun: 1 })
    await runLand(['backend'], stub.path)

    const landed = git(main, 'ls-tree', '-r', '--name-only', 'origin/develop')
    expect(landed).toContain('backend-new.txt')
    expect(landed, "the peer's commit was overwritten rather than merged").toContain('rival.txt')
  })

  it('CONTROL: a push refused for a NON-race reason is reported, and not retried', async () => {
    // Retrying a rejecting hook (or bad credentials) burns another full merge+verify cycle and
    // fails again for the same reason. Only git's own non-fast-forward markers may trigger a retry.
    const hook = join(upstream, 'hooks', 'pre-receive')
    writeFileSync(hook, '#!/usr/bin/env bash\necho "policy: pushes are frozen" >&2\nexit 1\n')
    chmodSync(hook, 0o755)
    await commitInWorktree('backend', { 'backend-new.txt': 'x\n' })
    const stub = writeRacingStub({ racesOnRun: 0 }) // never races; only counts runs

    const r = await runLand(['backend'], stub.path)
    expect(r.status).not.toBe(0)
    expect(r.out).toContain('PUSH FAILED')
    expect(stub.runs(), 'a non-race rejection was retried').toBe(1)
  })

  it('THE POINT OF THE CARD: the failure message carries git\'s own words', async () => {
    // Without this the operator cannot tell a race from a real fault -- which is the whole finding.
    const hook = join(upstream, 'hooks', 'pre-receive')
    writeFileSync(hook, '#!/usr/bin/env bash\necho "policy: pushes are frozen" >&2\nexit 1\n')
    chmodSync(hook, 0o755)
    await commitInWorktree('backend', { 'backend-new.txt': 'x\n' })

    const r = await runLand(['backend'], writeStub(0))
    expect(r.out, 'the push error is still being swallowed').toContain('policy: pushes are frozen')
  })

  it('a repeatedly-raced push gives up after the attempt budget, and pushes nothing', async () => {
    // Unbounded retry on a continuously-landing fleet would spin for ever, burning a full test run
    // each time. racesOnRun:0 with a stub that races EVERY time is the pathological case.
    await commitInWorktree('backend', { 'backend-new.txt': 'x\n' })
    const counter = join(dir, 'stub-runs')
    const rival = join(dir, 'rival')
    const p = join(dir, 'stub-always-race.sh')
    writeFileSync(
      p,
      `#!/usr/bin/env bash\n` +
        `n=$(( $(cat ${counter} 2>/dev/null || echo 0) + 1 )); echo "$n" > ${counter}\n` +
        `rm -rf ${rival}\n` +
        `git clone -q --branch develop ${upstream} ${rival}\n` +
        `git -C ${rival} config user.email r@t.local; git -C ${rival} config user.name rival\n` +
        `echo "rival $n" > ${rival}/rival-$n.txt\n` +
        `git -C ${rival} add rival-$n.txt\n` +
        `git -C ${rival} commit -q -m "peer $n"\n` +
        `git -C ${rival} push -q origin HEAD:develop\n` +
        `exit 0\n`,
    )
    chmodSync(p, 0o755)

    const r = await execFileP('bash', [LAND_SH, 'backend'], {
      encoding: 'utf-8',
      env: { ...process.env, MARVEEN_MAIN: main, MARVEEN_LAND_TEST: p, MARVEEN_LAND_MAX_ATTEMPTS: '2' },
    }).then(
      ({ stdout, stderr }) => ({ status: 0, out: stdout + stderr }),
      (e: { code?: number; stdout?: string; stderr?: string }) => ({
        status: e.code ?? -1,
        out: (e.stdout ?? '') + (e.stderr ?? ''),
      }),
    )
    expect(r.status).not.toBe(0)
    expect(r.out).toContain('lost the push race')
    expect(r.out).not.toContain('LANDED')
    expect(Number(execFileSync('cat', [counter], { encoding: 'utf-8' }).trim())).toBe(2)
    // The branch is untouched: nothing of ours reached origin.
    expect(git(main, 'ls-tree', '-r', '--name-only', 'origin/develop')).not.toContain('backend-new.txt')
  })
})
