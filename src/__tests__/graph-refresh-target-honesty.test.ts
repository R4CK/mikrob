// Card d2f4b273. `blast-radius-check.py --refresh <repo>` reported "already current" on a clone
// whose working tree was NINE commits behind the branch it tracks.
//
// WHY THE OBVIOUS FIX WAS WRONG, and why this test pins a REPORT rather than a refresh. The first
// plan was to key the staleness check on the upstream ref instead of HEAD. Measured, that would
// have made things worse: the graph builder discovers changed files with
// `git diff --name-status -z <base> --` -- NO second revision -- so it diffs the base against the
// WORKING TREE, and records the new sha from `rev-parse HEAD`. On the CleanCore clone
// `git diff --name-only <graph> --` saw 0 files where `... <graph> origin/main` saw 25. Pointing
// the check at the upstream without moving the tree would have printed "graph refreshed, was 9
// commit(s) behind" over zero indexed files and an unchanged recorded sha: a LOUDER falsehood.
// Making the graph actually current needs a checkout of the target, which is its own card
// (42194681). This card's job is that the tool stops lying.

import { describe, it, expect } from 'vitest'
import { execFileSync, spawnSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const STORE = join(__dirname, '..', '..', 'store')
const CHECK = join(STORE, 'blast-radius-check.py')

const git = (cwd: string, ...args: string[]): string =>
  execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf-8' }).trim()

describe('refresh_target: what the graph is supposed to cover (card d2f4b273)', () => {
  let dir: string
  const run = (fn: (repo: string) => void): void => {
    dir = mkdtempSync(join(tmpdir(), 'brc-target-'))
    try {
      fn(dir)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  }

  /** A bare "remote" plus a clone of it, so origin/<branch> is a real ref. */
  const cloneWithRemote = (root: string): string => {
    const origin = join(root, 'origin.git')
    const work = join(root, 'seed')
    execFileSync('git', ['init', '-q', '--bare', origin])
    // The bare repo's HEAD follows this machine's init.defaultBranch (here: master). Cloning it
    // then leaves an UNBORN head -- no checkout, no upstream -- and every assertion below would be
    // about a repo shape that does not occur in the fleet. Point it at the branch we push.
    git(origin, 'symbolic-ref', 'HEAD', 'refs/heads/main')
    execFileSync('git', ['init', '-q', work])
    writeFileSync(join(work, 'a.txt'), 'one')
    git(work, 'add', '-A')
    git(work, '-c', 'user.email=a@b', '-c', 'user.name=t', 'commit', '-qm', 'one')
    git(work, 'branch', '-M', 'main')
    git(work, 'remote', 'add', 'origin', origin)
    git(work, 'push', '-q', 'origin', 'main')
    const clone = join(root, 'clone')
    execFileSync('git', ['clone', '-q', origin, clone])
    return clone
  }

  const target = (repo: string): { ref: string; label: string } => {
    const out = execFileSync(
      'python3',
      [
        '-c',
        [
          'import importlib.util, json, sys',
          `spec = importlib.util.spec_from_file_location('brc', ${JSON.stringify(CHECK)})`,
          'm = importlib.util.module_from_spec(spec); spec.loader.exec_module(m)',
          'from pathlib import Path',
          `ref, label = m.refresh_target(Path(${JSON.stringify(repo)}))`,
          'print(json.dumps({"ref": ref, "label": label}))',
        ].join('\n'),
      ],
      { encoding: 'utf-8' },
    )
    return JSON.parse(out.trim())
  }

  // NON-VACUOUS BY CONSTRUCTION: the upstream is pointed at a DIFFERENT ref than origin/<branch>.
  // With both pointing at origin/main -- which is what a plain clone gives -- the two code paths
  // return the same string and the assertion proves nothing. A mutant that ignored the upstream
  // entirely kept this green until the fixture was changed.
  it('prefers the branch upstream over origin/<branch> when they differ', () => {
    run((root) => {
      const clone = cloneWithRemote(root)
      // A second branch on the remote, so the upstream can point somewhere else.
      git(clone, 'push', '-q', 'origin', 'HEAD:refs/heads/alt')
      git(clone, 'fetch', '-q', 'origin')
      git(clone, 'branch', '--set-upstream-to=origin/alt', 'main')
      expect(git(clone, 'rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}')).toBe(
        'origin/alt',
      )
      expect(target(clone).label).toBe('origin/alt')
    })
  })

  // THE CASE THAT MOTIVATED THE CARD, and the one an @{u}-only fix would have missed: CleanCore's
  // main clone is on `main` with NO upstream set, so `@{u}` fails there outright.
  it('falls back to origin/<branch> when no upstream is configured', () => {
    run((root) => {
      const clone = cloneWithRemote(root)
      git(clone, 'branch', '--unset-upstream')
      expect(() => git(clone, 'rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}')).toThrow()
      expect(target(clone).label).toBe('origin/main')
    })
  })

  it('falls back to HEAD when there is no remote at all', () => {
    run((root) => {
      const solo = join(root, 'solo')
      execFileSync('git', ['init', '-q', solo])
      writeFileSync(join(solo, 'a.txt'), 'x')
      git(solo, 'add', '-A')
      git(solo, '-c', 'user.email=a@b', '-c', 'user.name=t', 'commit', '-qm', 'x')
      expect(target(solo).label).toBe('HEAD')
    })
  })
})

describe('the refresh REPORTS a working tree that cannot cover the target (card d2f4b273)', () => {
  const SRC = readFileSync(CHECK, 'utf-8')
  /** Comment-stripped: a rule described in prose must not vouch for code that does not do it. */
  const CODE = SRC.split('\n')
    .map((l) => l.replace(/#.*$/, ''))
    .join('\n')

  it('the scan sees the real script -- otherwise the checks below are vacuous', () => {
    expect(CODE).toContain('def refresh_only')
    expect(CODE).toContain('def refresh_target')
    expect(SRC.length).toBeGreaterThan(5000)
  })

  it('compares the working tree against the target before doing anything else', () => {
    const body = CODE.slice(CODE.indexOf('def refresh_only'))
    const gate = body.indexOf('refresh_target(root)')
    const conn = body.indexOf('sqlite3.connect')
    expect(gate).toBeGreaterThan(-1)
    expect(
      gate,
      'the target comparison must happen before the graph is opened and judged',
    ).toBeLessThan(conn)
  })

  it('refuses to claim a refresh it cannot perform, and exits non-zero', () => {
    const body = CODE.slice(CODE.indexOf('def refresh_only'))
    const gate = body.indexOf('refresh_target(root)')
    const afterGate = body.slice(gate, body.indexOf('sqlite3.connect'))
    expect(afterGate).toMatch(/behind/)
    expect(afterGate).toMatch(/return 1/)
    // And it must NOT reach the refresh: the whole point is that indexing here would record a
    // successful-looking update of the wrong tree.
    expect(afterGate).not.toMatch(/refresh\(root/)
  })
})

// THE SAME PROPERTY, RUN RATHER THAN READ. The structural checks above all survive `if False:` --
// the text stays exactly where it was while the branch never fires. That is the vacuity this file
// keeps finding elsewhere, so the gate gets measured on a real repository too.
describe('--refresh on a tree behind its target: measured, not read (card d2f4b273)', () => {
  const refresh = (repo: string): { code: number; out: string } => {
    const r = spawnSync('python3', [CHECK, '--refresh', repo], { encoding: 'utf-8' })
    return { code: r.status ?? -1, out: `${r.stdout ?? ''}${r.stderr ?? ''}` }
  }

  /** A clone whose working tree is `behind` commits behind origin/main, with a graph file present
   *  so the run reaches the target check rather than stopping at "no graph". */
  const setup = (root: string, behind: number): string => {
    const origin = join(root, 'origin.git')
    const work = join(root, 'seed')
    execFileSync('git', ['init', '-q', '--bare', origin])
    execFileSync('git', ['-C', origin, 'symbolic-ref', 'HEAD', 'refs/heads/main'])
    execFileSync('git', ['init', '-q', work])
    writeFileSync(join(work, 'a.txt'), 'one')
    git(work, 'add', 'a.txt')
    git(work, '-c', 'user.email=a@b', '-c', 'user.name=t', 'commit', '-qm', 'one')
    git(work, 'branch', '-M', 'main')
    git(work, 'remote', 'add', 'origin', origin)
    git(work, 'push', '-q', 'origin', 'main')
    const clone = join(root, 'clone')
    execFileSync('git', ['clone', '-q', origin, clone])
    for (let i = 0; i < behind; i++) {
      writeFileSync(join(work, `extra${i}.txt`), `x${i}`)
      git(work, 'add', `extra${i}.txt`)
      git(work, '-c', 'user.email=a@b', '-c', 'user.name=t', 'commit', '-qm', `extra${i}`)
    }
    if (behind > 0) {
      git(work, 'push', '-q', 'origin', 'main')
      git(clone, 'fetch', '-q', 'origin') // fetched, deliberately NOT merged
    }
    mkdirSync(join(clone, '.code-review-graph'), { recursive: true })
    writeFileSync(join(clone, '.code-review-graph', 'graph.db'), '')
    return clone
  }

  const run = (behind: number, fn: (res: { code: number; out: string }) => void): void => {
    const dir = mkdtempSync(join(tmpdir(), 'brc-behaviour-'))
    try {
      fn(refresh(setup(dir, behind)))
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  }

  it('says how far behind it is, names the target, and exits non-zero', () => {
    run(3, (res) => {
      expect(res.out).toMatch(/3 commit\(s\) behind origin\/main/)
      expect(res.out).toMatch(/refresh skipped/)
      expect(res.code).not.toBe(0)
      // The two falsehoods this card exists to remove.
      expect(res.out).not.toMatch(/already current/)
      expect(res.out).not.toMatch(/graph refreshed/)
    })
  })

  // POSITIVE CONTROL: without this, a gate that fired unconditionally would pass the test above.
  it('does not claim a lag when the tree IS at the target', () => {
    run(0, (res) => {
      expect(res.out).not.toMatch(/behind/)
    })
  })
})

// The lander is the main caller, and its ORDER is what decides whether the tool ever sees a tree
// that matches the landed state. This is not decoration: before this card the refresh ran BEFORE
// the live install was fast-forwarded, so on marveen the graph silently tracked the PREVIOUS
// landing while reporting success.
describe('marveen-land.sh syncs the live install before indexing it (card d2f4b273)', () => {
  const LAND = readFileSync(join(STORE, 'marveen-land.sh'), 'utf-8')
  const CODE = LAND.split('\n')
    .map((l) => l.replace(/#.*$/, ''))
    .join('\n')

  it('the scan sees all three steps -- otherwise the order check is vacuous', () => {
    expect(CODE).toMatch(/sync_live_install\s*$/m)
    expect(CODE).toContain('blast-radius-check.py')
    expect(CODE).toMatch(/graphify\.sh"?\s+build/)
  })

  it('the fast-forward comes before both graph refreshes', () => {
    // The CALL, not the definition: `sync_live_install() {` also contains the name.
    const call = CODE.search(/^\s*sync_live_install\s*$/m)
    const blast = CODE.indexOf('blast-radius-check.py')
    const graphify = CODE.search(/graphify\.sh"?\s+build/)
    expect(call).toBeGreaterThan(-1)
    expect(call, 'sync_live_install must run before blast-radius').toBeLessThan(blast)
    expect(call, 'sync_live_install must run before graphify').toBeLessThan(graphify)
  })
})
