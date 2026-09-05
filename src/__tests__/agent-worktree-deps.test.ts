// Card 0b23ec28: the node_modules DIRECTORY SYMLINK is the enabler behind the 9dc0fba8 class, and
// store/agent-worktree-deps.sh replaces it with a real directory.
//
// The pair that matters is the first describe block below. It runs Cybered's measured wedge --
// `cd <worktree>/node_modules && rm -rf ../src` -- twice: once against today's symlink shape, where
// it reaches into the SHARED clone and deletes source there, and once against the real directory,
// where the same command stays inside the worktree. Without the first half the second proves
// nothing: a test that only shows the fixed state cannot tell "fixed" from "the wedge never worked
// here".
//
// Everything runs against a throwaway bare-origin + clone + worktrees trio under a temp dir (the
// same MARVEEN_MAIN / MARVEEN_WORKTREES override the sibling agent-worktree-marveen test uses), and
// every destructive step asserts its path is under that temp root before running.
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { execFileSync } from 'node:child_process'
import { chmodSync, copyFileSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { tmpdir } from 'node:os'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const WORKTREE_SH = join(ROOT, 'store', 'agent-worktree-marveen.sh')
const DEPS_SH = join(ROOT, 'store', 'agent-worktree-deps.sh')
const CC_GATE_SH = join(ROOT, 'store', 'cc-gate-worktree.sh')

let dir = ''
let main = ''
let worktrees = ''
let tree = ''

const gitOk = (repo: string, ...args: string[]): void => {
  execFileSync('git', ['-C', repo, ...args], { stdio: 'ignore' })
}

/** Runs a script with the temp overrides; returns { status, out }. */
function run(script: string, args: string[], env: Record<string, string> = {}): { status: number; out: string } {
  try {
    const out = execFileSync('bash', [script, ...args], {
      encoding: 'utf-8',
      env: { ...process.env, MARVEEN_MAIN: main, MARVEEN_WORKTREES: worktrees, ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    return { status: 0, out }
  } catch (err) {
    const e = err as { status?: number; stdout?: string; stderr?: string }
    return { status: e.status ?? 1, out: (e.stdout ?? '') + (e.stderr ?? '') }
  }
}

/**
 * Cybered's wedge, run for real. The TARGET is relative on purpose -- that is the whole mechanism --
 * so only the directory we cd into can be checked, and it must be under the temp root.
 */
function wedge(from: string, target: string): void {
  if (!from.startsWith(dir) || target.startsWith('/')) {
    throw new Error(`refusing to run the wedge: from=${from} target=${target}`)
  }
  execFileSync('bash', ['-c', `cd "${from}" && rm -rf "${target}"`], { stdio: 'ignore' })
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'wt-deps-'))
  const upstream = join(dir, 'origin.git')
  main = join(dir, 'main')
  worktrees = join(dir, 'worktrees')
  tree = join(worktrees, 'agentx')

  execFileSync('git', ['init', '-q', '--bare', upstream])
  execFileSync('git', ['clone', '-q', upstream, main])
  gitOk(main, 'config', 'user.email', 't@t.local')
  gitOk(main, 'config', 'user.name', 't')
  gitOk(main, 'checkout', '-q', '-b', 'develop')
  mkdirSync(join(main, 'src'), { recursive: true })
  mkdirSync(join(main, 'store'), { recursive: true })
  writeFileSync(join(main, 'src', 'keep.ts'), 'export const shared = 1\n')
  copyFileSync(DEPS_SH, join(main, 'store', 'agent-worktree-deps.sh'))
  gitOk(main, 'add', '-A')
  gitOk(main, 'commit', '-qm', 'seed')
  gitOk(main, 'push', '-q', '-u', 'origin', 'develop')
  // The script derives the default branch from origin/HEAD, which a clone of an empty bare repo
  // does not have -- same line the sibling agent-worktree-marveen test needs.
  gitOk(main, 'symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/develop')

  // The shared dependency tree the worktrees have been pointing at.
  mkdirSync(join(main, 'node_modules', 'somepkg'), { recursive: true })
  writeFileSync(join(main, 'node_modules', 'somepkg', 'index.js'), 'module.exports = 1\n')
})

afterEach(() => rmSync(dir, { recursive: true, force: true }))

describe('the wedge, before and after', () => {
  it('TODAY: through the symlink, `cd node_modules && rm -rf ../src` deletes the SHARED clone\'s src', () => {
    run(WORKTREE_SH, ['agentx'])
    expect(existsSync(join(main, 'src', 'keep.ts'))).toBe(true)

    wedge(join(tree, 'node_modules'), '../src')

    // This is the defect, reproduced: cd lands the process in the RESOLVED directory, so `..` is
    // the main clone, not the worktree. Nothing warned, nothing failed.
    expect(existsSync(join(main, 'src', 'keep.ts'))).toBe(false)
  })

  it('AFTER: with a real node_modules the same command cannot leave the worktree', () => {
    run(WORKTREE_SH, ['agentx'])
    expect(run(DEPS_SH, ['agentx']).status).toBe(0)

    wedge(join(tree, 'node_modules'), '../src')

    // The shared clone is untouched; the worktree's own src is what went, which is what `..` means
    // when node_modules is a real directory.
    expect(existsSync(join(main, 'src', 'keep.ts'))).toBe(true)
    expect(existsSync(join(tree, 'src'))).toBe(false)
  })
})

describe('agent-worktree-deps.sh', () => {
  it('never deletes the SHARED tree -- it unlinks the name, and the target keeps its content', () => {
    // The worst thing this script could do wrong. `rm` on a symlink removes the link; if it ever
    // followed through, the whole fleet would lose its dependencies in one call.
    run(WORKTREE_SH, ['agentx'])
    run(DEPS_SH, ['agentx'])
    expect(existsSync(join(main, 'node_modules', 'somepkg', 'index.js'))).toBe(true)
  })

  it('copies the content across, so the worktree is usable and not just empty', () => {
    run(WORKTREE_SH, ['agentx'])
    run(DEPS_SH, ['agentx'])
    expect(existsSync(join(tree, 'node_modules', 'somepkg', 'index.js'))).toBe(true)
  })

  it('is idempotent -- a second run reports the real directory and changes nothing', () => {
    run(WORKTREE_SH, ['agentx'])
    run(DEPS_SH, ['agentx'])
    writeFileSync(join(tree, 'node_modules', 'marker'), 'x')
    const again = run(DEPS_SH, ['agentx'])
    expect(again.status).toBe(0)
    expect(again.out).toMatch(/already a real directory/)
    expect(existsSync(join(tree, 'node_modules', 'marker'))).toBe(true)
  })

  it('--check names the shape and exits 4 on a symlink, 0 once it is real', () => {
    run(WORKTREE_SH, ['agentx'])
    const before = run(DEPS_SH, ['agentx', '--check'])
    expect(before.status).toBe(4)
    expect(before.out).toMatch(/SYMLINK/)

    run(DEPS_SH, ['agentx'])
    const after = run(DEPS_SH, ['agentx', '--check'])
    expect(after.status).toBe(0)
    expect(after.out).toMatch(/REAL directory/)
  })

  it('leaves no staging directory behind on success', () => {
    run(WORKTREE_SH, ['agentx'])
    run(DEPS_SH, ['agentx'])
    const leftovers = execFileSync('bash', ['-c', `ls -a "${tree}" | grep -c 'node_modules.incoming' || true`], {
      encoding: 'utf-8',
    }).trim()
    expect(leftovers).toBe('0')
  })

  // Card 65cc3860: the rollout converts trees belonging to agents that are MID-TASK, so the copy must
  // happen BEFORE the symlink is removed. The window is otherwise the whole ~1 minute of the copy,
  // during which the worktree has no node_modules at all and any vitest/tsc started there fails
  // looking like a broken dependency.
  //
  // The ordering is pinned through its observable consequence: make the copy fail, and the worktree
  // must be exactly as it was found. Under the old order the symlink was already gone by then, so the
  // tree was left broken and needing manual repair.
  it('a FAILED copy leaves the worktree untouched -- the symlink is still there (copy before swap)', () => {
    const unreadable = join(main, 'node_modules', 'unreadable-pkg')
    mkdirSync(unreadable, { recursive: true })
    writeFileSync(join(unreadable, 'index.js'), 'x')
    chmodSync(unreadable, 0o000) // cp -a cannot descend into it
    try {
      run(WORKTREE_SH, ['agentx'])
      const r = run(DEPS_SH, ['agentx'])
      expect(r.status).not.toBe(0)
      // The name must still be the ORIGINAL symlink, not missing and not a half-copy.
      expect(lstatSync(join(tree, 'node_modules')).isSymbolicLink()).toBe(true)
      // And no staging directory is left lying around.
      expect(readdirSync(tree).some((e) => e.startsWith('.node_modules.incoming.'))).toBe(false)
    } finally {
      chmodSync(unreadable, 0o755)
      rmSync(unreadable, { recursive: true, force: true })
    }
  })

  it('refuses when there is no worktree, instead of creating something halfway', () => {
    const r = run(DEPS_SH, ['nosuchagent'])
    expect(r.status).toBe(3)
    expect(r.out).toMatch(/no worktree at/)
  })
})

describe('agent-worktree-marveen.sh keeps the fast path fast', () => {
  it('still links by default -- the new shape is opt-in, not a sweep over live worktrees', () => {
    const r = run(WORKTREE_SH, ['agentx'])
    expect(r.status).toBe(0)
    expect(r.out).toMatch(/linked from/)
    // And it says how to change that, so the state is discoverable without reading this test.
    expect(r.out).toMatch(/agent-worktree-deps\.sh/)
  })

  it('MARVEEN_WORKTREE_REAL_DEPS=1 creates the real directory at creation time', () => {
    const r = run(WORKTREE_SH, ['agentx'], { MARVEEN_WORKTREE_REAL_DEPS: '1' })
    expect(r.status).toBe(0)
    expect(existsSync(join(tree, 'node_modules', 'somepkg', 'index.js'))).toBe(true)
    expect(run(DEPS_SH, ['agentx', '--check']).status).toBe(0)
  })

  it('re-running on an already-converted worktree does not link over the real directory', () => {
    run(WORKTREE_SH, ['agentx'])
    run(DEPS_SH, ['agentx'])
    const r = run(WORKTREE_SH, ['agentx'])
    expect(r.out).toMatch(/real directory/)
    expect(run(DEPS_SH, ['agentx', '--check']).status).toBe(0)
  })
})

// Card 0b23ec28, QA's input (comment 18034): cc-gate-worktree.sh already gives its worktrees a REAL
// node_modules with per-entry symlinks, but `.vite` was one of those entries -- and `.vite` is a
// WRITTEN dep-cache, not a read-only package. Two gate worktrees running a dev server at once
// optimised into the SAME cache and served each other 504 Outdated Optimize Dep, measured live.
describe('cc-gate-worktree.sh does not share the vite dep-cache', () => {
  it('creates .vite as a REAL directory while ordinary entries stay symlinks', () => {
    const cc = join(dir, 'cc')
    const gates = join(dir, 'gates')
    mkdirSync(join(cc, 'packages'), { recursive: true })
    mkdirSync(gates, { recursive: true })
    execFileSync('git', ['init', '-q', cc])
    gitOk(cc, 'config', 'user.email', 't@t.local')
    gitOk(cc, 'config', 'user.name', 't')
    writeFileSync(join(cc, 'seed.txt'), 'x\n')
    gitOk(cc, 'add', '-A')
    gitOk(cc, 'commit', '-qm', 'seed')
    const sha = execFileSync('git', ['-C', cc, 'rev-parse', '--short', 'HEAD'], {
      encoding: 'utf-8',
    }).trim()
    // The shared cache and one ordinary dependency, side by side in the same node_modules.
    mkdirSync(join(cc, 'node_modules', '.vite', 'deps'), { recursive: true })
    writeFileSync(join(cc, 'node_modules', '.vite', 'deps', 'stale.js'), 'shared\n')
    mkdirSync(join(cc, 'node_modules', 'somepkg'), { recursive: true })

    // `--agent` is REQUIRED since card a7da80d6: the path carries the agent so two gates on the
    // same card+sha cannot share (and destroy) one worktree.
    const out = execFileSync('bash', [CC_GATE_SH, '--agent', 'testagent', 'card0', sha], {
      encoding: 'utf-8',
      env: { ...process.env, CLEANCORE_MAIN: cc, CC_GATE_ROOT: gates },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    expect(out).toMatch(/worktree created/)

    const wt = join(gates, `cc-gate-card0-testagent-${sha}`)
    // A real directory: `lstat` says it is not a link, and it does NOT carry the shared cache
    // contents, so a dev server here cannot serve another tree's stale optimise output.
    expect(lstatSync(join(wt, 'node_modules', '.vite')).isSymbolicLink()).toBe(false)
    expect(existsSync(join(wt, 'node_modules', '.vite', 'deps', 'stale.js'))).toBe(false)
    // And the ordinary entry is still linked -- the change is scoped to the cache, not a rewrite
    // of how dependencies resolve.
    expect(lstatSync(join(wt, 'node_modules', 'somepkg')).isSymbolicLink()).toBe(true)
  })
})
